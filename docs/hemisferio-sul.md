# Parâmetros de tempo severo no Hemisfério Sul

Quase toda a literatura e todo o software de tempo severo foram escritos para o
Hemisfério Norte. Aplicar as convenções do HN a uma tempestade no sul do Brasil
não produz erro nenhum na tela — produz um número plausível apontando para a
tempestade errada. Este documento registra o que o NimbAI faz a respeito, o que
foi verificado e o que continua sem respaldo.

## O que o código faz

**O desviador ciclônico é escolhido pelo hemisfério.** `bunkersStormMotion`
devolve sempre os dois membros com rótulo geométrico: `right` é o que desvia no
sentido horário do vetor de cisalhamento 0–6 km e `left` no anti-horário, nos
dois hemisférios. Quem decide qual dos dois é a supercélula ciclônica — a que
carrega mesociclone e a que interessa a uma previsão de tornado — é
`cyclonicMover(hemisphere)`: **direito no norte, esquerdo no sul**.

**A helicidade sai nos dois sinais.** `stormRelativeHelicity` devolve a integral
crua, sem correção de hemisfério. O adaptador de sondagem reporta dois campos:
`srh0to1km`/`srh0to3km` com o sinal invertido ao sul do equador, para que
"grande e positivo" signifique a mesma coisa nos dois hemisférios, e
`srh0to1kmRaw`/`srh0to3kmRaw` com a integral como ela sai. O campo
`signConvention` diz em texto qual é qual, e a resposta sempre traz isso em
`gaps`.

**A média do vento é integral em altura.** `meanWind` faz `(1/Δz) ∫ V dz` por
trapézio sobre passos de 100 m, não média aritmética de amostras. Bunkers et al.
(2000) especificam média **não ponderada por pressão**.

## O que foi verificado

**A helicidade bate com uma implementação externa.** Fixando a mesma
movimentação de tempestade nos dois lados, sobre a sondagem de Norman de
1999-05-04 00Z que o MetPy distribui como `may4_sounding.txt`:

| | NimbAI | MetPy 1.7.1 | diferença |
|---|---|---|---|
| SRH 0–1 km | 227,5437 | 227,4816 | 0,03 % |
| SRH 0–3 km | 311,6919 | 311,6735 | 0,006 % |
| cisalhamento 0–1 km | 12,8755 | 12,8739 | 0,01 % |
| cisalhamento 0–6 km | 21,3544 | 21,3571 | 0,01 % |

**A simetria de reflexão fecha exatamente.** Espelhando aquele perfil no equador
(o eixo norte-sul inverte, o leste-oeste não), o desviador esquerdo do sul é a
imagem especular do direito do norte, e a SRH do desviador ciclônico sai igual e
oposta: `+240,05` e `−240,05`. É o que torna a escolha de hemisfério uma
afirmação verificável e não uma preferência.

**Um caso real do HS.** Guarapuava (PR), 2025-11-07 21Z, pelos níveis de pressão
do Open-Meteo: cisalhamento 0–6 km de 30,8 m/s, SRH 0–3 km reportada de
356 m²/s² (crua −356), CAPE de superfície 493 J/kg, LCL 844 m. É um ambiente de
tornado significativo, e é exatamente o caso em que não inverter o sinal faria
qualquer limiar a jusante ler −356 como desfavorável.

Os três estão fixados em testes (`packages/core/src/thermo.test.ts`), incluindo
um que falha se o sentido do desvio de Bunkers for invertido.

## Onde divergimos do MetPy, de propósito

A movimentação de Bunkers do MetPy fica cerca de 0,9 m/s da nossa no mesmo
perfil. A causa é só uma: **o MetPy integra a média do vento em pressão**
(`weighted_continuous_average` divide pelo intervalo de pressão), enquanto a
docstring do próprio MetPy diz "non-pressure-weighted mean wind" e Bunkers et
al. (2000) especificam não ponderada. Verificado numericamente: trapézio em
pressão reproduz o número do MetPy, trapézio em altura reproduz o nosso. A
[issue #2092](https://github.com/Unidata/MetPy/issues/2092) do MetPy registra a
intenção de usar outra média em `bunkers_storm_motion`. Integramos em altura.

## O que NÃO tem respaldo

Esta seção importa mais que as anteriores.

**A inversão de sinal é convenção nossa, não da área.** Procuramos e não
encontramos nenhuma fonte que documente inverter o sinal ou tomar o módulo da
SRH ambiental no Hemisfério Sul. A literatura do HS simplesmente **reporta o
valor negativo como ele sai**: Rae & Dyson (2015) dão Q1 de −112 m²/s² para
supercélulas na África do Sul; Oliveira et al. (2016) dão −423 (0–3 km) e −230
(0–1 km) para uma supercélula esquerda ciclônica no sul do Brasil, e cerca de
−150 para o tornado de Xanxerê. Invertemos porque o consumidor primário é um
modelo de linguagem aplicando limiares calibrados no HN, e um número negativo
seria lido como desfavorável. É uma escolha de produto defensável, **não é
prática estabelecida**, e é por isso que a integral crua acompanha toda
resposta.

**"Esquerdo = ciclônico no HS" tem respaldo, mas não de periódico.** As fontes
que encontramos são de conferência e operacionais: Rae & Dyson (2015, ECSS,
Serviço Meteorológico da África do Sul), Oliveira et al. (2016, 28th Conference
on Severe Local Storms, UFSM), um estudo de caso do NSSL sobre Sydney 1999, e a
página de ajuda de sondagens do SPC, que qualifica o vetor direito como
"cyclonic in northern hemisphere". Bunkers et al. (2000) **não menciona
hemisfério em momento algum**.

**O parâmetro de desvio de 7,5 m/s no HS não foi testado por ninguém.** Bunkers
et al. (2024) recalibraram desviadores esquerdos dos EUA — que são
anticiclônicos — e sugerem 5,0 m/s. Por simetria, o esquerdo ciclônico do HS é o
espelho do direito ciclônico do HN, e portanto 7,5, não 5,0. É o que fazemos.
Nenhuma fonte testa isso.

**Nenhum meteorologista revisou.** Toda a verificação acima é numérica e
bibliográfica.

## Uma coisa que parecia importar e não importa

O método de Bunkers é simétrico por reflexão: girar o desvio no sentido oposto
apenas troca os rótulos dos dois vetores e devolve o mesmo par. Logo, "aplicar a
rotação ao contrário" e "aplicar a mesma fórmula e ler o outro desviador como
ciclônico" dão resultado numérico idêntico. Escolhemos a segunda por ser a que
mantém os rótulos geométricos estáveis entre hemisférios.

## Referências

- Bunkers, M. J., B. A. Klimowski, J. W. Zeitler, R. L. Thompson, M. L. Weisman,
  2000: Predicting supercell motion using a new hodograph technique.
  *Wea. Forecasting*, **15**, 61–79.
  <https://www.weather.gov/media/unr/soo/scm/BKZTW00.pdf>
- Bunkers, M. J., 2002: Vertical wind shear associated with left-moving
  supercells. *Wea. Forecasting*, **17**, 845–855.
  <https://www.weather.gov/media/unr/soo/scm/B02a.pdf>
- Rae, K. e M. Dyson, 2015: Sounding-derived characteristics associated with
  some supercell storms over the Gauteng Province of South Africa. ECSS2015-126.
  <https://meetingorganizer.copernicus.org/ECSS2015/ECSS2015-126.pdf>
- Oliveira, M. I. et al., 2016: A left-moving, cyclonic supercell in southern
  Brazil. 28th Conf. on Severe Local Storms.
  <https://ams.confex.com/ams/28SLS/webprogram/Paper300453.html>
- SPC, convenções de vetores em sondagens.
  <https://spc.noaa.gov/exper/soundings/help/vectors.html>
