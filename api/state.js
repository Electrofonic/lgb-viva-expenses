// Επιστρέφει την τρέχουσα εικόνα: πραγματικά wallets από Viva + χρεώσεις από τη βάση
// [20/10] ?dedup=1 → οι χρεώσεις περνούν από το ΙΔΙΟ ξεδίπλωμα με τη σελίδα του υπαλλήλου (_dedup.js):
//   διπλοεγγραφές, ακυρωμένες κρατήσεις (ταξί κ.λπ.), επιστροφές, ξανα-κρατήσεις. Έτσι το dashboard
//   δείχνει ΑΚΡΙΒΩΣ την ίδια εικόνα με τον υπάλληλο. Χωρίς ?dedup=1 → ακατέργαστες γραμμές (για ελέγχους).
const { wallets, sbSelect, sbSelectAll, isAdmin } = require("./_viva.js");
const { dedupCharges } = require("./_dedup.js");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store"); if (!isAdmin(req)) return res.status(403).json({ error: "Μόνο για διαχειριστή" });
  try {
    const [ws, charges] = await Promise.all([
      wallets().catch((e) => ({ error: String(e.message) })),
      sbSelectAll("charges", "select=*&order=occurred_at.desc,id.desc"),
    ]);
    const q = req.query || {};
    if (String(q.dedup || "") === "1") {
      const wmap = {}; for (const w of (Array.isArray(ws) ? ws : [])) wmap[String(w.walletId)] = w;
      const byW = {};
      for (const c of (charges || [])) { const k = String(c.wallet_id); (byW[k] = byW[k] || []).push(c); }
      const out = [];
      for (const k of Object.keys(byW)) {
        if (!wmap[k]) continue; // όχι κάρτα (π.χ. ρυθμίσεις) → εκτός
        for (const c of dedupCharges(byW[k], { wallet: wmap[k] })) out.push(c);
      }
      out.sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")));
      return res.status(200).json({ wallets: ws, charges: out, deduped: true, generatedAt: new Date().toISOString() });
    }
    return res.status(200).json({ wallets: ws, charges, generatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
