// Τροφοδοτεί την προσωπική σελίδα κάθε υπαλλήλου (me.html).
//  GET ?w=<walletId>&t=<token>  → επιστρέφει το όνομα + τις χρεώσεις ΜΟΝΟ αυτού του ατόμου (τρέχων μήνας)
//  GET ?links=1                 → (για CFO) όλα τα προσωπικά links για διανομή
const { wallets, sbSelect, personToken, verifyToken } = require("./_viva.js");

// Έναρξη καταγραφής — δείχνουμε ΜΟΝΟ χρεώσεις από αυτή τη μέρα κι έπειτα.
// (Οι παλιές του Ιουλίου δεν θα τακτοποιηθούν — καθαρή εικόνα από σήμερα.)
const START_DATE = "2026-07-16";

// Σωστά ελληνικά ονόματα ανά κάρτα (ώστε ο καθένας να αναγνωρίζει το όνομά του)
const NAMES = {
  "448933314799": "Άγγελος Χρονόπουλος",
  "324887741089": "Ανδρέας Κολυγλιάτης",
  "566240519800": "Κώστας Κρυωνάς",
  "282541651501": "Ιωάννα Σκούρα",
  "657494082292": "Λουκία Μπαλτζή",
  "910827445981": "Άντα Μπαϊρακτάρη",
  "975269802823": "Αίας Παρασκευόπουλος",
  "405838582045": "Ζωή Ηγουμενίδη",
  "389933252655": "Μαριλού Θηβαίου",
  "968554634120": "Μαριλένα Σιταροπούλου",
  "577335556525": "Αναστασία Κοβάνη",
  "990263759336": "Δήμητρα Λάκη",
  "243763678466": "Ντόριαν Γκουτζέλας",
};
const niceName = (walletId, friendly) => {
  if (NAMES[String(walletId)]) return NAMES[String(walletId)];
  const m = String(friendly || "").match(/^(.*?)\s*\d{4}$/);
  return (m ? m[1] : friendly || "").trim();
};

// Καθαρίζει τα ονόματα καταστημάτων ώστε να είναι αναγνωρίσιμα (π.χ. "AB_MIMIKOPOULEIO_215" → "ΑΒ Βασιλόπουλος",
// "UBR* PENDING.UBER.COM" → "Uber"). Εφαρμόζεται ΜΟΝΟ στην εμφάνιση — ο εσωτερικός έλεγχος γίνεται στο πρωτότυπο.
const BRANDS = [
  [/FREE.?NOW|HOLD\.FREE-NOW/, "FREE NOW"],
  [/UBER|\bUBR\b/, "Uber"],
  [/EFOOD/, "efood"],
  [/WOLT/, "Wolt"],
  [/ABVASSILOPOULOS|^AB[\s_]|ΒΑΣΙΛΟΠΟΥΛ/, "ΑΒ Βασιλόπουλος"],
  [/SHELL/, "Shell"],
  [/\bEKO\b/, "ΕΚΟ"],
  [/\bBP\b/, "BP"],
  [/KAYSIMA ATTIKHS/, "Καύσιμα Αττικής"],
  [/\bOASA\b/, "ΟΑΣΑ"],
  [/SKROUTZ/, "Skroutz"],
  [/ANTHROPIC/, "Anthropic (Claude)"],
  [/OPENAI|CHATGPT/, "OpenAI (ChatGPT)"],
  [/^ZARA/, "ZARA"],
  [/JUMBO/, "Jumbo"],
  [/^H\s?M\s|H&M|^HM\b/, "H&M"],
  [/FLOCAFE/, "Flocafé"],
  [/\bERGON\b/, "Ergon"],
  [/ATTIKI ODOS/, "Αττική Οδός"],
  [/OLYMPIA (ODOS|DIODIA|PACHI)/, "Ολυμπία Οδός"],
  [/ELLESTIA MALL/, "Ellestia Mall"],
  [/JOWAE/, "Jowaé"],
];
function cleanMerchant(raw) {
  let s = String(raw || "").trim();
  if (!s) return "—";
  s = s.replace(/^Δέσμευση Αγοράς με Viva Wallet Card\s*-?\s*/i, "")
       .replace(/^Αγορά με Viva Wallet Card\s*-?\s*/i, "");
  const U = s.toUpperCase();
  for (const [re, name] of BRANDS) { if (re.test(U)) return name; }
  s = s.replace(/^[A-Z0-9]{2,10}\s*\*\s*/i, "");          // κόβει "SQ* ", "IZ* " κ.λπ.
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\s+(E\.?E\.?|A\.?E\.?|I\.?K\.?E\.?|S\.?A\.?|MONOPR\.?|LTD)\.?$/i, "").trim();
  if (s.length < 2) return "Αγορά με κάρτα";
  s = s.replace(/\b[A-Z][A-Z0-9&.\-]{2,}\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
  return s;
}

// Η Viva στέλνει ασυνεπείς ώρες: το webhook δίνει σωστό UTC, ενώ ο cron (Data Services)
// δίνει ΩΡΑ ΑΘΗΝΑΣ λαθεμένα σφραγισμένη ως +00:00. Οι cron-εγγραφές αναγνωρίζονται από το
// μαγαζί "…Viva Wallet Card". Εδώ επαναφέρουμε το σωστό instant (ψηφία = ώρα Αθήνας).
function athOffMin(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Athens", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - d.getTime()) / 60000;
}
function fixDsTime(iso) { try { const w = new Date(iso); return new Date(w.getTime() - athOffMin(w) * 60000).toISOString(); } catch (e) { return iso; } }

// Καθαρισμός διπλοεγγραφών + διόρθωση ωρών.
function dedupCharges(rows) {
  const norm = (id) => String(id || "").replace(/^AUTH-/, "");
  const isDup = (m) => /Viva Wallet Card/i.test(m || "");   // εγγραφή από cron (δέσμευση/εκκαθάριση)
  // 0) Διόρθωσε τις ώρες των cron-εγγραφών
  rows = (rows || []).map((c) => isDup(c.merchant) ? { ...c, occurred_at: fixDsTime(c.occurred_at) } : { ...c });
  // 1) Ένωσε την ΙΔΙΑ συναλλαγή (webhook + cron, ίδιο id χωρίς "AUTH-"). Κράτα πραγματικό μαγαζί, νωρίτερη ώρα, απόδειξη/project.
  const byId = new Map();
  for (const c of rows) {
    const k = norm(c.viva_tx_id); const ex = byId.get(k);
    if (!ex) { byId.set(k, { ...c }); continue; }
    const m = { ...ex };
    if (isDup(m.merchant) && !isDup(c.merchant)) m.merchant = c.merchant;
    if (String(c.occurred_at || "") < String(m.occurred_at || "")) m.occurred_at = c.occurred_at;
    if (c.has_receipt) { m.has_receipt = true; m.receipt_url = c.receipt_url || m.receipt_url; }
    if (c.project) m.project = c.project;
    if (String(c.status) !== "PENDING_CLEAR") m.status = c.status;
    byId.set(k, m);
  }
  const list = [...byId.values()];
  const reals = list.filter((c) => !isDup(c.merchant));
  const dups = list.filter((c) => isDup(c.merchant)).sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || "")));
  // 2) Ρίξε κάθε cron-εκκαθάριση πάνω σε ΠΡΟΓΕΝΕΣΤΕΡΗ πραγματική εγγραφή ίδιου ποσού (=ίδια αγορά).
  const pool = {}; for (const r of reals) { const k = Math.abs(+r.amount).toFixed(2); (pool[k] = pool[k] || []).push(r); }
  const used = new Set(); const kept = [];
  for (const s of dups) {
    const k = Math.abs(+s.amount).toFixed(2);
    const cand = (pool[k] || []).filter((r) => !used.has(r) && String(r.occurred_at || "") <= String(s.occurred_at || "")).sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")));
    const r = cand[0];
    if (r) {
      used.add(r);
      if (s.has_receipt && !r.has_receipt) { r.has_receipt = true; r.receipt_url = s.receipt_url; }
      if (s.project && !r.project) r.project = s.project;
      if (r.status === "PENDING_CLEAR") r.status = (r.has_receipt && r.project) ? "COMPLETE" : "MISSING_ALL";
    } else kept.push(s);
  }
  // 3) Ένωσε ορφανές cron-εγγραφές ίδιου ποσού (δέσμευση + εκκαθάριση χωρίς webhook auth).
  const kept2 = new Map();
  for (const s of kept) {
    const k = Math.abs(+s.amount).toFixed(2); const ex = kept2.get(k);
    if (!ex) { kept2.set(k, s); continue; }
    if (s.has_receipt && !ex.has_receipt) { ex.has_receipt = true; ex.receipt_url = s.receipt_url; }
    if (s.project && !ex.project) ex.project = s.project;
  }
  return [...reals, ...kept2.values()];
}

function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const ws = await wallets();
    const EXCLUDED = new Set(["901067108914"]); // Λυμπέρης Μελκί — εξαιρέθηκε
    const members = (Array.isArray(ws) ? ws : []).filter(
      (w) => w.hasIssuedCard && !w.isPrimary && w.friendlyName && w.friendlyName !== "ακυρο" && !EXCLUDED.has(String(w.walletId))
    );

    // Λίστα προσωπικών links για τον CFO
    if (q.links) {
      const base = baseUrl(req);
      const list = members.map((w) => {
        const m = w.friendlyName.match(/^(.*?)\s*(\d{4})$/);
        return {
          name: niceName(w.walletId, w.friendlyName),
          card: m ? m[2] : "----",
          link: `${base}/me.html?w=${w.walletId}&t=${personToken(w.walletId)}`,
        };
      });
      return res.status(200).json({ people: list });
    }

    // Προσωπική πρόσβαση
    const w = String(q.w || "");
    if (!w || !verifyToken(w, String(q.t || "")))
      return res.status(403).json({ error: "Άκυρο ή λανθασμένο link" });

    const wallet = members.find((x) => String(x.walletId) === w);
    if (!wallet) return res.status(404).json({ error: "Δεν βρέθηκε η κάρτα" });
    const m = wallet.friendlyName.match(/^(.*?)\s*(\d{4})$/);
    const name = niceName(w, wallet.friendlyName);
    const card = m ? m[2] : "----";

    const ym = new Date().toISOString().slice(0, 7); // τρέχων μήνας (προεπιλογή)
    const rowsRaw = await sbSelect("charges", `wallet_id=eq.${w}&order=occurred_at.desc&limit=1000`);
    const rows = dedupCharges(rowsRaw || [])
      .filter((c) => String(c.occurred_at || "") >= START_DATE); // μόνο από σήμερα κι έπειτα
    // Επιστρέφουμε ΟΛΟΥΣ τους μήνες — η σελίδα κάνει πλοήγηση μπρος-πίσω και φιλτράρει.
    const charges = (rows || []).map((c) => ({
      id: c.id,
      amount: Math.abs(+c.amount),
      merchant: cleanMerchant(c.merchant),
      occurred_at: c.occurred_at,
      has_receipt: !!c.has_receipt,
      receipt_url: c.receipt_url || null,
      // ΟΛΑ τα αρχεία της χρέωσης (κύριο + πρόσθετα π.χ. μεταφορικά). Κύριο πρώτο.
      receipts: (() => {
        const r = c.raw && Array.isArray(c.raw.receipts) ? c.raw.receipts : null;
        if (r && r.length) return r.slice().sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0)).map((f) => f.url);
        return c.receipt_url ? [c.receipt_url] : [];
      })(),
      project: c.project || null,
      pending: c.status === "PENDING_CLEAR",
      receipt_check: (c.raw && c.raw.receipt_check) || null,
    }));

    return res.status(200).json({ name, card, month: ym, charges });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
