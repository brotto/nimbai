# Política de segurança

Relate vulnerabilidades por **GitHub Security Advisories** (aba *Security* → *Report a vulnerability*). Hoje esse é o **único** canal: o projeto não tem caixa postal própria, e nenhum endereço `@nimbai.app` que você encontre em arquivos antigos é um canal válido. Resposta inicial em até 72 h.

- **Versões suportadas:** não há release publicada nem pacote no npm; o alvo é o `main` deste repositório.
- **Superfície de ataque atual:** apenas o servidor MCP por stdio, rodando na máquina de quem o instalou. Não há serviço hospedado, API pública nem banco de dados.
- **Segredos:** nunca no repositório; o `.env.example` contém só nomes de variáveis. A única variável lida pelo código é `NWS_USER_AGENT`, que é uma string de contato, não uma credencial. Quando houver ambiente hospedado, os segredos ficarão em Cloudflare Workers Secrets.
- **Rotação:** hoje não há segredo a rotacionar — a única variável lida é uma string de contato. Quando houver ambiente hospedado: trimestral, e imediata em suspeita de vazamento.
- **Dados pessoais:** o servidor roda na sua máquina e não envia nada para nenhum servidor nosso — não existe nenhum. Mas ele consulta as fontes diretamente, e o que você pergunta chega a elas, cada uma sob a sua própria política:
  - **o ponto (lat/lon)** vai ao NWS (como `point=`, arredondado a 4 decimais) e ao Open-Meteo (previsão e sondagem);
  - **o nome do lugar** que você digitar vai à geocodificação do Open-Meteo;
  - **uma caixa (bbox) em volta do seu ponto** vai ao NOAA Aviation Weather, para achar a estação METAR mais próxima, e ao NASA GIBS, nas sondagens de quadro dos loops;
  - **INMET e SPC não recebem coordenada nenhuma**: os feeds são baixados por inteiro e o casamento com o seu ponto é feito localmente;
  - as **URLs de imagem** devolvidas (NOAA STAR, GIBS, RIDGE) carregam a área na própria URL e são buscadas pelo seu cliente, não por este servidor.
  Em todas as chamadas vai um cabeçalho `User-Agent` identificando o cliente: o valor de `NWS_USER_AGENT`, se você o definir, ou o padrão `NimbAI/<versão> (+URL do repositório)` — e ele vai para **todas** as fontes, não só para a americana. Cada fonte também vê o IP da sua máquina. Não há política de privacidade própria publicada porque ainda não há serviço hospedado para ela descrever.
