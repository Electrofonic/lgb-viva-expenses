// Μηχανή αποστολής email υπενθυμίσεων.
//   ?action=seed-emails  (POST {map:{walletId:{name,firstName,card,emails:[]}}})  → αποθηκεύει τα email στη βάση (ιδιωτικά)
//   ?action=test&to=EMAIL                                                          → στέλνει ΕΝΑ δείγμα (πάντα, για δοκιμή Resend)
//   ?action=run&type=INSTANT|EOD|WEEKLY|MONTH_END                                  → κανονικό τρέξιμο
//        ΑΣΦΑΛΕΙΑ: αν EMAILS_LIVE !== "true" → ΤΙΠΟΤΑ δεν φεύγει σε υπάλληλο· ανακατευθύνεται στον CFO (REVIEW_EMAIL) με [TEST → …].
//        Μόνο όταν οριστεί ρητά EMAILS_LIVE=true αρχίζουν να φεύγουν στους πραγματικούς παραλήπτες.
const { sbSelect, sbInsert, sbUpdate, personToken, verifyToken } = require("./_viva.js");

// ── Ξεδίπλωμα διπλοεγγραφών Viva ────────────────────────────────────────────
// Η Viva γράφει την ίδια αγορά έως και 3 φορές (webhook + δέσμευση + εκκαθάριση).
// ΧΩΡΙΣ αυτό, ο υπάλληλος κυνηγιέται για αγορές που έχει ήδη τακτοποιήσει ή που
// έγιναν πριν την έναρξη του συστήματος. Ίδια λογική με my.js / elorus-push.js.
function athOffMin(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Athens", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000;
}
function fixDsTime(iso) { try { const w = new Date(iso); return new Date(w.getTime() - athOffMin(w) * 60000).toISOString(); } catch (e) { return iso; } }
function dedupCharges(rows) {
  rows = (rows || []).filter((r) => String(r && r.status) !== "VOID_JULY"); // μηδενισμένες Ιουλίου → εκτός
  const norm = (id) => String(id || "").replace(/^AUTH-/, "");
  const isDup = (m) => /Viva Wallet Card/i.test(m || "");
  rows = (rows || []).map((c) => isDup(c.merchant) ? { ...c, occurred_at: fixDsTime(c.occurred_at) } : { ...c });
  const byId = new Map();
  for (const c of rows) {
    const k = norm(c.viva_tx_id); const ex = byId.get(k);
    if (!ex) { byId.set(k, { ...c }); continue; }
    const m = { ...ex };
    if (isDup(m.merchant) && !isDup(c.merchant)) m.merchant = c.merchant;
    if (String(c.occurred_at || "") < String(m.occurred_at || "")) m.occurred_at = c.occurred_at;
    if (c.has_receipt) { m.has_receipt = true; m.receipt_url = c.receipt_url || m.receipt_url; }
    if (c.project) m.project = c.project;
    if (c.raw && (c.raw.rem || c.raw.invoice)) m.raw = Object.assign({}, m.raw || {}, c.raw);
    if (String(c.status) !== "PENDING_CLEAR") m.status = c.status;
    byId.set(k, m);
  }
  const list = [...byId.values()];
  const reals = list.filter((c) => !isDup(c.merchant));
  const dups = list.filter((c) => isDup(c.merchant)).sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || "")));
  const pool = {}; for (const r of reals) { const k = Math.abs(+r.amount).toFixed(2); (pool[k] = pool[k] || []).push(r); }
  const used = new Set(); const kept = [];
  for (const s of dups) {
    const k = Math.abs(+s.amount).toFixed(2);
    const cand = (pool[k] || []).filter((r) => !used.has(r) && String(r.occurred_at || "") <= String(s.occurred_at || "") && (Date.parse(s.occurred_at) - Date.parse(r.occurred_at)) <= 7 * 864e5).sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")));
    const r = cand[0];
    if (r) {
      used.add(r);
      if (s.has_receipt && !r.has_receipt) { r.has_receipt = true; r.receipt_url = s.receipt_url; }
      if (s.project && !r.project) r.project = s.project;
      if (r.status === "PENDING_CLEAR") r.status = (r.has_receipt && r.project) ? "COMPLETE" : "MISSING_ALL";
    } else kept.push(s);
  }
  // 3) [fix 25/9] Ζευγάρωμα ΜΟΝΟ δέσμευσης↔εκκαθάρισης της ΙΔΙΑΣ αγοράς: ίδιο ποσό, εκκαθάριση έως 6 μέρες μετά,
  //    1-προς-1, με προτίμηση ίδιου καταστήματος. (Παλιά ένωνε ΟΛΑ τα ίδια ποσά όλων των μηνών → έκρυβε
  //    μηνιαίες συνδρομές Claude/Apple/OpenAI και αγορές ίδιου ποσού.)
  const DAY = 864e5;
  const mkey = (m) => String(m || "").replace(/^.*Viva Wallet Card\s*-?\s*/i, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const isAuthRow = (c) => /^AUTH-/.test(String(c.viva_tx_id || ""));
  const orphanAuths = kept.filter(isAuthRow), orphanSettles = kept.filter((c) => !isAuthRow(c));
  const paired = new Set(), keptOut = [...orphanAuths];
  for (const s of orphanSettles) {
    const k = Math.abs(+s.amount).toFixed(2), ts = Date.parse(s.occurred_at);
    const cands = orphanAuths.filter((a) => { const d = ts - Date.parse(a.occurred_at); return !paired.has(a) && Math.abs(+a.amount).toFixed(2) === k && d >= -DAY && d <= 6 * DAY; })
      .sort((a, b) => ((mkey(b.merchant) === mkey(s.merchant)) - (mkey(a.merchant) === mkey(s.merchant))) || (Date.parse(b.occurred_at) - Date.parse(a.occurred_at)));
    const ex = cands[0];
    if (!ex) { keptOut.push(s); continue; }
    paired.add(ex);
    // Επιζεί η εγγραφή που έχει ήδη δουλειά πάνω της (Elorus/απόδειξη/project) — ώστε να μη χαθεί ο δεσμός με το Elorus.
    const score = (c) => (c.raw && c.raw.elorus_id ? 4 : 0) + (c.has_receipt ? 2 : 0) + (c.project ? 1 : 0);
    let keep = ex, drop = s;
    if (score(s) > score(ex)) { keep = s; drop = ex; keptOut[keptOut.indexOf(ex)] = s; }
    if (drop.has_receipt && !keep.has_receipt) { keep.has_receipt = true; keep.receipt_url = drop.receipt_url; }
    if (drop.project && !keep.project) keep.project = drop.project;
    if (String(keep.status) === "PENDING_CLEAR" && String(drop.status) !== "PENDING_CLEAR") keep.status = drop.status;
  }
  return [...reals, ...keptOut];
}

const BASE = "https://lgb-viva-expenses.vercel.app";
const REVIEW = process.env.REVIEW_EMAIL || "cs@viralpassion.gr";
const FROM = process.env.MAIL_FROM || "Σύστημα Εξόδων <expenses@aiwonderlab.eu>";
const EKEY = "__config_emails__";

// ── ΠΙΛΟΤΙΚΟ ──
// Όσο EMAILS_LIVE=false, ΜΟΝΟ αυτές οι κάρτες παίρνουν αληθινά email. Όλοι οι άλλοι
// συνεχίζουν να ανακατευθύνονται στον CFO με [TEST → …]. Default: Αίας Παρασκευόπουλος.
// Την 1η Αυγούστου: EMAILS_LIVE=true → φεύγουν σε όλους και το πιλοτικό παύει να έχει σημασία.
// Πριν την 1/8 στέλνουμε ΜΟΝΟ σε αυτούς. Όλοι οι υπόλοιποι: ΚΑΜΙΑ αποστολή, πουθενά.
// ΔΕΝ προωθούνται στον CFO — ο Κώστας δεν θέλει ενημερώσεις για εκκρεμότητες άλλων.
// Πιλοτική ομάδα (μέχρι 1/8): Αίας Παρασκευόπουλος (3029), Άγγελος Χρονόπουλος (5588),
// Λουκία Μπαλτζή (9600). ΜΟΝΟ αυτοί οι τρεις λαμβάνουν email — κανείς άλλος, ούτε ο CFO.
const PILOT = String(process.env.EMAILS_PILOT || "975269802823,448933314799,657494082292").split(",").map((s) => s.trim()).filter(Boolean);
// ── ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΑΝΑ ΑΤΟΜΟ ──
// Πιλοτικοί → 16/7. ΟΛΟΙ ΟΙ ΑΛΛΟΙ → 1/8/2026: πριν από αυτό δεν τους κυνηγάμε
// και δεν μετράμε εκκρεμότητες (οι Ιουλίου «σβήνουν»). Ο κανόνας ξεκινά 1/8.
const START_DATE = "2026-07-16";       // παλαιό γενικό (κρατιέται για συμβατότητα)
const GENERAL_START = "2026-08-01";
// Το «κόψιμο» Ιουλίου για μη-πιλοτικούς ισχύει ΜΟΝΟ από 1/8 κι έπειτα (όχι από τώρα).
const startFor = (w) => {
  if (todayAthens() < GENERAL_START) return START_DATE;               // πριν 1/8: όλοι από 16/7
  return PILOT.includes(String(w)) ? START_DATE : GENERAL_START;      // από 1/8: μη-πιλοτικοί καθαροί
};

// ── ΑΥΤΟΜΑΤΗ ΕΝΕΡΓΟΠΟΙΗΣΗ ──
// Την 1η Αυγούστου 2026 τα email αρχίζουν να φεύγουν σε ΟΛΟΥΣ, μόνα τους.
// Καμία ενέργεια από κανέναν, καμία μεταβλητή να αλλάξει.
// (Το EMAILS_LIVE=true παραμένει ως χειροκίνητος διακόπτης, αν χρειαστεί νωρίτερα.)
const GO_LIVE = "2026-08-01";
function todayAthens() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(new Date());
}

// ── ΚΛΙΜΑΚΩΣΗ ΥΠΕΝΘΥΜΙΣΕΩΝ ──
// 1η: 30' μετά τη χρέωση · 2η: 1 ώρα μετά την 1η · μετά: το πολύ μία τη μέρα.
// Οι συγκεντρωτικές (τέλος ημέρας/εβδομάδας/μήνα) φεύγουν πάντα, ανεξάρτητα.
const MIN = 60000;
function dueForNudge(c, now) {
  const rem = (c.raw && c.raw.rem) || { n: 0, last: null };
  const sinceCharge = now - new Date(c.occurred_at).getTime();
  const sinceLast = rem.last ? now - new Date(rem.last).getTime() : Infinity;
  if (!rem.n) return sinceCharge >= 30 * MIN;
  if (rem.n === 1) return sinceLast >= 60 * MIN;
  return sinceLast >= 20 * 60 * MIN;
}
async function markNudged(c, now) {
  const rem = (c.raw && c.raw.rem) || { n: 0, last: null };
  const raw = Object.assign({}, c.raw || {}, { rem: { n: (rem.n || 0) + 1, last: new Date(now).toISOString() } });
  await sbUpdate("charges", `id=eq.${encodeURIComponent(c.id)}`, { raw });
}
const fmt = (n) => Number(n).toLocaleString("el-GR", { minimumFractionDigits: 2 }) + "€";

async function readEmails() {
  const r = await sbSelect("charges", `viva_tx_id=eq.${EKEY}&select=raw`);
  return (r.length && r[0].raw && r[0].raw.map) ? r[0].raw.map : {};
}
async function writeEmails(map) {
  const raw = { map };
  const u = await sbUpdate("charges", `viva_tx_id=eq.${EKEY}`, { raw, status: "CONFIG" });
  if (u.ok && u.row) return;
  await sbInsert("charges", { viva_tx_id: EKEY, wallet_id: 0, amount: 0, merchant: "(config-emails)", occurred_at: new Date().toISOString(), status: "CONFIG", raw }, "viva_tx_id");
  await sbUpdate("charges", `viva_tx_id=eq.${EKEY}`, { raw, status: "CONFIG" });
}
async function resend(to, subject, html, text, fromOverride) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "λείπει RESEND_API_KEY" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromOverride || FROM, to: [to], reply_to: REVIEW, subject, html, text }),
  });
  const b = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, id: b.id, error: b.message || (b.name ? b.name : undefined) };
}

function compose(firstName, walletId, card, miss, type) {
  const link = `${BASE}/me.html?w=${walletId}&t=${personToken(walletId)}`;
  const total = miss.reduce((s, c) => s + Math.abs(+c.amount), 0);
  // ── ΠΩΣ ΣΤΟΙΒΑΖΕΤΑΙ ΤΟ ΥΠΟΛΟΙΠΟ (σήμερα / εβδομάδα / μήνας) ──────────────
  // Δείχνει τον όγκο που «τρέχει»: όσο μένουν ατακτοποίητες, το σύνολο μεγαλώνει.
  const athDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const nowT = Date.now();
  const todayStr = athDay(nowT);
  const sumIf = (fn) => miss.filter(fn).reduce((s, c) => s + Math.abs(+c.amount), 0);
  const nIf = (fn) => miss.filter(fn).length;
  const dayS = sumIf((c) => athDay(c.occurred_at) === todayStr);
  const dayN = nIf((c) => athDay(c.occurred_at) === todayStr);
  const wkS = sumIf((c) => (nowT - new Date(c.occurred_at).getTime()) <= 7 * 24 * 3600e3);
  const wkN = nIf((c) => (nowT - new Date(c.occurred_at).getTime()) <= 7 * 24 * 3600e3);
  // κελί «κλίμακας»: γεμίζει όσο ανεβαίνει το ποσό — οπτικά δείχνει την αύξηση
  const growCell = (lbl, n, s, hi) => `<td style="padding:10px 8px;text-align:center;border-radius:9px;background:${hi ? "#fdeef0" : "#f4f6fb"};border:1px solid ${hi ? "#f2c4cb" : "#e2e6ef"}">
      <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.3px">${lbl}</div>
      <div style="font-size:18px;font-weight:800;color:${hi ? "#b3260a" : "#2647c4"};margin-top:3px">${fmt(s)}</div>
      <div style="font-size:11px;color:#8a92a8;margin-top:2px">${n} ${n === 1 ? "χρέωση" : "χρεώσεις"}</div></td>`;
  const growBox = `<div style="margin:0 0 12px">
    <div style="font-size:13px;font-weight:700;color:#2a3157;margin:0 0 7px">📈 Πώς μεγαλώνει το υπόλοιπό σου — όσο περνά ο καιρός, στοιβάζεται:</div>
    <table style="border-collapse:separate;border-spacing:7px 0;width:100%"><tr>
      ${growCell("Σήμερα", dayN, dayS, false)}
      ${growCell("Τελευτ. 7 ημέρες", wkN, wkS, false)}
      ${growCell("Σύνολο μήνα", miss.length, total, true)}
    </tr></table></div>`;
  const rows = miss.map((c) => {
    const d = new Date(c.occurred_at);
    const dd = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const w = !c.has_receipt && !c.project ? "λείπουν όλα" : !c.has_receipt ? "χωρίς απόδειξη" : "χωρίς project";
    return `<tr><td style="padding:6px 10px">${dd}</td><td style="padding:6px 10px"><b>${c.merchant || ""}</b></td><td style="padding:6px 10px;text-align:right">${fmt(Math.abs(+c.amount))}</td><td style="padding:6px 10px;color:#c0392b">${w}</td></tr>`;
  }).join("");
  const subject = type === "MONTH_END"
    ? `🔴 Ο μήνας κλείνει — εκκρεμότητες ${fmt(total)}`
    : `⏰ ${firstName}, λείπουν ${miss.length} αποδείξεις/project (${fmt(total)})`;
  const nLbl = miss.length === 1 ? "1 χρέωση" : `${miss.length} χρεώσεις`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1a1a2e">
    <h2 style="font-size:17px">${firstName}, έχεις ${miss.length} χρεώσεις που θέλουν τακτοποίηση:</h2>
    <div style="display:flex;gap:10px;background:#eef1ff;border:1px solid #c9d0f5;border-radius:10px;padding:12px 16px;margin:0 0 12px;align-items:center;justify-content:space-between">
      <span style="font-size:14px;color:#2a3157">📊 <b>${nLbl}</b> σε εκκρεμότητα</span>
      <span style="font-size:20px;font-weight:800;color:#2647c4">σύνολο ${fmt(total)}</span>
    </div>
    ${growBox}
    <table style="border-collapse:collapse;width:100%;background:#f8f9fb;border-radius:8px">${rows}
      <tr style="border-top:2px solid #d5d9e6"><td colspan="2" style="padding:8px 10px;font-weight:700">Σύνολο (${miss.length})</td><td style="padding:8px 10px;text-align:right;font-weight:800;color:#2647c4">${fmt(total)}</td><td></td></tr>
    </table>
    <div style="background:#fffbea;border:1px solid #f6d55c;border-radius:8px;padding:10px 12px;margin:12px 0;font:13px Arial;color:#5f4b00">📸 Η φωτογραφία να είναι καθαρή: ολόκληρη η απόδειξη, ίσια, να διαβάζεται το ποσό. Όχι θολή, όχι κομμένη. Αν είναι ξεθωριασμένη, γράψε πάνω της με στυλό το ποσό.</div>
    <p><a href="${link}" style="background:#4f46e5;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Άνοιξε τη σελίδα σου ➜</a></p>
    <p style="color:#555;font-size:13px">Μπες, ανέβασε φωτ. απόδειξης + διάλεξε project. Ό,τι μείνει χωρίς απόδειξη στο τέλος του μήνα, συμψηφίζεται με την αμοιβή σου από τα βίντεο (επιστρέφεται αν προσκομιστεί μετά).</p>
    <p style="font-size:11px;color:#999">Αυτόματο μήνυμα — Σύστημα Εξόδων, Let's Go Bananas.</p></div>`;
  const text = `${firstName}, λείπουν ${miss.length} πράγματα (σύνολο ${fmt(total)}).\nΆνοιξε τη σελίδα σου: ${link}\nΑνέβασε φωτ. απόδειξης + διάλεξε project.`;
  return { subject, html, text };
}

// Καλωσόρισμα / ενημέρωση (onboarding) — μίνι brief + προσωπικό link
function welcomeEmail(firstName, walletId, card) {
  const link = `${BASE}/me.html?w=${walletId}&t=${personToken(walletId)}`;
  const subject = `👋 Καλωσήρθες στο Σύστημα Εξόδων — το προσωπικό σου link`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:580px;margin:auto;color:#1a1a2e">
    <h2 style="font-size:19px;margin:0 0 6px">Καλησπέρα ${firstName}! 🍌</h2>
    <p style="font-size:14px;line-height:1.5">Από εδώ και πέρα, τα έξοδα με την <b>εταιρική σου κάρτα Viva</b> (•••• ${card}) τα διαχειριζόμαστε όλα από μία πλατφόρμα. Αυτό είναι το <b>δικό σου προσωπικό link</b> — ανοίγει κατευθείαν στο όνομά σου.</p>
    <div style="background:#f6f7fb;border:1px solid #e6e8f0;border-radius:12px;padding:14px 16px;margin:14px 0">
      <b style="font-size:14px">Τι κάνεις κάθε φορά που χρεώνεσαι με την κάρτα:</b>
      <ol style="margin:8px 0 0;padding-left:18px;font-size:13.5px;line-height:1.6">
        <li>Μπες στο προσωπικό σου link (πιο κάτω).</li>
        <li>Βρες τη χρέωση — φαίνεται αυτόματα.</li>
        <li>Ανέβασε <b>φωτογραφία της απόδειξης</b> 📷 και διάλεξε το <b>project</b>. Τέλος.</li>
      </ol>
    </div>
    <div style="background:#fffbea;border:1px solid #f6d55c;border-radius:10px;padding:11px 13px;margin:12px 0;font-size:13px;color:#5f4b00">
      📸 Η φωτογραφία να είναι <b>καθαρή &amp; ολόκληρη</b>, ίσια, να διαβάζεται <b>το ποσό</b>. Όχι θολή/κομμένη. Αν είναι ξεθωριασμένη, γράψε πάνω της με στυλό το ποσό.
    </div>
    <p style="text-align:center;margin:18px 0"><a href="${link}" style="background:#4f46e5;color:#fff;padding:14px 26px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px">Άνοιξε τη σελίδα σου ➜</a></p>
    <p style="font-size:12.5px;color:#555;line-height:1.5">📱 Ανοίγει από <b>κινητό &amp; υπολογιστή</b>. Στο κινητό, κράτησέ το στην αρχική οθόνη για να το έχεις πρόχειρο. Το link είναι προσωπικό — μη το μοιράζεσαι.</p>
    <p style="font-size:12.5px;color:#555;line-height:1.5">Ό,τι μείνει χωρίς απόδειξη στο τέλος του μήνα, συμψηφίζεται με την αμοιβή σου από τα βίντεο (επιστρέφεται αν την ανεβάσεις αργότερα). <b>Ξεκινάμε από 1η Αυγούστου.</b></p>
    <p style="font-size:11px;color:#999">Σύστημα Εξόδων — Let's Go Bananas. Για απορίες, απάντησε σε αυτό το email.</p></div>`;
  const text = `Καλησπέρα ${firstName}! Από εδώ και πέρα τα έξοδα της εταιρικής σου κάρτας (••••${card}) τα διαχειριζόμαστε από μία πλατφόρμα.\n\nΤο προσωπικό σου link: ${link}\n\nΚάθε φορά που χρεώνεσαι: μπες, βρες τη χρέωση, ανέβασε φωτ. απόδειξης + διάλεξε project. Καθαρή & ολόκληρη φωτο, να φαίνεται το ποσό. Ανοίγει από κινητό & υπολογιστή. Ξεκινάμε 1η Αυγούστου.`;
  return { subject, html, text };
}

// ── ΗΜΕΡΗΣΙΑ ΑΝΑΦΟΡΑ ΣΤΟΝ ΚΩΣΤΑ (μία φορά, στο τέλος της ημέρας) ──
// Στέλνεται ΜΟΝΟ αν υπάρχει κάτι να πει. Αν όλα είναι καθαρά, δεν φεύγει τίποτα.
// weekly=true → εβδομαδιαία εικόνα με τις εκκρεμότητες όλων (ενημερωτικό).
// weekly=false → καθημερινό, φεύγει ΜΟΝΟ αν υπάρχει κάτι που θέλει τον Κώστα.
async function sendCfoDigest(weekly) {
  try {
    const w = "975269802823";
    const r = await fetch(`${BASE}/api/elorus-push?report=1&w=${w}&t=${personToken(w)}`);
    if (!r.ok) return { ok: false, error: `report ${r.status}` };
    const d = await r.json();
    const prob = d.problems || [], reg = d.registered || [];
    // Καθημερινά ΔΕΝ στέλνουμε τις εκκρεμότητες των υπαλλήλων — δεν μπορεί να κάνει κάτι.
    const pend = weekly ? (d.pending || []) : [];
    if (!prob.length && !pend.length) return { ok: true, skipped: "τίποτα που να θέλει τον Κώστα — δεν στάλθηκε" };

    const row = (p, color) => `<tr><td style="padding:6px 10px;white-space:nowrap">${p.date}</td><td style="padding:6px 10px"><b>${p.who}</b></td><td style="padding:6px 10px">${p.store}</td><td style="padding:6px 10px;text-align:right;white-space:nowrap">${fmt(p.amount)}</td><td style="padding:6px 10px;color:${color};font-size:12.5px">${p.reason}</td></tr>`;

    const subject = prob.length
      ? `🍌 LGB — ${prob.length} ${prob.length === 1 ? "θέλει" : "θέλουν"} ενέργεια από σένα`
      : `🍌 LGB — εβδομαδιαία εικόνα: ${pend.length} εκκρεμότητες`;

    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a1a2e">
      <h2 style="font-size:18px;margin:0 0 4px">Έξοδα LGB — ημερήσια εικόνα</h2>
      <p style="color:#666;font-size:13px;margin:0 0 14px">${new Intl.DateTimeFormat("el-GR",{timeZone:"Europe/Athens",dateStyle:"full"}).format(new Date())}</p>
      <p style="font-size:14px">✅ <b>${reg.length}</b> καταχωρημένα στο Elorus &nbsp;·&nbsp; ⏳ <b>${pend.length}</b> εκκρεμούν</p>
      ${prob.length ? `<div style="background:#fff4f4;border:1px solid #f5b5b5;border-radius:10px;padding:12px 14px;margin:14px 0">
        <b style="color:#b02020;font-size:14px">⚠️ Θέλουν δική σου ενέργεια (${prob.length})</b>
        <table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:13px">${prob.map((p)=>row(p,"#b02020")).join("")}</table>
        <p style="font-size:12.5px;color:#7a3a3a;margin:10px 0 0">Για προμηθευτή που λείπει: Elorus → Επαφές → Προσθήκη → βάλε το <b>ΑΦΜ</b> και τραβάει μόνο του τα στοιχεία από το ΑΑΔΕ.</p>
      </div>` : ""}
      ${pend.length ? `<b style="font-size:14px">⏳ Εκκρεμότητες υπαλλήλων (ενημερωτικά)</b>
      <table style="border-collapse:collapse;width:100%;background:#f8f9fb;border-radius:8px;margin-top:8px;font-size:13px">${pend.map((p)=>row(p,"#c0392b")).join("")}</table>
      <p style="font-size:12.5px;color:#666;margin:10px 0 0"><b>Δεν χρειάζεται να κάνεις τίποτα.</b> Τα κυνηγούν τα αυτόματα email στους ίδιους. Στο στέλνω μία φορά την εβδομάδα για να ξέρεις ποιος καθυστερεί.</p>` : ""}
      <p style="font-size:11px;color:#999;margin-top:18px">Αυτόματη αναφορά — Σύστημα Εξόδων LGB. Φεύγει μόνο όταν υπάρχει κάτι να πει.</p></div>`;

    const text = d.text || "";
    const s = await resend(REVIEW, subject, html, text);
    return { ok: s.ok, to: REVIEW, pending: pend.length, problems: prob.length, err: s.error };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
    body = body || {};
    const action = String(q.action || (body && body.action) || "").toLowerCase();
    // Ζωντανό είτε χειροκίνητα (EMAILS_LIVE=true) είτε ΑΥΤΟΜΑΤΑ από 1/8/2026 και μετά.
    const LIVE = process.env.EMAILS_LIVE === "true" || todayAthens() >= GO_LIVE;

    // ── ΑΣΦΑΛΕΙΑ ──
    // Χωρίς αυτό, οποιοσδήποτε γνώριζε το URL μπορούσε να στείλει email σε 13 υπαλλήλους.
    // Επιτρέπεται μόνο: Vercel cron, ή έγκυρο προσωπικό token, ή EMAILS_SECRET.
    const isCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
    const aw = String(body.w || q.w || ""), at = String(body.t || q.t || "");
    const hasSecret = process.env.EMAILS_SECRET && String(q.secret || body.secret || "") === String(process.env.EMAILS_SECRET);
    if (!isCron && !hasSecret && !(aw && verifyToken(aw, at))) {
      return res.status(403).json({ error: "Μη εξουσιοδοτημένο" });
    }

    // ── ΔΙΑΓΝΩΣΤΙΚΟ (δεν στέλνει τίποτα) ──
    // Λέει αν είναι όλα έτοιμα για να ξεκινήσουν τα email.
    if (action === "status") {
      const emails = await readEmails();
      const people = Object.keys(emails);
      const withAddr = people.filter((w) => (emails[w].emails || []).length);
      const mask = (e) => String(e).replace(/^(.).*(@.*)$/, "$1•••$2");
      return res.status(200).json({
        ok: true,
        έτοιμο_για_αποστολή: !!(process.env.RESEND_API_KEY && withAddr.length),
        RESEND_API_KEY: !!process.env.RESEND_API_KEY,
        MAIL_FROM: FROM,
        ζωντανό_σε_όλους: LIVE,
        αυτόματη_ενεργοποίηση: GO_LIVE,
        σήμερα: todayAthens(),
        μέρες_μέχρι_την_έναρξη: Math.max(0, Math.round((new Date(GO_LIVE) - new Date(todayAthens())) / 86400000)),
        παίρνουν_αληθινό_email_τώρα: LIVE ? "(όλοι)" : PILOT,
        άτομα_στη_βάση: people.length,
        άτομα_με_email: withAddr.length,
        λίστα: people.map((w) => ({
          wallet: w,
          όνομα: emails[w].name || emails[w].firstName || "",
          κάρτα: emails[w].card || "",
          emails: (emails[w].emails || []).map(mask),
        })),
      });
    }

    if (action === "seed-emails") {
      const map = (body && body.map) || {};
      await writeEmails(map);
      return res.status(200).json({ ok: true, seeded: Object.keys(map).length });
    }

    // ── ΕΙΔΟΠΟΙΗΣΗ ΚΩΣΤΑ ΜΟΝΟ ΓΙΑ ΠΡΑΓΜΑΤΙΚΟ, ΑΛΥΤΟ ΠΡΟΒΛΗΜΑ ──────────────
    // Ο Θέμης καλεί αυτό ΜΟΝΟ όταν κάτι χρειάζεται ανθρώπινη απόφαση/ενέργεια και
    // δεν λύνεται μόνο του. Πάει κατευθείαν στον Κώστα (REVIEW). Καμία άλλη περίπτωση.
    if (action === "alert" || action === "note") {
      const subject = String(q.subject || (body && body.subject) || "Θέμης");
      const msg = String(q.msg || (body && body.msg) || "");
      const info = action === "note" || String(q.tone || "").toLowerCase() === "info";
      const head = info
        ? `<h2 style="font-size:17px;color:#0f766e">🍌 Θέμης — εβδομαδιαία ενημέρωση</h2>`
        : `<h2 style="font-size:17px;color:#b3260a">⚠️ Θέμης — πραγματικό θέμα που δεν λύθηκε αυτόματα</h2>`;
      const boxCol = info ? "#e6f6ec;border:1px solid #86d3a2" : "#fdeef0;border:1px solid #f2c4cb";
      const foot = info
        ? `Αυτόματη σύνοψη — τα έξοδα καταχωρούνται μόνα τους. Θα σου γράψω μόνο αν προκύψει κάτι που θέλει εσένα.`
        : `Έλαβες αυτό γιατί χρειάζεται δική σου ενέργεια — τα υπόλοιπα ο Θέμης τα διαχειρίζεται μόνος του.`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1a1a2e">
        ${head}
        <div style="background:${boxCol};border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.6;white-space:pre-wrap">${msg.replace(/</g, "&lt;")}</div>
        <p style="color:#555;font-size:13px;margin-top:14px">${foot}</p>
        <p style="font-size:11px;color:#999">Αυτόματο μήνυμα — Θέμης, Σύστημα Εξόδων LGB.</p></div>`;
      const r = await resend(REVIEW, (info ? "🍌 " : "🔴 ") + subject, html, msg);
      return res.status(200).json({ ok: r.ok, to: REVIEW, sent: r.ok, resend: r });
    }

    if (action === "test") {
      const to = q.to || (body && body.to) || REVIEW;
      const s = compose("Κώστα", "566240519800", "1288", [
        { occurred_at: new Date().toISOString(), merchant: "Wolt", amount: -18.4, has_receipt: false, project: null },
        { occurred_at: new Date().toISOString(), merchant: "efood", amount: -24.9, has_receipt: true, project: null },
      ], "INSTANT");
      const r = await resend(to, "[ΔΕΙΓΜΑ] " + s.subject, s.html, s.text, q.from);
      return res.status(200).json({ ok: r.ok, to, from: q.from || FROM, resend: r });
    }

    // Δείγμα welcome σε ΕΝΑ email (για προεπισκόπηση)
    if (action === "welcome") {
      const to = q.to || REVIEW;
      const w = String(q.w || "566240519800");
      const emails = await readEmails();
      const info = emails[w] || { firstName: "Κώστα", name: "Κώστας Κρυωνάς", card: "1288" };
      const e = welcomeEmail(info.firstName || info.name, w, info.card || "");
      const r = await resend(to, "[ΔΕΙΓΜΑ] " + e.subject, e.html, e.text, q.from);
      return res.status(200).json({ ok: r.ok, to, resend: r });
    }

    // Αποστολή welcome σε ΟΛΟΥΣ (13 εταιρικά email) — ΤΟ ΤΡΕΧΟΥΜΕ ΣΤΟ MEETING
    if (action === "welcome-all") {
      const emails = await readEmails();
      const results = [];
      for (const w of Object.keys(emails)) {
        const info = emails[w];
        const e = welcomeEmail(info.firstName || info.name, w, info.card || "");
        for (const to of (info.emails || [])) {
          // Ίδια δικλείδα με τις υπενθυμίσεις: χωρίς EMAILS_LIVE=true πάει στον CFO για έλεγχο.
          let subject = e.subject, actualTo = to;
          if (!LIVE) { subject = "[TEST → " + to + "] " + e.subject; actualTo = REVIEW; }
          const r = await resend(actualTo, subject, e.html, e.text);
          results.push({ person: info.name, to: actualTo, live: LIVE, ok: r.ok, err: r.error });
        }
      }
      return res.status(200).json({ ok: true, live: LIVE, people: Object.keys(emails).length, sent: results.length, results });
    }

    // Ημερήσια αναφορά στον Κώστα — χειροκίνητα (για δοκιμή)
    if (action === "cfo") {
      const r = await sendCfoDigest(String(q.weekly || "") === "1");
      return res.status(200).json(r);
    }

    if (action === "run") {
      let type = String(q.type || "INSTANT").toUpperCase();
      // type=auto → αποφασίζει μόνο του βάσει ημερομηνίας (τοπική ώρα Ελλάδας)
      if (type === "AUTO") {
        const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Athens" }));
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        if (now.getDate() === lastDay) type = "MONTH_END";   // ΤΕΛΕΥΤΑΙΑ μέρα του μήνα (όποια μέρα κι αν είναι, ακόμα & Κυριακή)
        else if (now.getDay() === 5) type = "WEEKLY";         // Παρασκευή
        else type = "EOD";                                    // καθημερινό συγκεντρωτικό
      }
      const emails = await readEmails();
      const ym = new Date().toISOString().slice(0, 7);
      const rows = await sbSelect("charges", `select=*&order=occurred_at.desc&limit=1000`);
      // ΣΕΙΡΑ ΠΟΥ ΜΕΤΡΑΕΙ: πρώτα ομαδοποίηση ανά κάρτα → μετά ξεδίπλωμα διπλοεγγραφών
      // → και ΜΟΝΟ ΤΟΤΕ φιλτράρισμα μήνα/έναρξης/ολοκληρωμένων. Αν φιλτράρουμε πριν το
      // dedup, οι εκκαθαρίσεις παλιών αγορών μοιάζουν με νέες εκκρεμότητες.
      const rawByW = {};
      (rows || []).forEach((c) => {
        const w = String(c.wallet_id); if (!emails[w]) return;
        (rawByW[w] = rawByW[w] || []).push(c);
      });
      const byW = {};
      for (const w of Object.keys(rawByW)) {
        const startD = startFor(w); // πιλοτικός → 16/7, αλλιώς → 1/8 (Ιουλίου «σβήνουν»)
        for (const c of dedupCharges(rawByW[w])) {
          if (String(c.occurred_at || "").slice(0, 7) !== ym) continue;
          if (String(c.occurred_at || "").slice(0, 10) < startD) continue; // όχι πριν την έναρξη του ατόμου
          const done = (c.has_receipt && c.project) || c.status === "APPROVED_LOSS" || c.status === "INTERNAL";
          if (done) continue;
          (byW[w] = byW[w] || []).push(c);
        }
      }
      const results = [];
      const now = Date.now();
      for (const w of Object.keys(byW)) {
        const info = emails[w];
        let charges = byW[w];

        // INSTANT = η κλιμάκωση (30' → 1ώρα → max 1/ημέρα). Οι συγκεντρωτικές φεύγουν πάντα.
        if (type === "INSTANT") {
          charges = charges.filter((c) => dueForNudge(c, now));
          if (!charges.length) { results.push({ person: info.name, skipped: "δεν ήρθε η ώρα" }); continue; }
        }

        // Πριν την 1/8: στέλνουμε ΜΟΝΟ στους PILOT. Οι υπόλοιποι ΑΓΝΟΟΥΝΤΑΙ τελείως —
        // κανένα email, ούτε στον υπάλληλο ούτε στον CFO.
        const goesLive = LIVE || PILOT.includes(String(w));
        if (!goesLive) { results.push({ person: info.name, skipped: "εκτός πιλοτικού — καμία αποστολή" }); continue; }
        const c = compose(info.firstName || info.name || "", w, info.card || "", charges, type);
        for (const to of (info.emails || [])) {
          const r = await resend(to, c.subject, c.html, c.text);
          results.push({ person: info.name, to, live: true, charges: charges.length, ok: r.ok, err: r.error });
        }
        if (type === "INSTANT") for (const ch of charges) await markNudged(ch, now);
      }
      // Στο ημερήσιο τρέξιμο (όχι στις γρήγορες υπενθυμίσεις) στέλνουμε ΚΑΙ την αναφορά στον Κώστα.
      // Καθημερινά: μόνο αν κάτι θέλει τον Κώστα. Παρασκευή/τέλος μήνα: + εικόνα εκκρεμοτήτων.
      const cfo = type !== "INSTANT" ? await sendCfoDigest(type === "WEEKLY" || type === "MONTH_END") : null;
      return res.status(200).json({ ok: true, live: LIVE, pilot: LIVE ? [] : PILOT, type, people: Object.keys(byW).length, sent: results.length, cfoDigest: cfo, results });
    }

    return res.status(400).json({ error: "άγνωστο action (seed-emails | test | run)" });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }
};
