# @nimbai/mcp
Servidor MCP do NimbAI. Um único `createServer()` registra tools, resources e prompts; `bin/stdio` serve via `npx -y @nimbai/mcp`; `worker.ts` serve `/mcp` (Streamable HTTP) em Cloudflare Workers.
Tools (prefixo `nimbai_`): search_location, get_summary, get_forecast, get_alerts, get_satellite_latest, get_radar_latest, get_imagery_loop, get_lightning, get_severe_risk, get_sources_status.
