# RULER MCP — Price Floor Tools

Servidor MCP (JSON-RPC 2.0) que expõe as capacidades do RULER como ferramentas
pra agentes de IA (CORTEX, Claude Desktop, etc): leitura de price rules da
ActiveView, fill rate real por floor (eventos do TN Price Monitor) e
aplicação de floors com fluxo de confirmação.

## As 7 tools
| Tool | Tipo | O que faz |
|---|---|---|
| listar_price_rules | leitura | Rules da ActiveView com eCPM, revenue, match_rate por regra |
| performance_floors | leitura | Fill rate real por floor (blocos uri+país+device+utm com cascata) |
| eventos_recentes | leitura | Últimos eventos brutos do TN Price Monitor |
| listar_sites_monitorados | leitura | Sites com eventos coletados |
| historico_ajustes | leitura | Auditoria: quem mudou o quê e quando |
| sugerir_floor | análise | Sugestões de ajuste (não aplica nada) |
| aplicar_floor | AÇÃO | Upsert na ActiveView — exige confirm=true; sem ele, retorna preview |

## Autenticação (duas camadas)
1. **Acesso ao MCP**: header `Authorization: Bearer <token>` — tokens definidos em `RULER_MCP_TOKENS`
2. **ActiveView**: cada tool que fala com a AV recebe `av_bearer` como argumento — cada gestor usa a própria key

## Fluxo de segurança do aplicar_floor
- Sem `confirm: true` → retorna **preview** (o que seria aplicado) e NÃO executa
- Com `confirm: true` → aplica o upsert, grava snapshot anterior + mudança no histórico (com `actor`)
- O agente que consumir este MCP deve SEMPRE mostrar o preview ao gestor e só confirmar após aprovação explícita

## Arquitetura de dados
O ruler-mcp NÃO acessa o SQLite do RULER diretamente. Ele lê os eventos VIA HTTP
dos endpoints que o RULER já expõe (`/v1/events/_stats`, `_recent`, `_sites`).
O RULER continua dono do banco; o MCP é um consumidor stateless.
Só o HISTÓRICO de ajustes de floor é um SQLite próprio do MCP.

## Deploy no Railway (repo separado do RULER)
1. Crie um repo novo (ex: `ruler-mcp`), suba este código e conecte no Railway
2. Variáveis: `RULER_MCP_TOKENS`, `RULER_APP_URL` (URL do RULER no Railway), `HIST_DB_PATH=/data/ruler-mcp-history.db`
3. **Volume (recomendado)**: monte um volume em `/data` pro histórico de ajustes persistir entre deploys
4. Generate Domain → o endpoint MCP fica em `https://SEU-APP.up.railway.app/api/mcp`

## Conectar no CORTEX
Adicionar como segundo MCP no CLAUDE.md/config: URL do endpoint + token do gestor.
As tools da AV pedem `network` e `domain` — o gestor informa (não há descoberta automática).

## Requisitos
Node >= 22 (usa `node:sqlite` nativo — zero dependência de compilação).

## Rodar local
```bash
npm install
npm start
# POST http://localhost:8080/api/mcp  (JSON-RPC: initialize, tools/list, tools/call)
```
