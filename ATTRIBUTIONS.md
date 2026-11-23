# Atribuições de dados

O código do NimbAI é MIT. Os **dados** que ele consome têm termos próprios; quem opera o serviço é responsável por respeitá-los. Textos obrigatórios:

| Fonte | Licença | Texto de atribuição |
|---|---|---|
| NOAA / NWS / SPC / MRMS / GLM / NOAA STAR | domínio público (sem implicar endosso) | "Source: NOAA/NWS" |
| NOAA Open Data on AWS (GOES, Himawari, HRRR, GFS) | aberto | "NOAA Open Data Dissemination" |
| NASA GIBS | aberto | "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)." |
| EUMETSAT (EUMETView, Data Store — dados Core) | CC BY 4.0 | "Contains modified EUMETSAT Meteosat data 2026" |
| JMA Himawari (relay NOAA NODD) | **termos da JMA a confirmar por escrito** antes de uso comercial | "Source: Japan Meteorological Agency" |
| ECMWF Open Data (IFS, AIFS) | CC BY 4.0 | "Contains ECMWF Open Data (CC BY 4.0)" |
| DWD Open Data | CC BY 4.0 | "Quelle: Deutscher Wetterdienst" |
| Environment and Climate Change Canada | licença aberta (alertas sem alteração) | "Data Source: Environment and Climate Change Canada" |
| MeteoAlarm | CC BY 4.0 | "© MeteoAlarm. Data provided by EUMETNET members" |
| INMET | dado público federal | "Fonte: INMET" |
| DECEA / REDEMET | chave de API; termos a confirmar | "Fonte: DECEA/REDEMET" |
| Open-Meteo (dados) | CC BY 4.0 nos dados, mas o **endpoint gratuito é de uso não comercial**: marcada `termsPending` em `sources.ts` e não liberada para produto pago (precisaria do plano pago deles ou de instância própria) | "Weather data by Open-Meteo.com" |
| SSEC RealEarth (se usado) | crédito obrigatório | "Source: SSEC RealEarth, UW-Madison" |
| OpenStreetMap (basemap via OpenFreeMap/Protomaps) | ODbL | "© OpenStreetMap contributors" (link para openstreetmap.org/copyright) |
| CelesTrak / Space-Track (TLE) | redistribuível com citação | "Orbital data: CelesTrak" |

Fontes com termos **pendentes de confirmação escrita** (não habilitar no produto pago até o retorno): DECEA/REDEMET, JMA Himawari via NOAA NODD. **Em uso e com pendência própria:** Open-Meteo — é a única entrada do catálogo com `termsPending: true`, pelo motivo na tabela acima.

**Atenção, ponto em aberto:** imagens do **Himawari (JMA)** são servidas pelo satélite e pelos loops na Ásia-Pacífico, por meio das camadas `Himawari_AHI_*` da NASA GIBS — isto é, pelo caminho da GIBS, e não pelo relay NOAA NODD listado acima. **Se os termos de uso comercial dos dados da JMA alcançam essa via, não foi confirmado.** Mesmo assim, a atribuição emitida nessas imagens é só a da GIBS: o crédito "Source: Japan Meteorological Agency" não é acrescentado. Resolver antes de qualquer uso comercial — ou acrescentando o crédito da JMA nessas camadas, ou desligando-as.

Fontes **não utilizadas** por restrição de licença: Blitzortung/lightningmaps (não comercial), RainViewer (pessoal/educacional), CPTEC/INPE imagens (não comercial sem autorização), NICT Himawari (não comercial), Zoom Earth, Windy embed.
