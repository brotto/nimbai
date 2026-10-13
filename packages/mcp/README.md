# @nimbai/mcp

The NimbAI MCP server: weather intelligence from official public sources — forecasts, official
alerts reproduced verbatim, satellite and radar imagery, satellite lightning density and
severe-weather risk — for any MCP-capable agent.

A single `createServer()` registers the tools; `bin/stdio.ts` serves them over stdio. No API key
is needed: every source in this phase is free and open.

## Tools

All ten are read-only (`readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`) and
return both a text mirror and `structuredContent`, so clients that do not support structured
results still get a usable answer.

| Tool | Minimum input | Returns |
|---|---|---|
| `nimbai_search_location` | `query`, or `lat`+`lon` | `candidates[]` with id, name, admin, country, lat/lon, timezone |
| `nimbai_get_summary` | `lat`+`lon` or `bbox` | `current`, `forecast`, `alerts[]`, `alerts_coverage` |
| `nimbai_get_forecast` | `lat`+`lon` or `bbox` | `forecast` series with model, times and variables |
| `nimbai_get_alerts` | `lat`+`lon` or `bbox` | `alerts[]` with verbatim official text, `coverage` |
| `nimbai_get_satellite_latest` | `lat`+`lon` or `bbox` | `image`, `satellite`, `coverage` |
| `nimbai_get_radar_latest` | `lat`+`lon` or `bbox` | `image`, `sites[]`, `coverage`, `gaps[]` |
| `nimbai_get_imagery_loop` | `layer` + a place | `frames[]` (chronological, ≤24), `coverage` |
| `nimbai_get_lightning` | `lat`+`lon` or `bbox` | `image` or `null`, `caveat`, `coverage`, `gaps[]` |
| `nimbai_get_severe_risk` | `lat`+`lon` or `bbox` | `items[]` by risk kind, `coverage`, `gaps[]` |
| `nimbai_get_sources_status` | — | `statuses[]` with reachability and typical latency |

Errors come back as `isError: true` with `{ error, next_steps }`. `next_steps` tells the model what
to do instead, so it does not retry the same failing call.

## What this phase does not do

Honesty about gaps is a product requirement, not a disclaimer. Every tool that can be short on
coverage returns `coverage` and `gaps[]` saying so, and this phase in particular:

- **Lightning is gridded satellite flash density, not strike detection.** No counts, no
  "nearest strike", no trend — those need our own ingestion and arrive in a later phase. Never
  present it as a lightning-safety service.
- **The global "favourable environment" layer (STP/SCP) does not exist yet.** Severe risk is
  limited to official warnings and official outlooks where the authority publishes them.
- **Radar is not global.** No free, commercially usable global radar mosaic exists; see
  `ATTRIBUTIONS.md`.
- An absent alert is not an absent risk, and the tools say so rather than implying all-clear.

## Install

### Claude Code

```bash
claude mcp add nimbai -- npx -y @nimbai/mcp
```

### Claude Desktop, Codex, Cursor, Hermes, OpenClaw, Kimi, Gemini CLI, VS Code

Add to the harness's MCP config:

```json
{
  "mcpServers": {
    "nimbai": {
      "command": "npx",
      "args": ["-y", "@nimbai/mcp"],
      "env": { "NWS_USER_AGENT": "(your-app.example, you@example.com)" }
    }
  }
}
```

`NWS_USER_AGENT` is optional but recommended: the US National Weather Service API asks callers to
identify themselves with a contact, and sets lower limits for anonymous traffic. It is a contact
string, not a credential.

### From a checkout

```bash
pnpm install && pnpm --filter @nimbai/mcp build && node packages/mcp/dist/bin/stdio.js
```

## Skill

`skills/nimbai/SKILL.md` teaches a model when to call which tool, how to read an image's
`valid_time`/`bbox`/legend, and the safety rules. Install it in any agent that supports the
open skills format:

```bash
npx skills add brotto/nimbai
```

## Licence

MIT for the code. The **data** has its own terms — see `ATTRIBUTIONS.md` in the repository root.
Whoever operates the service is responsible for displaying the attribution each tool returns.
