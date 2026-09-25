// Κοινός Viva client για τα serverless functions.
// Env vars (ορίζονται στο Vercel): VIVA_CLIENT_ID, VIVA_CLIENT_SECRET,
// VIVA_MERCHANT_ID, VIVA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
let cache = { token: null, exp: 0 };

async function vivaToken() {
  if (cache.token && Date.now() < cache.exp - 60_000) return cache.token;
  const basic = Buffer.from(
    `${process.env.VIVA_CLIENT_ID}:${process.env.VIVA_CLIENT_SECRET}`
  ).toString("base64");
  const r = await fetch("https://accounts.vivapayments.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`viva token: ${r.status}`);
  const j = await r.json();
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cache.token;
}

async function wallets() {
  const t = await vivaToken();
  const r = await fetch("https://api.vivapayments.com/merchants/v1/wallets", {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!r.ok) throw new Error(`viva wallets: ${r.status}`);
  return r.json();
}

// Κλειδί επαλήθευσης webhook (η Viva κάνει GET στο URL και περιμένει {Key})
async function webhookKey() {
  const basic = Buffer.from(
    `${process.env.VIVA_MERCHANT_ID}:${process.env.VIVA_API_KEY}`
  ).toString("base64");
  const r = await fetch("https://www.vivapayments.com/api/messages/config/token", {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!r.ok) throw new Error(`viva webhook key: ${r.status}`);
  return r.json(); // {Key: "..."}
}

// --- Supabase (προαιρετικό μέχρι να στηθεί) ---
function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function sbInsert(table, row, onConflict) {
  const c = sb();
  if (!c) return { skipped: true };
  const q = onConflict ? `?on_conflict=${onConflict}` : "";
  const r = await fetch(`${c.url}/rest/v1/${table}${q}`, {
    method: "POST",
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  return { ok: r.ok, status: r.status };
}

async function sbSelect(table, query = "") {
  const c = sb();
  if (!c) return [];
  const r = await fetch(`${c.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}` },
  });
  if (!r.ok) return [];
  return r.json();
}

// [25/9] Φέρνει ΟΛΕΣ τις γραμμές σε σελίδες των 1000 (το Supabase κόβει στις 1000 σιωπηλά).
async function sbSelectAll(table, query = "") {
  const c = sb();
  if (!c) return [];
  const out = [];
  for (let off = 0; off < 50000; off += 1000) {
    const r = await fetch(`${c.url}/rest/v1/${table}?${query}&limit=1000&offset=${off}`, {
      headers: { apikey: c.key, Authorization: `Bearer ${c.key}` },
    });
    if (!r.ok) throw new Error(`sb ${table} ${r.status}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// Ενημέρωση γραμμής (π.χ. ορισμός project από τον CFO). filter π.χ. "id=eq.42"
async function sbUpdate(table, filter, patch) {
  const c = sb();
  if (!c) return { skipped: true };
  const r = await fetch(`${c.url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  const body = r.ok ? await r.json() : null;
  return { ok: r.ok, status: r.status, row: body && body[0] };
}

// --- Προσωπικό token ανά κάρτα (deterministic — δεν χρειάζεται πίνακας) ---
// token = HMAC(service_key, "me:"+walletId) → 16 hex. Χωρίς service key δεν βγαίνει.
const crypto = require("crypto");
function personToken(walletId) {
  const key = process.env.SUPABASE_SERVICE_KEY || "dev-secret";
  return crypto.createHmac("sha256", key).update("me:" + String(walletId)).digest("hex").slice(0, 16);
}
function verifyToken(walletId, token) {
  const good = personToken(walletId);
  // σύγκριση σταθερού χρόνου
  return token && token.length === good.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(good));
}

// --- Supabase Storage: αποθήκευση φωτογραφίας απόδειξης ---
async function sbEnsureBucket(bucket) {
  const c = sb();
  if (!c) return;
  await fetch(`${c.url}/storage/v1/bucket`, {
    method: "POST",
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: bucket, name: bucket, public: true }),
  }).catch(() => {}); // αν υπάρχει ήδη, αγνόησε
}
async function sbUploadReceipt(path, bytes, contentType) {
  const c = sb();
  if (!c) return { skipped: true };
  await sbEnsureBucket("receipts");
  const r = await fetch(`${c.url}/storage/v1/object/receipts/${path}`, {
    method: "POST",
    headers: {
      apikey: c.key, Authorization: `Bearer ${c.key}`,
      "Content-Type": contentType || "image/jpeg", "x-upsert": "true",
    },
    body: bytes,
  });
  if (!r.ok) return { ok: false, status: r.status, err: await r.text().catch(() => "") };
  return { ok: true, url: `${c.url}/storage/v1/object/public/receipts/${path}` };
}

module.exports = { sbSelectAll,
  vivaToken, wallets, webhookKey, sbInsert, sbSelect, sbUpdate,
  personToken, verifyToken, sbUploadReceipt,
};
