// Επιστρέφει την τρέχουσα εικόνα: πραγματικά wallets από Viva + χρεώσεις από τη βάση
const { wallets, sbSelect, sbSelectAll } = require("./_viva.js");

module.exports = async (req, res) => {
  try {
    const [ws, charges] = await Promise.all([
      wallets().catch((e) => ({ error: String(e.message) })),
      sbSelectAll("charges", "select=*&order=occurred_at.desc,id.desc"),
    ]);
    res.setHeader("Cache-Control", "s-maxage=60");
    return res.status(200).json({ wallets: ws, charges, generatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
