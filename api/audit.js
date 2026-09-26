// ΑΝΕΞΑΡΤΗΤΟΣ ΕΛΕΓΚΤΗΣ («δεύτερο μάτι»). Για ΚΑΘΕ κάρτα τραβά την αλήθεια απευθείας από τη Viva
// (authorizations = τα χτυπήματα) και τη συγκρίνει με ό,τι ΔΕΙΧΝΕΙ η πλατφόρμα (μετά το dedup).
// Πιάνει: διπλές χρεώσεις/συνδρομές, λάθος ποσά, φαντάσματα, λάθος/μελλοντικές ώρες.
// GET /api/audit  → { ok, generatedAt, totalIssues, people:[{wallet,name,ours,viva,issues:[...]}] }
const { wallets, sbSelect, sbSelectAll, isAdmin } = require("./_viva.js");

const START_DATE = "2026-07-16";
const EXCLUDED = new Set(["901067108914"]);
const NAMES = {
  "448933314799": "Άγγελος Χρονόπουλος", "324887741089": "Ανδρέας Κολυγλιάτης", "566240519800": "Κώστας Κρυωνάς",
  "282541651501": "Ιωάννα Σκούρα", "657494082292": "Λουκία Μπαλτζή", "910827445981": "Άντα Μπαϊρακτάρη",
  "975269802823": "Αίας Παρασκευόπουλος", "405838582045": "Ζωή Ηγουμενίδη", "389933252655": "Μαριλού Θηβαίου",
  "968554634120": "Μαριλένα Σιταροπούλου", "577335556525": "Αναστασία Κοβάνη", "990263759336": "Δήμητρα Λάκη",
  "243763678466": "Ντόριαν Γκουτζέλας",
};

// --- διόρθωση ώρας cron (ώρα Αθήνας σφραγισμένη ως UTC) ---
function athOffMin(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Athens", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000;
}
function fixDsTime(iso) { try { const w = new Date(iso); return new Date(w.getTime() - athOffMin(w) * 60000).toISOString(); } catch (e) { return iso; } }
function athDate(iso) { try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(new Date(iso)); } catch (e) { return ""; } }

// --- ίδιο dedup με την εμφάνιση (για να ελέγχουμε ΑΚΡΙΒΩΣ ό,τι βλέπει ο χρήστης) ---
// [25/9] Ενιαίο ξεδίπλωμα για όλη την εφαρμογή → βλ. api/_dedup.js
const { dedupCharges, HIDDEN_BEFORE_FIX } = require("./_dedup.js");

async function dsToken() {
  const id = process.env.VIVA_DS_CLIENT_ID, sec = process.env.VIVA_DS_SECRET;
  if (!id || !sec) throw new Error("Λείπουν VIVA_DS keys");
  const basic = Buffer.from(`${id}:${sec}`).toString("base64");
  const r = await fetch("https://accounts.vivapayments.com/connect/token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  if (!r.ok) throw new Error(`DS token ${r.status}`);
  return (await r.json()).access_token;
}
async function dsPage(token, page) {
  const r = await fetch(`https://api.vivapayments.com/dataservices/v2/accounttransactions/Search?dateFrom=2026-01-01T00:00:00&dateTo=2030-01-01T00:00:00&page=${page}&pageSize=500`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`DS ${r.status}`);
  return (await r.json()).data || [];
}

// [25/9] Κινήσεις Viva από συγκεκριμένη ημερομηνία (όλες οι σελίδες) — για τον έλεγχο «λείπει από την εφαρμογή».
async function dsSince(token, since) {
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const r = await fetch(`https://api.vivapayments.com/dataservices/v2/accounttransactions/Search?dateFrom=${since}&dateTo=2030-01-01T00:00:00&page=${p}&pageSize=500`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error(`DS ${r.status}`);
    const pg = (await r.json()).data || []; out.push(...pg.filter((x) => String(x.created || "") >= since));
    if (pg.length < 500 || pg.some((x) => String(x.created || "") < since)) break; // η Viva αγνοεί το dateFrom
  }
  return out;
}
const KNOWN_HIDDEN = HIDDEN_BEFORE_FIX;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store"); if (!isAdmin(req)) return res.status(403).json({ error: "Μόνο για διαχειριστή" });
  try {
    const ws = await wallets();
    const members = (Array.isArray(ws) ? ws : []).filter((w) => w.hasIssuedCard && !w.isPrimary && w.friendlyName && w.friendlyName !== "ακυρο" && !EXCLUDED.has(String(w.walletId))).map((w) => String(w.walletId));
    const mset = new Set(members);

    // 1) ΑΛΗΘΕΙΑ ΑΠΟ VIVA: authorizations (τα χτυπήματα) ανά κάρτα, από START_DATE
    const token = await dsToken();
    const dsRows = [...await dsPage(token, 1), ...await dsPage(token, 2)];
    const vivaAmts = {}; // wallet -> {amountKey: count}
    const vivaTimes = {}; // wallet -> [{amt, t}]
    for (const x of dsRows) {
      const w = String(x.walletId); if (!mset.has(w)) continue;
      const amt = Number(x.amount); if (!(amt < 0)) continue;
      const isAuth = x.isAuthorization || x.subTypeId === 101;
      if (!isAuth) continue; // η authorization = το χτύπημα (μοναδικό ανά αγορά)
      const t = fixDsTime(x.created);
      if (athDate(t) < START_DATE) continue;
      const k = Math.abs(amt).toFixed(2);
      (vivaAmts[w] = vivaAmts[w] || {})[k] = (vivaAmts[w]?.[k] || 0) + 1;
      (vivaTimes[w] = vivaTimes[w] || []).push({ amt: k, t });
    }

    // 1β) [25/9] Όλες οι αγορές/δεσμεύσεις των τελευταίων 21 ημερών — για τον έλεγχο MISSING
    const MISS_DAYS = Math.min(60, Math.max(3, Number((req.query || {}).days) || 21));
    const dsRecent = await dsSince(token, new Date(Date.now() - MISS_DAYS * 864e5).toISOString().slice(0, 19));

    // 2) ΤΙ ΔΕΙΧΝΟΥΜΕ: οι χρεώσεις μας μετά το dedup, ανά κάρτα
    const now = Date.now();
    const people = [];
    let totalIssues = 0;
    for (const w of members) {
      const raw = await sbSelectAll("charges", `wallet_id=eq.${w}&order=occurred_at.desc,id.desc`);
      const ours = dedupCharges(raw || []).filter((c) => athDate(c.occurred_at) >= START_DATE);
      const issues = [];
      const ourAmts = {};
      for (const c of ours) { const k = Math.abs(+c.amount).toFixed(2); ourAmts[k] = (ourAmts[k] || 0) + 1; if (c.hold_amount) { const h = Math.abs(+c.hold_amount).toFixed(2); ourAmts[h] = (ourAmts[h] || 0) + 1; } }
      const vAmts = vivaAmts[w] || {};
      // διπλά / φαντάσματα: εμφανίζουμε ένα ποσό πιο πολλές φορές απ' όσο το χτύπησε η Viva
      for (const k of Object.keys(ourAmts)) {
        const oc = ourAmts[k], vc = vAmts[k] || 0;
        if (vc === 0) issues.push({ type: "PHANTOM", amount: +k, detail: `Ποσό ${k}€ εμφανίζεται αλλά ΔΕΝ υπάρχει στη Viva` });
        else if (oc > vc) issues.push({ type: "DUPLICATE", amount: +k, detail: `Ποσό ${k}€ εμφανίζεται ${oc}× ενώ η Viva έχει ${vc}` });
      }
      // λάθος/μελλοντικές ώρες: κάθε χρέωση να ταιριάζει με χτύπημα Viva ίδιου ποσού (±15')
      for (const c of ours) {
        const oc = new Date(c.occurred_at).getTime();
        if (oc > now + 5 * 60000) { issues.push({ type: "FUTURE_TIME", amount: +Math.abs(+c.amount).toFixed(2), detail: `Ώρα στο μέλλον: ${c.occurred_at}` }); continue; }
        const k = Math.abs(+c.amount).toFixed(2);
        const cands = (vivaTimes[w] || []).filter((v) => v.amt === k);
        if (cands.length) {
          // Η Viva μπερδεύει UTC/ώρα-Αθήνας ανά τύπο εγγραφής, άρα απόκλιση ~0 ή ~ακέραιο ζώνης (60/120/180') = ΘΟΡΥΒΟΣ, όχι λάθος.
          const best = Math.min(...cands.map((v) => Math.abs(new Date(v.t).getTime() - oc))) / 60000;
          const dev = Math.min(best, Math.abs(best - 60), Math.abs(best - 120), Math.abs(best - 180));
          if (dev > 20) issues.push({ type: "WRONG_TIME", amount: +k, detail: `Ώρα αποκλίνει ${Math.round(best)}' από τη Viva (πέρα από ζώνη)` });
        }
      }
      // [25/9] MISSING: αγορά που ΥΠΑΡΧΕΙ στη Viva αλλά ΔΕΝ φαίνεται στον υπάλληλο (ούτε σε βάση, ούτε κρυμμένη).
      //   Ταίριασμα: ίδιο ποσό, ±4 μέρες, με οποιαδήποτε ορατή χρέωση. Μία αναφορά ανά αγορά (δέσμευση+εκκαθάριση = 1).
      {
        const seenKeys = new Set();
        const hiddenGroups = dedupCharges(raw || [], { onlyHidden: true });
        const cutoff = Date.now() - 30 * 60000; // αγνόησε τα τελευταία 30′ (ο sync δεν έχει προλάβει)
        for (const x of dsRecent) {
          if (String(x.walletId) !== w) continue;
          const a = Number(x.amount); if (!(a < 0)) continue;
          const isBuy = x.subTypeId === 100 || x.subTypeId === 104 || x.isAuthorization || x.subTypeId === 101;
          if (!isBuy) continue;
          const t = Date.parse(fixDsTime(x.created)); if (!(t < cutoff)) continue;
          const k = Math.abs(a).toFixed(2);
          const near = (c) => (Math.abs(+c.amount).toFixed(2) === k || (c.hold_amount && Math.abs(+c.hold_amount).toFixed(2) === k)) && Math.abs(Date.parse(c.occurred_at) - t) <= 4 * 864e5;
          if (ours.some(near)) continue;
          const txid = String(x.accountTransactionId || "");
          const inDb = (raw || []).filter((c) => String(c.viva_tx_id || "").replace(/^AUTH-/, "") === txid);
          if (inDb.some((c) => KNOWN_HIDDEN.has(Number(c.id)) || String(c.status) === "VOID_JULY")) continue;
          if ((raw || []).some((c) => KNOWN_HIDDEN.has(Number(c.id)) && near(c))) continue;
          if (hiddenGroups.some(near)) continue; // ανήκει σε ομάδα που κρύψαμε σκόπιμα (π.χ. εκκαθάριση παλιάς δέσμευσης Uber)
          const day = athDate(new Date(t).toISOString());
          const key = k + "|" + day; if (seenKeys.has(key)) continue; seenKeys.add(key);
          const store = String(x.userDescription || x.counterPart || "").replace(/^.*Viva Wallet Card\s*-?\s*/i, "").trim();
          issues.push({ type: inDb.length ? "MISSING_HIDDEN" : "MISSING_NOT_SYNCED", amount: +k, date: day, store, vivaTx: txid,
            detail: inDb.length ? `${day} ${store} ${k}€: υπάρχει στη Viva ΚΑΙ στη βάση αλλά ΔΕΝ φαίνεται στον υπάλληλο (dedup)` : `${day} ${store} ${k}€: υπάρχει στη Viva αλλά ΔΕΝ έχει έρθει στην εφαρμογή` });
        }
      }
      if (issues.length) totalIssues += issues.length;
      people.push({ wallet: w, name: NAMES[w] || w, ours: ours.length, viva: Object.values(vAmts).reduce((a, b) => a + b, 0), issues });
    }
    people.sort((a, b) => b.issues.length - a.issues.length);
    return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), totalIssues, people });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }
};
