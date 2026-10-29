# NimbAI

**Inteligência meteorológica para agentes de IA e para pessoas.**
Um servidor MCP open source (MIT) que entrega, em tempo quase real, imagens de satélite, radar e raios, previsões, alertas oficiais e risco de tempo severo a qualquer harness (Claude Desktop/Code, Codex/ChatGPT, Hermes Agent, OpenClaw, Kimi, Cursor, Gemini CLI, VS Code) — e um site com mapa, camadas animadas de 24 h e um assistente de IA que explica e navega.

> Status: em construção (Fase 1 — MCP MVP). Nada aqui substitui avisos oficiais. Não use para proteção de vida ou propriedade.

## Usar o MCP (local, sem chaves)

```bash
npx -y @nimbai/mcp
```

Claude Desktop / Claude Code (`.mcp.json`):
```json
{ "mcpServers": { "nimbai": { "command": "npx", "args": ["-y", "@nimbai/mcp"] } } }
```
Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.nimbai]
command = "npx"
args = ["-y", "@nimbai/mcp"]
```
Hermes (`~/.hermes/config.yaml`), OpenClaw (`openclaw mcp set nimbai …`), Kimi (`~/.kimi-code/mcp.json`), Cursor (`.cursor/mcp.json`), Gemini CLI (`~/.gemini/settings.json`): mesmo comando `npx -y @nimbai/mcp`. Servidor remoto (com conta): `https://api.nimbai.app/mcp`.

Skill para o modelo: `npx skills add nimbai-app/nimbai` (instala `skills/nimbai`).

## Tools
`nimbai_search_location` · `nimbai_get_summary` · `nimbai_get_forecast` · `nimbai_get_alerts` · `nimbai_get_satellite_latest` · `nimbai_get_radar_latest` · `nimbai_get_imagery_loop` · `nimbai_get_lightning` · `nimbai_get_sounding` · `nimbai_get_severe_risk` · `nimbai_get_sources_status`
Toda resposta traz `valid_time`, `bbox`, `source` e `attribution`; imagens vêm como miniatura inline + link em alta resolução.

## Fontes
Só fontes com uso comercial permitido (NOAA/NWS, NASA GIBS, EUMETSAT Core, ECMWF Open Data, DWD, ECCC, MeteoAlarm, INMET, Open-Meteo…). Lista e textos de atribuição em `ATTRIBUTIONS.md`. Fontes condicionais ficam desligadas por padrão e exigem sua própria chave (BYOK) — ver `.env.example`.

## Estrutura
`packages/core` (adaptadores) · `packages/mcp` (servidor MCP: stdio + Workers) · `apps/api` (Hono/Workers) · `apps/web` (MapLibre + deck.gl) · `services/ingest` (Python) · `skills/nimbai` (SKILL.md)

## Licença
MIT © 2026 Alexandre Brotto. Os dados têm termos próprios (ver `ATTRIBUTIONS.md`).
