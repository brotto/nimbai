---
name: nimbai
description: Use when the user asks about weather, clima, tempo, previsão, chuva, tempestade, radar, satélite, raios, relâmpagos, alertas, tornado, vento, furacão or storm safety anywhere in the world. Teaches how to call the NimbAI MCP tools (nimbai_*), how to read the returned images (timestamp, bbox, legend) and how to answer honestly with official sources.
license: MIT
compatibility: Requires the NimbAI MCP server (npx -y @nimbai/mcp or https://api.nimbai.app/mcp). Works in any MCP-capable agent.
metadata:
  author: nimbai-app
  version: "0.1.0"
---

# NimbAI — como usar as ferramentas de tempo

## Quando usar
Qualquer pergunta sobre tempo/clima atual, previsão, radar, satélite, raios, alertas ou tempo severo. Se o usuário citar um lugar, comece por `nimbai_search_location`.

## Fluxo recomendado
1. `nimbai_search_location(query)` → escolha o candidato certo (país/estado) e guarde `location_id`, `lat`, `lon`.
2. `nimbai_get_summary(location, detail="summary")` → condições atuais, próximas horas e alertas ativos. Use `detail="full"` só quando o usuário pedir detalhes.
3. Se houver alerta ativo: `nimbai_get_alerts` e **reproduza o texto oficial íntegro** (fonte, hora de emissão e expiração, link). Nunca resuma de forma que mude o sentido.
4. Para "como está agora" visual: `nimbai_get_radar_latest` (chuva/tempestade) ou `nimbai_get_satellite_latest` (nuvens). Para evolução: `nimbai_get_imagery_loop` (até 24 quadros).
5. Raios: `nimbai_get_lightning(location, minutes)` — são detecções por satélite (GLM) ou rede terrestre conforme `source`; diga qual.
6. Tempo severo/tornado: `nimbai_get_severe_risk` — distinga sempre (a) aviso oficial ativo, (b) ambiente favorável (índice STP/SCP, é previsão, não aviso), (c) sinal de radar.

## Como ler uma imagem
Cada imagem vem com `valid_time` (UTC), `bbox` [oeste, sul, leste, norte], `layer`, `source`, `attribution` e `legend`. Converta `valid_time` para o fuso do usuário e diga há quantos minutos foi gerada. Se `source_latency_min` for alto, avise que a imagem pode estar atrasada.

## Regras de segurança (obrigatórias)
- Nunca invente alertas nem diga "não vai ter tornado/tempestade". Cite fonte e hora.
- Termine respostas sobre tempo severo com a orientação oficial: siga INMET/Defesa Civil (Brasil), NWS (EUA), MeteoAlarm (Europa) ou a autoridade local.
- Dados de raios não servem para proteção de vida ou equipamentos.
- No Japão, apenas retransmita avisos da JMA.

## Exemplos
- "Vai chover em Curitiba hoje à noite?" → search_location → get_summary → responder com horários e probabilidade; oferecer o radar.
- "Tem raio perto de mim agora?" → get_lightning(minutes=30) → distância do mais próximo, tendência (aumentando/diminuindo), orientação de abrigo.
- "Risco de tornado no RS amanhã?" → get_severe_risk → avisos INMET (se houver) + índice de ambiente + disclaimer.

Veja `references/tools.md` para exemplos de chamadas e erros.
