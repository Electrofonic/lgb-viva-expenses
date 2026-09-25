// Viva webhook endpoint — Account Transaction Created (EventTypeId 2054)
// GET  → επαλήθευση από Viva (επιστρέφουμε το Key)
// POST → νέα κίνηση· κρατάμε μόνο αγορές με κάρτα (SubTypeId 100/104)
const { webhookKey, sbInsert } = require("./_viva.js");

const CARD_PURCHASE = new Set([100, 104]); // εκκαθαρισμένη αγορά με κάρτα

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const k = await webhookKey();
      return res.status(200).json(k);
    }
    if (req.method !== "POST") return res.status(405).end();

    const body = req.body || {};
    const e = body.EventData;
    if (!e || body.EventTypeId !== 2054) return res.status(200).json({ ignored: true });
    // Κρατάμε: εκκαθαρισμένες αγορές (100/104) ΚΑΙ δεσμεύσεις/authorizations (101 ή IsAuthorization)
    const isAuth = e.IsAuthorization === true || e.SubTypeId === 101;
    if (!CARD_PURCHASE.has(e.SubTypeId) && !isAuth) {
      return res.status(200).json({ ignored: true });
    }
    const charge = {
      // ίδιο id σχήμα με τον sync: δέσμευση → "AUTH-"+id, εκκαθάριση → id (ώστε να μη διπλογράφεται)
      viva_tx_id: isAuth ? "AUTH-" + e.WalletTransactionId : e.WalletTransactionId,
      wallet_id: e.WalletId,
      amount: Math.abs(e.Amount),
      merchant: e.Description || "",
      card_number: e.CardNumber || null,
      occurred_at: e.Created,
      has_receipt: false,
      comment: "",
      project: null,
      status: isAuth ? "PENDING_CLEAR" : "MISSING_ALL", // ⏳ δέσμευση που δεν εκκαθαρίστηκε ακόμα
      raw: e,
    };
    const r = await sbInsert("charges", charge, "viva_tx_id");
    console.log("charge stored", charge.viva_tx_id, r);
    if (r && r.ok === false) return res.status(500).json({ retry: true, status: r.status }); // [25/9] να ξαναστείλει η Viva
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error", err);
    // 200 για να μην κάνει retry-spam η Viva σε δικό μας bug· το log μένει
    return res.status(200).json({ error: String(err.message || err) });
  }
};
