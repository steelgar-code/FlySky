# FlySky — previsão do tempo

[English](README.md) · [Українська](README.uk.md) · Português (BR)

Previsão do tempo para pilotos de drones e VANTs. Em vez de um único "melhor palpite", o FlySky mostra toda a variação de respostas de vários modelos meteorológicos, para você ver quão prováveis são chuva, vento forte, rajadas, nuvens baixas ou pouca visibilidade nas próximas horas ou na semana — e confere isso com imagens de satélite ao vivo. Roda inteiramente no navegador, sem servidor.

O app tem duas telas, alternadas pelos botões do cabeçalho: **Previsão** e **Mapa de satélite**.

## Previsão

- **"Posso voar agora?"** — um cartão no topo: o veredito da hora e a confiança nele, o que o limita, um bloco por fator (chance de precipitação, vento, rajadas, vento em altura, nuvens baixas, visibilidade), cada um verde / amarelo / vermelho pela própria verificação, com uma faixa desse fator nas 6 horas a partir dela, e a próxima janela adequada. Sob os blocos, um **seletor de horas** cobre toda a janela de tempo, cada hora dividida pela fração de membros / modelos por veredito (como em *Dividir por fração*): deslize sobre ele (mouse ou dedo), toque, use os botões ‹ › ou as setas do teclado para ver outra hora — o cartão acompanha, *Agora* volta à hora atual e *Mapa* abre o mapa de satélite nessa hora. A hora selecionada é a mesma fixada na barra de condições de voo, e vice-versa. Um toque num bloco abre o gráfico desse fator na hora mostrada. Os alertas de perigo próximo e a nota do satélite (só na hora atual) ficam neste cartão; *Detalhes* leva à barra de condições de voo.
- **Dois modos de previsão**
  - **Conjunto**: cada rodada (membro) de cada modelo de conjunto selecionado, mostrando quão provável é cada resultado.
  - **Modelos**: a previsão principal (determinística) de cada modelo selecionado, mostrando quanto os modelos discordam.
  Os dois modos usam os mesmos gráficos, e o seletor flutua na parte de baixo da tela, para trocar enquanto olha qualquer gráfico.
- **Membros / modelos individuais** — o botão ao lado do modo mostra cada membro do conjunto no modo Conjunto (membros do vento em altura coloridos pela altura) e, no modo Modelos, troca a faixa combinada por uma linha colorida por modelo.
- **Faixas de probabilidade** — um gráfico por parâmetro com a linha da mediana e faixas sombreadas de 25–75% (50% de chance), 10–90% (80%) e mín–máx. Passe sobre qualquer hora para ver os números exatos.
- **Parâmetros** — precipitação (com uma barra da chance de precipitação por hora), velocidade do vento e rajadas a 10 m, nuvens baixas (modo Modelos; a API de conjuntos não as fornece), visibilidade e vento em altura (Conjunto: 1000 e 925 hPa juntos, cerca de 110–800 m; Modelos: 950 hPa, cerca de 500 m).
- **Condições de voo** — uma barra colorida que marca cada hora como adequada (verde), incerta (amarela) ou inadequada (vermelha), pela mediana do vento, das rajadas, do vento em altura, das nuvens baixas e da visibilidade e pela chance de precipitação:
  - *Adequado*: nenhuma chance de precipitação, vento e rajadas abaixo de 8 m/s, vento em altura abaixo de 8 m/s, nuvens baixas abaixo de 30%, visibilidade acima de 5 km.
  - *Incerto*: qualquer um de: chance de precipitação abaixo de 40%, vento ou rajadas de 8–14 m/s, vento em altura de 8–14 m/s, nuvens baixas de 30–60%, visibilidade de 3–5 km.
  - *Inadequado*: qualquer um de: chance de precipitação de 40% ou mais, vento ou rajadas de 14 m/s ou mais, vento em altura de 14 m/s ou mais, nuvens baixas de 60% ou mais, visibilidade abaixo de 3 km.
  Todos os limites podem ser ajustados nas configurações; o vento em altura tem limites próprios (aumente-os bastante para não considerá-lo).
- **Confiança da previsão** — cada membro (Conjunto) ou modelo (Modelos) recebe o próprio veredito por hora, cada modelo com o mesmo peso (um modelo sem um fator que os outros têm — por exemplo, sem vento em altura — assume esse fator como esses modelos o veem, então dados ausentes não contam como concordância com "tudo bem"); uma faixa sob a barra de condições mostra quantos concordam (alta ≥ 80%, média 60–80%, baixa < 60%). *Dividir por fração* mostra cada hora dividida pela fração de adequado / incerto / inadequado.
- **Detalhamento por causa** — as mesmas zonas separadas para precipitação, vento e rajadas, vento em altura, nuvens baixas e visibilidade, com um quadro de detalhes próprio (toque para fixar uma hora). Uma hora fixada na barra de condições oferece o botão **Mapa**, que abre o mapa de satélite nesse horário (horas futuras: a imagem mais recente com setas de vento previsto).
- **Planejador de janelas de voo** — janelas voáveis dia a dia, com as causas e os piores valores dos períodos incertos e a confiança da previsão; janelas mais curtas que a duração mínima (1 h por padrão) ficam de fora.
- **Perigos próximos** — alertas no cartão "Posso voar agora?" quando os dados de satélite mostram **raios ou chuva a até 50 km** do local (distância, direção, intensidade e se está se aproximando e quando: para um alerta novo, os últimos ~40 min são lidos em algumas imagens pequenas, então a previsão de chegada aparece em segundos). Um toque abre o mapa com essa camada ligada, afastado para incluir a célula. No mapa, um alerta cuja camada está desligada tem o botão **Mostrar** (camada ligada, célula à vista). Quando satélite e previsão discordam claramente no local (chuva, nuvens baixas), uma nota avisa. Ligado por padrão; desligue em qualquer um dos menus de configurações.
- **Dia e noite** — linhas pontilhadas marcam a meia-noite, uma faixa fina sombreia dia e noite, e a data de hoje, o nascer e o pôr do sol aparecem no cartão do local (calculados no aparelho).
- **Resumo da previsão** — precipitação esperada com sua faixa de 80% e a chance de pelo menos 1 mm, pico de vento, rajadas e vento em altura com o pior caso de 1 em 10, nuvens baixas e menor visibilidade (dois cartões por linha nos celulares); um toque num cartão abre seu gráfico na hora de pico / mais limpa / pior.
- **Gráficos reordenáveis** — mova os painéis com as setas ou arraste pela alça no computador. Depois de rolar para baixo, um botão redondo ↑ volta ao topo.
- **Janelas de tempo** — 3 h, 8 h, 24 h (padrão), 48 h, 72 h ou 1 semana a partir da hora atual, no horário local do lugar.
- **Escolha de modelos** — no menu lateral (☰, ou *Modelos* no cartão "Posso voar agora?"), para o modo atual, com quanto uma atualização consome da cota gratuita do Open-Meteo. Os padrões servem para a Ucrânia e o Leste Europeu (conjuntos: DWD ICON-EU, ECMWF IFS Europe e AIFS, Google WeatherNext 2; modelos: DWD ICON, ECMWF IFS e AIFS, Météo-France, UK Met Office), com NOAA GFS, GEM, JMA e BOM também disponíveis. Um modelo que não carrega é sinalizado e ignorado.
- **Requisições** — o Open-Meteo conta cada variável de cada membro do conjunto, então uma atualização de conjunto é cara (≈ 120 chamadas com os 4 conjuntos padrão, ≈ 180–210 com os 8; uso gratuito: 600 por minuto, 5.000 por hora, 10.000 por dia). O FlySky sempre pede 8 dias de uma vez (qualquer pedido de até 14 dias custa o mesmo), então mudar a janela de tempo não exige nova requisição; uma previsão é reaproveitada por 2 h no modo Conjunto e 1 h no modo Modelos (*Atualizar* sempre pede de novo). Um limite por minuto é tentado de novo uma vez após um minuto; um limite por hora ou por dia para com uma nota, e a última previsão continua.
- **Locais** — busca, posição atual, favoritos (marque um local com a estrela); o último local, o modo, os modelos e a janela são lembrados.

## Mapa de satélite

Imagens EUMETSAT ao vivo (EUMETView) sobre a região escolhida, centradas no local da previsão.

- **Produtos** — *Automático (dia / noite)* por padrão: Nevoeiro / Nuvens baixas RGB à noite, Microfísica diurna de dia, GeoColour no crepúsculo, escolhido para cada imagem pelo sol. Também Nevoeiro / Nuvens baixas RGB (microfísica noturna), GeoColour (dia e noite), Microfísica diurna, Tipo de nuvem (inclui água super-resfriada — risco de formação de gelo), Fase da nuvem, Cor natural, Máscara de nuvens e Infravermelho 10,8 / 10,5 µm. Cada RGB tem uma **legenda de cores** dos guias rápidos da EUMETSAT; quando vários satélites oferecem um produto (MSG, MTG, MSG Rapid Scan), escolha a fonte.
- **Camadas** — **precipitação** por satélite (taxa combinada MTG), **raios** (MTG Lightning Imager, últimos 30 min) e **incêndios** (potência radiativa de fogo MTG, acumulando a partir do horário selecionado — reproduza a partir de um horário anterior para ver as áreas de risco crescerem), com opacidade e legendas (as pilhas de raios e incêndios são desenhadas como uma imagem cada, leve para celulares); **setas de vento previsto** (ligadas por padrão) a 10 m, 120 m (padrão), ~500 m, ~800 m ou ~1500 m — uma altura de vento compartilhada com a calculadora de tempo de voo — coloridas pelos seus limites de voo (acima de 120 m, os limites de vento em altura).
- **Animação** — últimas 6 ou 12 horas de horários reais de imagens; reproduzir, avançar, controle deslizante, mais recente, velocidade; horário local (padrão) ou UTC. Ao abrir, só a imagem mais recente é carregada; escolher um horário carrega essa e as seguintes (nunca as anteriores). A barra de tempo some quando nada no mapa tem horário (sem produto de satélite, sem camada de precipitação / raios / incêndios) e enquanto a calculadora de tempo de voo está aberta (uma pequena etiqueta mostra o horário e a idade da imagem; toque nela para a mais recente).
- **Leitura na mira** — lida quando o mapa para (nada é pedido enquanto você arrasta; movimentos pequenos reaproveitam o que foi lido, numa grade de ~1 km para o satélite e ~5 km para os modelos), e nunca cobre a mira (conteúdo longo rola). O que está sob a mira na imagem exibida: tipo provável de nuvem pela legenda de cores (ou a classe exata da Máscara de nuvens), taxa de chuva por satélite, raios / incêndios mais próximos a até 50 km e os valores dos modelos de previsão — nuvens baixas, visibilidade, precipitação e vento nessa hora —, com quais modelos concordam com o satélite. *Definir local* torna o ponto da mira o local da previsão.
- **Calculadora de tempo de voo** (botão do cronômetro) — uma ferramenta opcional para medir durante o voo. A partida A é onde está a mira ao abrir (ou após "Partida A aqui").
  - Modo **Mira**: B é a mira, então mover o mapa mede ao vivo; o zoom mantém B no lugar, e um toque leva a mira até lá.
  - Modo **Toque**: um toque marca B, e o mapa se move e aproxima livremente para ver a rota (voltar ao modo Mira leva o mapa até B).
  - Sempre visíveis: A em MGRS, o controle de velocidade do ar (18–30 m/s) e B em MGRS. Toque em A ou B para colar uma referência MGRS (várias para B viram pontos intermediários); A e B também podem ser arrastados. A altura do vento (a mesma das setas de vento do mapa) e a partida (agora ou em 1–6 h) ficam ao lado do seletor de modo.
  - Mostra o tempo de voo, a hora de chegada e a volta; uma etiqueta ao lado da linha da rota mostra tempo, distância e velocidade no solo e continua visível enquanto qualquer parte da linha estiver na tela.
  - Cada trecho da rota usa o vento previsto da hora em que o drone chega lá (triângulo de vento: proa corrigida para o vento lateral, depois velocidade no solo); se o vento for forte demais para a velocidade do ar, isso é informado.
  - Enquanto está aberta, a reprodução para, a barra de tempo some e os alertas viram ícones, para a mira ficar livre.
- **Navegação** — zoom até o nível da rua (18; a imagem de satélite é desenhada no máximo para o zoom 8 — mais fina que os próprios pixels de 1–5 km do satélite —, então aproximar ou mover dentro da área carregada não precisa de nova imagem, e as últimas áreas ficam lembradas, então voltar reaproveita suas imagens; com zoom além da grade de vento, uma seta mostra o vento junto à mira), círculos de distância ao redor do local, favoritos como estrelas, nomes de lugares e fronteiras por cima (desligados por padrão: o mapa de fundo já os tem), fundo escuro / OSM / nenhum, regiões (Ucrânia, Europa, ao redor do local, retângulos desenhados, vistas salvas), tela cheia, layout para celular na horizontal.
- Todos os ajustes do mapa ficam no menu lateral (☰) enquanto o mapa está à vista, em cartões que se recolhem — *Produto de satélite*, *Camadas* (precipitação, raios, incêndios, vento, alertas de perigo; cada camada ligada recolhe os próprios ajustes), *Mapa*, *Região*, *Animação*, *Diagnóstico* —, cada um mostrando o que está escolhido quando recolhido.

As imagens RGB de satélite mostram nevoeiro e nuvens baixas *prováveis* visualmente; não medem a altura da base das nuvens. A chuva por satélite é uma estimativa e os raios chegam com alguns minutos de atraso — os alertas são um aviso prévio, não um serviço de alerta.

## Configurações, idiomas, offline

- **Configurações** (menu ☰): modelos, unidades (vento m/s, km/h, nós, mph; precipitação mm ou polegada), limites de voo (incluindo vento em altura), janela mínima do planejador, alertas de perigo próximo, tela cheia; na tela do mapa o mesmo menu traz os ajustes do mapa.
- **Idiomas**: inglês, ucraniano e português (Brasil).
- **PWA instalável**: funciona offline com as últimas previsões carregadas (as quatro combinações mais recentes de local / modo ficam guardadas); o mapa precisa de conexão.

## Uso

O FlySky é feito de arquivos estáticos, sem etapa de build: `index.html` (previsão), `map.js` (mapa de satélite, carregado com o Leaflet na primeira abertura), `hazard.js` (alertas de perigo próximo), `sw.js` (cache offline). Para rodar, sirva a pasta com qualquer servidor de arquivos estáticos (por exemplo, `npx serve .`) e abra no navegador; se quiser, instale pelo aviso de instalação do navegador.

Ao alterar `map.js` ou `hazard.js`, aumente o `?v=` deles em `index.html` e em `sw.js`, e a versão do cache do service worker.

## Testes

Os testes de navegador (Playwright, com todos os serviços externos simulados) ficam em [`tests/`](tests/README.md) (descrição em inglês):

```sh
cd tests && npm install && npm test
```

## Dados e privacidade

- Previsões: [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api) e [Forecast API](https://open-meteo.com/en/docs); busca de lugares: [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api) (CC BY 4.0).
- Imagens e produtos de satélite: [EUMETSAT EUMETView](https://view.eumetsat.int/) (© EUMETSAT; consulte a política de dados da EUMETSAT antes de uso público ou comercial).
- Blocos do mapa: © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright).

Só o texto da busca, as coordenadas selecionadas, a área do mapa e (com a calculadora de tempo de voo) os pontos ao longo da rota são enviados a esses serviços. Favoritos, configurações e previsões salvas ficam no seu navegador (localStorage e IndexedDB).

## Licença

MIT — veja o arquivo [LICENSE](LICENSE).
