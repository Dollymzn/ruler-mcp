/**
 * events.js — Leitura dos eventos do TN Price Monitor VIA HTTP do RULER
 * O RULER é o dono do SQLite; o ruler-mcp consome os endpoints de leitura
 * que o RULER já expõe (/v1/events/_stats, _recent, _sites).
 * Stateless: cada consulta abre, busca, fecha.
 * MBOLIVEIRAZ MEDIA & TECH
 */

const RULER_APP_URL = (process.env.RULER_APP_URL || "").replace(/\/+$/, "");

function hasEventsSource() {
  return !!RULER_APP_URL;
}

async function rulerFetch(pathname, params = {}) {
  if (!RULER_APP_URL) {
    const e = new Error("RULER_APP_URL não configurada — tools de eventos indisponíveis");
    e.status = 503;
    throw e;
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `${RULER_APP_URL}${pathname}${qs.toString() ? "?" + qs.toString() : ""}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.ok === false) {
      const e = new Error(data?.error || `RULER HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Lista de sites distintos com contagem de eventos. */
async function listSites() {
  const data = await rulerFetch("/v1/events/_sites");
  return data.sites || [];
}

/** Últimos N eventos (opcionalmente filtrando por site). */
async function recentEvents(site, limit = 50) {
  const data = await rulerFetch("/v1/events/_recent", { site, limit });
  return data.events || [];
}

/**
 * Agregação em blocos (uri+país+device+utm) com cascata de price_rules,
 * fill rate e duração de sessão — calculada pelo próprio RULER (_stats).
 */
async function floorStats(site, sinceMs, sort = "sessions") {
  const data = await rulerFetch("/v1/events/_stats", { site, since: sinceMs, sort });
  return { totals: data.totals, blocks: data.blocks };
}

module.exports = { hasEventsSource, listSites, recentEvents, floorStats, RULER_APP_URL };
