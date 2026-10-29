# Referência das tools NimbAI

Todas as tools são somente-leitura e devolvem `structuredContent` mais um espelho em texto. Toda
resposta traz `attribution` (uma lista) — **mostre o crédito ao usuário**. Respostas sobre alerta,
raio ou tempo severo trazem também `safety_notice`.

Um ponto é `lat` + `lon`. Quase toda tool aceita `bbox` `[oeste, sul, leste, norte]` como
alternativa; quando só o `bbox` é dado, o centro dele é usado como ponto.

| Tool | Entrada mínima | Campos-chave da saída |
|---|---|---|
| `nimbai_search_location` | `query`, ou `lat`+`lon` | `candidates[] {id, name, admin, country, countryCode, lat, lon, timezone, population}` |
| `nimbai_get_summary` | ponto ou `bbox` (+ `detail`) | `current`, `forecast`, `alerts[]`, `alerts_coverage` |
| `nimbai_get_forecast` | ponto ou `bbox` (+ `hours` ou `days`) | `forecast {model, run, times[], variables{nome:{unit, values[]}}}` |
| `nimbai_get_alerts` | ponto ou `bbox` (+ `severity[]`) | `alerts[] {event, severity, urgency, certainty, tags[], areaDescription, onset, expires, text, url}`, `coverage` |
| `nimbai_get_satellite_latest` | ponto ou `bbox` (+ `product`) | `image`, `satellite`, `coverage` |
| `nimbai_get_radar_latest` | ponto ou `bbox` | `image`, `sites[] {id, name, lat, lon, rangeKm}`, `coverage`, `gaps[]` |
| `nimbai_get_imagery_loop` | `layer` + ponto ou `bbox` (+ `frames`) | `frames[]` (cronológico, ≤24), `coverage` |
| `nimbai_get_lightning` | ponto ou `bbox` (+ `minutes`) | `image` **ou `null`**, `caveat`, `coverage`, `gaps[]` |
| `nimbai_get_sounding` | ponto ou `bbox` (+ `hours_ahead`) | `sounding {validTime, levels[], thermodynamics, kinematics, model, gaps[]}` |
| `nimbai_get_severe_risk` | ponto ou `bbox` | `items[] {kind, label, detail, probability, validFrom, validTo, url}`, `coverage`, `gaps[]` |
| `nimbai_get_sources_status` | — | `statuses[] {source, ok, latencyMs, typicalLatencyMin, note}`, `checkedAt` |

## `image` (todo `ImageRef`)

`{ url, thumbnailUrl?, mimeType, validTime?, bbox?, layer, legend?, sourceLatencyMin?, attribution }`

`validTime` é UTC. **Se `validTime` estiver ausente, a fonte não carimbou a hora** — não invente
uma; use `sourceLatencyMin` para dizer ao usuário a defasagem típica. Converta para o fuso dele e
diga há quantos minutos a imagem foi gerada.

## `kind` em `nimbai_get_severe_risk` — não são intercambiáveis

| `kind` | O que é | Como falar com o usuário |
|---|---|---|
| `official_warning` | Aviso/alerta emitido por autoridade | Lidere com ele, cite a autoridade e a hora |
| `official_outlook` | Prognóstico probabilístico oficial (ex. SPC Day 1) | "A autoridade estima X% de chance" |
| `favourable_environment` | Índices calculados (STP/SCP) | "Ambiente **favorável**" — é previsão de potencial, **nunca** um aviso |
| `automated_guidance` | Orientação automática de radar/satélite | Diga que é automático, não um aviso humano |

Confundir `favourable_environment` com `official_warning` é o erro mais grave que você pode
cometer com esta ferramenta.

## `nimbai_get_sounding` — duas famílias de número, nunca misture

A sondagem é **de modelo**, não de balão: nenhuma radiossonda foi lançada no ponto. A resposta
separa de propósito:

| Objeto | De onde vem | Como citar |
|---|---|---|
| `model` | O próprio modelo de previsão calculou para esta célula (`capeJkg`, `convectiveInhibitionJkg`, `liftedIndex`, `freezingLevelHeightM`) | "o modelo calcula X" |
| `thermodynamics` | O NimbAI levantou uma parcela pelos níveis reportados (`surfaceParcel`, `mixedLayerParcel`, `precipitableWaterMm`, taxas de lapso) | "calculado a partir do perfil" |
| `kinematics` | Cisalhamento, movimento de tempestade Bunkers e helicidade, do perfil de vento | ver convenção de sinal abaixo |

**O sinal do CIN é oposto entre as duas famílias**: `thermodynamics.*.cinJkg` é **negativo** (o
trabalho que falta à parcela para chegar ao LFC), `model.convectiveInhibitionJkg` é a **magnitude
positiva** como o Open-Meteo publica. Não some os dois nem diga "entre +1 e −20".

Quando `capeTruncated` é `true`, a parcela ainda estava flutuante no topo do perfil: o CAPE é
**piso**, não valor, e não há nível de equilíbrio — não cite o topo da integração como topo de
tempestade.

Os dois CAPEs **vão divergir** — o modelo roda na resolução nativa dele e com a definição de
parcela dele; o perfil aqui tem ~19 níveis. Divergência não é erro de nenhum dos dois, e dizer um
no lugar do outro é o erro mais fácil de cometer com esta tool.

### Hemisfério Sul — o sinal inverte

`kinematics.cyclonicMover` diz qual dos dois movedores de Bunkers gira ciclonicamente: **`right` no
Hemisfério Norte, `left` no Sul**. A SRH em `srh0to1kmM2S2`/`srh0to3kmM2S2` já vem com o sinal
corrigido, de modo que **positivo = favorável a supercélula ciclônica nos dois hemisférios**; os
valores crus da integral estão em `*_raw`. Leia `kinematics.signConvention` antes de citar um
número. Aplicar a convenção do Norte ao Brasil aponta todo parâmetro de tornado para a tempestade
errada.

STP, SCP e SHIP **não são calculados**: as formulações publicadas são calibradas em dados do
Hemisfério Norte e não têm forma validada para o Sul.

### Para desenhar o Skew-T

`levels[]` traz `pressureHpa`, `heightM`/`heightAglM`, `temperatureC`, `dewPointC`, vento;
`thermodynamics.surfaceParcel.curve[]` traz a temperatura da parcela em cada nível. A área entre as
duas curvas é o CAPE.

## Lacunas desta fase — leia `gaps[]` e `coverage` sempre

- **Raios**: é densidade de flashes em grade, detectada opticamente por satélite. **Não** há
  contagem, distância do raio mais próximo nem tendência — isso exige ingestão própria e chega
  numa fase futura. Nunca apresente como serviço de proteção contra raios.
- **Ambiente favorável (STP/SCP) global**: ainda não existe. `nimbai_get_severe_risk` se limita a
  avisos e prognósticos oficiais onde a autoridade os publica.
- **Radar não é global**: não existe mosaico global gratuito e legalmente usável. Fora da cobertura
  NEXRAD a tool falha e, quando o NimbAI sabe quem opera radar ali (Argentina: SMN/SINARAME e OHMC;
  Brasil: REDEMET/DECEA), o `next_steps` nomeia o serviço para o usuário abrir direto. O NimbAI
  **não serve** essas imagens: nenhum desses operadores publica licença de reuso.
- **Sondagem é de modelo**: não há radiossonda. Sem CAPE observado, sem sondagem do Wyoming.
- **Brasil**: não existe aviso oficial de **tornado** por polígono. Os avisos do INMET trazem um
  `poligono`, mas é um envelope aproximado: a área oficial é a lista de municípios, e o servidor não
  resolve em qual município o ponto está. Um aviso listado pode não valer para o local exato, e estar
  fora do polígono não garante ausência de aviso. Só avisos **em vigor agora** são listados; os de
  início futuro são contados no `coverage`, não na lista.
- **Europa**: o feed do MeteoAlarm responde, mas identifica a área só por nome e código, sem
  geometria — não é possível dizer se um ponto está dentro de um aviso europeu. Nenhuma fonte de
  aviso europeia é consultada, e o `coverage` diz isso.
- Alerta ausente **não** é risco ausente. Nunca responda "não vai ter tempestade" porque a lista
  voltou vazia; diga o que foi consultado (`coverage`).

## Erros

Lista de alertas vazia **não** é tudo limpo: leia `consulted` (por fonte: `ok`, `outside`,
`failed`). Se alguma fonte está `failed`, diga ao usuário que a fonte caiu e mande consultar a
autoridade oficial — não responda que não há aviso. O mesmo vale para `warnings` em
`nimbai_get_severe_risk`.

Vêm como `isError: true` com `{ error, next_steps }`. `next_steps` diz o que fazer em vez de
repetir a mesma chamada — siga-o. Padrões comuns: ponto ausente (chame
`nimbai_search_location` primeiro), nenhuma localização encontrada (peça país/estado ao usuário),
fonte indisponível (chame `nimbai_get_sources_status` e informe o usuário em vez de insistir).

## Fluxo típico

```
nimbai_search_location("Foz do Iguaçu")
  → escolha o candidato com country=Brazil, guarde lat/lon
nimbai_get_summary(lat, lon, detail="summary")
  → se alerts[] não estiver vazio: nimbai_get_alerts e reproduza text na íntegra
  → se o usuário quiser ver: nimbai_get_radar_latest ou nimbai_get_satellite_latest
  → evolução: nimbai_get_imagery_loop(layer="satellite", frames=12)
```
