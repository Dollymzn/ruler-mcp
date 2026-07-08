# RULER MCP — Price Rules (ActiveView)

Servidor MCP (JSON-RPC 2.0) focado 100% nas price rules da ActiveView:
leitura, agregação, sugestão e aplicação de floors com fluxo de confirmação.
Feito pra agentes de IA (CORTEX, Claude Desktop) analisarem e ajustarem a
monetização junto com os dados de campanha.

## As 5 tools
| Tool | Tipo | O que faz |
|---|---|---|
| resumo_floors | leitura | Panorama do domínio: revenue total, eCPM ponderado, top 10 regras por revenue, REGRAS PROBLEMÁTICAS (match fora do desired, revenue zerado) |
| listar_price_rules | leitura | Todas as rules com floor, eCPM, revenue, impressões, match_rate, desired, país, device, uri, utm |
| historico_ajustes | leitura | Auditoria: quem mudou qual floor, quando, com snapshot anterior |
| sugerir_floor | análise | Sugestões SUBIR/DESCER com justificativa e confiança (match_rate vs desired) — não aplica nada |
| aplicar_floor | AÇÃO | Upsert na ActiveView — exige confirm=true; sem ele retorna preview e NÃO executa |

## Autenticação (duas camadas)
1. **Acesso ao MCP**: `Authorization: Bearer <token>` — tokens em `RULER_MCP_TOKENS`
2. **ActiveView**: cada tool recebe `av_bearer` como argumento — cada gestor usa a própria key. `network` e `domain` são informados pelo gestor.

## Fluxo de segurança do aplicar_floor
- Sem `confirm: true` → retorna **preview** e NÃO executa
- Com `confirm: true` → aplica, grava snapshot anterior + mudança + actor no histórico
- O agente deve SEMPRE mostrar o preview e só confirmar após aprovação explícita do gestor

## Deploy no Railway
1. Repo próprio (separado do RULER), conecta no Railway
2. Variáveis: `RULER_MCP_TOKENS`, `HIST_DB_PATH=/data/ruler-mcp-history.db`
3. Volume em `/data` (recomendado, pro histórico persistir)
4. Generate Domain → endpoint: `https://SEU-APP.up.railway.app/api/mcp`

## Requisitos
Node >= 22 (usa `node:sqlite` nativo pro histórico — zero compilação).

## Fluxo de análise recomendado (pro agente)
1. `resumo_floors` → panorama + problemas do domínio
2. `listar_price_rules` → detalhe das regras relevantes
3. `sugerir_floor` → propostas de ajuste
4. Cruzar com dados de campanha (moodlr-ops: roas_cross, analise_campanhas)
5. `aplicar_floor` sem confirm → preview → gestor aprova → confirm=true
6. `historico_ajustes` depois → correlacionar mudança × resultado
