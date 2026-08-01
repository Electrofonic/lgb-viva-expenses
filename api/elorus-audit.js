// ΔΕΥΤΕΡΟΣ AGENT — ανεξάρτητος ελεγκτής των καταχωρήσεων στο Elorus.
// Δεν καταχωρεί και δεν σβήνει ΤΙΠΟΤΑ. Μόνο ελέγχει και αναφέρει.
// Πιάνει: (1) ΔΙΠΛΕΣ καταχωρήσεις, (2) ορφανά (η χρέωση δείχνει σε σβησμένο έξοδο),
//         (3) χρεώσεις ολοκληρωμένες που ΔΕΝ πέρασαν, (4) έξοδα χωρίς συνημμένο/προμηθευτή.
// GET /api/elorus-audit?w=..&t=..   → { ok, totalIssues, issues:[...] }
const { sbSelect, verifyToken, wallets } = require("./_viva.js");

const BASE = "https://api.elorus.com/v1.1";
const ORG = process.env.ELORUS_ORG_ID || "2802338946946696842";
const EXCLUDED = new Set(["901067108914"]);

async function eg(path) {
  const key = process.env.ELORUS_API_KEY;
  if (!key) return { status: 0, body: { error: "Λείπει ELORUS_API_KEY" } };
  const r = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: `Token ${key}`, "X-Elorus-Organization": ORG, "Content-Type": "application/json" },
  });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 200); }
  return { status: r.status, body: b };
}

// --- ίδιο dedup με το push/dashboard ---
function athOffMin(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Athens", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000;
}
function fixDsTime(iso) { try { const w = new Date(iso); return new Date(w.getTime() - athOffMin(w) * 60000).toISOString(); } catch (e) { return iso; } }
function dedupCharges(rows) {
  rows = (rows || []).filter((r) => String(r && r.status) !== "VOID_JULY"); // μηδενισμένες Ιουλίου → εκτός
  const norm = (id) => String(id || "").replace(/^AUTH-/, "");
  const isDup = (m) => /Viva Wallet Card/i.test(m || "");
  rows = (rows || []).map((c) => isDup(c.merchant) ? { ...c, occurred_at: fixDsTime(c.occurred_at) } : { ...c });
  const byId = new Map();
  for (const c of rows) {
    const k = norm(c.viva_tx_id); const ex = byId.get(k);
    if (!ex) { byId.set(k, { ...c }); continue; }
    const m = { ...ex };
    if (isDup(m.merchant) && !isDup(c.merchant)) m.merchant = c.merchant;
    if (String(c.occurred_at || "") < String(m.occurred_at || "")) m.occurred_at = c.occurred_at;
    if (c.has_receipt) { m.has_receipt = true; m.receipt_url = c.receipt_url || m.receipt_url; }
    if (c.project) m.project = c.project;
    if (c.raw && c.raw.elorus_id) m.raw = c.raw;
    byId.set(k, m);
  }
  const list = [...byId.values()];
  const reals = list.filter((c) => !isDup(c.merchant));
  const dups = list.filter((c) => isDup(c.merchant)).sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || "")));
  const pool = {}; for (const r of reals) { const k = Math.abs(+r.amount).toFixed(2); (pool[k] = pool[k] || []).push(r); }
  const used = new Set(); const kept = [];
  for (const s of dups) {
    const k = Math.abs(+s.amount).toFixed(2);
    const cand = (pool[k] || []).filter((r) => !used.has(r) && String(r.occurred_at || "") <= String(s.occurred_at || "")).sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")));
    if (cand[0]) { used.add(cand[0]); if (s.has_receipt && !cand[0].has_receipt) { cand[0].has_receipt = true; cand[0].receipt_url = s.receipt_url; } if (s.project && !cand[0].project) cand[0].project = s.project; } else kept.push(s);
  }
  const km = new Map();
  for (const s of kept) { const k = Math.abs(+s.amount).toFixed(2); if (!km.has(k)) km.set(k, s); }
  return [...reals, ...km.values()];
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const isCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
    if (!isCron) {
      const w = String(q.w || ""), t = String(q.t || "");
      if (!w || !verifyToken(w, t)) return res.status(403).json({ error: "Μη εξουσιοδοτημένο" });
    }

    // 1) ΟΛΑ τα έξοδα του Elorus που έχουν δικό μας αποτύπωμα (custom_id = VIVA-*)
    const byTag = new Map();   // tag -> [expenses]
    const byId = new Map();    // expenseId -> expense
    for (let page = 1; page <= 6; page++) {
      const r = await eg(`expenses/?page_size=200&page=${page}&ordering=-date`);
      const rows = (r.body && r.body.results) || [];
      for (const e of rows) {
        byId.set(String(e.id), e);
        const cid = String(e.custom_id || "");
        if (/^VIVA-/.test(cid)) { if (!byTag.has(cid)) byTag.set(cid, []); byTag.get(cid).push(e); }
      }
      if (!r.body || !r.body.next) break;
    }

    const issues = [];

    // 2) ΔΙΠΛΕΣ: ίδιο custom_id σε πάνω από ένα έξοδο
    for (const [tag, list] of byTag) {
      if (list.length > 1) {
        issues.push({
          type: "DIPLI_KATAXORHSH", tag,
          detail: `Η ίδια χρέωση (${tag}) έχει ${list.length} έξοδα στο Elorus`,
          expenses: list.map((e) => ({ id: e.id, date: e.date, total: e.total })),
        });
      }
    }

    // 3) ΔΙΠΛΕΣ χωρίς αποτύπωμα: ίδια ημερομηνία + ίδιο ποσό (πιθανό χειροκίνητο διπλό)
    const seen = new Map();
    for (const e of byId.values()) {
      const k = `${e.date}|${parseFloat(e.total).toFixed(2)}`;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(e);
    }
    for (const [k, list] of seen) {
      if (list.length > 1) {
        const tags = new Set(list.map((e) => String(e.custom_id || "")).filter((x) => /^VIVA-/.test(x)));
        if (tags.size <= 1 && list.some((e) => /^VIVA-/.test(String(e.custom_id || "")))) {
          const [d, a] = k.split("|");
          issues.push({
            type: "PITHANO_DIPLO", detail: `${list.length} έξοδα με ίδιο ποσό ${a}€ στις ${d}`,
            expenses: list.map((e) => ({ id: e.id, custom_id: e.custom_id || "", total: e.total })),
          });
        }
      }
    }

    // 4) Οι δικές μας χρεώσεις: ορφανά + μη-περασμένα
    const ws = await wallets();
    const members = (Array.isArray(ws) ? ws : []).filter((x) => x.hasIssuedCard && !x.isPrimary && x.friendlyName && x.friendlyName !== "ακυρο" && !EXCLUDED.has(String(x.walletId))).map((x) => String(x.walletId));
    let completed = 0, pushed = 0;
    for (const wid of members) {
      const raw = await sbSelect("charges", `wallet_id=eq.${wid}&order=occurred_at.desc&limit=1000`);
      for (const c of dedupCharges(raw || [])) {
        if (!c.has_receipt || !c.project) continue;
        completed++;
        const eid = c.raw && c.raw.elorus_id;
        if (!eid) {
          issues.push({ type: "DEN_PERASE", charge: c.id, detail: `Ολοκληρωμένη χρέωση ${Math.abs(+c.amount).toFixed(2)}€ (${c.merchant}) δεν έχει περάσει στο Elorus` });
          continue;
        }
        pushed++;
        if (!byId.has(String(eid))) {
          issues.push({ type: "ORFANO", charge: c.id, expense: eid, detail: `Η χρέωση δείχνει σε έξοδο που δεν υπάρχει πια στο Elorus (διαγράφηκε)` });
        }
        if (!(c.raw && c.raw.elorus_attachment)) {
          issues.push({ type: "XORIS_SYNHMMENO", charge: c.id, expense: eid, detail: `Έξοδο χωρίς συνημμένη απόδειξη` });
        }
      }
    }

    issues.sort((a, b) => (a.type === "DIPLI_KATAXORHSH" ? -1 : 1));
    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      elorusExpensesScanned: byId.size,
      ourEntries: byTag.size,
      completedCharges: completed,
      pushedCharges: pushed,
      totalIssues: issues.length,
      issues,
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }
};
