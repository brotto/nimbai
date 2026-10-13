# Referência rápida das tools (rascunho — atualizar com os outputSchema reais)

| Tool | Entrada mínima | Campos-chave da saída |
|---|---|---|
| nimbai_search_location | `query` | `candidates[] {id, name, admin, country, lat, lon, bbox}` |
| nimbai_get_summary | `location`, `detail` | `current`, `next_hours[]`, `alerts_active[]`, `sources[]` |
| nimbai_get_forecast | `location`, `hours` ou `days`, `model?` | `series[]`, `model`, `run_time` |
| nimbai_get_alerts | `bbox` ou `location` | `alerts[] {headline, severity, event, onset, expires, source, url, text}` |
| nimbai_get_satellite_latest | `region` ou `bbox`, `product` | `image`, `image_url`, `valid_time`, `bbox`, `satellite`, `attribution` |
| nimbai_get_radar_latest | `bbox` ou `location` | idem + `radars[] {id, name, lat, lon, range_km, status}` |
| nimbai_get_imagery_loop | `layer`, `bbox`, `frames` | `frames[] {valid_time, image_url}`, `cursor` |
| nimbai_get_lightning | `location`/`bbox`, `minutes` | `count`, `nearest_km`, `trend`, `source`, `density_tiles?` |
| nimbai_get_severe_risk | `location`/`bbox` | `official_warnings[]`, `outlooks[]`, `environment {stp, scp, class}`, `radar_rotation?` |
| nimbai_get_sources_status | — | `sources[] {name, last_sync, latency_min, ok}` |

Erros comuns: `LOCATION_AMBIGUOUS` (peça país/estado), `NO_COVERAGE` (fonte não cobre a região; diga isso), `RATE_LIMITED` (espere e tente de novo), `SOURCE_DOWN` (use `nimbai_get_sources_status`).
