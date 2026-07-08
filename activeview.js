/**
 * activeview.js — Camada de acesso à ActiveView API
 * Reusa a lógica real do RULER (proxy + sanitize + normalização).
 * MBOLIVEIRAZ MEDIA & TECH
 */

const API_BASE = process.env.AV_API_BASE || "https://external-api.activeview.app";

// A ActiveView às vezes retorna NaN/Infinity literal (JSON inválido)
function sanitizeJSON(str) {
  return String(str)
    .replace(/:\s*NaN/g, ":null")
    .replace(/:\s*Infinity/g, ":null")
    .replace(/:\s*-Infinity/g, ":null")
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]");
}

async function avFetch(path, { method = "GET", body, bearer } = {}) {
  if (!bearer) {
    const e = new Error("Token da ActiveView ausente (bearer)");
    e.status = 401;
    throw e;
  }
  const auth = bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}`;
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(sanitizeJSON(raw));
  } catch {
    data = { raw: raw.slice(0, 500) };
  }
  if (!r.ok) {
    const e = new Error(data?.error || data?.message || `ActiveView HTTP ${r.status}`);
    e.status = r.status;
    e.body = data;
    throw e;
  }
  return data;
}

/**
 * Lê as price rules de um domínio (mesma normalização do ruler.html fetchRaw).
 * Retorna array de rules com: rule (floor), ecpm, impressions, revenue,
 * match_rate, desired_match_rate, aggressiveness, country, device,
 * request_uri, utm_source, ad_unit, enabled, ...
 */
async function getRules(network, domain, bearer) {
  const data = await avFetch(`/rules/${network}/${domain}`, { bearer });
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.response)
    ? data.response
    : data?.rules || [];
  return arr.map((r) => ({
    ...r,
    rule: r.rule ?? 0,
    ecpm: r.ecpm ?? 0,
    impressions: r.impressions ?? 0,
    revenue: r.revenue ?? 0,
    match_rate: r.match_rate ?? 0,
    desired_match_rate: r.desired_match_rate ?? 0,
    aggressiveness: r.aggressiveness ?? 1,
  }));
}

/**
 * Upsert de price rules (mesmo endpoint do RULER: POST /upsert/{network}/{domain}).
 * payload: array de rules a criar/atualizar.
 */
async function upsertRules(network, domain, payload, bearer) {
  if (!Array.isArray(payload) || !payload.length) {
    const e = new Error("Payload de upsert vazio — envie um array de rules");
    e.status = 400;
    throw e;
  }
  const data = await avFetch(`/upsert/${network}/${domain}`, {
    method: "POST",
    body: payload,
    bearer,
  });
  return data;
}

module.exports = { getRules, upsertRules, API_BASE };
