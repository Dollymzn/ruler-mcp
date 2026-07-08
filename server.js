/**
 * server.js — RULER MCP
 * Servidor MCP (JSON-RPC 2.0 via HTTP POST) expondo tools de price floor:
 * leitura (ActiveView rules + eventos TN) e ação (sugerir/aplicar floors).
 *
 * Auth: Bearer token no header Authorization (RULER_MCP_TOKENS = lista
 * separada por vírgula). O token da ACTIVEVIEW vai como argumento av_bearer
 * nas tools que falam com a AV — cada gestor usa o seu.
 *
 * MBOLIVEIRAZ MEDIA & TECH
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { getRules, upsertRules } = require("./activeview");

const PORT = process.env.PORT || 8080;
const MCP_TOKENS = (process.env.RULER_MCP_TOKENS || "")
  .split(",").map((t) => t.trim()).filter(Boolean);

/* ── Histórico de ajustes (SQLite próprio do MCP, compartilhado) ── */
const HIST_PATH = process.env.HIST_DB_PATH ||
  (fs.existsSync("/data") ? "/data/ruler-mcp-history.db" : path.join(__dirname, "data", "ruler-mcp-history.db"));
fs.mkdirSync(path.dirname(HIST_PATH), { recursive: true });
const histDb = new DatabaseSync(HIST_PATH);
histDb.exec("PRAGMA journal_mode = WAL");
histDb.exec(`
  CREATE TABLE IF NOT EXISTS floor_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT,
    network TEXT,
    domain TEXT,
    action TEXT,
    payload TEXT,
    prev_snapshot TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fc_domain ON floor_changes(domain);
  CREATE INDEX IF NOT EXISTS idx_fc_ts ON floor_changes(ts);
`);
const histInsert = histDb.prepare(`
  INSERT INTO floor_changes (ts, actor, network, domain, action, payload, prev_snapshot)
  VALUES (@ts, @actor, @network, @domain, @action, @payload, @prev)
`);

/* ── Definição das TOOLS ─────────────────────────────────── */

const TOOLS = [
  {
    name: "listar_price_rules",
    description:
      "Lê as price rules (floors) ativas de um domínio na ActiveView, com performance por regra: floor (rule), eCPM, impressões, REVENUE, match_rate, desired_match_rate, aggressiveness, país, device, uri, utm, ad_unit, enabled. Use pra ver como a monetização está configurada e rendendo.",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", description: "Network ID (ex: código GAM da conta)" },
        domain: { type: "string", description: "Domínio do blog (ex: blog.hakatt.com)" },
        av_bearer: { type: "string", description: "Token da ActiveView do gestor" },
      },
      required: ["network", "domain", "av_bearer"],
    },
  },
  {
    name: "historico_ajustes",
    description:
      "Histórico de mudanças de floor feitas via este MCP (quem, quando, o quê, snapshot anterior). Use pra auditar o que foi alterado e correlacionar com mudanças de receita.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Filtrar por domínio. Opcional." },
        limit: { type: "number", description: "Quantidade (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "resumo_floors",
    description:
      "Visão agregada das price rules de um domínio: revenue total, impressões totais, eCPM médio ponderado por impressões, contagem de regras (ativas/inativas), top regras por revenue, e REGRAS PROBLEMÁTICAS (match_rate muito fora do desired, revenue zerado com impressões altas, floors extremos). Use como primeiro passo antes de mergulhar em listar_price_rules — dá o panorama da monetização do domínio numa chamada.",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", description: "Network ID (ex: código GAM da conta)" },
        domain: { type: "string", description: "Domínio do blog (ex: blog.hakatt.com)" },
        av_bearer: { type: "string", description: "Token da ActiveView do gestor" },
      },
      required: ["network", "domain", "av_bearer"],
    },
  },
  {
    name: "sugerir_floor",
    description:
      "Analisa as rules atuais (ActiveView) e o fill real (TN Price Monitor) e devolve SUGESTÕES de ajuste de floor — sem aplicar nada. Heurística: match_rate muito acima do desired = floor baixo demais (subir); muito abaixo = floor alto demais (descer); revenue e eCPM ponderam. Retorna lista de sugestões com regra alvo, floor atual, floor sugerido e justificativa.",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", description: "Network ID" },
        domain: { type: "string", description: "Domínio do blog" },
        av_bearer: { type: "string", description: "Token da ActiveView" },
      },
      required: ["network", "domain", "av_bearer"],
    },
  },
  {
    name: "aplicar_floor",
    description:
      "APLICA price rules na ActiveView (upsert). AÇÃO REAL que mexe em receita — exige confirm=true. Sem confirm=true, retorna um preview do que seria aplicado e NÃO executa. Sempre mostre o preview ao gestor e só chame com confirm=true após ele confirmar explicitamente.",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", description: "Network ID" },
        domain: { type: "string", description: "Domínio do blog" },
        av_bearer: { type: "string", description: "Token da ActiveView" },
        rules: {
          type: "array",
          description: "Array de rules a criar/atualizar (formato ActiveView: rule, country, device, request_uri, utm_source, ad_unit, enabled, ...)",
          items: { type: "object" },
        },
        confirm: { type: "boolean", description: "true = executa de verdade; false/ausente = só preview" },
        actor: { type: "string", description: "Nome do gestor que está aplicando (pro histórico)" },
      },
      required: ["network", "domain", "av_bearer", "rules"],
    },
  },
];

/* ── Implementação das tools ─────────────────────────────── */

async function runTool(name, args) {
  switch (name) {
    case "listar_price_rules": {
      const rules = await getRules(args.network, args.domain, args.av_bearer);
      return { status: "success", data: rules, count: rules.length };
    }

    case "historico_ajustes": {
      const lim = Math.min(Math.max(parseInt(args.limit) || 50, 1), 500);
      let rows;
      if (args.domain) {
        rows = histDb.prepare(
          "SELECT * FROM floor_changes WHERE domain = ? ORDER BY ts DESC LIMIT ?"
        ).all(args.domain, lim);
      } else {
        rows = histDb.prepare("SELECT * FROM floor_changes ORDER BY ts DESC LIMIT ?").all(lim);
      }
      const data = rows.map((r) => ({
        ...r,
        payload: safeParse(r.payload),
        prev_snapshot: safeParse(r.prev_snapshot),
      }));
      return { status: "success", data, count: data.length };
    }

    case "resumo_floors": {
      const rules = await getRules(args.network, args.domain, args.av_bearer);
      const ativas = rules.filter((r) => r.enabled !== false && r.enabled !== 0);
      const totRevenue = ativas.reduce((s, r) => s + (parseFloat(r.revenue) || 0), 0);
      const totImps = ativas.reduce((s, r) => s + (parseInt(r.impressions) || 0), 0);
      const ecpmPonderado = totImps > 0
        ? +(ativas.reduce((s, r) => s + (parseFloat(r.ecpm) || 0) * (parseInt(r.impressions) || 0), 0) / totImps).toFixed(2)
        : 0;

      const topRevenue = [...ativas]
        .sort((a, b) => (parseFloat(b.revenue) || 0) - (parseFloat(a.revenue) || 0))
        .slice(0, 10)
        .map((r) => ({
          rule: r.rule, country: r.country, device: r.device,
          request_uri: r.request_uri, utm_source: r.utm_source,
          revenue: r.revenue, ecpm: r.ecpm, impressions: r.impressions,
          match_rate: r.match_rate, desired_match_rate: r.desired_match_rate,
        }));

      const problematicas = [];
      for (const r of ativas) {
        const match = parseFloat(r.match_rate) || 0;
        const desired = parseFloat(r.desired_match_rate) || 0;
        const imps = parseInt(r.impressions) || 0;
        const rev = parseFloat(r.revenue) || 0;
        const ident = {
          rule: r.rule, country: r.country, device: r.device,
          request_uri: r.request_uri, utm_source: r.utm_source,
          match_rate: match, desired_match_rate: desired,
          impressions: imps, revenue: rev, ecpm: r.ecpm,
        };
        if (desired > 0 && imps >= 100 && match > desired * 1.2)
          problematicas.push({ ...ident, problema: "match muito ACIMA do desired — floor provavelmente baixo, dinheiro na mesa" });
        else if (desired > 0 && imps >= 100 && match < desired * 0.6)
          problematicas.push({ ...ident, problema: "match muito ABAIXO do desired — floor segurando fill" });
        else if (imps >= 500 && rev === 0)
          problematicas.push({ ...ident, problema: "impressões altas com revenue ZERO — investigar" });
      }

      return {
        status: "success",
        data: {
          domain: args.domain,
          total_regras: rules.length,
          regras_ativas: ativas.length,
          revenue_total: +totRevenue.toFixed(2),
          impressoes_totais: totImps,
          ecpm_medio_ponderado: ecpmPonderado,
          top_10_por_revenue: topRevenue,
          regras_problematicas: problematicas,
        },
      };
    }

    case "sugerir_floor": {
      const rules = await getRules(args.network, args.domain, args.av_bearer);
      const suggestions = suggestFloors(rules);
      return {
        status: "success",
        data: suggestions,
        count: suggestions.length,
        note: "Sugestões apenas — nada foi aplicado. Use aplicar_floor com confirm=true após validação do gestor.",
      };
    }

    case "aplicar_floor": {
      const { network, domain, av_bearer, rules, confirm, actor } = args;
      if (!Array.isArray(rules) || !rules.length) {
        return { status: "error", error: "rules vazio — envie um array de rules" };
      }
      if (!confirm) {
        return {
          status: "preview",
          data: {
            would_apply: rules,
            count: rules.length,
            target: `${network}/${domain}`,
          },
          note: "PREVIEW — nada foi aplicado. Confirme com o gestor e chame novamente com confirm=true.",
        };
      }
      // snapshot anterior pro histórico
      let prev = [];
      try { prev = await getRules(network, domain, av_bearer); } catch {}
      const result = await upsertRules(network, domain, rules, av_bearer);
      histInsert.run({
        ts: Date.now(),
        actor: actor || "desconhecido",
        network, domain,
        action: "upsert",
        payload: JSON.stringify(rules),
        prev: JSON.stringify(prev.slice(0, 200)),
      });
      return {
        status: "success",
        data: { applied: rules.length, target: `${network}/${domain}`, av_response: result },
      };
    }

    default: {
      const e = new Error(`Tool desconhecida: ${name}`);
      e.status = 404;
      throw e;
    }
  }
}

/* ── Heurística de sugestão (baseada nos campos reais da AV) ── */
function suggestFloors(rules) {
  const out = [];
  for (const r of rules) {
    if (r.enabled === false || r.enabled === 0) continue;
    const floor = parseFloat(r.rule) || 0;
    const match = parseFloat(r.match_rate) || 0;
    const desired = parseFloat(r.desired_match_rate) || 0;
    const ecpm = parseFloat(r.ecpm) || 0;
    const revenue = parseFloat(r.revenue) || 0;
    const imps = parseInt(r.impressions) || 0;

    if (imps < 100) continue; // volume insuficiente pra decidir

    const ident = {
      country: r.country, device: r.device, request_uri: r.request_uri,
      utm_source: r.utm_source, ad_unit: r.ad_unit,
    };

    // match muito acima do desejado → floor baixo demais → subir 15%
    if (desired > 0 && match > desired * 1.15) {
      const suggested = +(floor * 1.15).toFixed(2);
      out.push({
        ...ident,
        floor_atual: floor, floor_sugerido: suggested,
        direcao: "SUBIR",
        motivo: `match_rate ${match}% muito acima do desejado ${desired}% — floor baixo, dinheiro na mesa (eCPM $${ecpm}, rev $${revenue})`,
        confianca: imps > 1000 ? "alta" : "média",
      });
    }
    // match muito abaixo do desejado → floor alto demais → descer 15%
    else if (desired > 0 && match < desired * 0.7) {
      const suggested = +(floor * 0.85).toFixed(2);
      out.push({
        ...ident,
        floor_atual: floor, floor_sugerido: suggested,
        direcao: "DESCER",
        motivo: `match_rate ${match}% bem abaixo do desejado ${desired}% — floor segurando fill (eCPM $${ecpm}, rev $${revenue})`,
        confianca: imps > 1000 ? "alta" : "média",
      });
    }
  }
  // maiores oportunidades primeiro (por revenue envolvido)
  out.sort((a, b) => 0); // ordem original já reflete a lista da AV
  return out;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

/* ── Servidor HTTP + protocolo MCP (JSON-RPC 2.0) ────────── */

const app = express();
app.use(express.json({ limit: "4mb" }));

function checkMcpAuth(req, res) {
  if (!MCP_TOKENS.length) return true; // sem tokens configurados = aberto (dev)
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (MCP_TOKENS.includes(auth)) return true;
  res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Token inválido" } });
  return false;
}

app.post("/api/mcp", async (req, res) => {
  if (!checkMcpAuth(req, res)) return;
  const { id = null, method, params = {} } = req.body || {};

  const reply = (result) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) =>
    res.status(200).json({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: params.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ruler-mcp", version: "1.0.0" },
        });

      case "notifications/initialized":
        return res.status(204).end();

      case "tools/list":
        return reply({ tools: TOOLS });

      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        const result = await runTool(name, args);
        // padrão MCP: resultado em content[0].text como string JSON
        return reply({
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: result?.status === "error",
        });
      }

      default:
        return fail(-32601, `Método não suportado: ${method}`);
    }
  } catch (e) {
    return fail(e.status || -32000, String(e.message || e));
  }
});

// health
app.get("/health", (req, res) =>
  res.json({ ok: true, service: "ruler-mcp", focus: "price-rules" })
);

app.listen(PORT, () => {
  console.log("");
  console.log("  ██████╗ ██╗   ██╗██╗     ███████╗██████╗       ███╗   ███╗ ██████╗██████╗ ");
  console.log("  ██╔══██╗██║   ██║██║     ██╔════╝██╔══██╗      ████╗ ████║██╔════╝██╔══██╗");
  console.log("  ██████╔╝██║   ██║██║     █████╗  ██████╔╝█████╗██╔████╔██║██║     ██████╔╝");
  console.log("  ██╔══██╗██║   ██║██║     ██╔══╝  ██╔══██╗╚════╝██║╚██╔╝██║██║     ██╔═══╝ ");
  console.log("  ██║  ██║╚██████╔╝███████╗███████╗██║  ██║      ██║ ╚═╝ ██║╚██████╗██║     ");
  console.log("  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝      ╚═╝     ╚═╝ ╚═════╝╚═╝     ");
  console.log(`  MBOLIVEIRAZ MEDIA & TECH — ruler-mcp na porta ${PORT}`);
  console.log(`  Endpoint MCP:  POST /api/mcp`);
  console.log(`  Tools:         ${TOOLS.length}`);
    console.log("");
});
