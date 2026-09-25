// ΑΥΤΟΜΑΤΗ ΚΑΤΑΧΩΡΗΣΗ εξόδου στο Elorus (Let's Go Bananas / playground-lads-ike).
// Παίρνει μία ΟΛΟΚΛΗΡΩΜΕΝΗ χρέωση (απόδειξη + project) και δημιουργεί expense στο Elorus.
//   POST { w, t, chargeId }         → push ΜΙΑΣ χρέωσης (owner-authenticated με προσωπικό token)
//   GET/POST ?all=1  (Vercel cron)  → push ΟΛΩΝ των eligible που δεν έχουν σταλεί ακόμα
// Idempotent: αποθηκεύει το elorus_id στο charges.raw → δεν ξανακαταχωρεί.
const { sbSelect, sbSelectAll, sbUpdate, verifyToken, wallets } = require("./_viva.js");

const BASE = "https://api.elorus.com/v1.1";
const ORG = process.env.ELORUS_ORG_ID || "2802338946946696842";
const TRACKING_ID = "2816025548696847940"; // tracking category «ΕΞΟΔΟΛΟΓΙΑ»
const START_DATE = "2026-07-16";           // παλαιό γενικό — κρατιέται για registration
// ── ΗΜΕΡΟΜΗΝΙΑ ΕΝΑΡΞΗΣ ΑΝΑ ΑΤΟΜΟ ──────────────────────────────────────────
// Οι πιλοτικοί (δηλωμένοι) μετράνε από 16/7. ΟΛΟΙ ΟΙ ΑΛΛΟΙ από 1/8/2026: πριν
// από αυτό ΔΕΝ τους κυνηγάμε και ΔΕΝ μετράμε εκκρεμότητες — «σβήνουν» οι Ιουλίου.
const PILOT_WALLETS = new Set(["975269802823", "448933314799", "657494082292"]);
const PILOT_START = "2026-07-16";
const GENERAL_START = "2026-08-01";
// ΠΡΟΣΟΧΗ: το «κόψιμο» των Ιουλίου για τους μη-πιλοτικούς ΔΕΝ ισχύει από τώρα.
// Μέχρι 31/7 φαίνονται κανονικά (καμία σβήσιμο). ΑΠΟ 1/8 και μετά, οι μη-πιλοτικοί
// ξεκινούν καθαροί από 1/8 — δεν κουβαλάνε παλιές εκκρεμότητες Ιουλίου.
const startForWallet = (wid) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(new Date());
  if (today < GENERAL_START) return PILOT_START;                       // πριν 1/8: όλοι όπως τώρα
  return PILOT_WALLETS.has(String(wid)) ? PILOT_START : GENERAL_START; // από 1/8: μη-πιλοτικοί καθαροί
};
const INTERNAL = new Set(["LGB HOME", "LBG HOME"]);

// Σωστά ελληνικά ονόματα ανά κάρτα (η Viva δίνει λατινικά friendlyName).
const NAMES = {
  "448933314799": "Άγγελος Χρονόπουλος", "324887741089": "Ανδρέας Κολυγλιάτης", "566240519800": "Κώστας Κρυωνάς",
  "282541651501": "Ιωάννα Σκούρα", "657494082292": "Λουκία Μπαλτζή", "910827445981": "Άντα Μπαϊρακτάρη",
  "975269802823": "Αίας Παρασκευόπουλος", "405838582045": "Ζωή Ηγουμενίδη", "389933252655": "Μαριλού Θηβαίου",
  "968554634120": "Μαριλένα Σιταροπούλου", "577335556525": "Αναστασία Κοβάνη", "990263759336": "Δήμητρα Λάκη",
  "243763678466": "Ντόριαν Γκουτζέλας",
};

// --- κατηγορίες εξόδων Elorus (id) ---
const CAT = {
  ADS: "2816023551763547146",              // Ads
  SOFTWARE: "2816023626547987467",         // Applications & Software
  ANALOSIMA: "2802338947475179172",        // Αναλώσιμα & Προμήθειες
  AUTO: "2802338947475179162",             // Αυτοκίνητο & Μίλια
  FOOD: "2802338947475179167",             // Γεύματα & Διασκέδαση
  OFFICE: "2802338947475179168",           // Έξοδα γραφείου
  TRAVEL: "2802338947475179174",           // Ταξιδιωτικά
  LOIPA: "2802338947475179169",            // Λοιπά Έξοδα
};

// αφαίρεση ελληνικών τόνων + κεφαλαία (για σταθερό matching)
function deaccentUp(s) {
  return String(s || "").toUpperCase()
    .replace(/[ΆΑ]/g, "Α").replace(/[ΈΕ]/g, "Ε").replace(/[ΉΗ]/g, "Η").replace(/[ΊΪΐΙ]/g, "Ι")
    .replace(/[ΌΟ]/g, "Ο").replace(/[ΎΫΰΥ]/g, "Υ").replace(/[ΏΩ]/g, "Ω");
}
// όνομα καταστήματος → κατηγορία εξόδου (best-effort, default = Λοιπά Έξοδα)
// Ελέγχει ΚΑΙ το raw ΚΑΙ το καθαρισμένο όνομα, χωρίς τόνους/prefix Viva.
function pickCategory(rawMerchant) {
  const U = deaccentUp(cleanName(rawMerchant) + " || " + rawMerchant);
  const has = (re) => re.test(U);
  if (has(/ANTHROPIC|OPENAI|CHATGPT|WISPR|CLAUDE\b|ADOBE|CANVA|FIGMA|NOTION|SLACK|ZOOM|VERCEL|GITHUB|MICROSOFT|MSFT|GOOGLE\s?(WORKSPACE|GSUITE|CLOUD|ONE|STORAGE)|APPLE\.COM|APPLE BILL|ITUNES|DROPBOX|SPOTIFY|LINKEDIN|ELEVENLABS|MIDJOURNEY|HEYGEN|CAPCUT|SEMRUSH|AHREFS|MAILCHIMP|WIX\b|SQUARESPACE|GODADDY|NAMECHEAP|HOSTINGER|SUNO|RUNWAY|PERPLEXITY/)) return CAT.SOFTWARE;
  if (has(/META\b|FACEBK|FACEBOOK|FB\.ME|INSTAGRAM|GOOGLE\s?ADS|GOOGLEADS|TIKTOK|SNAP\b|TWITTER ADS|\bX ADS\b|LINKEDIN ADS|\bADS\b|ADWORDS/)) return CAT.ADS;
  if (has(/ΒΑΣΙΛΟΠΟΥΛ|ABVASSILOPOULOS|\bAB[\s_]|SKLAVENIT|ΣΚΛΑΒΕΝΙΤ|MASOUTIS|ΜΑΣΟΥΤΗ|\bLIDL\b|JUMBO|ΓΕΜΙΣΤΑ|MY MARKET|MYMARKET|KRITIKOS|ΚΡΗΤΙΚΟΣ|BAZAAR|PLAISIO|ΠΛΑΙΣΙΟ|\bPUBLIC\b|KOTSOVOLOS|ΚΩΤΣΟΒΟΛΟ|MEDIA MARKT|\bIKEA\b|ΓΕΡΜΑΝΟΣ|SUPER ?MARKET|ΣΟΥΠΕΡ ?ΜΑΡΚΕΤ|ΠΡΑΚΤΙΚΕΡ|PRAKTIKER|LEROY/)) return CAT.ANALOSIMA;
  if (has(/EFOOD|E-FOOD|\bWOLT\b|\bBOX\b|COFFEE|\bCAFE\b|FLOCAFE|ΚΑΦΕ|\bERGON\b|\bKFC\b|K\.F\.C|PIZZA|GOODY|MCDONALD|STARBUCKS|ΕΣΤΙΑΤ|TAVERN|ΤΑΒΕΡΝ|GRILL|SOUVLAK|ΣΟΥΒΛΑ|BAKERY|ΦΟΥΡΝΟΣ|ΑΡΤΟ|ΖΑΧΑΡΟΠΛΑΣΤ|\bBAR\b|BRUNCH|EVEREST|GREGORY|GREGORYS|MIKEL|\bCOOK\b|SNACK|WOKSHOP|ISLAND/)) return CAT.FOOD;
  if (has(/SHELL|\bEKO\b|\bBP\b|\bAVIN\b|\bELIN\b|ΕΛΙΝ|KAYSIMA|ΚΑΥΣΙΜ|PETROL|\bGAS\b|\bFUEL\b|FREE.?NOW|\bUBER\b|\bUBR\b|\bBEAT\b|\bTAXI\b|ΤΑΞΙ|\bOASA\b|ΟΑΣΑ|ATTIKI ODOS|ΑΤΤΙΚΗ ΟΔΟ|DIODIA|ΔΙΟΔΙΑ|OLYMPIA ODOS|ΟΛΥΜΠΙΑ ΟΔΟ|PARKING|ΠΑΡΚΙΝΓΚ|MOOVIT|CAR ?WASH|ΠΛΥΝΤΗΡΙΟ|ΣΤΑΘΜΕΥΣ|PARKADORO|AUTOMEDON|ΑΥΤΟΜΕΔΩΝ|DIONISAKOPOULOU|ΔΙΟΝΥΣΑΚΟΠΟΥΛ|ΓΚΑΡΑΖ|GARAGE|ΔΙΟΔΙΑ|E-PASS|ΕΛΕΥΘΕΡΩ/)) return CAT.AUTO;
  if (has(/AEGEAN|RYANAIR|SKY EXPRESS|\bBOOKING\b|AIRBNB|\bHOTEL\b|ΞΕΝΟΔΟΧ|TRAINOSE|HELLENIC TRAIN|\bFERR|BLUE ?STAR|SUPERFAST|ATTICA GROUP|AIRPORT|ΑΕΡΟΔΡΟΜ|\bTRIP\b|EXPEDIA/)) return CAT.TRAVEL;
  if (has(/PRINT|ΧΑΡΤΙΚ|\bOFFICE\b|ΓΡΑΦΙΚ|COURIER|\bACS\b|\bELTA\b|ΕΛΤΑ|SPEEDEX|BOX ?NOW|ΚΟΥΡΙΕΡ/)) return CAT.OFFICE;
  return CAT.LOIPA;
}

// project (επιλογή υπαλλήλου) → ακριβές tracking option string του Elorus
const TRACK_OPTIONS = ["2ΓΕΜΙΣΤΑ ΠΑΠΑΔΟΠΟΥΛΟΥ", "ALGIDA", "ATTRATIVO", "BWIN", "CAPRICE-SARANTIS", "CLINEA-SARANTIS", "COFEE ISLAND", "CROCS", "INTERSPORT", "JOWAE", "K.F.C.", "KLINEX", "LBG HOME", "NEW HOME", "PHARMASEPT", "PIZZA HUT", "SANITAS", "SARANTIS-BECKMANN", "SARANTIS-DIRTY LAUNDRY", "SEPHORA", "SFN NOSTOS", "SNAPPI", "SNF NIARXOS", "STR8", "Shell", "TEZA-SARANTIS", "THE ELLINIKON", "TSAKIRIS", "VODAFONE", "WOKSHOP", "WOWCHI", "Α Β ΒΑΣΙΛΟΠΟΥΛΟΣ", "ΒΙΤΑΜ", "ΓΕΜΙΣΤΑ", "ΚΩΤΣΟΒΟΛΟΣ-GINGER", "ΜΕΤΑΙΧΜΙΟ"];
function norm(s) {
  return String(s || "").toUpperCase().replace(/[\s._\-]+/g, "")
    .replace(/[ΆΑ]/g, "Α").replace(/[ΈΕ]/g, "Ε").replace(/[ΉΗ]/g, "Η").replace(/[ΊΪΙ]/g, "Ι")
    .replace(/[ΌΟ]/g, "Ο").replace(/[ΎΫΥ]/g, "Υ").replace(/[ΏΩ]/g, "Ω");
}
function pickTrackingOption(project) {
  if (!project) return null;
  const np = norm(project);
  if (np === norm("LGB HOME") || np === norm("LBG HOME")) return "LBG HOME";
  const hit = TRACK_OPTIONS.find((o) => norm(o) === np);
  return hit || null; // αν δεν ταιριάζει, το αφήνει κενό (ο λογιστής το συμπληρώνει)
}

// --- ώρα Αθήνας για την ημερομηνία εξόδου ---
function athOffMin(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Athens", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000;
}
function isCron(m) { return /Viva Wallet Card/i.test(m || ""); }
function fixDsTime(iso) { try { const w = new Date(iso); return new Date(w.getTime() - athOffMin(w) * 60000).toISOString(); } catch (e) { return iso; } }

// ΙΔΙΟ dedup με το dashboard/my.js — ΚΡΙΣΙΜΟ ώστε διπλές φυσικές εγγραφές (cron/settlement)
// της ίδιας αγοράς να ΜΗΝ δημιουργούν διπλά έξοδα στο Elorus.
// [25/9] Ενιαίο ξεδίπλωμα για όλη την εφαρμογή → βλ. api/_dedup.js
const { dedupCharges } = require("./_dedup.js");
function athDate(iso) { try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(new Date(iso)); } catch (e) { return String(iso || "").slice(0, 10); } }
function grDate(iso) { try { return new Intl.DateTimeFormat("el-GR", { timeZone: "Europe/Athens", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso)); } catch (e) { return ""; } }

// καθαρό όνομα καταστήματος για την περιγραφή (ελαφρύ)
function cleanName(raw) {
  let s = String(raw || "").replace(/^(Δέσμευση Αγοράς|Αγορά) με Viva Wallet Card\s*-?\s*/i, "").trim();
  s = s.replace(/^[A-Z0-9]{2,10}\s*\*\s*/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return s || "Αγορά με κάρτα";
}

async function elorus(method, path, body) {
  const key = process.env.ELORUS_API_KEY;
  if (!key) return { status: 0, body: { error: "Λείπει ELORUS_API_KEY" } };
  const r = await fetch(`${BASE}/${path}`, {
    method,
    headers: { Authorization: `Token ${key}`, "X-Elorus-Organization": ORG, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let b; try { b = JSON.parse(txt); } catch (e) { b = txt.slice(0, 400); }
  return { status: r.status, body: b };
}

// --- ΠΡΟΜΗΘΕΥΤΕΣ ---
// Τα τιμολόγια (invoices) πρέπει να περνάνε ΜΕ προμηθευτή, όχι «καρφωτά».
// Κατηγορίες που τυπικά εκδίδουν ΤΙΜΟΛΟΓΙΟ (όχι απλή απόδειξη λιανικής):
const INVOICE_CATS = new Set([CAT.SOFTWARE, CAT.ADS, CAT.OFFICE]);

// ══ Η ΔΙΚΛΕΙΔΑ: ΤΙΜΟΛΟΓΙΟ ή ΑΠΟΔΕΙΞΗ; ══════════════════════════════════════
// Είναι το ένα Ή το άλλο — ποτέ και τα δύο. Ο τύπος του χαρτιού καθορίζει τη
// διαδρομή καταχώρησης:
//   ΤΙΜΟΛΟΓΙΟ → πάει ΜΕ προμηθευτή (ΑΦΜ → όνομα), με αρ. παραστατικού
//   ΑΠΟΔΕΙΞΗ  → πάει ΚΑΡΦΩΤΑ, ΧΩΡΙΣ προμηθευτή, ακόμα κι αν τύχει να ταιριάζει
//               κάποιος υπάρχων προμηθευτής με το όνομα του καταστήματος
// Σειρά απόφασης (η πρώτη που ισχύει, κερδίζει):
//   1. Ρητή εντολή (opts.type) — ο άνθρωπος υπερισχύει πάντα
//   2. Το OCR είδε «ΤΙΜΟΛΟΓΙΟ / ΔΕΛΤΙΟ ΑΠΟΣΤΟΛΗΣ / INVOICE» πάνω στο χαρτί
//   3. Κατηγορία που ΠΑΝΤΑ εκδίδει τιμολόγιο (συνδρομές, διαφήμιση, γραφείο) —
//      καλύπτει τα PDF που δεν περνούν από OCR
//   4. Το OCR διάβασε το χαρτί και ΔΕΝ είδε τιμολόγιο → απόδειξη λιανικής
//   5. Δεν ξέρουμε → απόδειξη (ασφαλής επιλογή: δεν λερώνει καρτέλα προμηθευτή)
function docType(raw0, catId, opts) {
  const o = String((opts && opts.type) || "").toLowerCase();
  if (o === "invoice" || o === "τιμολογιο") return "invoice";
  if (o === "receipt" || o === "αποδειξη") return "receipt";
  const inv = (raw0 && raw0.invoice) || {};
  if (inv.isInvoice === true) return "invoice";
  if (INVOICE_CATS.has(catId)) return "invoice";
  return "receipt";
}
// λέξεις που αφαιρούνται πριν το matching (νομικές μορφές κ.λπ.)
const LEGALS = /\b(PBC|INC|LLC|LTD|LIMITED|CORP|CO|GMBH|BV|OU|OÜ|SA|AE|ΑΕ|ΕΕ|ΟΕ|ΙΚΕ|IKE|ΜΟΝ|ΜΟΝΟΠΡΟΣΩΠΗ|ΑΝΩΝΥΜΗ|ΕΤΑΙΡΕΙΑ|ΕΤΑΙΡΙΑ|SOFTWARE|SYSTEMS|IRELAND|HELLAS|GREECE)\b/g;
function normName(s) {
  return deaccentUp(String(s || ""))
    .replace(/\|\|/g, " ").replace(/[^A-ZΑ-Ω0-9 ]+/g, " ")
    .replace(LEGALS, " ").replace(/\s+/g, " ").trim();
}
let _contactsCache = null;
async function allContacts() {
  if (_contactsCache) return _contactsCache;
  const out = [];
  for (let page = 1; page <= 4; page++) {
    const r = await elorus("GET", `contacts/?page_size=300&page=${page}`);
    const res = (r.body && r.body.results) || [];
    out.push(...res);
    if (!r.body || !r.body.next) break;
  }
  _contactsCache = out;
  return out;
}
// ΑΦΜ → προμηθευτής. Ο ΠΙΟ ΑΞΙΟΠΙΣΤΟΣ τρόπος: το όνομα της κάρτας είναι το brand
// (π.χ. «Shell»), ενώ ο εκδότης του τιμολογίου είναι άλλη οντότητα (π.χ. «Ο ΕΡΜΗΣ»).
// Μόνο το ΑΦΜ πάνω στο χαρτί τους συνδέει.
async function findSupplierByVat(vat) {
  const v = String(vat || "").replace(/[^0-9]/g, "");
  if (v.length < 9) return null;
  const list = await allContacts();
  for (const c of list) {
    const cv = String(c.vat_number || "").replace(/[^0-9]/g, "");
    if (cv && cv === v) return { id: c.id, name: c.company || c.display_name, vat: c.vat_number, is_supplier: !!c.is_supplier, via: "ΑΦΜ" };
  }
  return null;
}

// Βρίσκει προμηθευτή που ταιριάζει με το όνομα καταστήματος. Επιστρέφει {id,name} ή null.
async function findSupplier(merchantRaw) {
  // ΚΑΙ το raw ΚΑΙ το καθαρισμένο: το cleanName κόβει prefix πριν το «*» (π.χ. ANTHROPIC*CLAUDE)
  const m = normName(String(merchantRaw || "") + " " + cleanName(merchantRaw));
  if (!m) return null;
  const tokens = m.split(" ").filter((x) => x.length >= 4);
  if (!tokens.length) return null;
  const list = await allContacts();
  let best = null;
  for (const c of list) {
    const nm = normName(c.company || c.display_name || `${c.first_name || ""} ${c.last_name || ""}`);
    if (!nm) continue;
    // δυνατό ταίριασμα: κοινό «σημαντικό» token (π.χ. ANTHROPIC) ή πλήρης περιοχή ονόματος
    const hit = tokens.some((t) => nm.split(" ").includes(t)) || (m.length >= 5 && nm.includes(m));
    if (!hit) continue;
    const score = (c.is_supplier ? 2 : 0) + (nm === m ? 3 : 0);
    if (!best || score > best.score) best = { id: c.id, name: c.company || c.display_name, score, is_supplier: !!c.is_supplier };
  }
  return best;
}

// --- ΦΥΛΑΚΑΣ ΔΙΠΛΟΕΓΓΡΑΦΩΝ ---
// Κάθε έξοδο που φτιάχνουμε φέρει custom_id = VIVA-<chargeId>. Πριν από ΚΑΘΕ καταχώρηση
// ρωτάμε το ΙΔΙΟ το Elorus (όχι μόνο τη βάση μας) αν υπάρχει ήδη.
function vivaTag(chargeId) { return `VIVA-${chargeId}`; }
async function findExistingExpense(chargeId, dateStr, amt, walletId) {
  const tag = vivaTag(chargeId);
  // 1) ακριβές ταίριασμα με custom_id (ο δικός μας «δακτυλικός αποτυπωτής»)
  for (const qs of [`custom_id=${encodeURIComponent(tag)}`, `search=${encodeURIComponent(tag)}`]) {
    const r = await elorus("GET", `expenses/?${qs}&page_size=20`);
    const res = (r.body && r.body.results) || [];
    const hit = res.find((x) => String(x.custom_id || "") === tag);
    if (hit) return { kind: "same-charge", expense: hit };
  }
  // 2) ίδια ημερομηνία + ίδιο ποσό → πιθανό διπλό (π.χ. χειροκίνητη καταχώρηση).
  // Σαρώνουμε με σειρά ημερομηνίας (τα φίλτρα date_from/date_to δεν είναι αξιόπιστα).
  const same = [];
  for (let page = 1; page <= 4; page++) {
    const r2 = await elorus("GET", `expenses/?page_size=200&page=${page}&ordering=-date`);
    const res2 = (r2.body && r2.body.results) || [];
    if (!res2.length) break;
    for (const x of res2) {
      if (x.date === dateStr && Math.abs(parseFloat(x.total) - amt) < 0.005) same.push(x);
    }
    // τα αποτελέσματα είναι φθίνουσα ημερομηνία → αν περάσαμε τη ζητούμενη, σταμάτα
    const last = res2[res2.length - 1];
    if (last && String(last.date) < String(dateStr)) break;
    if (!r2.body || !r2.body.next) break;
  }
  if (same.length) {
    const mine = same.find((x) => String(x.custom_id || "") === tag);
    if (mine) return { kind: "same-charge", expense: mine };
    // [25/9] Έξοδο ίδιου ποσού/ημέρας που είναι ΔΙΚΟ ΜΑΣ για χρέωση ΑΛΛΟΥ υπαλλήλου (άλλη κάρτα) = άλλη αγορά, όχι διπλό.
    //   (π.χ. δύο εισιτήρια ΟΑΣΑ 1,20€ από δύο άτομα την ίδια μέρα). Χειροκίνητα έξοδα ή ίδια κάρτα → μένουν «ύποπτα».
    const suspects = [];
    for (const x of same) {
      const m = /^VIVA-(\d+)$/.exec(String(x.custom_id || ""));
      if (m && walletId) {
        try {
          const rows = await sbSelect("charges", `id=eq.${m[1]}&select=wallet_id`);
          if (rows && rows[0] && String(rows[0].wallet_id) !== String(walletId)) continue;
        } catch (e) { /* αν δεν ξέρουμε, μένει ύποπτο */ }
      }
      suspects.push(x);
    }
    if (!suspects.length) return null;
    return { kind: "possible-duplicate", expense: suspects[0], count: suspects.length };
  }
  return null;
}

// Ορίζει προμηθευτή σε ΥΠΑΡΧΟΝ έξοδο. Το Elorus δεν δέχεται PATCH → GET + PUT ολόκληρου.
async function setExpenseSupplier(expenseId, supplierId) {
  const cur = await elorus("GET", `expenses/${expenseId}/`);
  if (cur.status !== 200) return { ok: false, error: `GET ${cur.status}` };
  const b = cur.body || {};
  const putBody = {
    date: b.date,
    currency_code: b.currency_code,
    exchange_rate: b.exchange_rate,
    reference: b.reference || "",
    custom_id: b.custom_id || "",
    branch: b.branch || null,
    supplier: supplierId,
    items: (b.items || []).map((it) => ({
      expense_category: it.expense_category,
      description: it.description,
      amount: it.amount,
      taxes: it.taxes || [],
      project: it.project || null,
      billable: !!it.billable,
    })),
    trackingcategories: (b.trackingcategories || []).map((t) => ({ trackingcategory: t.trackingcategory, option: t.option })),
  };
  const pr = await elorus("PUT", `expenses/${expenseId}/`, putBody);
  if (pr.status >= 200 && pr.status < 300) return { ok: true };
  return { ok: false, error: `PUT ${pr.status}`, detail: pr.body };
}

// Βάζει το αρχείο στο ΠΕΔΙΟ «Απόδειξη» του εξόδου, ώστε να ΦΑΙΝΕΤΑΙ η εικόνα δεξιά
// όταν ανοίγει το έξοδο στο Elorus (όχι απλώς συνδετήρας/link).
// Κλήση JSON στο v1.2 (τα attachments ζουν εκεί).
async function elorus12(method, path, body) {
  const key = process.env.ELORUS_API_KEY;
  if (!key) return { status: 0, body: { error: "Λείπει ELORUS_API_KEY" } };
  const r = await fetch(`https://api.elorus.com/v1.2/${path}`, {
    method,
    headers: { Authorization: `Token ${key}`, "X-Elorus-Organization": ORG, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = String(t).slice(0, 200); }
  return { status: r.status, body: b };
}

// ΑΝΕΝΕΡΓΟ (αντικαταστάθηκε): το «πλαίσιο απόδειξης» είναι στην πραγματικότητα το attachment
// που έχει primary=true. Βλ. ensurePrimary μέσα στο attachReceipt.
const RECEIPT_PANEL_ENABLED = false;
async function setExpenseReceipt(expenseId, receiptUrl) {
  try {
    if (!RECEIPT_PANEL_ENABLED) return { ok: false, why: "disabled" };
    if (!receiptUrl) return { ok: false, why: "no-url" };
    const key = process.env.ELORUS_API_KEY;
    const rf = await fetch(receiptUrl);
    if (!rf.ok) return { ok: false, why: `fetch ${rf.status}` };
    const ct = (rf.headers.get("content-type") || "image/jpeg").split(";")[0];
    const buf = Buffer.from(await rf.arrayBuffer());
    const ext = (ct.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    const attempts = [];
    const P = `expenses/${expenseId}/receipt/`;
    const combos = [
      // raw body (το αρχείο σκέτο) — πιθανότερο για endpoint «receipt»
      { v: "v1.2", p: P, m: "PUT", raw: true },
      { v: "v1.2", p: P, m: "POST", raw: true },
      { v: "v1.2", p: `expenses/${expenseId}/receipt`, m: "PUT", raw: true },
      // multipart παραλλαγές
      { v: "v1.2", p: P, m: "POST", f: "file" },
      { v: "v1.2", p: P, m: "PUT", f: "file" },
      { v: "v1.1", p: P, m: "POST", f: "file" },
    ];
    for (const cb of combos) {
      const label = `${cb.m} ${cb.v}/${cb.p}${cb.raw ? " [raw]" : ` [${cb.f}]`}`;
      try {
        const headers = { Authorization: `Token ${key}`, "X-Elorus-Organization": ORG };
        let body;
        if (cb.raw) { body = buf; headers["Content-Type"] = ct; headers["Content-Disposition"] = `attachment; filename="apodeixi.${ext}"`; }
        else { const form = new FormData(); form.append(cb.f, new Blob([buf], { type: ct }), `apodeixi.${ext}`); body = form; }
        const r = await fetch(`https://api.elorus.com/${cb.v}/${cb.p}`, { method: cb.m, headers, body });
        const txt = await r.text(); let b; try { b = JSON.parse(txt); } catch (e) { b = String(txt).slice(0, 120); }
        if (r.status >= 200 && r.status < 300) return { ok: true, via: label, body: b };
        attempts.push({ via: label, status: r.status, detail: b });
      } catch (e) {
        attempts.push({ via: label, err: String(e.message || e) });
      }
    }
    return { ok: false, attempts };
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
}

// Επισυνάπτει το αρχείο απόδειξης στο έξοδο (Elorus API v1.2, multipart/form-data).
// Κάνει ένα attachment «primary» → ΕΜΦΑΝΙΖΕΤΑΙ στο δεξί πλαίσιο «Απόδειξη» του εξόδου.
async function makePrimary(expenseId, attachmentId) {
  for (const m of ["PATCH", "PUT"]) {
    const r = await elorus12(m, `expenses/${expenseId}/attachments/${attachmentId}/`, { primary: true });
    if (r.status >= 200 && r.status < 300) return { ok: true, via: m };
    if (r.status !== 404 && r.status !== 405) return { ok: false, status: r.status, detail: r.body };
  }
  return { ok: false, why: "primary-not-settable" };
}

async function attachReceipt(expenseId, receiptUrl, title) {
  try {
    if (!receiptUrl) return { ok: false, why: "no-url" };
    // ΠΟΤΕ διπλό συνημμένο: αν υπάρχει ήδη, απλώς βεβαιώσου ότι είναι primary.
    const cur = await elorus12("GET", `expenses/${expenseId}/attachments/?page_size=20`);
    const list = (cur.body && cur.body.results) || [];
    if (list.length) {
      const prim = list.find((a) => a.primary);
      if (prim) return { ok: true, id: prim.id, existed: true, primary: true };
      const pr = await makePrimary(expenseId, list[0].id);
      return { ok: true, id: list[0].id, existed: true, primary: pr.ok, primaryInfo: pr };
    }
    const key = process.env.ELORUS_API_KEY;
    const rf = await fetch(receiptUrl);
    if (!rf.ok) return { ok: false, why: `fetch ${rf.status}` };
    const ct = (rf.headers.get("content-type") || "image/jpeg").split(";")[0];
    const buf = Buffer.from(await rf.arrayBuffer());
    const ext = (ct.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    const form = new FormData();
    form.append("title", String(title || "Απόδειξη").slice(0, 120));
    form.append("primary", "true"); // → να φαίνεται στο δεξί πλαίσιο «Απόδειξη»
    form.append("file", new Blob([buf], { type: ct }), `apodeixi.${ext}`);
    const r = await fetch(`https://api.elorus.com/v1.2/expenses/${expenseId}/attachments/`, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "X-Elorus-Organization": ORG }, // ΟΧΙ Content-Type — το βάζει το FormData με boundary
      body: form,
    });
    const txt = await r.text(); let b; try { b = JSON.parse(txt); } catch (e) { b = txt.slice(0, 200); }
    if (r.status !== 201 && r.status !== 200) return { ok: false, status: r.status, detail: b };
    const newId = b && b.id;
    // Σιγουριά: αν το POST δεν δέχτηκε το primary, όρισέ το ρητά.
    let prim = { ok: !!(b && b.primary) };
    if (!prim.ok && newId) prim = await makePrimary(expenseId, newId);
    return { ok: true, id: newId, primary: prim.ok, primaryInfo: prim };
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
}

// Όλα τα URLs αρχείων μιας χρέωσης, κύριο πρώτο. Συμβατότητα με παλιό μονό receipt_url.
function receiptUrlsOf(raw0, c) {
  const list = raw0 && Array.isArray(raw0.receipts) ? raw0.receipts : null;
  if (list && list.length) {
    return list.slice().sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0)).map((f) => f.url).filter(Boolean);
  }
  return c && c.receipt_url ? [c.receipt_url] : [];
}

// Επισυνάπτει ΟΛΑ τα αρχεία μιας χρέωσης (κύριο + πρόσθετα π.χ. μεταφορικά). Το 1ο = primary
// (φαίνεται δεξιά), τα υπόλοιπα δευτερεύοντα. Dedup ανά τίτλο ώστε να μη διπλασιάζονται.
async function attachAllReceipts(expenseId, urls, storeName) {
  const clean = (urls || []).filter(Boolean);
  if (!clean.length) return { ok: false, why: "no-receipt" };
  if (clean.length === 1) return await attachReceipt(expenseId, clean[0], `Απόδειξη ${storeName}`);
  const key = process.env.ELORUS_API_KEY;
  const cur = await elorus12("GET", `expenses/${expenseId}/attachments/?page_size=50`);
  const existing = (cur.body && cur.body.results) || [];
  const titles = new Set(existing.map((a) => String(a.title || "")));
  const results = []; let attached = 0, primaryId = null;
  for (let i = 0; i < clean.length; i++) {
    const isMain = i === 0;
    const title = (isMain ? `Απόδειξη ${storeName}` : `Έξτρα ${storeName} #${i + 1}`).slice(0, 120);
    if (titles.has(title)) { results.push({ title, skipped: "exists" }); continue; }
    try {
      const rf = await fetch(clean[i]);
      if (!rf.ok) { results.push({ title, error: `fetch ${rf.status}` }); continue; }
      const ct = (rf.headers.get("content-type") || "image/jpeg").split(";")[0];
      const buf = Buffer.from(await rf.arrayBuffer());
      const ext = (ct.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
      const form = new FormData();
      form.append("title", title);
      form.append("primary", isMain ? "true" : "false");
      form.append("file", new Blob([buf], { type: ct }), `apodeixi_${i + 1}.${ext}`);
      const r = await fetch(`https://api.elorus.com/v1.2/expenses/${expenseId}/attachments/`, {
        method: "POST", headers: { Authorization: `Token ${key}`, "X-Elorus-Organization": ORG }, body: form,
      });
      const txt = await r.text(); let b; try { b = JSON.parse(txt); } catch (e) { b = txt.slice(0, 150); }
      if (r.status === 201 || r.status === 200) {
        attached++; if (isMain) { primaryId = b && b.id; if (!(b && b.primary) && primaryId) await makePrimary(expenseId, primaryId); }
        results.push({ title, id: b && b.id });
      } else results.push({ title, error: `${r.status}`, detail: b });
    } catch (e) { results.push({ title, error: String(e.message || e) }); }
  }
  return { ok: attached > 0 || results.some((x) => x.skipped), id: primaryId, primary: !!primaryId, count: clean.length, attached, results };
}

// Δημιουργεί το expense στο Elorus για μία χρέωση (charge row). Επιστρέφει {ok, id?, skipped?, error?}
async function pushCharge(c, nameByWallet, opts) {
  opts = opts || {};
  const raw0 = c.raw || {};
  // Αν ο άνθρωπος ορίσει ρητά τον τύπο (ή δώσει προμηθευτή), ΑΠΟΘΗΚΕΥΣΕ την απόφαση
  // πάνω στη χρέωση — ώστε ο ελεγκτής και κάθε επόμενο πέρασμα να τη σέβονται.
  // Χρειάζεται για χαρτιά που ανέβηκαν πριν βελτιωθεί η αναγνώριση.
  {
    const explicit = String(opts.type || "").toLowerCase();
    const wantInv = explicit === "invoice" || explicit === "τιμολογιο" || !!opts.supplierId;
    const wantRec = explicit === "receipt" || explicit === "αποδειξη";
    if (wantInv || wantRec) {
      const cur = raw0.invoice || {};
      if (cur.isInvoice !== wantInv) {
        raw0.invoice = Object.assign({}, cur, { isInvoice: wantInv, setBy: "χειροκίνητα", at: new Date().toISOString() });
        if (opts.reference) raw0.invoice.number = String(opts.reference);
        if (opts.vat) raw0.invoice.vat = String(opts.vat);
        await sbUpdate("charges", `id=eq.${encodeURIComponent(c.id)}`, { raw: raw0 });
      }
    }
  }
  let existing = opts.force ? null : raw0.elorus_id;

  // ΑΥΤΟ-ΕΠΙΔΙΟΡΘΩΣΗ ΟΡΦΑΝΩΝ: αν ο Κώστας διέγραψε το έξοδο, ο δεσμός είναι νεκρός.
  // Ψάχνουμε αν υπάρχει άλλο ίδιο έξοδο (αντίγραφο που κρατήθηκε) → ξανασυνδέουμε.
  // Αν δεν υπάρχει κανένα → καθαρίζουμε και ξαναδημιουργούμε (με τον φύλακα ενεργό).
  if (existing) {
    const chk = await elorus("GET", `expenses/${existing}/`);
    if (chk.status === 404) {
      const amt0 = Math.abs(+c.amount);
      const d0 = athDate(c.occurred_at);
      const alt = await findExistingExpense(c.id, d0, amt0, c.wallet_id);
      if (alt && alt.expense && String(alt.expense.id) !== String(existing)) {
        await sbUpdate("charges", `id=eq.${encodeURIComponent(c.id)}`, { raw: Object.assign({}, raw0, { elorus_id: alt.expense.id, elorus_attachment: null, elorus_supplier: null }) });
        return { ok: true, skipped: "relinked", id: alt.expense.id, detail: "Ο παλιός δεσμός ήταν σε διαγραμμένο έξοδο — συνδέθηκε με το υπάρχον" };
      }
      existing = null; // δεν βρέθηκε τίποτα → ξαναδημιούργησε
      delete raw0.elorus_id; delete raw0.elorus_attachment; delete raw0.elorus_supplier;
    }
  }

  // Υπάρχει ήδη έξοδο: αν λείπει ΜΟΝΟ το συνημμένο/προμηθευτής, συμπλήρωσέ το (χωρίς νέο έξοδο).
  if (existing) {
    const fixes = {}; let att = null, supFix = null, rec = null;
    // 1) Συνημμένα (κύριο + πρόσθετα π.χ. μεταφορικά). Idempotent (dedup ανά τίτλο).
    //    Ξανατρέχει αν λείπει primary Ή αν προστέθηκαν νέα αρχεία μετά την πρώτη καταχώρηση.
    const urls = receiptUrlsOf(raw0, c);
    const needAttach = urls.length && (!(raw0.elorus_attachment && raw0.elorus_primary) || urls.length > (raw0.elorus_att_count || 1));
    if (needAttach) {
      att = await attachAllReceipts(existing, urls, cleanName(c.merchant));
      if (att.ok) {
        if (att.id) fixes.elorus_attachment = att.id;
        fixes.elorus_att_at = new Date().toISOString();
        fixes.elorus_att_count = urls.length;
        if (att.primary) fixes.elorus_primary = true;
      }
    }
    // 2) λείπει προμηθευτής → βρες τον και ΔΙΟΡΘΩΣΕ το υπάρχον έξοδο (όχι νέο/διπλό).
    //    Με ρητό supplierId γίνεται ΠΑΝΤΑ, ακόμα κι αν είχε μαρκαριστεί ως «χωρίς προμηθευτή».
    //    ΑΛΛΑ: μόνο αν το χαρτί είναι ΤΙΜΟΛΟΓΙΟ. Απόδειξη λιανικής μένει καρφωτή.
    const kindEx = docType(raw0, pickCategory(c.merchant), opts);
    if ((kindEx === "invoice" || opts.supplierId) && (!raw0.elorus_supplier || raw0.elorus_supplier === "none" || opts.supplierId)) {
      const found = opts.supplierId ? { id: String(opts.supplierId), name: "(χειροκίνητο)" }
        : (await findSupplierByVat(opts.vat || (raw0.invoice && raw0.invoice.vat))) || await findSupplier(c.merchant);
      if (found) {
        const pr = await setExpenseSupplier(existing, found.id);
        if (pr.ok) { fixes.elorus_supplier = found.id; supFix = found; }
        else supFix = Object.assign({ tried: found }, pr);
      } else { fixes.elorus_supplier = "none"; }
    }
    if (Object.keys(fixes).length) await sbUpdate("charges", `id=eq.${encodeURIComponent(c.id)}`, { raw: Object.assign({}, raw0, fixes) });
    if (!att && !supFix && !rec) return { ok: true, skipped: "already", id: existing };
    return { ok: true, skipped: "updated", id: existing, attachment: att, receipt: rec, supplier: supFix };
  }
  if (!c.has_receipt || !c.project) return { ok: false, skipped: "incomplete" };

  const amt = Math.abs(+c.amount);
  if (!(amt > 0)) return { ok: false, error: "μηδενικό ποσό" };
  // ΚΑΝΟΝΑΣ: αν υπάρχει ημερομηνία ΤΙΜΟΛΟΓΙΟΥ (από OCR ή override), αυτή υπερισχύει
  // της ημερομηνίας χρέωσης της κάρτας.
  const cardDate = athDate(c.occurred_at);
  const invDateRaw = opts.date || (raw0.invoice && raw0.invoice.date) || null;
  // Δικλείδα: δεχόμαστε την ημερομηνία τιμολογίου μόνο αν είναι λογική σε σχέση με τη
  // χρέωση (±60 ημέρες) — ώστε λάθος ανάγνωση OCR να μη ρίξει το έξοδο σε άλλη περίοδο.
  let date = cardDate, dateSrc = "κάρτα";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(invDateRaw || ""))) {
    const diff = Math.abs(new Date(invDateRaw + "T12:00:00Z") - new Date(cardDate + "T12:00:00Z")) / 86400000;
    if (diff <= 60) { date = String(invDateRaw); dateSrc = "τιμολόγιο"; }
  }
  const invNo = opts.reference || (raw0.invoice && raw0.invoice.number) || null;

  // ΦΥΛΑΚΑΣ: υπάρχει ήδη στο Elorus; (ποτέ διπλή καταχώρηση)
  if (!opts.allowDup) {
    const dup = await findExistingExpense(c.id, date, amt, c.wallet_id);
    if (dup && dup.kind === "same-charge") {
      // Υπάρχει ήδη δικό μας — κράτα τη σύνδεση, μη φτιάξεις νέο
      await sbUpdate("charges", `id=eq.${encodeURIComponent(c.id)}`, { raw: Object.assign({}, raw0, { elorus_id: dup.expense.id }) });
      return { ok: true, skipped: "exists-in-elorus", id: dup.expense.id };
    }
    if (dup && dup.kind === "possible-duplicate") {
      return { ok: false, skipped: "possible-duplicate", detail: `Υπάρχει ήδη έξοδο ${amt.toFixed(2)}€ στις ${date} (id ${dup.expense.id}) — δεν καταχωρήθηκε για αποφυγή διπλού` };
    }
  }
  const catId = pickCategory(c.merchant);
  const opt = pickTrackingOption(c.project);
  const store = cleanName(c.merchant);
  const info = nameByWallet[String(c.wallet_id)] || {};
  const who = info.name || "";
  const card = info.card || "";
  const parts = [store];
  const meta = [who && `${who}`, card && `κάρτα ••${card}`, grDate(c.occurred_at) && grDate(c.occurred_at)].filter(Boolean).join(", ");
  const desc = `${store}${meta ? ` (${meta})` : ""}${c.receipt_url ? ` · Απόδειξη: ${c.receipt_url}` : ""}`;

  // ══ ΔΙΚΛΕΙΔΑ: πρώτα ΤΙ είναι το χαρτί, μετά ΠΩΣ περνιέται ══════════════════
  const kind = docType(raw0, catId, opts);
  // Ρητός προμηθευτής από άνθρωπο ⇒ είναι τιμολόγιο εξ ορισμού.
  const isInvoice = kind === "invoice" || !!opts.supplierId;
  let sup = null, supWarn = null;
  if (opts.supplierId) {
    // Ρητή εντολή ανθρώπου — υπερισχύει (και το κάνει αυτομάτως τιμολόγιο)
    sup = { id: String(opts.supplierId), name: "(χειροκίνητο)" };
  } else if (isInvoice) {
    // ΤΙΜΟΛΟΓΙΟ → ΠΑΝΤΑ με προμηθευτή. 1ο ΑΦΜ από το χαρτί (αξιόπιστο),
    // 2ο όνομα καταστήματος (ενδεικτικό — τα brands συχνά διαφέρουν από τον εκδότη).
    const byVat = await findSupplierByVat(opts.vat || (raw0.invoice && raw0.invoice.vat));
    const found = byVat || await findSupplier(c.merchant);
    if (found) sup = found;
    else supWarn = "ΤΙΜΟΛΟΓΙΟ ΧΩΡΙΣ ΠΡΟΜΗΘΕΥΤΗ — χρειάζεται άνοιγμα προμηθευτή"
      + ((raw0.invoice && raw0.invoice.vat) ? ` (ΑΦΜ ${raw0.invoice.vat})` : "");
  }
  // ΑΠΟΔΕΙΞΗ → sup μένει null: περνάει καρφωτά, ακόμα κι αν υπάρχει προμηθευτής
  // με παρόμοιο όνομα. Δεν λερώνουμε καρτέλα προμηθευτή με λιανική.

  const payload = {
    date,
    currency_code: "EUR",
    custom_id: vivaTag(c.id), // μοναδικό «αποτύπωμα» → φύλακας διπλοεγγραφών
    supplier: sup ? sup.id : null,
    // Στο τιμολόγιο μπαίνει ο αρ. παραστατικού· στην απόδειξη το ίχνος της κάρτας.
    reference: String((isInvoice && invNo) || `Viva ••${card} ${c.project}`).slice(0, 60),
    items: [{
      expense_category: catId,
      description: String(opts.descr || desc).slice(0, 300),
      amount: amt.toFixed(2),
      taxes: [],
      project: null,
      billable: false,
    }],
  };
  if (opt) payload.trackingcategories = [{ trackingcategory: TRACKING_ID, option: opt }];

  const r = await elorus("POST", "expenses/", payload);
  if (r.status !== 201 && r.status !== 200) return { ok: false, error: `Elorus ${r.status}`, detail: r.body };
  const id = r.body && r.body.id;
  // Επισύναψε ΟΛΑ τα αρχεία (κύριο + πρόσθετα π.χ. μεταφορικά). Το κύριο γίνεται primary.
  const allUrls = receiptUrlsOf(raw0, c);
  const att = allUrls.length ? await attachAllReceipts(id, allUrls, store) : { ok: false, why: "no-receipt" };
  const rec = c.receipt_url ? await setExpenseReceipt(id, c.receipt_url) : { ok: false, why: "no-receipt" };
  // idempotency: κράτα elorus_id + attachment + πλήθος αρχείων στη χρέωση
  const newRaw = Object.assign({}, raw0, { elorus_id: id, elorus_at: new Date().toISOString(), elorus_cat: catId, elorus_option: opt || null, elorus_attachment: att.ok ? att.id : null, elorus_primary: !!att.primary, elorus_att_count: allUrls.length, elorus_supplier: sup ? sup.id : null, elorus_type: isInvoice ? "invoice" : "receipt" });
  await sbUpdate("charges", `id=eq.${encodeURIComponent(c.id)}`, { raw: newRaw });
  return { ok: true, id, category: catId, option: opt || null, attachment: att, receipt: rec, type: isInvoice ? "ΤΙΜΟΛΟΓΙΟ" : "ΑΠΟΔΕΙΞΗ", date, dateSrc, reference: invNo || null, supplier: sup, warn: supWarn };
}

async function walletInfo() {
  const map = {};
  try {
    const ws = await wallets();
    for (const w of (Array.isArray(ws) ? ws : [])) {
      const fn = w.friendlyName || "";
      const m = fn.match(/^(.*?)\s*(\d{4})$/);
      map[String(w.walletId)] = { name: NAMES[String(w.walletId)] || (m ? m[1] : fn).trim(), card: m ? m[2] : "" };
    }
  } catch (e) {}
  return map;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
    body = body || {};

    // ---- ΜΗΔΕΝΙΣΜΟΣ ΙΟΥΛΙΟΥ ΧΩΡΙΣ ΑΠΟΔΕΙΞΗ: ?voidJuly=1 (POST) ----
    // Κρατά τις χρεώσεις Ιουλίου που ΕΧΟΥΝ απόδειξη/PDF (για τη λογίστρια). Βγάζει ΕΚΤΟΣ
    // (soft-void, status=VOID_JULY) όσες ΔΕΝ έχουν τίποτα ανεβασμένο. ΔΕΝ διαγράφει —
    // αναστρέψιμο. ?voidJuly=1&dry=1 → μόνο προεπισκόπηση, χωρίς αλλαγή.
    if (q.voidJuly) {
      const vw = String(body.w || q.w || ""), vt = String(body.t || q.t || "");
      if (!(vw && verifyToken(vw, vt))) return res.status(403).json({ error: "Μη εξουσιοδοτημένο" });
      const dry = !!(q.dry || body.dry);
      const JUL_FROM = "2026-07-01T00:00:00", JUL_TO = "2026-08-01T00:00:00";
      // ΜΟΝΟ χρεώσεις Ιουλίου, ΧΩΡΙΣ απόδειξη. (Οι με απόδειξη μένουν ανέπαφες.)
      const flt = `occurred_at=gte.${JUL_FROM}&occurred_at=lt.${JUL_TO}&has_receipt=eq.false&status=neq.VOID_JULY&select=id,wallet_id,amount,merchant,occurred_at`;
      const rows = await sbSelect("charges", flt);
      const preview = (rows || []).slice(0, 8).map((r) => ({ id: r.id, amount: Math.abs(+r.amount), store: cleanName(r.merchant), date: grDate(r.occurred_at) }));
      if (dry) return res.status(200).json({ ok: true, dry: true, willVoid: (rows || []).length, sample: preview });
      // Εκτέλεση: bulk PATCH status → VOID_JULY (μία κλήση, με το ίδιο φίλτρο).
      const upd = await sbUpdate("charges", `occurred_at=gte.${JUL_FROM}&occurred_at=lt.${JUL_TO}&has_receipt=eq.false&status=neq.VOID_JULY`, { status: "VOID_JULY" });
      return res.status(200).json({ ok: !!upd.ok || upd.skipped ? undefined : true, ok2: true, voided: (rows || []).length, sample: preview, note: "Οι χρεώσεις Ιουλίου χωρίς απόδειξη βγήκαν εκτός (VOID_JULY). Οι με απόδειξη κρατήθηκαν. Αναστρέψιμο." });
    }

    // ---- ΑΝΑΦΟΡΑ ΕΚΚΡΕΜΟΤΗΤΩΝ (read-only): ?report=1 ----
    // Λέει σε απλά ελληνικά ΤΙ καταχωρήθηκε και ΤΙ έμεινε πίσω — με τον ΛΟΓΟ για το καθένα.
    if (q.report) {
      const rw = String(body.w || q.w || ""), rt = String(body.t || q.t || "");
      const cronOk2 = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
      if (!cronOk2 && !(rw && verifyToken(rw, rt))) return res.status(403).json({ error: "Μη εξουσιοδοτημένο" });

      const nameByWallet = await walletInfo();
      const EXCL2 = new Set(["901067108914"]);
      const ws2 = await wallets();
      const mem2 = (Array.isArray(ws2) ? ws2 : []).filter((x) => x.hasIssuedCard && !x.isPrimary && x.friendlyName && x.friendlyName !== "ακυρο" && !EXCL2.has(String(x.walletId))).map((x) => String(x.walletId));

      const registered = [], pending = [], problems = [];
      const perPerson = {}; // who -> {who, count, amount} — για σύνοψη εκκρεμοτήτων ανά άτομο
      for (const wid of mem2) {
        const info = nameByWallet[wid] || {};
        const who = info.name || wid;
        if (!perPerson[who]) perPerson[who] = { who, count: 0, amount: 0, nudges: 0, pilot: PILOT_WALLETS.has(String(wid)) };
        const startD = startForWallet(wid); // πιλοτικός → 16/7, αλλιώς → 1/8 (Ιουλίου «σβήνουν»)
        const raw = await sbSelectAll("charges", `wallet_id=eq.${wid}&order=occurred_at.desc,id.desc`);
        for (const c of dedupCharges(raw || [])) {
          if (athDate(c.occurred_at) < startD) continue;
          const amt = Math.abs(+c.amount).toFixed(2);
          const store = cleanName(c.merchant);
          const when = grDate(c.occurred_at);
          const base = { who, card: info.card || "", amount: +amt, store, date: when, charge: c.id };
          const r0 = c.raw || {};
          // ΚΑΝΟΝΑΣ: χρειάζονται ΚΑΙ χρέωση ΚΑΙ απόδειξη ΚΑΙ project
          const nud = (c.raw && c.raw.rem && +c.raw.rem.n) || 0;
          const addPend = (reason) => { pending.push({ ...base, reason }); perPerson[who].count++; perPerson[who].amount += +amt; if (nud > perPerson[who].nudges) perPerson[who].nudges = nud; };
          if (!c.has_receipt && !c.project) { addPend("λείπουν απόδειξη ΚΑΙ project"); continue; }
          if (!c.has_receipt) { addPend("λείπει η απόδειξη"); continue; }
          if (!c.project) { addPend("λείπει το project"); continue; }
          if (r0.elorus_id) {
            const kindR = docType(r0, pickCategory(c.merchant), {});
            const supR = r0.elorus_supplier && r0.elorus_supplier !== "none" ? r0.elorus_supplier : null;
            registered.push({ ...base, expense: r0.elorus_id, type: kindR === "invoice" ? "ΤΙΜΟΛΟΓΙΟ" : "ΑΠΟΔΕΙΞΗ", supplier: supR });
            // Δικλείδα και στην αναφορά: τιμολόγιο χωρίς προμηθευτή = πρόβλημα.
            if (kindR === "invoice" && !supR) {
              problems.push({ ...base, reason: "τιμολόγιο χωρίς προμηθευτή — θέλει άνοιγμα προμηθευτή στο Elorus" + ((r0.invoice && r0.invoice.vat) ? ` (ΑΦΜ ${r0.invoice.vat})` : "") });
            }
            // Και το αντίστροφο: απόδειξη λιανικής δεν πρέπει να έχει προμηθευτή.
            if (kindR === "receipt" && supR) {
              problems.push({ ...base, reason: "απόδειξη λιανικής καταχωρημένη σε προμηθευτή — πρέπει να είναι καρφωτή" });
            }
            if (!r0.elorus_primary) problems.push({ ...base, reason: "η απόδειξη δεν φαίνεται στη δεξιά προβολή του εξόδου" });
          } else {
            problems.push({ ...base, reason: "ολοκληρωμένο αλλά ΔΕΝ πέρασε στο Elorus" });
          }
        }
      }

      const L = [];
      L.push(`📊 Έξοδα LGB — ${new Intl.DateTimeFormat("el-GR", { timeZone: "Europe/Athens", dateStyle: "short", timeStyle: "short" }).format(new Date())}`);
      L.push(`✅ Καταχωρημένα στο Elorus: ${registered.length}`);
      if (pending.length) {
        L.push(``, `⏳ Εκκρεμούν ${pending.length} — περιμένουν τον υπάλληλο:`);
        for (const p of pending) L.push(`   • ${p.who} — ${p.amount}€ ${p.store} (${p.date}): ${p.reason}`);
      } else L.push(``, `⏳ Καμία εκκρεμότητα — όλοι έχουν ανεβάσει απόδειξη + project.`);
      if (problems.length) {
        L.push(``, `⚠️ Θέλουν δική σου προσοχή (${problems.length}):`);
        for (const p of problems) L.push(`   • ${p.who} — ${p.amount}€ ${p.store} (${p.date}): ${p.reason}`);
      }
      L.push(``, `Κανόνας: τίποτα δεν καταχωρείται χωρίς χρέωση + απόδειξη + project.`);

      // Σύνοψη εκκρεμοτήτων ανά άτομο (όλοι, ακόμα κι όσοι έχουν 0) — ταξινομημένη φθίνουσα.
      const pendingByPerson = Object.values(perPerson).sort((a, b) => b.count - a.count || b.amount - a.amount)
        .map((p) => ({ who: p.who, count: p.count, amount: +p.amount.toFixed(2), nudges: p.nudges, pilot: p.pilot }));

      return res.status(200).json({
        ok: true, generatedAt: new Date().toISOString(),
        counts: { registered: registered.length, pending: pending.length, problems: problems.length },
        registered, pending, problems, pendingByPerson, text: L.join("\n"),
      });
    }

    // ---- ΔΕΥΤΕΡΟΣ AGENT (read-only): ?audit=1 ----
    // Ανεξάρτητος έλεγχος των καταχωρήσεων ΜΕΣΑ στο Elorus. Δεν γράφει/σβήνει τίποτα.
    if (q.audit) {
      const aw2 = String(body.w || q.w || ""), at2 = String(body.t || q.t || "");
      const cronOk = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
      if (!cronOk && !(aw2 && verifyToken(aw2, at2))) return res.status(403).json({ error: "Μη εξουσιοδοτημένο" });

      const byTag = new Map(), expById = new Map();
      // Δοκιμάζουμε 200/σελίδα· αν το Elorus γυρίσει άδειο (όριο/σφάλμα), fallback σε 50.
      let scanOk = false;
      for (const sz of [200, 50]) {
        expById.clear(); byTag.clear();
        for (let page = 1; page <= 6; page++) {
          const r = await elorus("GET", `expenses/?page_size=${sz}&page=${page}&ordering=-date`);
          const rows = (r.body && r.body.results) || [];
          for (const e of rows) {
            expById.set(String(e.id), e);
            const cid = String(e.custom_id || "");
            if (/^VIVA-/.test(cid)) { if (!byTag.has(cid)) byTag.set(cid, []); byTag.get(cid).push(e); }
          }
          if (!r.body || !r.body.next) break;
        }
        if (expById.size > 0) { scanOk = true; break; }
      }
      // ΔΙΚΛΕΙΔΑ: αν η σάρωση απέτυχε (0 έξοδα), ΔΕΝ βγάζουμε ψεύτικα «ΟΡΦΑΝΑ»/«διπλά».
      // Επιστρέφουμε ουδέτερο αποτέλεσμα ώστε να μη σκάσει λάθος συναγερμός στον Κώστα.
      if (!scanOk) {
        return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), scanFailed: true, elorusScanned: 0, ourEntries: 0, totalIssues: 0, issues: [], note: "Η ανάγνωση του Elorus δεν απάντησε αυτή τη στιγμή — παραλείπω τον έλεγχο για να μη βγει ψευδής συναγερμός. Θα ξαναγίνει στο επόμενο τρέξιμο." });
      }

      const issues = [];
      // (1) ΔΙΠΛΕΣ: ίδιο αποτύπωμα σε >1 έξοδα
      for (const [tag, list] of byTag) {
        if (list.length > 1) issues.push({ type: "ΔΙΠΛΗ_ΚΑΤΑΧΩΡΗΣΗ", tag, detail: `Η ίδια χρέωση (${tag}) έχει ${list.length} έξοδα`, expenses: list.map((e) => ({ id: e.id, date: e.date, total: e.total })) });
      }
      // (2) ΠΙΘΑΝΑ ΔΙΠΛΑ: ίδια ημ/νία + ίδιο ποσό όπου εμπλέκεται δική μας καταχώρηση
      const seen = new Map();
      for (const e of expById.values()) {
        const k = `${e.date}|${parseFloat(e.total).toFixed(2)}`;
        if (!seen.has(k)) seen.set(k, []); seen.get(k).push(e);
      }
      for (const [k, list] of seen) {
        if (list.length < 2) continue;
        const ours = list.filter((e) => /^VIVA-/.test(String(e.custom_id || "")));
        if (!ours.length) continue;
        const tags = new Set(ours.map((e) => e.custom_id));
        if (tags.size <= 1) {
          const [d, a] = k.split("|");
          issues.push({ type: "ΠΙΘΑΝΟ_ΔΙΠΛΟ", detail: `${list.length} έξοδα ${a}€ στις ${d}`, expenses: list.map((e) => ({ id: e.id, custom_id: e.custom_id || "(χειροκίνητο)", total: e.total })) });
        }
      }
      // (3) Οι χρεώσεις μας: ορφανά / δεν πέρασαν / χωρίς συνημμένο
      const EXCL = new Set(["901067108914"]);
      const wsA = await wallets();
      const mem = (Array.isArray(wsA) ? wsA : []).filter((x) => x.hasIssuedCard && !x.isPrimary && x.friendlyName && x.friendlyName !== "ακυρο" && !EXCL.has(String(x.walletId))).map((x) => String(x.walletId));
      let completed = 0, pushed = 0;
      for (const wid of mem) {
        const raw = await sbSelectAll("charges", `wallet_id=eq.${wid}&order=occurred_at.desc,id.desc`);
        for (const c of dedupCharges(raw || [])) {
          if (!c.has_receipt || !c.project) continue;
          completed++;
          const eid = c.raw && c.raw.elorus_id;
          if (!eid) { issues.push({ type: "ΔΕΝ_ΠΕΡΑΣΕ", charge: c.id, detail: `${Math.abs(+c.amount).toFixed(2)}€ ${cleanName(c.merchant)} — δεν έχει περάσει στο Elorus` }); continue; }
          pushed++;
          if (!expById.has(String(eid))) issues.push({ type: "ΟΡΦΑΝΟ", charge: c.id, expense: eid, detail: "Δείχνει σε έξοδο που δεν υπάρχει πια (διαγράφηκε)" });
          if (!(c.raw && c.raw.elorus_attachment)) issues.push({ type: "ΧΩΡΙΣ_ΣΥΝΗΜΜΕΝΟ", charge: c.id, expense: eid, detail: "Έξοδο χωρίς συνημμένη απόδειξη" });
        }
      }
      return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), elorusScanned: expById.size, ourEntries: byTag.size, completedCharges: completed, pushedCharges: pushed, totalIssues: issues.length, issues });
    }

    // ---- ΕΛΕΓΧΟΣ ΠΡΟΜΗΘΕΥΤΗ (read-only): ?supplier=Anthropic ----
    if (q.supplier) {
      const sw = String(body.w || q.w || ""), st = String(body.t || q.t || "");
      if (!sw || !verifyToken(sw, st)) return res.status(403).json({ error: "Μη εξουσιοδοτημένο" });
      const found = await findSupplier(String(q.supplier));
      const list = await allContacts();
      const nm = normName(String(q.supplier));
      const near = list.filter((c) => normName(c.company || c.display_name || "").includes(nm.split(" ")[0] || "___"))
        .slice(0, 10).map((c) => ({ id: c.id, name: c.company || c.display_name, is_supplier: !!c.is_supplier, vat: c.vat_number || "" }));
      return res.status(200).json({ query: q.supplier, match: found, near, totalContacts: list.length });
    }

    // ---- BULK: push όλων των eligible ----
    // Auth: Vercel cron header Ή έγκυρο member token (w,t) — το χρησιμοποιεί το κουμπί & το daily task.
    if (q.all || body.all) {
      const aw = String(body.w || q.w || ""), at = String(body.t || q.t || "");
      const ua = String(req.headers["user-agent"] || "");
      const isVercelCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(ua);
      const authed = isVercelCron || (aw && verifyToken(aw, at)) || String(q.secret || "") === String(process.env.ELORUS_PUSH_SECRET || "__none__");
      if (!authed) return res.status(403).json({ error: "Μη εξουσιοδοτημένο" });
      const nameByWallet = await walletInfo();
      // Πάρε τα μέλη (κάρτες), κάνε dedup ΑΝΑ κάρτα, μετά push μόνο τους representatives.
      const EXCLUDED = new Set(["901067108914"]);
      const ws = await wallets();
      const members = (Array.isArray(ws) ? ws : []).filter((x) => x.hasIssuedCard && !x.isPrimary && x.friendlyName && x.friendlyName !== "ακυρο" && !EXCLUDED.has(String(x.walletId))).map((x) => String(x.walletId));
      const out = []; let scanned = 0;
      // [25/9] Πρώτα ΟΛΕΣ οι ολοκληρωμένες που ΔΕΝ έχουν περάσει ακόμα, μετά (αν περισσεύει χρόνος) επαλήθευση των παλιών.
      //   Πριν: σειρά ανά κάρτα → η συνάρτηση κοβόταν στα 60″ και οι τελευταίες κάρτες δεν περνούσαν ποτέ.
      const T0 = Date.now(), BUDGET = 35000;
      const todo = [];
      for (const wid of members) {
        const raw = await sbSelectAll("charges", `wallet_id=eq.${wid}&order=occurred_at.desc,id.desc`);
        for (const c of dedupCharges(raw || [])) if (c.has_receipt && c.project) todo.push(c);
      }
      todo.sort((a, b) => (!!(a.raw && a.raw.elorus_id) - !!(b.raw && b.raw.elorus_id)) || String(b.occurred_at).localeCompare(String(a.occurred_at)));
      for (const c of todo) {
        if (Date.now() - T0 > BUDGET) { out.push({ id: c.id, skipped: "time-budget" }); continue; }
        scanned++;
        // Το pushCharge επαληθεύει ότι το έξοδο υπάρχει ΟΝΤΩΣ στο Elorus και είναι idempotent — δεν δημιουργεί διπλό.
        const r = await pushCharge(c, nameByWallet);
        out.push({ id: c.id, ...r });
      }
      const created = out.filter((x) => x.ok && !x.skipped).length;
      const attached = out.filter((x) => x.skipped === "attach-only").length;
      return res.status(200).json({ ok: true, scanned, created, attached, results: out });
    }

    // ---- SINGLE: owner-authenticated ----
    const w = String(body.w || q.w || "");
    const t = String(body.t || q.t || "");
    const chargeId = body.chargeId || q.chargeId;
    if (!w || !verifyToken(w, t)) return res.status(403).json({ error: "Άκυρο link" });
    if (!chargeId) return res.status(400).json({ error: "λείπει chargeId" });

    const rows = await sbSelect("charges", `id=eq.${encodeURIComponent(chargeId)}&select=*`);
    if (!rows.length) return res.status(404).json({ error: "δεν βρέθηκε η χρέωση" });
    const c = rows[0];
    if (String(c.wallet_id) !== w) return res.status(403).json({ error: "η χρέωση δεν είναι δική σου" });

    const nameByWallet = await walletInfo();
    const r = await pushCharge(c, nameByWallet, {
      force: !!(body.force || q.force),
      allowDup: !!(body.allowDup || q.allowDup),
      supplierId: body.supplierId || q.supplierId,
      reference: body.reference || q.reference,
      descr: body.descr || q.descr,
      date: body.date || q.date,
      vat: body.vat || q.vat,
      type: body.type || q.type,   // "invoice" | "receipt" — χειροκίνητη παράκαμψη
    });
    if (!r.ok && !r.skipped) return res.status(400).json(r);
    return res.status(200).json(r);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
