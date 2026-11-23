# @nimbai/mcp

The NimbAI MCP server: weather intelligence from official public sources — forecasts, official
alerts reproduced verbatim, satellite and radar imagery, satellite lightning density and
severe-weather risk — for any MCP-capable agent.

A single `createServer()` registers the tools; `bin/stdio.ts` serves them over stdio. No API key
is needed: every source in this phase is free and open.

## Tools

All eleven are read-only (`readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`) and
return both a text mirror and `structuredContent`, so clients that do not support structured
results still get a usable answer.

| Tool | Minimum input | Returns |
|---|---|---|
| `nimbai_search_location` | `query`, or `lat`+`lon` | `candidates[]` with id, name, admin, country, lat/lon, timezone |
| `nimbai_get_summary` | `lat`+`lon` or `bbox` | `observed`, `modelled`, `forecast`, `alerts[]`, `alerts_coverage` |
| `nimbai_get_forecast` | `lat`+`lon` or `bbox` | `forecast` series with model, times and variables |
| `nimbai_get_alerts` | `lat`+`lon` or `bbox` | `alerts[]` with verbatim official text, `coverage` |
| `nimbai_get_satellite_latest` | `lat`+`lon` or `bbox` | `image`, `satellite`, `coverage` |
| `nimbai_get_radar_latest` | `lat`+`lon` or `bbox` | `image`, `sites[]`, `coverage`, `gaps[]` |
| `nimbai_get_imagery_loop` | `layer` + a place | `frames[]` (chronological, ≤24), `coverage` |
| `nimbai_get_lightning` | `lat`+`lon` or `bbox` | `image` or `null`, `caveat`, `coverage`, `gaps[]` |
| `nimbai_get_sounding` | `lat`+`lon` or `bbox` | `sounding` with `levels[]`, `thermodynamics`, `kinematics`, `model`, `gaps[]` |
| `nimbai_get_severe_risk` | `lat`+`lon` or `bbox` | `items[]` by risk kind, `coverage`, `gaps[]` |
| `nimbai_get_sources_status` | — | `statuses[]` with reachability and typical latency |

Errors come back as `isError: true` with `{ error, next_steps }`. `next_steps` tells the model what
to do instead, so it does not retry the same failing call.

## What this phase does not do

Honesty about gaps is a product requirement, not a disclaimer. Every tool that can be short on
coverage returns `coverage` (and, where the table above says so, `gaps[]`),
and this phase in particular:

- **Lightning is gridded satellite flash density, not strike detection.** No counts, no
  "nearest strike", no trend — those need our own ingestion and arrive in a later phase. Never
  present it as a lightning-safety service.
- **The global "favourable environment" layer (STP/SCP) does not exist yet.** Severe risk is
  limited to official warnings and official outlooks where the authority publishes them.
- **Radar is not global.** No free, commercially usable global radar mosaic exists; see
  `ATTRIBUTIONS.md`. Where NimbAI knows who does operate radar over a point it cannot serve
  (Argentina: SMN/SINARAME and OHMC; Brazil: REDEMET/DECEA), the error names that service so the
  user can open it themselves. NimbAI does not serve their imagery: none of them publishes terms
  that permit it.
- **The sounding is a model sounding.** No radiosonde is launched. `nimbai_get_sounding` keeps the
  model's own CAPE/CIN/LI in `model` and what NimbAI computed from the ~19 reported levels in
  `thermodynamics`/`kinematics`; the two differ and neither corrects the other. Composite indices
  (STP, SCP, SHIP) are absent because they have no validated Southern Hemisphere formulation.
- An absent alert is not an absent risk, and the tools say so rather than implying all-clear.

## Install

**This package is not published to npm yet**, so install it from a checkout. Requires Node >= 22
and pnpm 10.

```bash
git clone https://github.com/brotto/nimbai.git
cd nimbai
pnpm install
pnpm build
```

The build produces `packages/mcp/dist/bin/stdio.js`. Use its **absolute path** below.

### Claude Code

```bash
claude mcp add nimbai -- node /path/to/nimbai/packages/mcp/dist/bin/stdio.js
```

### Claude Desktop, Cursor, Gemini CLI, VS Code (JSON)

Codex uses TOML and Hermes YAML — see the root README.

Add to the harness's MCP config:

```json
{
  "mcpServers": {
    "nimbai": {
      "command": "node",
      "args": ["/path/to/nimbai/packages/mcp/dist/bin/stdio.js"],
      "env": { "NWS_USER_AGENT": "(your-app.example, you@example.com)" }
    }
  }
}
```

`NWS_USER_AGENT` is optional but recommended: the US National Weather Service API asks callers to
identify themselves with a contact, and rejects requests that carry no identifying User-Agent. It is a
contact string, not a credential.

## Skill

`skills/nimbai/SKILL.md` teaches a model when to call which tool, how to read an image's
`validTime`/`bbox`/`legend`, and the safety rules. Point your agent at that directory, or copy it in,
according to how it loads skills.

## Licence

MIT for the code. The **data** has its own terms — see `ATTRIBUTIONS.md` in the repository root.
Whoever operates the service is responsible for displaying the attribution each tool returns.
