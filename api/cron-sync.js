// Αυτόματος συγχρονισμός πληρωμών από Viva Data Services (τρέχει στο cloud, κάθε ~15').
// Φέρνει τις νεότερες κινήσεις (σελ. 1-2 = ~1000 πιο πρόσφατες), κρατά τον τρέχοντα μήνα,
// και περνά στη βάση: εκκαθαρισμένες αγορές (100/104) + δεσμεύσεις (101/authorization ⏳).
// Το dedup γίνεται μέσω μοναδικού viva_tx_id (ignore-duplicates) — ασφαλές να ξανατρέξει.
// Χρειάζεται env στο Vercel: VIVA_DS_CLIENT_ID, VIVA_DS_SECRET (read-only reporting keys).
const { wallets, sbInsert } = require("./_viva.js");

async function dsToken() {
  const id = process.env.VIVA_DS_CLIENT_ID, sec = process.env.VIVA_DS_SECRET;
  if (!id || !sec) throw new Error("Λείπουν VIVA_DS_CLIENT_ID / VIVA_DS_SECRET στο Vercel env");
  const basic = Buffer.from(`${id}:${sec}`).toString("base64");
  const r = await fetch("https://accounts.vivapayments.com/connect/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`DS token ${r.status}`);
  return (await r.json()).access_token;
}

async function dsPage(token, page, since) {
  const url = `https://api.vivapayments.com/dataservices/v2/accounttransactions/Search?dateFrom=${since}&dateTo=2030-01-01T00:00:00&page=${page}&pageSize=500`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`DS search ${r.status}`);
  return (await r.json()).data || [];
}

module.exports = async (req, res) => {
  try {
    const ws = await wallets();
    const EXCLUDED = new Set(["901067108914"]); // Λυμπέρης Μελκί — εξαιρέθηκε
    const members = new Set(
      (Array.isArray(ws) ? ws : [])
        .filter((w) => w.hasIssuedCard && !w.isPrimary && w.friendlyName && w.friendlyName !== "ακυρο" && !EXCLUDED.has(String(w.walletId)))
        .map((w) => String(w.walletId))
    );
    const token = await dsToken();
    // [25/9] Τελευταίες 10 μέρες, ΟΛΕΣ οι σελίδες. Πριν: μόνο σελίδα 1 + μόνο τρέχων μήνας → χρεώσεις των
    // τελευταίων ημερών του μήνα που έφταναν αργά (ή μετά από διακοπή) χάνονταν για πάντα. Ασφαλές: ignore-duplicates.
    const since = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 19);
    const rows = [];
    // Η Viva ΑΓΝΟΕΙ το dateFrom (επιστρέφει από τα νεότερα προς τα παλιά) → κόβουμε εμείς και σταματάμε μόλις περάσουμε το όριο.
    for (let p = 1; p <= 6; p++) {
      const pg = await dsPage(token, p, since);
      rows.push(...pg.filter((x) => String(x.created || "") >= since));
      if (pg.length < 500 || pg.some((x) => String(x.created || "") < since)) break;
    }

    const ym = new Date().toISOString().slice(0, 7); // τρέχων μήνας YYYY-MM
    const batch = [];
    for (const x of rows) {
      if (!members.has(String(x.walletId))) continue;
      const amt = Number(x.amount);
      const settle = (x.subTypeId === 100 || x.subTypeId === 104) && amt < 0;
      const auth = (x.isAuthorization || x.subTypeId === 101) && amt < 0;
      if (!settle && !auth) continue;
      batch.push({
        viva_tx_id: auth ? "AUTH-" + x.accountTransactionId : String(x.accountTransactionId),
        wallet_id: x.walletId,
        amount: Math.abs(amt),
        merchant: x.userDescription || x.counterPart || "",
        occurred_at: x.created,
        has_receipt: false,
        status: auth ? "PENDING_CLEAR" : "MISSING_ALL",
        raw: x,
      });
    }
    // dedup μέσα στο batch (η Postgres σκάει με διπλό κλειδί στο ίδιο insert)
    const seen = new Set();
    const uniq = batch.filter((r) => (seen.has(r.viva_tx_id) ? false : (seen.add(r.viva_tx_id), true)));
    // ΜΙΑ μαζική εγγραφή (ignore-duplicates) — γρήγορο, μέσα στο όριο χρόνου
    let ins = { skipped: true };
    if (uniq.length) ins = await sbInsert("charges", uniq, "viva_tx_id");
    return res.status(200).json({ ok: true, month: ym, scanned: uniq.length, saved: ins.ok !== false, status: ins.status || null, at: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }
};
