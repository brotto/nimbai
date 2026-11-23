---
name: nimbai
description: Use when the user asks about weather, clima, tempo, previsão, chuva, tempestade, radar, satélite, raios, relâmpagos, alertas, tornado, vento, furacão or storm safety anywhere in the world. Teaches how to call the NimbAI MCP tools (nimbai_*), how to read the returned images (timestamp, bbox, legend) and how to answer honestly with official sources.
license: MIT
compatibility: Requires the NimbAI MCP server, run from a checkout of github.com/brotto/nimbai (no npm package or hosted server yet; see its README). Works in any MCP-capable agent.
metadata:
  author: nimbai-app
  version: "0.1.0"
---

# NimbAI — como usar as ferramentas de tempo

## Quando usar
Qualquer pergunta sobre tempo/clima atual, previsão, radar, satélite, raios, alertas ou tempo severo. Se o usuário citar um lugar, comece por `nimbai_search_location`.

## Fluxo recomendado
1. `nimbai_search_location(query)` → escolha o candidato certo (país/estado) e guarde `id`, `lat`, `lon`.
2. `nimbai_get_summary(lat, lon, detail="summary")` → condições atuais, próximas horas e alertas ativos. Use `detail="full"` só quando o usuário pedir detalhes.
3. Se houver alerta ativo: `nimbai_get_alerts` e **reproduza o texto oficial íntegro** (fonte, `onset`, `expires`, `url`). Nunca resuma de forma que mude o sentido.
4. Para "como está agora" visual: `nimbai_get_radar_latest` (chuva/tempestade) ou `nimbai_get_satellite_latest` (nuvens). Para evolução: `nimbai_get_imagery_loop` (até 24 quadros).
5. Raios: `nimbai_get_lightning(lat, lon)` — é **densidade de flashes** detectada por satélite (GLM do GOES-East), nunca rede terrestre. A janela de acumulação é fixa pela NOAA: o parâmetro `minutes` é aceito e **não é aplicado**, e `gaps` diz isso. Não há contagem, distância do raio mais próximo nem tendência. Diga isso.
6. Perfil vertical / Skew-T: `nimbai_get_sounding` — sondagem **de modelo** (sem balão). Diga de qual
   família é o número que você citar: `model` (o modelo calculou) ou `thermodynamics`/`kinematics`
   (o NimbAI calculou do perfil). No Hemisfério Sul a supercélula ciclônica é o movedor da
   **esquerda** e o sinal da helicidade inverte — leia `kinematics.signConvention`.
7. Tempo severo/tornado: `nimbai_get_severe_risk` — distinga sempre o aviso oficial ativo do prognóstico oficial (SPC). Itens de **ambiente favorável (STP/SCP) e de radar automático não são emitidos hoje** — leia `gaps` e diga que a camada não existe, em vez de tratar a ausência como ausência de risco.

## Como ler uma imagem
Cada imagem traz `url`, `layer` e `attribution` (e dentro dela o `source`). Os campos `validTime` (UTC), `bbox` [oeste, sul, leste, norte], `legend` e `sourceLatencyMin` são **opcionais**: só aparecem quando a fonte os informa. Havendo `validTime`, converta para o fuso do usuário e diga há quantos minutos a imagem foi gerada; **não havendo, diga que a hora não foi informada em vez de estimar**. Se `sourceLatencyMin` for alto, avise que a imagem pode estar atrasada.

## Regras de segurança (obrigatórias)
- Nunca invente alertas nem diga "não vai ter tornado/tempestade". Cite fonte e hora.
- Termine respostas sobre tempo severo com a orientação oficial: siga INMET/Defesa Civil (Brasil), NWS (EUA), MeteoAlarm (Europa) ou a autoridade local.
- Dados de raios não servem para proteção de vida ou equipamentos.

## Exemplos
- "Vai chover em Curitiba hoje à noite?" → search_location → get_summary → responder com horários e probabilidade; oferecer o radar.
- "Tem raio perto de mim agora?" → get_lightning → densidade de flashes na grade, em janela fixa (sem contagem, distância nem tendência) + orientação de abrigo.
- "Tem aviso de tempestade severa para Porto Alegre agora?" → get_severe_risk → avisos do INMET em vigor (se houver) + o que `gaps` declarar como ausente + disclaimer. Para o Brasil não há prognóstico de amanhã: o prognóstico oficial que a tool traz é o do SPC, só para os EUA continentais.

Veja `references/tools.md` para exemplos de chamadas e erros.
