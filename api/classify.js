// Αποθήκευση χειροκίνητης ταξινόμησης από τον CFO/λογίστρια:
// ορισμός project ή/και μαρκάρισμα «εγκεκριμένη απώλεια». Γράφει ΜΟΝΙΜΑ στη βάση.
const { sbSelect, sbUpdate, isAdmin } = require("./_viva.js");

const INTERNAL = "LGB HOME";

// Υπολογισμός status από τα πεδία (ίδια λογική με το dashboard)
function statusOf({ has_receipt, project, approved_loss }) {
  if (approved_loss) return "APPROVED_LOSS";
  if (project === INTERNAL) return "INTERNAL";
  if (has_receipt && project) return "COMPLETE";
  if (!has_receipt && !project) return "MISSING_ALL";
  if (!has_receipt) return "NO_RECEIPT";
  return "NO_PROJECT";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store"); if (!isAdmin(req)) return res.status(403).json({ error: "Μόνο για διαχειριστή" });
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const { id, project, approvedLoss, receipt } = body || {};
    if (!id) return res.status(400).json({ error: "λείπει το id" });

    // Διάβασε την τρέχουσα γραμμή για να υπολογίσουμε σωστά το status
    const rows = await sbSelect("charges", `id=eq.${encodeURIComponent(id)}&select=*`);
    if (!rows.length) return res.status(404).json({ error: "δεν βρέθηκε η χρέωση" });
    const cur = rows[0];

    const patch = {};
    if (project !== undefined) patch.project = project || null;
    if (approvedLoss !== undefined) patch.approved_loss = !!approvedLoss;
    if (receipt !== undefined) patch.has_receipt = !!receipt;

    const merged = {
      has_receipt: patch.has_receipt ?? cur.has_receipt,
      project: patch.project !== undefined ? patch.project : cur.project,
      approved_loss: patch.approved_loss ?? cur.approved_loss,
    };
    patch.status = statusOf(merged);

    const upd = await sbUpdate("charges", `id=eq.${encodeURIComponent(id)}`, patch);
    if (!upd.ok) return res.status(500).json({ error: "αποτυχία αποθήκευσης", status: upd.status });
    return res.status(200).json({ ok: true, charge: upd.row });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
