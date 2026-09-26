// Επιστρέφει την τρέχουσα εικόνα: πραγματικά wallets από Viva + χρεώσεις από τη βάση
const { wallets, sbSelect, sbSelectAll, isAdmin } = require("./_viva.js");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store"); if (!isAdmin(req)) return res.status(403).json({ error: "Μόνο για διαχειριστή" });
  try {
    const [ws, charges] = await Promise.all([
      wallets().catch((e) => ({ error: String(e.message) })),
      sbSelectAll("charges", "select=*&order=occurred_at.desc,id.desc"),
    ]);
    return res.status(200).json({ wallets: ws, charges, generatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
