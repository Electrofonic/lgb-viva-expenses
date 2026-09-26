// Ρυθμίσεις εξαιρέσεων (καταστήματα χωρίς απόδειξη, π.χ. Αττική Οδός).
// Αποθηκεύονται σε μία «config» γραμμή του πίνακα charges (viva_tx_id = "__config_exempt__"),
// ώστε να μη χρειάζεται νέος πίνακας. GET διαβάζει τη λίστα, POST προσθέτει/αφαιρεί μοτίβο.
// Έτσι οι εξαιρέσεις ισχύουν ΑΜΕΣΩΣ, χωρίς redeploy.
const { sbSelect, sbInsert, sbUpdate, isAdmin } = require("./_viva.js");

const KEY = "__config_exempt__";

async function readList() {
  const rows = await sbSelect("charges", `viva_tx_id=eq.${KEY}&select=raw`);
  if (rows.length && rows[0].raw && Array.isArray(rows[0].raw.merchants))
    return rows[0].raw.merchants;
  return [];
}

async function writeList(merchants) {
  const raw = { merchants };
  // πρώτα δοκίμασε update· αν δεν υπάρχει η γραμμή, κάν' την insert
  const upd = await sbUpdate("charges", `viva_tx_id=eq.${KEY}`, { raw, status: "CONFIG" });
  if (upd.ok && upd.row) return true;
  await sbInsert("charges", {
    viva_tx_id: KEY, wallet_id: 0, amount: 0, merchant: "(config)",
    occurred_at: new Date().toISOString(), status: "CONFIG", raw,
  });
  // δεύτερο update για σιγουριά (σε περίπτωση που το insert αγνοήθηκε ως duplicate)
  await sbUpdate("charges", `viva_tx_id=eq.${KEY}`, { raw, status: "CONFIG" });
  return true;
}

const norm = (s) => String(s || "").trim().toUpperCase();

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store"); if (!isAdmin(req)) return res.status(403).json({ error: "Μόνο για διαχειριστή" });
  try {
    if (req.method === "GET") {
      return res.status(200).json({ merchants: await readList() });
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body || "{}");
      const action = body.action, pattern = norm(body.pattern);
      if (!pattern) return res.status(400).json({ error: "λείπει το pattern" });
      let list = await readList();
      if (action === "remove") {
        list = list.filter((x) => norm(x) !== pattern);
      } else {
        if (!list.some((x) => norm(x) === pattern)) list.push(pattern);
      }
      await writeList(list);
      return res.status(200).json({ ok: true, merchants: list });
    }
    return res.status(405).json({ error: "GET/POST only" });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
