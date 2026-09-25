// ΕΝΙΑΙΟ ξεδίπλωμα διπλοεγγραφών (25/9/2026). Το χρησιμοποιούν ΟΛΑ: σελίδα υπαλλήλου (my), υπενθυμίσεις,
// Elorus, audit — ώστε να βλέπουν ΑΚΡΙΒΩΣ την ίδια εικόνα (πριν υπήρχαν 4 ελαφρώς διαφορετικά αντίγραφα).
//
// Η Viva γράφει κάθε αγορά έως 3 φορές: webhook (πραγματικό μαγαζί), cron-δέσμευση («Δέσμευση Αγοράς με Viva Wallet Card - …»,
// viva_tx_id "AUTH-<id>") και cron-εκκαθάριση («Αγορά με Viva Wallet Card - …», νέο id). Εδώ τις κάνουμε ΜΙΑ.

function athOffMin(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Athens", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000;
}
// Ο cron (Data Services) δίνει ώρα Αθήνας σφραγισμένη ως UTC → επαναφορά στο σωστό instant.
function fixDsTime(iso) { try { const w = new Date(iso); return new Date(w.getTime() - athOffMin(w) * 60000).toISOString(); } catch (e) { return iso; } }

// Χρεώσεις που αποκαλύφθηκαν από τη διόρθωση της 25/9 αλλά ήταν ΠΡΙΝ από αυτήν (δόθηκαν σε χαρτί) → μένουν κρυφές.
const HIDDEN_BEFORE_FIX = new Set([1579, 5152, 5309, 5537, 6091, 6586, 7078, 7081, 7258, 7553, 8969, 9577, 12501, 12824, 12825, 13486, 14015, 14569, 14575, 14971, 15184]);

const DAY = 864e5;
const isDup = (m) => /Viva Wallet Card/i.test(m || "");                  // εγγραφή από cron
const isAuthRow = (c) => /^AUTH-/.test(String(c.viva_tx_id || ""));   // δέσμευση
const norm = (id) => String(id || "").replace(/^AUTH-/, "");
const amtKey = (c) => Math.abs(+c.amount).toFixed(2);
const tms = (c) => Date.parse(c.occurred_at);
const storeOf = (m) => String(m || "").replace(/^.*Viva Wallet Card\s*-?\s*/i, "").toUpperCase();
const mkey = (m) => storeOf(m).replace(/[^A-Z0-9]/g, "").slice(0, 5);
// «Μάρκα» για εταιρείες που δεσμεύουν ΑΛΛΟ ποσό από αυτό που τελικά χρεώνουν (ταξί/μεταφορές).
const brandKey = (m) => { const U = storeOf(m); if (/\bUBER|\bUBR\b/.test(U)) return "UBER"; if (/FREE.?NOW|\bFRN\b/.test(U)) return "FREENOW"; if (/\bBOLT\b/.test(U)) return "BOLT"; return null; };
// Πόση «δουλειά» έχει πάνω της μια εγγραφή — επιζεί πάντα αυτή με την περισσότερη (για να μη χαθεί Elorus/απόδειξη/project).
const score = (c) => (c.raw && c.raw.elorus_id ? 4 : 0) + (c.has_receipt ? 2 : 0) + (c.project ? 1 : 0);

// Ενώνει δύο εγγραφές της ΙΔΙΑΣ αγοράς: επιστρέφει νέο αντικείμενο με ό,τι χρήσιμο έχουν και οι δύο.
function mergeInto(keep, other, opts = {}) {
  const kr = (keep && keep.raw) || {}, or = (other && other.raw) || {};
  const m = { ...keep, raw: { ...kr } };
  // Από την άλλη εγγραφή παίρνουμε ΜΟΝΟ ό,τι λείπει: αρχεία, στοιχεία τιμολογίου, έλεγχο απόδειξης, μετρητή υπενθυμίσεων.
  // ΠΟΤΕ elorus_* (ο δεσμός με το Elorus ανήκει στη συγκεκριμένη εγγραφή).
  if (Array.isArray(or.receipts) && !(Array.isArray(kr.receipts) && kr.receipts.length)) m.raw.receipts = or.receipts;
  if (or.invoice && !kr.invoice) m.raw.invoice = or.invoice;
  if (or.receipt_check && !kr.receipt_check) m.raw.receipt_check = or.receipt_check;
  if (or.rem && (!kr.rem || (or.rem.n || 0) > (kr.rem.n || 0))) m.raw.rem = or.rem;
  if (isDup(m.merchant) && !isDup(other.merchant)) m.merchant = other.merchant;
  if (opts.earliestTime && String(other.occurred_at || "") < String(m.occurred_at || "")) m.occurred_at = other.occurred_at;
  if (other.has_receipt && !m.has_receipt) { m.has_receipt = true; m.receipt_url = other.receipt_url || m.receipt_url; }
  if (other.project && !m.project) m.project = other.project;
  if (other.approved_loss && !m.approved_loss) m.approved_loss = other.approved_loss;
  if (String(m.status) === "PENDING_CLEAR" && String(other.status) !== "PENDING_CLEAR") m.status = other.status;
  // αν η μία από τις δύο είναι εκκαθάριση, η αγορά δεν είναι πια «σε αναμονή»
  if (String(m.status) === "PENDING_CLEAR" && (!isAuthRow(other) || !isAuthRow(keep))) m.status = m.has_receipt && m.project ? "COMPLETE" : "MISSING_ALL";
  // κρυφή ομάδα μένει κρυφή — εκτός αν η εγγραφή που επιζεί είναι ΜΗ-κρυφή και έχει ήδη δουλειά (τότε ήταν ήδη ορατή)
  if (keep._hidden || (other._hidden && score(keep) === 0)) m._hidden = true; else delete m._hidden;
  return m;
}

function dedupCharges(rows) {
  rows = (rows || []).filter((r) => r && String(r.status) !== "VOID_JULY");
  // 0) σωστή ώρα για τις cron-εγγραφές
  rows = rows.map((c) => ({ ...c, ...(isDup(c.merchant) ? { occurred_at: fixDsTime(c.occurred_at) } : {}), ...(HIDDEN_BEFORE_FIX.has(Number(c.id)) ? { _hidden: true } : {}) }));

  // 1) ίδιο viva_tx_id (webhook + cron) → μία εγγραφή. Επιζεί όποια έχει περισσότερη δουλειά.
  const byId = new Map();
  for (const c of rows) {
    const k = norm(c.viva_tx_id); const ex = byId.get(k);
    if (!ex) { byId.set(k, c); continue; }
    const [keep, oth] = score(c) > score(ex) ? [c, ex] : [ex, c];
    byId.set(k, mergeInto(keep, oth, { earliestTime: true }));
  }
  const list = [...byId.values()];
  const reals = list.filter((c) => !isDup(c.merchant));
  const dups = list.filter((c) => isDup(c.merchant)).sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || "")));

  // 2) cron-εγγραφή → ΠΡΟΓΕΝΕΣΤΕΡΗ webhook-εγγραφή ίδιου ποσού, ≤7 μέρες, ΑΝΤΙΘΕΤΟΥ τύπου (δέσμευση↔εκκαθάριση).
  //    (Δύο διαφορετικές δεσμεύσεις δεν είναι ποτέ η ίδια αγορά — ίδιο id ενώνεται ήδη στο βήμα 1.)
  const pool = {}; for (const r of reals) (pool[amtKey(r)] = pool[amtKey(r)] || []).push(r);
  const used = new Set(); const kept = []; const realOut = new Map(reals.map((r) => [r, r]));
  for (const s of dups) {
    const cand = (pool[amtKey(s)] || []).filter((r) => !used.has(r) && isAuthRow(r) !== isAuthRow(s) && String(r.occurred_at || "") <= String(s.occurred_at || "") && tms(s) - tms(r) <= 7 * DAY)
      .sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")));
    const r = cand[0];
    if (!r) { kept.push(s); continue; }
    used.add(r);
    const cur = realOut.get(r);
    realOut.set(r, score(s) > score(cur) ? { ...mergeInto(s, cur), merchant: cur.merchant, occurred_at: cur.occurred_at } : mergeInto(cur, s));
  }

  // 3) δέσμευση ↔ εκκαθάριση μεταξύ cron-εγγραφών: ίδιο ποσό, εκκαθάριση έως 6 μέρες μετά, 1-προς-1, προτίμηση ίδιου καταστήματος.
  const auths = kept.filter(isAuthRow), settles = kept.filter((c) => !isAuthRow(c));
  const out = new Map(auths.map((a) => [a, a])); const orphanSettles = [];
  const paired = new Set();
  for (const s of settles) {
    const k = amtKey(s), ts = tms(s);
    const cands = auths.filter((a) => { const d = ts - tms(a); return !paired.has(a) && amtKey(a) === k && d >= -DAY && d <= 6 * DAY; })
      .sort((a, b) => ((mkey(b.merchant) === mkey(s.merchant)) - (mkey(a.merchant) === mkey(s.merchant))) || (tms(b) - tms(a)));
    const a = cands[0];
    if (!a) { orphanSettles.push(s); continue; }
    paired.add(a);
    const cur = out.get(a);
    out.set(a, score(s) > score(cur) ? mergeInto(s, cur) : mergeInto(cur, s));
  }
  // 3β) Ταξί/μεταφορές (Uber, FREE NOW, Bolt): η δέσμευση είναι ΑΛΛΟ ποσό από την τελική χρέωση.
  //     Ορφανή δέσμευση + ορφανή εκκαθάριση ίδιας μάρκας, έως 3 μέρες μετά → ίδια διαδρομή. Επιζεί η ΠΡΑΓΜΑΤΙΚΗ χρέωση
  //     (εκκαθάριση), εκτός αν η δέσμευση έχει ήδη περισσότερη δουλειά (π.χ. καταχωρήθηκε στο Elorus).
  const finalSettles = [];
  // υποψήφιες δεσμεύσεις: ορφανές cron-δεσμεύσεις + webhook-δεσμεύσεις που δεν ζευγάρωσαν στο βήμα 2
  const holdPool = [...auths.map((a) => ({ a, src: "cron" })), ...reals.filter((r) => isAuthRow(r) && !used.has(r)).map((a) => ({ a, src: "real" }))];
  const usedHold = new Set();
  for (const s of orphanSettles) {
    const b = brandKey(s.merchant);
    if (!b) { finalSettles.push(s); continue; }
    const ts = tms(s);
    // ΑΣΦΑΛΕΙΑ: ενώνουμε ΜΟΝΟ αν η μία από τις δύο δεν έχει καμία δουλειά (απόδειξη/project/Elorus).
    //   Αν ο υπάλληλος έχει δουλέψει ΚΑΙ τις δύο, τις αφήνουμε ορατές (ο audit τις αναφέρει ως «πιθανό διπλό»).
    const curOf = (h) => (h.src === "cron" ? out : realOut).get(h.a) || h.a;
    const cands = holdPool.filter((h) => { const d = ts - tms(h.a); return !paired.has(h.a) && !usedHold.has(h.a) && brandKey(h.a.merchant) === b && d >= -10 * 60e3 && d <= 3 * DAY && Math.min(score(curOf(h)), score(s)) === 0; })
      .sort((x, y) => (Math.abs(+s.amount - +x.a.amount) - Math.abs(+s.amount - +y.a.amount)) || (tms(x.a) - tms(y.a)));
    const h = cands[0];
    if (!h) { finalSettles.push(s); continue; }
    usedHold.add(h.a);
    const store = h.src === "cron" ? out : realOut;
    const cur = store.get(h.a);
    // το ΠΟΣΟ είναι πάντα αυτό της τελικής χρέωσης (η δέσμευση ήταν προσωρινό «κράτημα»)
    if (score(cur) > score(s)) store.set(h.a, { ...mergeInto(cur, s), amount: s.amount, hold_amount: cur.amount, ...(cur.raw && cur.raw.elorus_id && Math.abs(+cur.amount - +s.amount) > 0.005 ? { amount_mismatch: true } : {}) });
    else { store.delete(h.a); finalSettles.push({ ...mergeInto(s, cur), hold_amount: cur.amount }); }
  }

  // Οι 21 κρυφές μένουν κρυφές ΠΑΝΤΑ (κάποιες έχουν ήδη περαστεί στο Elorus εκτός εφαρμογής → αλλιώς θα γράφονταν διπλά).
  return [...realOut.values(), ...out.values(), ...finalSettles].filter((c) => !c._hidden).map((c) => { const { _hidden, ...rest } = c; return rest; });
}

module.exports = { dedupCharges, fixDsTime, athOffMin, HIDDEN_BEFORE_FIX, brandKey };
