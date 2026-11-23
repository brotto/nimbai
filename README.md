# NimbAI

**Inteligência meteorológica para agentes de IA e para pessoas.**
Um servidor MCP open source (MIT) que entrega, em tempo quase real, imagens de satélite, radar e raios, previsões, alertas oficiais e risco de tempo severo a qualquer harness (Claude Desktop/Code, Codex/ChatGPT, Hermes Agent, OpenClaw, Kimi, Cursor, Gemini CLI, VS Code).

A cobertura não é uniforme no mundo e as respostas dizem isso: previsão e sondagem são globais; satélite é GOES-19 (NOAA STAR) nas Américas e, via NASA GIBS, GOES-Oeste e Himawari em tempo quase real — mas na Europa, África e Oceano Índico só há um composto diário de órbita polar, que **não é tempo real** e não tem vapor d'água nem loop; **radar é só dos EUA**, **raios só do campo de visão do GOES-East**, e alertas oficiais só do NWS (EUA) e do INMET (Brasil). Fora da cobertura, a resposta diz o que não foi consultado. Só o radar indica o **operador** do serviço local, e só na América do Sul (REDEMET/DECEA, SMN/SINARAME, OHMC); as outras ferramentas trazem apenas o aviso de seguir a autoridade oficial — NWS, INMET/Defesa Civil, MeteoAlarm ou a local.

> **Status: Fase 1 (MCP MVP), em construção.** O que funciona hoje é o servidor MCP por stdio, rodando a partir deste repositório. **Ainda não existem:** pacote publicado no npm, servidor remoto hospedado e site com mapa — todos planejados, nenhum disponível. Nada aqui substitui avisos oficiais. Não use para proteção de vida ou propriedade.

## Usar o MCP (local, sem chaves)

Requer Node >= 22 e pnpm 10.

```bash
git clone https://github.com/brotto/nimbai.git
cd nimbai
pnpm install
pnpm build
```

O build produz o servidor em `packages/mcp/dist/bin/stdio.js`. Use o **caminho absoluto** dele na configuração do seu harness.

Claude Code (`.mcp.json`) e Claude Desktop (`claude_desktop_config.json`), mesmo formato:
```json
{ "mcpServers": { "nimbai": { "command": "node", "args": ["/caminho/para/nimbai/packages/mcp/dist/bin/stdio.js"] } } }
```
Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.nimbai]
command = "node"
args = ["/caminho/para/nimbai/packages/mcp/dist/bin/stdio.js"]
```
Hermes (`~/.hermes/config.yaml`), OpenClaw, Kimi (`~/.kimi-code/mcp.json`), Cursor (`.cursor/mcp.json`), Gemini CLI (`~/.gemini/settings.json`): mesmo `command` e mesmos `args`.

Skill para o modelo: `skills/nimbai/SKILL.md`, neste repositório — aponte ou copie o diretório conforme o seu harness.

## Tools
`nimbai_search_location` · `nimbai_get_summary` · `nimbai_get_forecast` · `nimbai_get_alerts` · `nimbai_get_satellite_latest` · `nimbai_get_radar_latest` · `nimbai_get_imagery_loop` · `nimbai_get_lightning` · `nimbai_get_sounding` · `nimbai_get_severe_risk` · `nimbai_get_sources_status`
Toda resposta de dados bem-sucedida traz `attribution`: os créditos das fontes cujos dados aparecem naquela resposta, cada um com o seu `source`. Vem vazia quando não há dado de fonte para creditar — `nimbai_get_sources_status`, ou um `nimbai_get_alerts`/`nimbai_get_severe_risk` sem nenhum item, caso em que quem diz o que foi consultado são `consulted` e `coverage` (no `nimbai_get_alerts`) ou `coverage` e `warnings` (no `nimbai_get_severe_risk`). Respostas de erro não trazem `attribution`. Imagens vêm **como URL, nunca embutidas na resposta**: `url` em resolução cheia, `thumbnailUrl` quando existe, mais `layer` e — quando a fonte os informa — `validTime` (UTC), `bbox`, `legend` e `sourceLatencyMin`.

## Fontes
Uma fonte só entra no catálogo se seus termos permitirem uso comercial (com um ponto em aberto sobre o Himawari, registrado em `ATTRIBUTIONS.md`), ou se estiver explicitamente marcada como `termsPending` — e nesse caso é tratada como **não liberada para o produto pago**.

Em uso hoje: NOAA/NWS (alertas e radar), SPC, NOAA STAR (satélite e raios), NASA GIBS, NOAA Aviation Weather (METAR), INMET e Open-Meteo.

O MeteoAlarm (EUMETNET) está no catálogo mas **não é consultado**: o feed identifica áreas por nome e código, sem geometria, e por isso um ponto não pode ser casado com um aviso europeu. `nimbai_get_alerts` declara isso em `consulted`, com o motivo, em vez de omitir a Europa em silêncio.

A Open-Meteo é a única com `termsPending`: o dado é CC BY 4.0, mas o endpoint gratuito é de **uso não comercial**. Serve a este servidor MIT da comunidade e não está liberada para uma versão paga, que precisaria do plano pago deles ou de instância própria. EUMETSAT Core, ECMWF Open Data, DWD e ECCC estão previstos e ainda não catalogados.

Lista completa e textos de atribuição em `ATTRIBUTIONS.md`, que registra também as fontes recusadas por licença e as de termos pendentes de confirmação escrita.

Nenhuma fonte condicional está implementada hoje: as chaves da seção BYOK do `.env.example` são para fontes futuras e **nenhuma delas é lida pelo código atual**. A única variável de ambiente em uso em todo o `packages/` é `NWS_USER_AGENT` — uma string de contato que o serviço americano pede, não uma credencial.

## Estrutura
`packages/core` (adaptadores) · `packages/mcp` (servidor MCP por stdio) · `skills/nimbai` (SKILL.md).
As pastas `apps/api`, `apps/web` e `services/ingest` contêm hoje **apenas um README** descrevendo o que serão.

## Planejado
- **Fase 2 — Site MVP** (`apps/web`): mapa MapLibre + deck.gl, camadas de satélite, radar, raios e alertas, timeline de 24 h, login. Sem IA e sem cobrança nesta fase.
- **Fase 3 — IA e assinatura** (`apps/api`): servidor MCP hospedado com autenticação e quotas, assistente que explica e navega o mapa, planos.
- **Fase 4 — Tornado e Brasil**: camada de risco tornádico. STP/SCP **não são calculados** e o risco `favourable_environment` **não é emitido**, de propósito: a cinemática que eles exigem (movimento de Bunkers e SRH, já disponíveis em `nimbai_get_sounding`) depende de convenções de Hemisfério Sul que ainda aguardam revisão de um meteorologista, e essa lacuna é declarada no campo `gaps` de `nimbai_get_sounding` (o `nimbai_get_severe_risk` informa apenas que a camada ainda não existe). Ver `docs/hemisferio-sul.md` (inglês: `docs/southern-hemisphere.md`) e a issue [#8](https://github.com/brotto/nimbai/issues/8).
- **Publicação no npm**: quando o pacote estiver pronto. Até lá, a instalação é a partir deste repositório.

## Licença
MIT © 2026 Alexandre Brotto. Os dados têm termos próprios (ver `ATTRIBUTIONS.md`).
