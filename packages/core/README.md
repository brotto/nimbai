# @nimbai/core
Adaptadores de fontes (NOAA/NWS, SPC, IEM, MRMS, GLM, GIBS, EUMETView, NOAA STAR, Open-Meteo, MeteoAlarm, INMET, REDEMET, CelesTrak), normalização, atribuições e tipos (zod).
Regras: não conhece HTTP de borda nem UI; recebe `fetch` e um `KeyProvider`; cada adaptador declara `license`, `commercialUse` e `attribution`.
