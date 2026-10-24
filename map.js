// FlySky — satellite map view (EUMETSAT EUMETView WMS)
//
// Loaded on demand (together with Leaflet) the first time the Map view is
// opened. Shares the page's globals: t(), translations, currentLang, state,
// escapeHtml(), loadFromStorage(), saveToStorage(), sunAltitudeDeg().
//
// How it works
//  - Layer names, time steps, styles and coverage are read from the service's
//    WMS GetCapabilities at runtime; nothing about the catalog is hardcoded
//    except the two layer names published on EUMETSAT's own product pages,
//    which are only *preferred* when the capabilities list them.
//  - The whole catalog is large, so a slim copy (matched layers only) is kept
//    for 12 h. The time steps of the layer in use are refreshed from that
//    layer's own small capabilities document every few minutes.
//  - Each animation frame is one GetMap image of the visible area (EPSG:3857,
//    like the basemap), fetched through a small queue (3 at a time), cached by
//    layer + style + time + extent + size, and shown as a Leaflet image
//    overlay. Changing layer, area or window cancels requests that are no
//    longer needed.
//
// RGB composites show *likely* fog / low cloud visually; they do not measure
// cloud-base height. Precipitation is a satellite retrieval with its own
// uncertainty and latency. The UI says so.
(function () {
    'use strict';

    // ================= Configuration =================
    const MAP_CONFIG = {
        wmsBase: 'https://view.eumetsat.int/geoserver/wms',
        // GeoServer "virtual service" for one layer: same WMS, but the
        // capabilities document only describes that layer (small and fast).
        layerWmsBase: name => {
            const [ws, layer] = String(name).split(':');
            return layer ? `https://view.eumetsat.int/geoserver/${encodeURIComponent(ws)}/${encodeURIComponent(layer)}/wms` : null;
        },
        version: '1.3.0',
        crs: 'EPSG:3857',
        // RGB frames as JPEG on the app's background colour: ~150 KB and
        // ~2 s each. PNG (and "jpeg-png", which falls back to PNG as soon as
        // the view reaches past the edge of the satellite disk) is ~2 MB and
        // 10–40 s per frame.
        format: 'image/jpeg',
        background: '0x020617',
        // Mostly-transparent overlays (precipitation) stay small as 8-bit PNG.
        overlayFormat: 'image/png; mode=8bit',
        // Namespaces left out of the products: Metop / multimission mosaics
        // are accumulated orbits updated every 1 h 40 min – 3 h, not suited
        // to a 6–12 h animation.
        // Background / boundary layers are never products.
        excludeNamespaces: ['eps', 'mumi', 'backgrounds', 'osmgray'],
        // Boundary lines + coastline drawn on top of the imagery, in this
        // order of preference (white lines stay visible on every RGB).
        borders: [
            { name: 'backgrounds:ne_boundary_lines_land', style: 'whitelines' },
            { name: 'backgrounds:ne_10m_coastline', style: 'whitelines' }
        ],
        catalogKey: 'flysky_map_catalog',
        catalogTtlMs: 12 * 3600e3,
        timesTtlMs: 4 * 60e3,
        autoRefreshMs: 5 * 60e3,
        concurrency: 3,
        cacheLimit: 160,
        requestTimeoutMs: 45000,
        maxImageSide: 2048,
        windows: [6, 12],
        speeds: [0.5, 1, 2, 4],
        baseFrameMs: 650,
        settingsKey: 'flysky_map_settings',
        regionsKey: 'flysky_map_regions',
        regions: {
            ukraine: [22, 44, 41, 53],
            europe: [-12, 34, 45, 63]
        },
        // Key-free basemaps only (CARTO's tiles now need an API key).
        basemaps: {
            osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }
        },
        eumetsatAttribution: '&copy; <a href="https://www.eumetsat.int/" target="_blank" rel="noopener">EUMETSAT</a>'
    };

    // Products, in priority order. `test` runs on "<name> <title>" of every
    // layer in the capabilities; `prefer` names win when present.
    const PRODUCTS = [
        // EUMETView's "Fog / Low Clouds RGB" is the Night Microphysics RGB
        // (EUMETSAT quick guide: "also sometimes referred to as the Fog RGB").
        { id: 'fog', role: 'night', icon: 'fa-smog', prefer: ['msg_fes:rgb_fog'],
          test: s => /rgb_fog|\bfog\b|night.?micro/i.test(s) && !/day.?micro/i.test(s) },
        { id: 'dayMicro', role: 'day', icon: 'fa-sun', prefer: ['msg_fes:rgb_microphysics'],
          test: s => /micro/i.test(s) && !/night|24/i.test(s) },
        { id: 'natural', role: 'day', icon: 'fa-earth-europe',
          test: s => /natural.?colou?r|rgb_natural/i.test(s) },
        // MSG measures at 10.8 µm, MTG's FCI at 10.5 µm.
        { id: 'ir108', role: 'any', icon: 'fa-temperature-half',
          test: s => /ir[_\s-]?10[._]?[58]|10[.,][58]\s*[µμ]?m/i.test(s) },
        { id: 'ctth', role: 'context', icon: 'fa-arrows-up-to-line',
          test: s => /ctth|cloud.?top.?(height|temp)/i.test(s) }
    ];
    // Colour keys from EUMETSAT's RGB quick guides; swatches sampled from
    // the official colour-interpretation charts. Texts: mapKey_<id>.
    const GUIDE = 'https://user.eumetsat.int/resources/user-guides/';
    const RGB_KEYS = {
        fog: { guide: GUIDE + 'night-microphysics-rgb-quick-guide',
            colors: [['#785af0', '#b06fd9'], '#9cd0d9', '#aad7b0', '#a6797b', '#820a14', 'dots', '#1b009c', '#7800c8', '#c80078'] },
        dayMicro: { guide: GUIDE + 'day-microphysics-rgb-quick-guide',
            colors: ['#b4d878', '#8665ac', '#54a28c', '#e6661b', '#a34448', '#ce4698', '#5d9eba', '#064ab5'] },
        natural: { guide: GUIDE + 'natural-colour-rgb-quick-guide',
            colors: ['#f2f2f2', '#dae3f4', '#6bd4c6', '#57f6da', '#7b8745', '#b99774', '#156c7d', '#131d29'] }
    };

    const PRECIP = { id: 'precip', prefer: ['mtg_fd:h40b', 'msg_fes:h60b'], test: s => /precip|rain.?rate/i.test(s) };
    const BORDERS = { id: 'borders', test: s => /boundar|border|coastline/i.test(s) };

    // ================= Translations =================
    const MAP_I18N = {
        en: {
            mapProductTitle: 'Satellite product',
            mapKeyTitle: 'Colour key',
            mapKeySource: 'EUMETSAT quick guide',
            mapKeyAngle: 'Colours also vary with viewing angle, season and latitude.',
            mapKey_fog: [
                'Cloud-free land and sea (blue or pink, by surface temperature and moisture)',
                'Warm, thick fog / low cloud, small droplets (aqua)',
                'Cold, thick fog / low cloud (greenish; pinkish grey if thin or large droplets)',
                'Thick mid-level cloud (tan)',
                'Thick ice cloud (reddish brown)',
                'Very cold thick ice cloud (reddish brown with green dots)',
                'Thin cirrus (dark blue)',
                'Very thin cirrus (magenta / violet)',
                'Any cloud in daylight — this RGB is night-only (magenta, red or blue)'
            ],
            mapKey_fog_note: 'Fog and low cloud look the same; fog under cirrus may not show. The thinner the fog, the more it takes the pink ground colour.',
            mapKey_dayMicro: [
                'Low / mid-level thick water cloud, small droplets (incl. fog)',
                'Thick low-level water cloud, large droplets',
                'Semi-transparent ice cloud',
                'Thick ice cloud with small ice crystals on top',
                'Thick ice cloud with large ice particles',
                'Snow and ice on the ground',
                'Cloud-free land',
                'Sea and lakes'
            ],
            mapKey_natural: [
                'Water cloud (fog or stratus)',
                'Mixed-phase cloud or cloud with a cirrus veil',
                'Thick ice cloud with large ice crystals',
                'Snow and ice on the ground',
                'Green vegetation',
                'Desert, bare soil or dry vegetation',
                'Sea ice without snow',
                'Sea and lakes'
            ],
            mapProduct_fog: 'Fog / Low Clouds RGB (Night Microphysics)',
            mapProduct_dayMicro: 'Day Microphysics RGB',
            mapProduct_natural: 'Natural Colour RGB',
            mapProduct_ir108: 'Infrared 10.8 / 10.5 µm',
            mapProduct_ctth: 'Cloud top height',
            mapProduct_none: 'None (precipitation only)',
            mapRole_night: 'Night',
            mapRole_day: 'Day',
            mapRole_any: 'Day & night',
            mapRole_context: 'Context',
            mapNotFound: 'not offered by the service',
            mapSource: 'Source layer',
            mapOpacity: 'Opacity',
            mapDisclaimer: 'RGB imagery shows likely fog / low cloud visually. It does not measure cloud-base height. Cloud-top height is not cloud-base height.',
            mapPrecipTitle: 'Precipitation',
            mapPrecipShow: 'Show precipitation layer',
            mapPrecipKind: 'Satellite-derived precipitation rate at ground (observation-based estimate, not a forecast).',
            mapPrecipNone: 'No near-real-time precipitation product found in the service for this area. Use the forecast charts for precipitation forecasts.',
            mapPrecipPartial: 'The precipitation product does not cover the whole selected area.',
            mapPrecipAt: 'Precipitation frame: {time}',
            mapPrecipNoFrame: 'No precipitation frame within 30 min of this image.',
            mapRegionTitle: 'Region',
            mapRegion_ukraine: 'Ukraine',
            mapRegion_europe: 'Europe',
            mapRegion_location: 'Around current location',
            mapRegion_custom: 'Custom area',
            mapDraw: 'Draw box',
            mapDrawHint: 'Drag on the map to draw the area',
            mapSaveView: 'Save view',
            mapSaveName: 'Name for this area',
            mapDeleteRegion: 'Delete saved area',
            mapBaseTitle: 'Map',
            mapBase_osm: 'OSM',
            mapBase_none: 'None',
            mapBorders: 'Borders on top',
            mapTimeTitle: 'Animation',
            mapWindowHours: '{n} h',
            mapUtc: 'UTC',
            mapLocal: 'Local',
            mapPlay: 'Play',
            mapPause: 'Pause',
            mapPrev: 'Previous frame',
            mapNext: 'Next frame',
            mapLatest: 'Latest frame',
            mapSpeed: 'Speed',
            mapFrameOf: 'frame {i} of {n}',
            mapLoadingFrames: 'loading {done}/{n}',
            mapFailedFrames: '{n} failed',
            mapLoadingCatalog: 'Reading the EUMETSAT layer list…',
            mapNoTimes: 'Time steps unavailable — showing the latest image only.',
            mapStale: 'Latest available image is {age} old.',
            mapPartial: 'This product does not cover the whole selected area.',
            mapOffline: 'Offline — satellite imagery needs a connection.',
            mapNight: 'Night over this area — Fog / Low Clouds RGB is the best fog product.',
            mapDay: 'Daytime over this area — Day Microphysics or Natural Colour show fog and low cloud best.',
            mapTwilight: 'Twilight over this area — night and day products are both limited now.',
            mapUse: 'Switch',
            mapDiagTitle: 'Diagnostics',
            mapDiagService: 'Service',
            mapDiagCatalog: 'Layer list',
            mapDiagLayer: 'Layer',
            mapDiagTimes: 'Time steps',
            mapDiagLatest: 'Latest available',
            mapDiagFrames: 'Frames',
            mapDiagMode: 'Image requests',
            mapDiagLastOk: 'Last successful request',
            mapDiagLastError: 'Last error',
            mapDiagReload: 'Reload layer list',
            mapDiagNone: '—',
            mapCatalogLoaded: '{n} layers read {when}',
            mapErrNetwork: 'Network error or the service blocked the request',
            mapErrTimeout: 'Request timed out',
            mapErrRate: 'Too many requests — slowing down',
            mapErrCatalog: 'Could not read the EUMETSAT layer list: {msg}',
            mapErrFrame: 'Image failed: {msg}',
            mapAttrNote: 'Imagery © EUMETSAT, via EUMETView. Check EUMETSAT data policy before public or commercial use.',
            mapPanelToggle: 'Layers & settings',
            mapProbeToggle: 'Point readout (crosshair)',
            mapCenterLoc: 'Centre on forecast location',
            mapProbeSat: 'Satellite',
            mapProbeClose: 'close colour match',
            mapProbeApprox: 'approximate match',
            mapProbeOr: 'or',
            mapProbeUnclear: 'unclear colour — nearest: {label}',
            mapProbeNoKey: 'pixel colour (no colour key for this product)',
            mapProbeRain: 'Precipitation',
            mapProbeRainValue: '{v} {u}/h',
            mapProbeQuality: 'quality {q}%',
            mapProbeModel: 'Model',
            mapProbeModelValues: 'low clouds {c}% · visibility {v} km · precip {p} {u}',
            mapProbeNoData: 'no data at this point',
            mapProbeNoValue: 'colour only, no value',
            mapProbePlaying: 'Pause the animation to read values',
            mapProbeLoading: 'Reading…',
            mapProbeError: 'could not read ({msg})',
            mapGoForecast: 'Forecast here',
            mapProbeCollapse: 'Collapse / expand',
            mapNow: 'latest available'
        },
        uk: {
            mapProductTitle: 'Супутниковий продукт',
            mapKeyTitle: 'Пояснення кольорів',
            mapKeySource: 'Довідник EUMETSAT',
            mapKeyAngle: 'Кольори також залежать від кута огляду, сезону та широти.',
            mapKey_fog: [
                'Безхмарні суходіл і море (синій або рожевий — залежно від температури поверхні й вологості)',
                'Теплий щільний туман / низька хмарність, дрібні краплі (аква)',
                'Холодний щільний туман / низька хмарність (зеленуватий; рожево-сірий, якщо тонкий або великі краплі)',
                'Щільна хмарність середнього ярусу (бежевий)',
                'Щільна льодяна хмарність (червоно-коричневий)',
                'Дуже холодна щільна льодяна хмарність (червоно-коричневий із зеленими цятками)',
                'Тонкі перисті хмари (темно-синій)',
                'Дуже тонкі перисті хмари (пурпурово-фіолетовий)',
                'Будь-яка хмарність удень — цей RGB лише нічний (пурпуровий, червоний або синій)'
            ],
            mapKey_fog_note: 'Туман і низьку хмарність за кольором не розрізнити; під перистими хмарами туман може бути не видно. Що тонший туман, то більше він набуває рожевого кольору поверхні.',
            mapKey_dayMicro: [
                'Щільна водяна хмарність нижнього / середнього ярусу, дрібні краплі (зокрема туман)',
                'Щільна водяна хмарність нижнього ярусу, великі краплі',
                'Напівпрозора льодяна хмарність',
                'Щільна льодяна хмарність із дрібними кристалами вгорі',
                'Щільна льодяна хмарність із великими частинками льоду',
                'Сніг і лід на поверхні',
                'Безхмарний суходіл',
                'Море та озера'
            ],
            mapKey_natural: [
                'Водяна хмарність (туман або шарувата)',
                'Змішана хмарність або хмари під пеленою перистих',
                'Щільна льодяна хмарність із великими кристалами',
                'Сніг і лід на поверхні',
                'Зелена рослинність',
                'Пустеля, оголений ґрунт або суха рослинність',
                'Морський лід без снігу',
                'Море та озера'
            ],
            mapProduct_fog: 'Туман / низька хмарність RGB (нічна мікрофізика)',
            mapProduct_dayMicro: 'Денна мікрофізика RGB',
            mapProduct_natural: 'Природні кольори RGB',
            mapProduct_ir108: 'Інфрачервоний 10,8 / 10,5 мкм',
            mapProduct_ctth: 'Висота верхньої межі хмар',
            mapProduct_none: 'Немає (лише опади)',
            mapRole_night: 'Ніч',
            mapRole_day: 'День',
            mapRole_any: 'День і ніч',
            mapRole_context: 'Контекст',
            mapNotFound: 'сервіс не надає',
            mapSource: 'Шар-джерело',
            mapOpacity: 'Непрозорість',
            mapDisclaimer: 'RGB-зображення візуально показують ймовірний туман / низьку хмарність. Вони не вимірюють висоту нижньої межі хмар. Висота верхньої межі — не висота нижньої.',
            mapPrecipTitle: 'Опади',
            mapPrecipShow: 'Показати шар опадів',
            mapPrecipKind: 'Інтенсивність опадів біля землі за супутниковими даними (оцінка за спостереженнями, не прогноз).',
            mapPrecipNone: 'Сервіс не надає продукту опадів майже в реальному часі для цієї області. Для прогнозу опадів використовуйте графіки прогнозу.',
            mapPrecipPartial: 'Продукт опадів покриває не всю вибрану область.',
            mapPrecipAt: 'Кадр опадів: {time}',
            mapPrecipNoFrame: 'Немає кадру опадів у межах 30 хв від цього зображення.',
            mapRegionTitle: 'Регіон',
            mapRegion_ukraine: 'Україна',
            mapRegion_europe: 'Європа',
            mapRegion_location: 'Навколо поточної локації',
            mapRegion_custom: 'Власна область',
            mapDraw: 'Намалювати',
            mapDrawHint: 'Проведіть по карті, щоб виділити область',
            mapSaveView: 'Зберегти вигляд',
            mapSaveName: 'Назва області',
            mapDeleteRegion: 'Видалити збережену область',
            mapBaseTitle: 'Карта',
            mapBase_osm: 'OSM',
            mapBase_none: 'Немає',
            mapBorders: 'Кордони зверху',
            mapTimeTitle: 'Анімація',
            mapWindowHours: '{n} год',
            mapUtc: 'UTC',
            mapLocal: 'Місцевий',
            mapPlay: 'Відтворити',
            mapPause: 'Пауза',
            mapPrev: 'Попередній кадр',
            mapNext: 'Наступний кадр',
            mapLatest: 'Останній кадр',
            mapSpeed: 'Швидкість',
            mapFrameOf: 'кадр {i} з {n}',
            mapLoadingFrames: 'завантаження {done}/{n}',
            mapFailedFrames: 'помилок: {n}',
            mapLoadingCatalog: 'Читаю список шарів EUMETSAT…',
            mapNoTimes: 'Часові кроки недоступні — показано лише останнє зображення.',
            mapStale: 'Останнє доступне зображення має вік {age}.',
            mapPartial: 'Цей продукт покриває не всю вибрану область.',
            mapOffline: 'Офлайн — для супутникових знімків потрібне з’єднання.',
            mapNight: 'Над цією областю ніч — найкращий продукт для туману: Туман / низька хмарність RGB.',
            mapDay: 'Над цією областю день — туман і низьку хмарність найкраще видно на Денній мікрофізиці або Природних кольорах.',
            mapTwilight: 'Над цією областю сутінки — і нічні, і денні продукти зараз обмежені.',
            mapUse: 'Перемкнути',
            mapDiagTitle: 'Діагностика',
            mapDiagService: 'Сервіс',
            mapDiagCatalog: 'Список шарів',
            mapDiagLayer: 'Шар',
            mapDiagTimes: 'Часові кроки',
            mapDiagLatest: 'Останнє доступне',
            mapDiagFrames: 'Кадри',
            mapDiagMode: 'Запити зображень',
            mapDiagLastOk: 'Останній успішний запит',
            mapDiagLastError: 'Остання помилка',
            mapDiagReload: 'Перечитати список шарів',
            mapDiagNone: '—',
            mapCatalogLoaded: '{n} шарів, прочитано {when}',
            mapErrNetwork: 'Помилка мережі або сервіс заблокував запит',
            mapErrTimeout: 'Час очікування вичерпано',
            mapErrRate: 'Забагато запитів — сповільнюю',
            mapErrCatalog: 'Не вдалося прочитати список шарів EUMETSAT: {msg}',
            mapErrFrame: 'Помилка зображення: {msg}',
            mapAttrNote: 'Знімки © EUMETSAT, через EUMETView. Перед публічним чи комерційним використанням перевірте політику даних EUMETSAT.',
            mapPanelToggle: 'Шари та налаштування',
            mapProbeToggle: 'Дані в точці (приціл)',
            mapCenterLoc: 'Центрувати на локації прогнозу',
            mapProbeSat: 'Супутник',
            mapProbeClose: 'колір близький',
            mapProbeApprox: 'приблизний збіг',
            mapProbeOr: 'або',
            mapProbeUnclear: 'колір неоднозначний — найближче: {label}',
            mapProbeNoKey: 'колір пікселя (для цього продукту немає пояснення кольорів)',
            mapProbeRain: 'Опади',
            mapProbeRainValue: '{v} {u}/год',
            mapProbeQuality: 'якість {q}%',
            mapProbeModel: 'Модель',
            mapProbeModelValues: 'низька хмарність {c}% · видимість {v} км · опади {p} {u}',
            mapProbeNoData: 'немає даних у цій точці',
            mapProbeNoValue: 'лише колір, без значення',
            mapProbePlaying: 'Поставте анімацію на паузу, щоб побачити значення',
            mapProbeLoading: 'Читаю…',
            mapProbeError: 'не вдалося прочитати ({msg})',
            mapGoForecast: 'Прогноз тут',
            mapProbeCollapse: 'Згорнути / розгорнути',
            mapNow: 'останнє доступне'
        },
        'pt-BR': {
            mapProductTitle: 'Produto de satélite',
            mapKeyTitle: 'Legenda de cores',
            mapKeySource: 'Guia rápido da EUMETSAT',
            mapKeyAngle: 'As cores também variam com o ângulo de visada, a estação e a latitude.',
            mapKey_fog: [
                'Terra e mar sem nuvens (azul ou rosa, conforme temperatura da superfície e umidade)',
                'Nevoeiro / nuvem baixa espessa e quente, gotas pequenas (água-marinha)',
                'Nevoeiro / nuvem baixa espessa e fria (esverdeado; cinza-rosado se fino ou com gotas grandes)',
                'Nuvem média espessa (bege)',
                'Nuvem de gelo espessa (marrom-avermelhado)',
                'Nuvem de gelo espessa muito fria (marrom-avermelhado com pontos verdes)',
                'Cirrus fino (azul-escuro)',
                'Cirrus muito fino (magenta / violeta)',
                'Qualquer nuvem de dia — este RGB é só noturno (magenta, vermelho ou azul)'
            ],
            mapKey_fog_note: 'Nevoeiro e nuvem baixa têm a mesma cor; nevoeiro sob cirrus pode não aparecer. Quanto mais fino o nevoeiro, mais ele assume a cor rosada do solo.',
            mapKey_dayMicro: [
                'Nuvem de água espessa baixa / média, gotas pequenas (inclui nevoeiro)',
                'Nuvem de água espessa baixa, gotas grandes',
                'Nuvem de gelo semitransparente',
                'Nuvem de gelo espessa com cristais pequenos no topo',
                'Nuvem de gelo espessa com partículas de gelo grandes',
                'Neve e gelo no solo',
                'Terra sem nuvens',
                'Mar e lagos'
            ],
            mapKey_natural: [
                'Nuvem de água (nevoeiro ou estrato)',
                'Nuvem de fase mista ou com véu de cirrus',
                'Nuvem de gelo espessa com cristais grandes',
                'Neve e gelo no solo',
                'Vegetação verde',
                'Deserto, solo exposto ou vegetação seca',
                'Gelo marinho sem neve',
                'Mar e lagos'
            ],
            mapProduct_fog: 'Nevoeiro / Nuvens baixas RGB (microfísica noturna)',
            mapProduct_dayMicro: 'Microfísica diurna RGB',
            mapProduct_natural: 'Cor natural RGB',
            mapProduct_ir108: 'Infravermelho 10,8 / 10,5 µm',
            mapProduct_ctth: 'Altura do topo das nuvens',
            mapProduct_none: 'Nenhum (só precipitação)',
            mapRole_night: 'Noite',
            mapRole_day: 'Dia',
            mapRole_any: 'Dia e noite',
            mapRole_context: 'Contexto',
            mapNotFound: 'não oferecido pelo serviço',
            mapSource: 'Camada de origem',
            mapOpacity: 'Opacidade',
            mapDisclaimer: 'Imagens RGB mostram visualmente prováveis nevoeiro / nuvens baixas. Não medem a altura da base das nuvens. Altura do topo não é altura da base.',
            mapPrecipTitle: 'Precipitação',
            mapPrecipShow: 'Mostrar camada de precipitação',
            mapPrecipKind: 'Taxa de precipitação no solo derivada de satélite (estimativa baseada em observação, não previsão).',
            mapPrecipNone: 'O serviço não oferece produto de precipitação quase em tempo real para esta área. Use os gráficos de previsão para precipitação.',
            mapPrecipPartial: 'O produto de precipitação não cobre toda a área selecionada.',
            mapPrecipAt: 'Quadro de precipitação: {time}',
            mapPrecipNoFrame: 'Sem quadro de precipitação até 30 min desta imagem.',
            mapRegionTitle: 'Região',
            mapRegion_ukraine: 'Ucrânia',
            mapRegion_europe: 'Europa',
            mapRegion_location: 'Ao redor do local atual',
            mapRegion_custom: 'Área personalizada',
            mapDraw: 'Desenhar área',
            mapDrawHint: 'Arraste no mapa para desenhar a área',
            mapSaveView: 'Salvar vista',
            mapSaveName: 'Nome para esta área',
            mapDeleteRegion: 'Excluir área salva',
            mapBaseTitle: 'Mapa',
            mapBase_osm: 'OSM',
            mapBase_none: 'Nenhum',
            mapBorders: 'Fronteiras por cima',
            mapTimeTitle: 'Animação',
            mapWindowHours: '{n} h',
            mapUtc: 'UTC',
            mapLocal: 'Local',
            mapPlay: 'Reproduzir',
            mapPause: 'Pausar',
            mapPrev: 'Quadro anterior',
            mapNext: 'Próximo quadro',
            mapLatest: 'Último quadro',
            mapSpeed: 'Velocidade',
            mapFrameOf: 'quadro {i} de {n}',
            mapLoadingFrames: 'carregando {done}/{n}',
            mapFailedFrames: '{n} com erro',
            mapLoadingCatalog: 'Lendo a lista de camadas da EUMETSAT…',
            mapNoTimes: 'Horários indisponíveis — mostrando só a imagem mais recente.',
            mapStale: 'A imagem mais recente tem {age}.',
            mapPartial: 'Este produto não cobre toda a área selecionada.',
            mapOffline: 'Offline — imagens de satélite precisam de conexão.',
            mapNight: 'Noite nesta área — Nevoeiro / Nuvens baixas RGB é o melhor produto para nevoeiro.',
            mapDay: 'Dia nesta área — Microfísica diurna ou Cor natural mostram melhor nevoeiro e nuvens baixas.',
            mapTwilight: 'Crepúsculo nesta área — produtos noturnos e diurnos estão limitados agora.',
            mapUse: 'Trocar',
            mapDiagTitle: 'Diagnóstico',
            mapDiagService: 'Serviço',
            mapDiagCatalog: 'Lista de camadas',
            mapDiagLayer: 'Camada',
            mapDiagTimes: 'Horários',
            mapDiagLatest: 'Mais recente',
            mapDiagFrames: 'Quadros',
            mapDiagMode: 'Pedidos de imagem',
            mapDiagLastOk: 'Último pedido bem-sucedido',
            mapDiagLastError: 'Último erro',
            mapDiagReload: 'Recarregar lista de camadas',
            mapDiagNone: '—',
            mapCatalogLoaded: '{n} camadas lidas {when}',
            mapErrNetwork: 'Erro de rede ou o serviço bloqueou o pedido',
            mapErrTimeout: 'Tempo esgotado',
            mapErrRate: 'Pedidos demais — desacelerando',
            mapErrCatalog: 'Não foi possível ler a lista de camadas da EUMETSAT: {msg}',
            mapErrFrame: 'Falha na imagem: {msg}',
            mapAttrNote: 'Imagens © EUMETSAT, via EUMETView. Verifique a política de dados da EUMETSAT antes de uso público ou comercial.',
            mapPanelToggle: 'Camadas e ajustes',
            mapProbeToggle: 'Leitura no ponto (mira)',
            mapCenterLoc: 'Centralizar no local da previsão',
            mapProbeSat: 'Satélite',
            mapProbeClose: 'cor muito próxima',
            mapProbeApprox: 'correspondência aproximada',
            mapProbeOr: 'ou',
            mapProbeUnclear: 'cor incerta — mais próxima: {label}',
            mapProbeNoKey: 'cor do pixel (sem legenda de cores para este produto)',
            mapProbeRain: 'Precipitação',
            mapProbeRainValue: '{v} {u}/h',
            mapProbeQuality: 'qualidade {q}%',
            mapProbeModel: 'Modelo',
            mapProbeModelValues: 'nuvens baixas {c}% · visibilidade {v} km · precip. {p} {u}',
            mapProbeNoData: 'sem dados neste ponto',
            mapProbeNoValue: 'só cor, sem valor',
            mapProbePlaying: 'Pause a animação para ler os valores',
            mapProbeLoading: 'Lendo…',
            mapProbeError: 'não foi possível ler ({msg})',
            mapGoForecast: 'Previsão aqui',
            mapProbeCollapse: 'Recolher / expandir',
            mapNow: 'mais recente'
        }
    };
    Object.keys(MAP_I18N).forEach(lang => {
        if (translations[lang]) Object.assign(translations[lang], MAP_I18N[lang]);
    });

    // ================= Small helpers =================
    const $ = id => document.getElementById(id);
    const h = escapeHtml;

    // Builds a WMS URL with every parameter encoded. Keys listed in
    // `keepEmpty` are sent even when empty (STYLES= is mandatory in GetMap).
    function buildWmsUrl(base, params, keepEmpty = ['STYLES']) {
        const url = new URL(base);
        Object.entries(params).forEach(([k, v]) => {
            if (v === undefined || v === null) return;
            if (v === '' && !keepEmpty.includes(k)) return;
            url.searchParams.set(k, String(v));
        });
        return url.toString();
    }

    function isoDurationMs(str) {
        const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(String(str || '').trim());
        if (!m) return 0;
        const [, d, hh, mm, ss] = m.map(x => (x === undefined ? 0 : Number(x)));
        return ((d * 24 + hh) * 60 + mm) * 60000 + ss * 1000;
    }

    // Time dimension → sorted UTC ms values not older than `fromMs`. Handles
    // value lists, start/end/period intervals and a mix of both, and "PRESENT".
    function parseTimeDimension(text, fromMs = -Infinity) {
        const out = new Set();
        const now = Date.now();
        const parse = s => (/^present$/i.test(s.trim()) ? now : Date.parse(s.trim()));
        String(text || '').split(',').forEach(part => {
            if (!part.trim()) return;
            const seg = part.split('/');
            if (seg.length === 1) {
                const v = parse(seg[0]);
                if (Number.isFinite(v) && v >= fromMs) out.add(v);
                return;
            }
            const a = parse(seg[0]), b = parse(seg[1]);
            if (!Number.isFinite(a) || !Number.isFinite(b)) return;
            const step = seg[2] ? isoDurationMs(seg[2]) : 0;
            if (!step) { if (a >= fromMs) out.add(a); if (b >= fromMs) out.add(b); return; }
            let v = a < fromMs ? a + Math.ceil((fromMs - a) / step) * step : a;
            for (let n = 0; v <= b && n < 5000; v += step, n++) out.add(v);
        });
        return [...out].sort((x, y) => x - y);
    }

    function directChild(el, tag) {
        for (const c of el.children) if (c.localName === tag) return c;
        return null;
    }
    function directChildren(el, tag) {
        return [...el.children].filter(c => c.localName === tag);
    }
    function childText(el, tag) {
        const c = directChild(el, tag);
        return c ? c.textContent.trim() : '';
    }

    // OGC service exception → readable message (or null if not one).
    function parseServiceException(text) {
        if (!/ServiceException|ExceptionReport/i.test(text || '')) return null;
        try {
            const doc = new DOMParser().parseFromString(text, 'application/xml');
            const ex = doc.querySelector('ServiceException, Exception, ExceptionText');
            const code = ex && (ex.getAttribute('code') || ex.getAttribute('exceptionCode'));
            const msg = ex ? ex.textContent.trim() : text.slice(0, 200);
            return (code ? `${code}: ` : '') + msg.replace(/\s+/g, ' ').slice(0, 300);
        } catch (err) {
            return text.slice(0, 200);
        }
    }

    // Parses a WMS 1.3.0 capabilities document into named layers with
    // inherited bounding box, styles and time dimension.
    function parseCapabilities(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid capabilities XML');
        const exc = parseServiceException(xmlText);
        if (exc && !doc.getElementsByTagNameNS('*', 'Capability').length) throw new Error(exc);
        const layers = [];
        const walk = (el, inherited) => {
            const geo = directChild(el, 'EX_GeographicBoundingBox');
            const bbox = geo ? ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map(k => Number(childText(geo, k))) : inherited.bbox;
            const dims = directChildren(el, 'Dimension').concat(directChildren(el, 'Extent'));
            const timeEl = dims.find(d => (d.getAttribute('name') || '').toLowerCase() === 'time');
            const time = timeEl ? { values: timeEl.textContent.trim(), def: timeEl.getAttribute('default') || '' } : inherited.time;
            const crs = new Set(inherited.crs);
            directChildren(el, 'CRS').concat(directChildren(el, 'SRS')).forEach(c => crs.add(c.textContent.trim()));
            const name = childText(el, 'Name');
            if (name) {
                const styles = directChildren(el, 'Style').map(s => {
                    const legend = directChild(s, 'LegendURL');
                    const res = legend && directChild(legend, 'OnlineResource');
                    return {
                        name: childText(s, 'Name'),
                        title: childText(s, 'Title'),
                        legend: res ? (res.getAttribute('xlink:href') || res.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '') : ''
                    };
                });
                layers.push({
                    name, title: childText(el, 'Title'), abstract: childText(el, 'Abstract').slice(0, 400),
                    bbox: bbox && bbox.every(Number.isFinite) ? bbox : null,
                    time, styles, crs3857: crs.has('EPSG:3857') || crs.has('EPSG:900913')
                });
            }
            directChildren(el, 'Layer').forEach(child => walk(child, { bbox, time, crs: [...crs] }));
        };
        const cap = doc.getElementsByTagNameNS('*', 'Capability')[0];
        const root = cap && directChild(cap, 'Layer');
        if (root) walk(root, { bbox: null, time: null, crs: [] });
        return layers;
    }

    function covers(bbox, region) {
        if (!bbox) return true;   // unknown: don't warn
        const [w, s, e, n] = bbox;
        return w <= region[0] + 0.01 && s <= region[1] + 0.01 && e >= region[2] - 0.01 && n >= region[3] - 0.01;
    }

    function sourceRank(layer, product, region) {
        let r = 0;
        // Preferred names first, in the order listed.
        if (product.prefer && product.prefer.includes(layer.name)) r += -1000 + product.prefer.indexOf(layer.name) * 100;
        if (!covers(layer.bbox, region)) r += 100;
        const ns = layer.name.split(':')[0].toLowerCase();
        // MSG 0° first (the reference products), then MTG, MSG rapid scan
        // (5 min, Europe), MSG Indian Ocean, then the rest.
        if (/^msg_fes|^msg$/.test(ns)) r += 0;
        else if (/mtg|fci/.test(ns)) r += 10;
        else if (/rss/.test(ns)) r += 15;
        else if (/iodc/.test(ns)) r += 30;
        else r += 20;
        return r;
    }

    // ================= Persistent settings =================
    const defaults = {
        product: null, productAt: 0, sources: {}, opacity: 0.4, precipOn: false, precipOpacity: 0.4,
        basemap: 'osm', borders: true, windowH: 6, utc: true, speed: 1,
        view: null, region: 'ukraine', panelOpen: null, diagOpen: false, keyOpen: true, probe: true, probeOpen: true
    };
    const S = Object.assign({}, defaults, loadFromStorage(MAP_CONFIG.settingsKey, {}) || {});
    // Opacity defaults to 40%; only a value the user actually set is kept
    // (earlier versions stored the old 100% / 85% defaults unasked).
    if (!S.opacitySet) S.opacity = defaults.opacity;
    if (!S.precipOpacitySet) S.precipOpacity = defaults.precipOpacity;
    if (!MAP_CONFIG.windows.includes(S.windowH)) S.windowH = 6;
    if (!MAP_CONFIG.speeds.includes(S.speed)) S.speed = 1;
    if (!['osm', 'none'].includes(S.basemap)) S.basemap = 'osm';
    delete S.labels;
    let savedRegions = loadFromStorage(MAP_CONFIG.regionsKey, []);
    if (!Array.isArray(savedRegions)) savedRegions = [];
    const save = () => saveToStorage(MAP_CONFIG.settingsKey, S);

    // ================= Runtime state =================
    const R = {
        map: null, built: false, visible: false,
        catalog: null,            // { at, layers: [...] } (matched layers only)
        catalogStatus: 'idle',    // idle | loading | ok | error
        catalogError: '',
        resolved: {},             // productId -> [layer, ...] ordered
        precipLayers: [], borderLayers: [],
        times: {},                // layerName -> { at, list:[ms], ok, error }
        frames: [],               // [{ t, key }]
        precipFrames: [],
        index: -1, playing: false, playTimer: null,
        extent: null,             // { key, bounds, bbox3857, w, h }
        overlay: null, precipOverlay: null, bordersLayer: null, baseLayer: null, locMarker: null,
        lastOk: null, lastError: null, requestMode: 'fetch', fetchWorked: false,
        refreshTimer: null, moveTimer: null, drawing: null, gen: 0
    };

    // ================= Image queue & cache =================
    const cache = new Map();      // key -> entry { key, url, status, error, controller, img }
    const queue = [];
    let active = 0;

    function frameKey(layer, style, t, ext, format) {
        return [layer, style || '', t === null ? 'latest' : t, ext.key, `${ext.w}x${ext.h}`, MAP_CONFIG.crs, format].join('|');
    }

    function getMapUrl(layerName, style, t, ext, format) {
        const opaque = format === 'image/jpeg';
        return buildWmsUrl(MAP_CONFIG.wmsBase, {
            SERVICE: 'WMS', VERSION: MAP_CONFIG.version, REQUEST: 'GetMap',
            LAYERS: layerName, STYLES: style || '', CRS: MAP_CONFIG.crs,
            BBOX: ext.bbox3857.join(','), WIDTH: ext.w, HEIGHT: ext.h,
            FORMAT: format, TRANSPARENT: opaque ? 'FALSE' : 'TRUE', BGCOLOR: opaque ? MAP_CONFIG.background : undefined, EXCEPTIONS: 'XML',
            TIME: t === null ? undefined : new Date(t).toISOString().replace('.000Z', 'Z')
        });
    }

    function ensureFrame(job, priority) {
        let e = cache.get(job.key);
        if (e) {
            // Refresh LRU position.
            cache.delete(job.key); cache.set(job.key, e);
            if (e.status === 'queued' && priority) { const i = queue.indexOf(e); if (i > 0) { queue.splice(i, 1); queue.unshift(e); } }
            return e;
        }
        e = { key: job.key, src: job.url, status: 'queued', url: null, error: '', waiters: [] };
        cache.set(job.key, e);
        if (priority) queue.unshift(e); else queue.push(e);
        pump();
        return e;
    }

    function whenReady(e) {
        if (e.status === 'ok' || e.status === 'error') return Promise.resolve(e);
        return new Promise(res => e.waiters.push(res));
    }

    function settle(e) {
        const w = e.waiters; e.waiters = [];
        w.forEach(fn => fn(e));
        renderProgress();
        if (e.status === 'ok') evict();
    }

    // Drops queued / in-flight requests whose key is not wanted any more.
    function cancelExcept(wanted) {
        for (let i = queue.length - 1; i >= 0; i--) {
            if (!wanted.has(queue[i].key)) { cache.delete(queue[i].key); queue.splice(i, 1); }
        }
        cache.forEach((e, key) => {
            if (e.status === 'loading' && !wanted.has(key)) {
                try { e.controller && e.controller.abort(); } catch (err) {}
                if (e.img) e.img.src = '';
                cache.delete(key);
            }
        });
    }

    function evict() {
        if (cache.size <= MAP_CONFIG.cacheLimit) return;
        const inUse = new Set(R.frames.map(f => f.key).concat(R.precipFrames.map(f => f.key)));
        for (const [key, e] of cache) {
            if (cache.size <= MAP_CONFIG.cacheLimit) break;
            if (inUse.has(key) || e.status === 'loading' || e.status === 'queued') continue;
            if (e.url && e.url.startsWith('blob:')) URL.revokeObjectURL(e.url);
            cache.delete(key);
        }
    }

    function pump() {
        while (active < MAP_CONFIG.concurrency && queue.length) {
            const e = queue.shift();
            active++;
            load(e).finally(() => { active--; pump(); });
        }
    }

    async function load(e, attempt = 0) {
        e.status = 'loading';
        renderProgress();
        if (R.requestMode === 'img') return loadAsImage(e);
        const controller = new AbortController();
        e.controller = controller;
        const timer = setTimeout(() => controller.abort('timeout'), MAP_CONFIG.requestTimeoutMs);
        try {
            const res = await fetch(e.src, { signal: controller.signal, mode: 'cors', credentials: 'omit' });
            // Rate limit or a transient gateway error: back off and retry.
            if ([429, 502, 503, 504].includes(res.status)) {
                clearTimeout(timer);
                if (attempt < 2) {
                    noteError(res.status === 429 ? t('mapErrRate') : `HTTP ${res.status}`, e.src);
                    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                    if (!cache.has(e.key)) return;
                    return load(e, attempt + 1);
                }
            }
            const type = res.headers.get('content-type') || '';
            if (!res.ok || !type.startsWith('image/')) {
                const text = await res.text();
                throw new Error(parseServiceException(text) || `HTTP ${res.status}${type ? ` (${type.split(';')[0]})` : ''}`);
            }
            const blob = await res.blob();
            R.fetchWorked = true;
            const url = URL.createObjectURL(blob);
            await decode(url);
            if (!cache.has(e.key)) { URL.revokeObjectURL(url); return; }
            e.url = url; e.status = 'ok';
            R.lastOk = { url: e.src, at: Date.now() };
        } catch (err) {
            if (!cache.has(e.key)) return;           // cancelled
            const reason = controller.signal.aborted ? (controller.signal.reason === 'timeout' ? t('mapErrTimeout') : 'aborted') : null;
            // A TypeError before anything ever worked means the browser could
            // not read the response (usually missing CORS headers): plain
            // <img> requests still work without CORS, so switch to those.
            if (!reason && err instanceof TypeError && !R.fetchWorked) {
                R.requestMode = 'img';
                return loadAsImage(e);
            }
            e.status = 'error';
            e.error = reason || (err instanceof TypeError ? t('mapErrNetwork') : err.message);
            noteError(t('mapErrFrame', { msg: e.error }), e.src);
        } finally {
            clearTimeout(timer);
            e.controller = null;
            // Only a finished request settles; a retry or the <img> fallback
            // carries on with the same entry.
            if (e.status === 'ok' || e.status === 'error') settle(e);
        }
    }

    function loadAsImage(e) {
        return new Promise(resolve => {
            const img = new Image();
            e.img = img;
            const timer = setTimeout(() => { img.src = ''; done(false, t('mapErrTimeout')); }, MAP_CONFIG.requestTimeoutMs);
            const done = (ok, msg) => {
                clearTimeout(timer);
                e.img = null;
                if (!cache.has(e.key)) return resolve();
                if (ok) { e.url = e.src; e.status = 'ok'; R.lastOk = { url: e.src, at: Date.now() }; }
                else { e.status = 'error'; e.error = msg; noteError(t('mapErrFrame', { msg }), e.src); }
                settle(e);
                resolve();
            };
            img.onload = () => done(true);
            // Without CORS the exception text can't be read; the URL is in Diagnostics.
            img.onerror = () => done(false, t('mapErrNetwork'));
            img.src = e.src;
        });
    }

    function decode(url) {
        const img = new Image();
        img.src = url;
        return img.decode ? img.decode().catch(() => {}) : new Promise(r => { img.onload = img.onerror = r; });
    }

    function noteError(msg, url) {
        R.lastError = { msg, url: url || '', at: Date.now() };
        renderDiagnostics();
    }

    // ================= Capabilities =================
    async function fetchText(url, timeoutMs = 60000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal, credentials: 'omit' });
            const text = await res.text();
            if (!res.ok) throw new Error(parseServiceException(text) || `HTTP ${res.status}`);
            return text;
        } catch (err) {
            if (controller.signal.aborted) throw new Error(t('mapErrTimeout'));
            if (err instanceof TypeError) throw new Error(t('mapErrNetwork'));
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    function capsUrl(base) {
        return buildWmsUrl(base, { SERVICE: 'WMS', VERSION: MAP_CONFIG.version, REQUEST: 'GetCapabilities' });
    }

    function excluded(name) {
        return MAP_CONFIG.excludeNamespaces.includes(String(name).split(':')[0].toLowerCase());
    }

    function slimLayer(l) {
        return { name: l.name, title: l.title, abstract: l.abstract, bbox: l.bbox, styles: l.styles, crs3857: l.crs3857, hasTime: !!l.time };
    }

    function matchCatalog(layers) {
        const keep = new Map();
        const add = l => keep.set(l.name, l);
        layers.forEach(l => {
            const s = `${l.name} ${l.title}`;
            if (BORDERS.test(s) && !l.time) { add(l); return; }
            if (excluded(l.name)) return;
            if (PRODUCTS.some(p => (p.prefer || []).includes(l.name) || p.test(s)) || PRECIP.test(s) || BORDERS.test(s)) add(l);
        });
        return [...keep.values()];
    }

    async function loadCatalog(force) {
        if (!force) {
            const cached = loadFromStorage(MAP_CONFIG.catalogKey, null);
            if (cached && Array.isArray(cached.layers) && Date.now() - cached.at < MAP_CONFIG.catalogTtlMs) {
                R.catalog = cached; R.catalogStatus = 'ok';
                resolveProducts();
                return;
            }
        }
        R.catalogStatus = 'loading';
        renderAllMapUi();
        try {
            const text = await fetchText(capsUrl(MAP_CONFIG.wmsBase), 120000);
            const all = parseCapabilities(text);
            const matched = matchCatalog(all);
            // Times seen in the full document are fresh right now: keep them.
            matched.forEach(l => { if (l.time) storeTimes(l.name, l.time); });
            R.catalog = { at: Date.now(), total: all.length, layers: matched.map(slimLayer) };
            saveToStorage(MAP_CONFIG.catalogKey, R.catalog);
            R.catalogStatus = 'ok';
            R.catalogError = '';
        } catch (err) {
            R.catalogStatus = 'error';
            R.catalogError = err.message;
            noteError(t('mapErrCatalog', { msg: err.message }), capsUrl(MAP_CONFIG.wmsBase));
        }
        resolveProducts();
    }

    function storeTimes(name, time) {
        const list = parseTimeDimension(time.values, Date.now() - 36 * 3600e3);
        const def = Date.parse(time.def);
        if (!list.length && Number.isFinite(def)) list.push(def);
        R.times[name] = { at: Date.now(), list: list.filter(v => v <= Date.now() + 10 * 60e3), ok: true };
    }

    // Fresh time steps for one layer, from its own small capabilities
    // document (falls back to whatever the full catalog gave us).
    async function refreshTimes(name, force) {
        const known = R.times[name];
        if (!force && known && known.ok && Date.now() - known.at < MAP_CONFIG.timesTtlMs) return known;
        const base = MAP_CONFIG.layerWmsBase(name);
        try {
            if (!base) throw new Error('no workspace');
            const layers = parseCapabilities(await fetchText(capsUrl(base), 45000));
            const local = name.split(':').pop();
            const l = layers.find(x => x.name === name || x.name === local || x.name.split(':').pop() === local);
            if (!l) throw new Error(`LayerNotDefined: ${name}`);
            if (!l.time) { R.times[name] = { at: Date.now(), list: [], ok: true, noTime: true }; return R.times[name]; }
            storeTimes(name, l.time);
            return R.times[name];
        } catch (err) {
            noteError(`${name}: ${err.message}`, capsUrl(base || MAP_CONFIG.wmsBase));
            if (known && known.list.length) return known;
            R.times[name] = { at: Date.now(), list: [], ok: false, error: err.message };
            return R.times[name];
        }
    }

    function regionBbox() {
        const b = R.map ? R.map.getBounds() : null;
        return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : MAP_CONFIG.regions.ukraine;
    }

    function resolveProducts() {
        const all = R.catalog ? R.catalog.layers : [];
        const layers = all.filter(l => !excluded(l.name));
        const region = MAP_CONFIG.regions.ukraine;
        R.resolved = {};
        PRODUCTS.forEach(p => {
            const list = layers.filter(l => (p.prefer || []).includes(l.name) || p.test(`${l.name} ${l.title}`));
            // Without a catalog, preferred names are still tried (verified
            // through their own capabilities before use).
            if (!list.length && R.catalogStatus !== 'ok' && p.prefer) p.prefer.forEach(name => list.push({ name, title: name, styles: [], bbox: null, guessed: true }));
            list.sort((a, b) => sourceRank(a, p, region) - sourceRank(b, p, region) || a.name.localeCompare(b.name));
            R.resolved[p.id] = list;
        });
        R.precipLayers = layers.filter(l => PRECIP.test(`${l.name} ${l.title}`) && l.hasTime)
            .sort((a, b) => sourceRank(a, PRECIP, region) - sourceRank(b, PRECIP, region) || a.name.localeCompare(b.name));
        // Preferred boundary/coastline layers with their white-line style;
        // otherwise any boundary layer the service offers, default style.
        const byName = new Map(all.map(l => [l.name, l]));
        R.borderLayers = MAP_CONFIG.borders.filter(b => byName.has(b.name));
        if (!R.borderLayers.length) {
            const any = all.find(l => BORDERS.test(`${l.name} ${l.title}`) && !l.hasTime);
            if (any) R.borderLayers = [{ name: any.name, style: '' }];
        }
        if (!S.product || (S.product !== 'none' && !(R.resolved[S.product] || []).length) || Date.now() - S.productAt > 6 * 3600e3) {
            S.product = suggestedProduct();
        }
        updateBorders();
        renderAllMapUi();
        reloadFrames();
    }

    function activeLayer() {
        if (S.product === 'none') return null;
        const list = R.resolved[S.product] || [];
        return list.find(l => l.name === S.sources[S.product]) || list[0] || null;
    }

    function activePrecipLayer() {
        return S.precipOn ? (R.precipLayers.find(l => l.name === S.sources.precip) || R.precipLayers[0] || null) : null;
    }

    // ================= Day / night =================
    function sunState() {
        const c = R.map ? R.map.getCenter() : { lat: 48.5, lng: 31.5 };
        const alt = sunAltitudeDeg(Date.now(), c.lat, c.lng);
        return alt < -3 ? 'night' : alt > 6 ? 'day' : 'twilight';
    }

    function suggestedProduct() {
        const has = id => (R.resolved[id] || []).length > 0;
        const sun = sunState();
        const order = sun === 'day' ? ['dayMicro', 'natural', 'fog', 'ir108'] : sun === 'night' ? ['fog', 'ir108', 'dayMicro'] : ['fog', 'dayMicro', 'ir108'];
        return order.find(has) || PRODUCTS.map(p => p.id).find(has) || 'fog';
    }

    // ================= Extent =================
    function computeExtent() {
        const map = R.map;
        const size = map.getSize();
        if (!size.x || !size.y) return null;
        const b = map.getBounds().pad(0.1);
        const sw = L.CRS.EPSG3857.project(L.latLng(Math.max(b.getSouth(), -85), b.getWest()));
        const ne = L.CRS.EPSG3857.project(L.latLng(Math.min(b.getNorth(), 85), b.getEast()));
        // Snap to 1 km so tiny pans reuse cached images.
        const snap = v => Math.round(v / 1000) * 1000;
        const bbox3857 = [snap(sw.x), snap(sw.y), snap(ne.x), snap(ne.y)];
        // The imagery is ~3 km per pixel, so beyond 1.25× device pixels
        // only the download grows.
        const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
        let w = size.x * 1.2 * ratio, hh = size.y * 1.2 * ratio;
        const k = Math.min(1, MAP_CONFIG.maxImageSide / Math.max(w, hh));
        w = Math.round(w * k / 16) * 16; hh = Math.round(hh * k / 16) * 16;
        const bounds = L.latLngBounds(L.CRS.EPSG3857.unproject(L.point(bbox3857[0], bbox3857[1])), L.CRS.EPSG3857.unproject(L.point(bbox3857[2], bbox3857[3])));
        return { key: bbox3857.join(','), bbox3857, bounds, w, h: hh, zoom: map.getZoom() };
    }

    // True when the current view still sits inside the fetched extent at the same zoom.
    function extentStillGood() {
        if (!R.extent) return false;
        if (R.extent.zoom !== R.map.getZoom()) return false;
        return R.extent.bounds.contains(R.map.getBounds());
    }

    // ================= Frames =================
    async function reloadFrames(opts = {}) {
        if (!R.map || !R.visible) return;
        const gen = ++R.gen;
        if (!navigator.onLine) { renderStatus(); return; }
        if (opts.newExtent || !R.extent) R.extent = computeExtent();
        const ext = R.extent;
        if (!ext) return;
        const layer = activeLayer();
        const precip = activePrecipLayer();
        const winMs = S.windowH * 3600e3;

        const [satTimes, precipTimes] = await Promise.all([
            layer ? refreshTimes(layer.name, opts.forceTimes) : null,
            precip ? refreshTimes(precip.name, opts.forceTimes) : null
        ]);
        if (gen !== R.gen) return;

        const pick = info => {
            if (!info || !info.list.length) return info && (info.noTime || !info.ok) ? [null] : [];
            const latest = info.list[info.list.length - 1];
            return info.list.filter(v => v >= latest - winMs);
        };
        const satList = layer ? pick(satTimes) : [];
        const precipList = precip ? pick(precipTimes) : [];
        const satStyle = layer ? styleOf(layer) : '';
        const precipStyle = precip ? styleOf(precip) : '';
        const prevT = R.frames[R.index] ? R.frames[R.index].t : undefined;
        const wasLatest = R.index === R.frames.length - 1;

        const satFmt = MAP_CONFIG.format, precipFmt = MAP_CONFIG.overlayFormat;
        R.frames = satList.map(tm => ({ t: tm, key: frameKey(layer.name, satStyle, tm, ext, satFmt), url: getMapUrl(layer.name, satStyle, tm, ext, satFmt) }));
        R.precipFrames = precipList.map(tm => ({ t: tm, key: frameKey(precip.name, precipStyle, tm, ext, precipFmt), url: getMapUrl(precip.name, precipStyle, tm, ext, precipFmt) }));

        const wanted = new Set(R.frames.map(f => f.key).concat(R.precipFrames.map(f => f.key)));
        cancelExcept(wanted);
        // Opens on the latest image; only it is loaded until another time
        // is picked (showFrame() then loads from there forward).
        const timeline = timelineFrames();
        let idx = prevT === undefined || wasLatest ? timeline.length - 1 : timeline.findIndex(f => f.t === prevT);
        if (idx < 0) idx = timeline.length - 1;
        R.index = idx;
        renderAllMapUi();
        showFrame(R.index);
    }

    // Frames needed once frame `from` is selected: that frame, then every
    // later one up to the latest (with their precipitation frames).
    function framesFrom(from) {
        const tl = timelineFrames();
        const withPrecip = !!(activeLayer() && activePrecipLayer());
        const out = [], seen = new Set();
        const add = f => { if (f && !seen.has(f.key)) { seen.add(f.key); out.push(f); } };
        for (let i = Math.max(0, from); i < tl.length; i++) {
            add(tl[i]);
            if (withPrecip) add(precipFrameFor(tl[i].t));
        }
        return out;
    }

    // Loads the selected frame first, then the following ones in time order.
    // Earlier frames are never preloaded; queued requests that are no longer
    // ahead of the selection are dropped (ones already sent may finish).
    function loadFrom(from) {
        const want = framesFrom(from);
        const keys = new Set(want.map(f => f.key));
        for (let i = queue.length - 1; i >= 0; i--) {
            if (!keys.has(queue[i].key)) { cache.delete(queue[i].key); queue.splice(i, 1); }
        }
        want.forEach(f => {
            const e = cache.get(f.key);
            if (!e) ensureFrame(f, false);
            else if (e.status === 'queued') { queue.splice(queue.indexOf(e), 1); queue.push(e); }
        });
        renderProgress();
    }

    function styleOf(layer) {
        const chosen = S.sources[`${layer.name}#style`];
        if (chosen !== undefined && (layer.styles || []).some(s => s.name === chosen)) return chosen;
        return '';   // server default
    }

    // The timeline follows the satellite product, or the precipitation
    // layer when no product is selected.
    function timelineFrames() {
        return activeLayer() ? R.frames : R.precipFrames;
    }

    function precipFrameFor(tm) {
        if (!R.precipFrames.length || tm === null || tm === undefined) return R.precipFrames[R.precipFrames.length - 1] || null;
        let best = null;
        R.precipFrames.forEach(f => {
            if (f.t === null) return;
            if (f.t <= tm + 5 * 60e3 && tm - f.t <= 30 * 60e3 && (!best || Math.abs(f.t - tm) < Math.abs(best.t - tm))) best = f;
        });
        return best;
    }

    async function showFrame(i) {
        const tl = timelineFrames();
        if (!tl.length || i < 0) { setOverlay('overlay', null); setOverlay('precipOverlay', null); renderTimeLabel(); return; }
        R.index = Math.max(0, Math.min(i, tl.length - 1));
        loadFrom(R.index);
        renderSlider();
        renderTimeLabel();
        renderProgress();   // moves the current-frame marker
        const f = tl[R.index];
        const gen = R.gen;
        const satFrame = activeLayer() ? f : null;
        const precipFrame = activeLayer() ? (activePrecipLayer() ? precipFrameFor(f.t) : null) : f;
        const satEntry = satFrame ? cache.get(satFrame.key) || ensureFrame(satFrame, true) : null;
        const precipEntry = precipFrame ? cache.get(precipFrame.key) || ensureFrame(precipFrame, true) : null;
        if (satEntry) whenReady(satEntry).then(e => { if (gen === R.gen && timelineFrames()[R.index] === f && e.status === 'ok') setOverlay('overlay', e.url); });
        else setOverlay('overlay', null);
        if (precipEntry) whenReady(precipEntry).then(e => { if (gen === R.gen && timelineFrames()[R.index] === f && e.status === 'ok') setOverlay('precipOverlay', e.url); });
        else setOverlay('precipOverlay', null);
        renderPrecipInfo(precipFrame);
        if (!R.playing) scheduleProbe();
    }

    function setOverlay(which, url) {
        const ov = R[which];
        if (!url) { if (ov) ov.setUrl(transparentPixel); return; }
        const opacity = which === 'overlay' ? S.opacity : S.precipOpacity;
        if (!ov) {
            R[which] = L.imageOverlay(url, R.extent.bounds, {
                pane: which === 'overlay' ? 'sat' : 'precip', opacity, interactive: false,
                attribution: MAP_CONFIG.eumetsatAttribution
            }).addTo(R.map);
            return;
        }
        ov.setUrl(url);
        ov.setBounds(R.extent.bounds);
        ov.setOpacity(opacity);
    }
    const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    // ================= Playback =================
    function play(on) {
        R.playing = on;
        clearTimeout(R.playTimer);
        renderControls();
        if (on) tick();
        scheduleProbe();
    }

    function tick() {
        if (!R.playing) return;
        const tl = timelineFrames();
        if (tl.length < 2) { play(false); return; }
        // Next frame that has loaded; failed ones are skipped, pending ones
        // waited for. After the latest it wraps to the start of the window,
        // which (like any selection) loads from there forward.
        let next = (R.index + 1) % tl.length;
        for (let n = 0; n < tl.length; n++) {
            let e = cache.get(tl[next].key);
            if (!e) { loadFrom(next); e = cache.get(tl[next].key); }
            if (e && e.status === 'ok') break;
            if (e && (e.status === 'loading' || e.status === 'queued')) { R.playTimer = setTimeout(tick, 200); return; }
            next = (next + 1) % tl.length;
        }
        showFrame(next);
        const hold = next === tl.length - 1 ? 1500 : 0;   // pause on the newest image
        R.playTimer = setTimeout(tick, MAP_CONFIG.baseFrameMs / S.speed + hold);
    }

    function step(d) {
        play(false);
        const tl = timelineFrames();
        if (tl.length) showFrame((R.index + d + tl.length) % tl.length);
    }

    // ================= Formatting =================
    function fmtTime(ms) {
        if (ms === null || ms === undefined) return t('mapDiagNone');
        const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        if (S.utc) return `${new Intl.DateTimeFormat(currentLang, { ...opts, timeZone: 'UTC' }).format(ms)} UTC`;
        const off = -new Date(ms).getTimezoneOffset();
        const sign = off >= 0 ? '+' : '−';
        const hm = `${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? ':' + String(Math.abs(off) % 60).padStart(2, '0') : ''}`;
        return `${new Intl.DateTimeFormat(currentLang, opts).format(ms)} (UTC${sign}${hm})`;
    }

    function fmtAge(ms) {
        const min = Math.round(ms / 60000);
        return min < 90 ? `${min} min` : `${Math.round(min / 6) / 10} h`;
    }

    // ================= UI =================
    function buildUi() {
        const root = $('mapView');
        root.innerHTML = `
            <div id="satMap" class="absolute inset-0 z-0 bg-slate-950"></div>
            <div id="mapDrawHint" class="hidden absolute top-3 left-1/2 -translate-x-1/2 z-[500] px-3 py-1.5 rounded-lg bg-cyan-500 text-slate-950 text-xs font-semibold shadow-lg"></div>
            <button type="button" id="mapPanelBtn" class="absolute top-3 left-3 z-[500] flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/90 border border-slate-700 text-xs text-slate-200 shadow-xl backdrop-blur-md hover:border-cyan-600 transition">
                <i class="fa-solid fa-layer-group text-cyan-400"></i><span id="mapPanelBtnLabel" class="max-w-[11rem] truncate"></span><i id="mapPanelChevron" class="fa-solid fa-chevron-down text-[10px] text-slate-500 transition-transform"></i>
            </button>
            <div id="mapPanel" class="hidden absolute top-14 left-3 z-[500] w-[min(22rem,calc(100vw-1.5rem))] max-h-[calc(100%-12rem)] overflow-y-auto p-3 space-y-4 rounded-2xl bg-slate-900/95 border border-slate-700 shadow-2xl backdrop-blur-md text-xs text-slate-300"></div>
            <div id="mapCrosshair" class="hidden absolute left-1/2 top-1/2 z-[420] -translate-x-1/2 -translate-y-1/2 pointer-events-none">
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
                    <g stroke="#020617" stroke-width="4" stroke-linecap="round"><path d="M22 3v12M22 29v12M3 22h12M29 22h12"/><circle cx="22" cy="22" r="3"/></g>
                    <g stroke="#f8fafc" stroke-width="2" stroke-linecap="round"><path d="M22 3v12M22 29v12M3 22h12M29 22h12"/><circle cx="22" cy="22" r="3"/></g>
                </svg>
            </div>
            <div class="absolute top-[5.75rem] right-[10px] z-[500] flex flex-col gap-1.5">
                <button type="button" id="mapProbeBtn" class="w-[34px] h-[34px] rounded-lg border-2 border-black/20 bg-white text-slate-800 hover:bg-slate-100 transition"><i class="fa-solid fa-crosshairs"></i></button>
                <button type="button" id="mapCenterBtn" class="w-[34px] h-[34px] rounded-lg border-2 border-black/20 bg-white text-slate-800 hover:bg-slate-100 transition"><i class="fa-solid fa-location-dot"></i></button>
            </div>
            <div class="absolute bottom-[7.75rem] left-1/2 -translate-x-1/2 z-[450] w-[min(30rem,calc(100vw-1rem))] flex flex-col gap-1.5 pointer-events-none">
                <div id="mapStatus" class="space-y-1.5"></div>
                <div id="mapProbe" class="hidden pointer-events-auto rounded-xl bg-slate-900/95 border border-slate-700 shadow-xl backdrop-blur-md text-[11px] text-slate-300"></div>
            </div>
            <div id="mapBar" class="absolute bottom-7 left-1/2 -translate-x-1/2 z-[500] w-[min(44rem,calc(100vw-1rem))] p-2 rounded-2xl bg-slate-900/90 border border-slate-700 shadow-2xl backdrop-blur-md"></div>`;
        const map = L.map('satMap', { zoomControl: false, worldCopyJump: false, minZoom: 3, maxZoom: 11, attributionControl: true });
        R.map = map;
        L.control.zoom({ position: 'topright' }).addTo(map);
        map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
        [['sat', 410], ['precip', 420], ['borders', 600], ['loc', 650]].forEach(([name, z]) => {
            const pane = map.createPane(name);
            pane.style.zIndex = z;
            if (name !== 'loc') pane.style.pointerEvents = 'none';
        });
        if (state.location) {
            R.anchor = L.latLng(state.location.latitude, state.location.longitude);
            map.setView(R.anchor, S.view && S.view.zoom ? S.view.zoom : 6);
            R.centeredLoc = locKey();
        } else if (S.view && S.view.center) map.setView(S.view.center, S.view.zoom);
        else fitRegion(MAP_CONFIG.regions.ukraine, false);
        setBasemap(S.basemap, true);
        updateLocationMarker();

        map.on('movestart', () => clearTimeout(R.moveTimer));
        map.on('move', renderProbeHeader);
        map.on('moveend', () => {
            S.view = { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() };
            save();
            clearTimeout(R.moveTimer);
            R.moveTimer = setTimeout(() => {
                if (!extentStillGood()) reloadFrames({ newExtent: true });
                renderStatus();
            }, 450);
            // Moved away from the forecast location: follow the crosshair.
            if (R.anchor && !anchorCentred()) R.anchor = null;
            scheduleProbe();
        });
        setupDrawing();
        setupUiEvents();
        if (S.panelOpen === null) S.panelOpen = window.innerWidth >= 768;
        R.built = true;
    }

    function fitRegion(bbox, animate = true) {
        R.map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { animate, padding: [8, 8] });
    }

    function setBasemap(id, init) {
        S.basemap = id;
        if (R.baseLayer) { R.map.removeLayer(R.baseLayer); R.baseLayer = null; }
        const cfg = MAP_CONFIG.basemaps[id];
        if (cfg) R.baseLayer = L.tileLayer(cfg.url, { subdomains: cfg.subdomains || 'abc', maxZoom: cfg.maxZoom, attribution: cfg.attribution, detectRetina: false }).addTo(R.map);
        $('satMap').style.background = id === 'osm' ? '#aad3df' : '#020617';
        if (!init) { save(); renderPanel(); }
    }

    // Boundary lines from the same service, drawn as transparent WMS tiles
    // above the imagery (only when the service offers such a layer).
    function updateBorders() {
        if (!R.map) return;
        const names = R.borderLayers.map(b => b.name).join(',');
        const want = S.borders && names;
        if (R.bordersLayer && (!want || R.bordersLayer.options.layers !== names)) { R.map.removeLayer(R.bordersLayer); R.bordersLayer = null; }
        if (want && !R.bordersLayer) {
            R.bordersLayer = L.tileLayer.wms(MAP_CONFIG.wmsBase, {
                layers: names, styles: R.borderLayers.map(b => b.style).join(','), format: 'image/png', transparent: true, version: MAP_CONFIG.version,
                pane: 'borders', attribution: MAP_CONFIG.eumetsatAttribution, opacity: 0.9
            }).addTo(R.map);
        }
    }

    function updateLocationMarker() {
        if (!R.map) return;
        const loc = state.location;
        if (R.locMarker) { R.map.removeLayer(R.locMarker); R.locMarker = null; }
        if (!loc) return;
        R.locMarker = L.circleMarker([loc.latitude, loc.longitude], { pane: 'loc', radius: 6, color: '#0f172a', weight: 2, fillColor: '#22d3ee', fillOpacity: 1 })
            .bindTooltip(h(loc.name || ''), { direction: 'top', offset: [0, -6] })
            .addTo(R.map);
    }

    function regionOptions() {
        const opts = [
            { id: 'ukraine', label: t('mapRegion_ukraine') },
            { id: 'europe', label: t('mapRegion_europe') }
        ];
        if (state.location) opts.push({ id: 'location', label: `${t('mapRegion_location')} (${state.location.name})` });
        savedRegions.forEach((r, i) => opts.push({ id: `saved:${i}`, label: r.name }));
        opts.push({ id: 'custom', label: t('mapRegion_custom') });
        return opts;
    }

    function selectRegion(id) {
        S.region = id;
        save();
        let bbox = null;
        if (MAP_CONFIG.regions[id]) bbox = MAP_CONFIG.regions[id];
        else if (id === 'location' && state.location) {
            const { latitude: la, longitude: lo } = state.location;
            bbox = [lo - 3, la - 2, lo + 3, la + 2];
        } else if (id.startsWith('saved:')) {
            const r = savedRegions[Number(id.slice(6))];
            if (r) bbox = r.bbox;
        }
        if (bbox) fitRegion(bbox);
        renderPanel();
    }

    function setupDrawing() {
        const el = R.map.getContainer();
        el.addEventListener('pointerdown', e => {
            if (!R.drawing || R.drawing.rect) return;
            e.preventDefault(); e.stopPropagation();
            const start = R.map.mouseEventToLatLng(e);
            R.drawing.start = start;
            R.drawing.rect = L.rectangle([start, start], { pane: 'loc', color: '#22d3ee', weight: 2, dashArray: '5 4', fill: true, fillOpacity: 0.08, interactive: false }).addTo(R.map);
            try { el.setPointerCapture(e.pointerId); } catch (err) {}
        }, true);
        el.addEventListener('pointermove', e => {
            if (!R.drawing || !R.drawing.rect) return;
            e.preventDefault();
            R.drawing.rect.setBounds(L.latLngBounds(R.drawing.start, R.map.mouseEventToLatLng(e)));
        }, true);
        const finish = e => {
            if (!R.drawing || !R.drawing.rect) return;
            const b = R.drawing.rect.getBounds();
            R.map.removeLayer(R.drawing.rect);
            stopDrawing();
            const a = R.map.latLngToContainerPoint(b.getSouthWest()), c = R.map.latLngToContainerPoint(b.getNorthEast());
            if (Math.abs(a.x - c.x) < 12 || Math.abs(a.y - c.y) < 12) return;
            S.region = 'custom';
            fitRegion([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
            renderPanel();
        };
        el.addEventListener('pointerup', finish, true);
        el.addEventListener('pointercancel', () => { if (R.drawing && R.drawing.rect) R.map.removeLayer(R.drawing.rect); stopDrawing(); }, true);
    }

    function startDrawing() {
        R.drawing = { start: null, rect: null };
        R.map.dragging.disable();
        R.map.getContainer().style.cursor = 'crosshair';
        const hint = $('mapDrawHint');
        hint.textContent = t('mapDrawHint');
        hint.classList.remove('hidden');
        if (window.innerWidth < 768) setPanel(false);
    }

    function stopDrawing() {
        R.drawing = null;
        R.map.dragging.enable();
        R.map.getContainer().style.cursor = '';
        $('mapDrawHint').classList.add('hidden');
    }

    function setPanel(open) {
        S.panelOpen = open;
        save();
        $('mapPanel').classList.toggle('hidden', !open);
        $('mapPanelChevron').style.transform = open ? 'rotate(180deg)' : '';
    }

    const seg = (name, items, current) => `<div class="seg" role="group">${items.map(([v, label]) =>
        `<button type="button" data-map-${name}="${v}" class="${String(v) === String(current) ? 'active' : ''}">${label}</button>`).join('')}</div>`;
    const sectionTitle = (icon, key) => `<h3 class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2"><i class="fa-solid ${icon} mr-1.5"></i>${h(t(key))}</h3>`;

    function renderPanel() {
        if (!R.built) return;
        const layer = activeLayer();
        const productRows = PRODUCTS.map(p => {
            const list = R.resolved[p.id] || [];
            const available = list.length > 0;
            const active = S.product === p.id;
            return `<button type="button" data-map-product="${p.id}" ${available ? '' : 'disabled'} class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left border transition ${active ? 'border-cyan-500/70 bg-cyan-950/40 text-white' : 'border-transparent hover:bg-slate-800/70'} ${available ? '' : 'opacity-40 cursor-not-allowed'}">
                <i class="fa-solid ${p.icon} w-4 text-center ${active ? 'text-cyan-400' : 'text-slate-500'}"></i>
                <span class="flex-1 min-w-0"><span class="block truncate">${h(t('mapProduct_' + p.id))}</span>${available ? '' : `<span class="block text-[10px] text-slate-500">${h(t('mapNotFound'))}</span>`}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">${h(t('mapRole_' + p.role))}</span>
            </button>`;
        }).join('') + `<button type="button" data-map-product="none" class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left border transition ${S.product === 'none' ? 'border-cyan-500/70 bg-cyan-950/40 text-white' : 'border-transparent hover:bg-slate-800/70'}">
                <i class="fa-solid fa-ban w-4 text-center text-slate-500"></i><span class="flex-1">${h(t('mapProduct_none'))}</span></button>`;
        const sources = S.product !== 'none' ? (R.resolved[S.product] || []) : [];
        const sourceSelect = sources.length > 1 ? `<label class="block mt-2"><span class="block text-[10px] text-slate-500 mb-1">${h(t('mapSource'))}</span>
            <select data-map-source="${S.product}" class="unit-select w-full">${sources.map(l => `<option value="${h(l.name)}" ${layer && l.name === layer.name ? 'selected' : ''}>${h(l.title || l.name)} · ${h(l.name)}</option>`).join('')}</select></label>` : '';
        const styleSelect = layer && (layer.styles || []).length > 1 ? `<label class="block mt-2"><span class="block text-[10px] text-slate-500 mb-1">Style</span>
            <select data-map-style="${h(layer.name)}" class="unit-select w-full"><option value="">default</option>${layer.styles.map(s => `<option value="${h(s.name)}" ${styleOf(layer) === s.name ? 'selected' : ''}>${h(s.title || s.name)}</option>`).join('')}</select></label>` : '';
        const opacity = (key, value) => `<label class="flex items-center gap-2 mt-2"><span class="text-[10px] text-slate-500 w-20 shrink-0">${h(t('mapOpacity'))}</span>
            <input type="range" min="0.1" max="1" step="0.05" value="${value}" data-map-opacity="${key}" class="flex-1 accent-cyan-500"></label>`;

        const precip = R.precipLayers;
        const precipLayer = R.precipLayers.find(l => l.name === S.sources.precip) || R.precipLayers[0];
        const legend = precipLayer ? legendUrl(precipLayer) : '';
        const precipBlock = precip.length ? `
            <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" data-map-precip ${S.precipOn ? 'checked' : ''} class="accent-cyan-500 w-4 h-4"> <span>${h(t('mapPrecipShow'))}</span></label>
            <p class="text-[10px] text-slate-500 mt-1">${h(t('mapPrecipKind'))}</p>
            ${precip.length > 1 ? `<select data-map-source="precip" class="unit-select w-full mt-2">${precip.map(l => `<option value="${h(l.name)}" ${l.name === precipLayer.name ? 'selected' : ''}>${h(l.title || l.name)}</option>`).join('')}</select>` : ''}
            ${S.precipOn ? opacity('precip', S.precipOpacity) : ''}
            ${S.precipOn && precipLayer && !covers(precipLayer.bbox, regionBbox()) ? `<p class="text-[10px] text-amber-300 mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${h(t('mapPrecipPartial'))}</p>` : ''}
            <p id="mapPrecipInfo" class="text-[10px] text-slate-400 mt-1"></p>
            ${S.precipOn && legend ? `<img src="${h(legend)}" alt="" class="mt-2 max-w-full rounded bg-white/90 p-1" loading="lazy" onerror="this.remove()">` : ''}`
            : `<p class="text-[11px] text-slate-500">${h(R.catalogStatus === 'loading' ? t('mapLoadingCatalog') : t('mapPrecipNone'))}</p>`;

        const regions = regionOptions();
        $('mapPanel').innerHTML = `
            <section>${sectionTitle('fa-satellite', 'mapProductTitle')}
                <div class="space-y-1">${productRows}</div>${sourceSelect}${styleSelect}
                ${layer ? opacity('sat', S.opacity) : ''}
                ${layer ? colourKeyHtml(layer) : ''}
                <p class="text-[10px] text-slate-500 mt-2"><i class="fa-solid fa-circle-info mr-1"></i>${h(t('mapDisclaimer'))}</p>
            </section>
            <section>${sectionTitle('fa-cloud-showers-heavy', 'mapPrecipTitle')}${precipBlock}</section>
            <section>${sectionTitle('fa-crop-simple', 'mapRegionTitle')}
                <select data-map-region class="unit-select w-full">${regions.map(r => `<option value="${h(r.id)}" ${r.id === S.region ? 'selected' : ''}>${h(r.label)}</option>`).join('')}</select>
                <div class="flex flex-wrap gap-1.5 mt-2">
                    <button type="button" data-map-draw class="chip py-1"><i class="fa-regular fa-square"></i> ${h(t('mapDraw'))}</button>
                    <button type="button" data-map-saveview class="chip py-1"><i class="fa-regular fa-bookmark"></i> ${h(t('mapSaveView'))}</button>
                    ${S.region.startsWith('saved:') ? `<button type="button" data-map-delregion class="chip py-1" title="${h(t('mapDeleteRegion'))}" aria-label="${h(t('mapDeleteRegion'))}"><i class="fa-regular fa-trash-can"></i></button>` : ''}
                </div>
                <form data-map-saveform class="hidden mt-2 flex gap-1.5"><input name="name" maxlength="40" placeholder="${h(t('mapSaveName'))}" class="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"><button class="chip py-1"><i class="fa-solid fa-check"></i></button></form>
            </section>
            <section>${sectionTitle('fa-map', 'mapBaseTitle')}
                ${seg('basemap', [['osm', h(t('mapBase_osm'))], ['none', h(t('mapBase_none'))]], S.basemap)}
                ${R.borderLayers.length ? `<label class="flex items-center gap-2 mt-1.5 cursor-pointer"><input type="checkbox" data-map-borders ${S.borders ? 'checked' : ''} class="accent-cyan-500 w-4 h-4"> ${h(t('mapBorders'))}</label>` : ''}
            </section>
            <section>${sectionTitle('fa-film', 'mapTimeTitle')}
                <div class="flex flex-wrap gap-2">
                    ${seg('window', MAP_CONFIG.windows.map(n => [n, h(t('mapWindowHours', { n }))]), S.windowH)}
                    ${seg('utc', [['1', h(t('mapUtc'))], ['0', h(t('mapLocal'))]], S.utc ? '1' : '0')}
                </div>
            </section>
            <section>
                <button type="button" data-map-diag class="w-full flex items-center gap-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider" aria-expanded="${S.diagOpen}">
                    <i class="fa-solid fa-stethoscope"></i><span class="flex-1 text-left">${h(t('mapDiagTitle'))}</span><i class="fa-solid fa-chevron-down text-[10px] transition-transform" style="${S.diagOpen ? 'transform: rotate(180deg)' : ''}"></i>
                </button>
                <div id="mapDiag" class="${S.diagOpen ? '' : 'hidden'} mt-2"></div>
            </section>
            <p class="text-[10px] text-slate-500">${h(t('mapAttrNote'))}</p>`;
        renderDiagnostics();
        renderPrecipInfo();
    }

    // Colour key of the active product: EUMETSAT's interpretation for the
    // RGBs, the service's own legend image for quantitative layers (CTH).
    function colourKeyHtml(layer) {
        const key = RGB_KEYS[S.product];
        let body = '';
        if (key) {
            const texts = t('mapKey_' + S.product);
            const swatch = c => {
                const bg = c === 'dots' ? 'radial-gradient(circle, #9be05a 24%, transparent 30%) 0 0 / 5px 5px, #a02700'
                    : Array.isArray(c) ? `linear-gradient(90deg, ${c[0]} 50%, ${c[1]} 50%)` : c;
                return `<span class="w-5 h-3.5 rounded-sm shrink-0 mt-px border border-white/10" style="background: ${bg}"></span>`;
            };
            body = `<ul class="space-y-1">${key.colors.map((c, i) => `<li class="flex items-start gap-2">${swatch(c)}<span>${h(texts[i] || '')}</span></li>`).join('')}</ul>
                ${translations.en['mapKey_' + S.product + '_note'] ? `<p class="mt-1.5 text-slate-400">${h(t('mapKey_' + S.product + '_note'))}</p>` : ''}
                <p class="mt-1 text-slate-500">${h(t('mapKeyAngle'))} <a href="${h(key.guide)}" target="_blank" rel="noopener" class="text-cyan-400 hover:text-cyan-300">${h(t('mapKeySource'))} <i class="fa-solid fa-arrow-up-right-from-square text-[9px]"></i></a></p>`;
        } else {
            // Only real legends: RGB layers advertise a 20×20 placeholder.
            const s = (layer.styles || []).find(x => x.legend && !/width=20\b/.test(x.legend));
            if (!s) return '';
            body = `<img src="${h(s.legend)}" alt="" class="max-w-full rounded bg-white/90 p-1" loading="lazy" onerror="this.closest('[data-map-keybox]').remove()">`;
        }
        return `<div data-map-keybox class="mt-2 rounded-lg border border-slate-800 bg-slate-950/50">
            <button type="button" data-map-key class="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-semibold text-slate-300" aria-expanded="${S.keyOpen}">
                <i class="fa-solid fa-palette text-slate-500"></i><span class="flex-1 text-left">${h(t('mapKeyTitle'))}</span>
                <i class="fa-solid fa-chevron-down text-[10px] text-slate-500 transition-transform" style="${S.keyOpen ? 'transform: rotate(180deg)' : ''}"></i>
            </button>
            ${S.keyOpen ? `<div class="px-2.5 pb-2 text-[10.5px] leading-snug text-slate-300">${body}</div>` : ''}
        </div>`;
    }

    function legendUrl(layer) {
        const style = styleOf(layer);
        const s = (layer.styles || []).find(x => x.name === style) || (layer.styles || [])[0];
        if (s && s.legend) return s.legend;
        return buildWmsUrl(MAP_CONFIG.wmsBase, { SERVICE: 'WMS', VERSION: MAP_CONFIG.version, REQUEST: 'GetLegendGraphic', FORMAT: 'image/png', LAYER: layer.name, STYLE: style, SLD_VERSION: '1.1.0' }, []);
    }

    function renderPrecipInfo(frame) {
        const el = $('mapPrecipInfo');
        if (!el) return;
        if (!activePrecipLayer()) { el.textContent = ''; return; }
        if (frame === undefined) {
            const tl = timelineFrames();
            const f = tl[R.index];
            frame = f ? (activeLayer() ? precipFrameFor(f.t) : f) : null;
        }
        el.textContent = frame ? t('mapPrecipAt', { time: fmtTime(frame.t) }) : (R.precipFrames.length ? t('mapPrecipNoFrame') : '');
    }

    function renderDiagnostics() {
        const el = $('mapDiag');
        if (!el || !S.diagOpen) return;
        const layer = activeLayer();
        const info = layer ? R.times[layer.name] : null;
        const tl = timelineFrames();
        const count = st => tl.filter(f => { const e = cache.get(f.key); return e && e.status === st; }).length;
        const row = (k, v, mono) => `<div class="py-1 border-b border-slate-800/70"><div class="text-[10px] text-slate-500">${h(t(k))}</div><div class="${mono ? 'font-mono break-all' : ''} text-[11px] text-slate-200">${v}</div></div>`;
        const when = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        el.innerHTML = [
            row('mapDiagService', h(MAP_CONFIG.wmsBase) + ` · WMS ${MAP_CONFIG.version} · ${MAP_CONFIG.crs}`, true),
            row('mapDiagCatalog', R.catalogStatus === 'ok' && R.catalog ? h(t('mapCatalogLoaded', { n: R.catalog.total || R.catalog.layers.length, when: when(R.catalog.at) })) + ` · ${R.catalog.layers.length} matched`
                : R.catalogStatus === 'error' ? `<span class="text-rose-300">${h(R.catalogError)}</span>` : h(R.catalogStatus)),
            row('mapDiagLayer', layer ? `${h(layer.name)}${styleOf(layer) ? ` · style ${h(styleOf(layer))}` : ''}${layer.guessed ? ' · (unverified)' : ''}` : h(t('mapDiagNone')), true),
            row('mapDiagTimes', info ? (info.ok ? `${info.list.length}${info.noTime ? ' (no TIME dimension)' : ''} · ${h(when(info.at))}` : `<span class="text-rose-300">${h(info.error || '')}</span>`) : h(t('mapDiagNone'))),
            row('mapDiagLatest', info && info.list.length ? h(fmtTime(info.list[info.list.length - 1])) : h(t('mapDiagNone'))),
            row('mapDiagFrames', `${tl.length} · ok ${count('ok')} · loading ${count('loading') + count('queued')} · failed ${count('error')}${R.extent ? ` · ${R.extent.w}×${R.extent.h}px` : ''}`),
            row('mapDiagMode', R.requestMode === 'fetch' ? 'fetch (CORS)' : 'img (no CORS — error details hidden)'),
            row('mapDiagLastOk', R.lastOk ? `${h(when(R.lastOk.at))}<br><a href="${h(R.lastOk.url)}" target="_blank" rel="noopener" class="text-cyan-400">${h(R.lastOk.url)}</a>` : h(t('mapDiagNone')), true),
            row('mapDiagLastError', R.lastError ? `<span class="text-rose-300">${h(R.lastError.msg)}</span><br>${h(when(R.lastError.at))}${R.lastError.url ? `<br><a href="${h(R.lastError.url)}" target="_blank" rel="noopener" class="text-cyan-400">${h(R.lastError.url)}</a>` : ''}` : h(t('mapDiagNone')), true),
            `<button type="button" data-map-recatalog class="chip py-1 mt-2"><i class="fa-solid fa-rotate"></i> ${h(t('mapDiagReload'))}</button>`
        ].join('');
    }

    function renderControls() {
        const bar = $('mapBar');
        if (!bar) return;
        const tl = timelineFrames();
        const btn = (attr, icon, key, extra = '') => `<button type="button" ${attr} class="w-9 h-9 shrink-0 rounded-xl text-slate-200 hover:bg-slate-800 disabled:opacity-30 transition ${extra}" title="${h(t(key))}" aria-label="${h(t(key))}" ${tl.length < 2 ? 'disabled' : ''}><i class="fa-solid ${icon}"></i></button>`;
        bar.innerHTML = `
            <div class="flex items-center justify-between gap-2 px-1 mb-1.5 text-[11px]">
                <span id="mapTime" class="font-mono text-slate-100 truncate"></span>
                <span id="mapProgress" class="text-slate-500 shrink-0"></span>
            </div>
            <div id="mapTicks" class="flex gap-px h-1 mx-1 mb-1.5 rounded overflow-hidden"></div>
            <div class="flex items-center gap-1">
                ${btn('data-map-prev', 'fa-backward-step', 'mapPrev')}
                ${btn('data-map-play', R.playing ? 'fa-pause' : 'fa-play', R.playing ? 'mapPause' : 'mapPlay', 'bg-cyan-500 hover:bg-cyan-400 text-slate-950')}
                ${btn('data-map-next', 'fa-forward-step', 'mapNext')}
                <input id="mapSlider" type="range" min="0" max="${Math.max(0, tl.length - 1)}" step="1" value="${Math.max(0, R.index)}" class="flex-1 min-w-0 accent-cyan-500" ${tl.length < 2 ? 'disabled' : ''} aria-label="${h(t('mapTimeTitle'))}">
                ${btn('data-map-latest', 'fa-forward-fast', 'mapLatest')}
                <select data-map-speed class="unit-select !py-1 !px-1.5 shrink-0" title="${h(t('mapSpeed'))}" aria-label="${h(t('mapSpeed'))}">${MAP_CONFIG.speeds.map(s => `<option value="${s}" ${s === S.speed ? 'selected' : ''}>${s}×</option>`).join('')}</select>
            </div>`;
        renderSlider();
        renderTimeLabel();
        renderProgress();
    }

    function renderSlider() {
        const s = $('mapSlider');
        if (s) s.value = Math.max(0, R.index);
    }

    function renderTimeLabel() {
        const el = $('mapTime');
        if (!el) return;
        const tl = timelineFrames();
        const f = tl[R.index];
        if (!f) { el.textContent = R.catalogStatus === 'loading' ? t('mapLoadingCatalog') : t('mapDiagNone'); return; }
        const name = activeLayer() ? t('mapProduct_' + S.product) : t('mapPrecipTitle');
        el.textContent = `${f.t === null ? t('mapNow') : fmtTime(f.t)} · ${name}`;
        el.title = `${t('mapFrameOf', { i: R.index + 1, n: tl.length })}`;
    }

    function renderProgress() {
        if (!R.built) return;
        const tl = timelineFrames();
        const ticks = $('mapTicks');
        const prog = $('mapProgress');
        if (!ticks || !prog) return;
        // Loaded / loading / not requested / failed; the current frame is
        // the bright one (outlined while it is still loading).
        let done = 0, failed = 0, pending = 0;
        ticks.innerHTML = tl.map((f, i) => {
            const e = cache.get(f.key);
            const st = e ? e.status : 'idle';
            if (st === 'ok') done++;
            else if (st === 'error') failed++;
            else if (st !== 'idle') pending++;
            const current = i === R.index;
            const color = st === 'ok' ? (current ? '#22d3ee' : '#155e75') : st === 'error' ? '#d03b3b' : st === 'idle' ? '#1e293b' : '#475569';
            const mark = current && st !== 'ok' ? 'box-shadow: inset 0 0 0 1px #22d3ee;' : '';
            return `<span class="flex-1" ${current ? 'data-current' : ''} style="background:${color};${mark}" title="${h(fmtTime(f.t))}${e && e.error ? ' — ' + h(e.error) : ''}"></span>`;
        }).join('');
        const parts = [t('mapFrameOf', { i: Math.max(1, R.index + 1), n: tl.length })];
        if (pending) parts.push(`<i class="fa-solid fa-circle-notch fa-spin text-cyan-400"></i> ${h(t('mapLoadingFrames', { done: done + failed, n: done + failed + pending }))}`);
        if (failed) parts.push(`<span class="text-rose-300">${h(t('mapFailedFrames', { n: failed }))}</span>`);
        prog.innerHTML = tl.length ? parts.join(' · ') : '';
        if (S.diagOpen) renderDiagnostics();
    }

    function renderStatus() {
        const el = $('mapStatus');
        if (!el) return;
        const notes = [];
        const pill = (cls, icon, text, action) => `<div class="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px] shadow-lg backdrop-blur-md ${cls}"><i class="fa-solid ${icon}"></i><span class="flex-1">${h(text)}</span>${action || ''}</div>`;
        if (!navigator.onLine) notes.push(pill('bg-amber-950/90 border border-amber-800/60 text-amber-200', 'fa-wifi', t('mapOffline')));
        if (R.catalogStatus === 'loading') notes.push(pill('bg-slate-900/90 border border-slate-700 text-slate-300', 'fa-circle-notch fa-spin', t('mapLoadingCatalog')));
        if (R.catalogStatus === 'error') {
            // Without the list only the two published layer names can be tried.
            const none = !Object.values(R.resolved).some(l => l.length);
            notes.push(pill(none ? 'bg-rose-950/90 border border-rose-800/60 text-rose-200' : 'bg-amber-950/90 border border-amber-800/60 text-amber-200',
                'fa-triangle-exclamation', t('mapErrCatalog', { msg: R.catalogError })));
        }
        const layer = activeLayer();
        if (layer) {
            const info = R.times[layer.name];
            if (info && (info.noTime || !info.ok) && R.frames.length === 1) notes.push(pill('bg-slate-900/90 border border-slate-700 text-slate-300', 'fa-clock', t('mapNoTimes')));
            if (info && info.list.length) {
                const age = Date.now() - info.list[info.list.length - 1];
                if (age > 90 * 60e3) notes.push(pill('bg-amber-950/90 border border-amber-800/60 text-amber-200', 'fa-clock-rotate-left', t('mapStale', { age: fmtAge(age) })));
            }
            if (!covers(layer.bbox, regionBbox())) notes.push(pill('bg-amber-950/90 border border-amber-800/60 text-amber-200', 'fa-crop', t('mapPartial')));
            const sun = sunState();
            const recommended = sun === 'night' ? ['fog'] : sun === 'day' ? ['dayMicro', 'natural'] : null;
            if (recommended && !recommended.includes(S.product)) {
                const target = recommended.find(id => (R.resolved[id] || []).length);
                if (target) notes.push(pill('bg-indigo-950/90 border border-indigo-800/60 text-indigo-100', sun === 'night' ? 'fa-moon' : 'fa-sun',
                    t(sun === 'night' ? 'mapNight' : 'mapDay'),
                    `<button type="button" data-map-product="${target}" class="px-2 py-0.5 rounded-md bg-indigo-500/30 hover:bg-indigo-500/50 font-semibold">${h(t('mapUse'))}</button>`));
            } else if (sun === 'twilight' && S.product !== 'ir108') {
                notes.push(pill('bg-slate-900/90 border border-slate-700 text-slate-300', 'fa-circle-half-stroke', t('mapTwilight')));
            }
        }
        el.innerHTML = notes.join('');
    }

    function renderAllMapUi() {
        if (!R.built) return;
        $('mapPanelBtnLabel').textContent = S.product === 'none' ? t('mapPrecipTitle') : t('mapProduct_' + S.product);
        $('mapPanelBtn').title = t('mapPanelToggle');
        setPanel(!!S.panelOpen);
        renderPanel();
        renderControls();
        renderStatus();
        renderProbe();
    }

    function setupUiEvents() {
        $('mapPanelBtn').addEventListener('click', () => setPanel(!S.panelOpen));
        $('mapProbeBtn').addEventListener('click', () => { S.probe = !S.probe; save(); renderProbe(); scheduleProbe(0); });
        $('mapCenterBtn').addEventListener('click', () => centerOnLocation(true));
        const view = $('mapView');
        view.addEventListener('click', e => {
            const q = sel => e.target.closest(sel);
            let el;
            if ((el = q('[data-map-product]')) && !el.disabled) {
                S.product = el.dataset.mapProduct; S.productAt = Date.now(); save();
                play(false); renderAllMapUi(); reloadFrames();
            } else if ((el = q('[data-map-basemap]'))) setBasemap(el.dataset.mapBasemap);
            else if ((el = q('[data-map-window]'))) { S.windowH = Number(el.dataset.mapWindow); save(); renderPanel(); reloadFrames(); }
            else if ((el = q('[data-map-utc]'))) { S.utc = el.dataset.mapUtc === '1'; save(); renderPanel(); renderTimeLabel(); renderProgress(); }
            else if (q('[data-map-play]')) play(!R.playing);
            else if (q('[data-map-prev]')) step(-1);
            else if (q('[data-map-next]')) step(1);
            else if (q('[data-map-latest]')) { play(false); showFrame(timelineFrames().length - 1); }
            else if (q('[data-map-draw]')) startDrawing();
            else if (q('[data-map-saveview]')) { const f = view.querySelector('[data-map-saveform]'); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.elements.name.focus(); }
            else if (q('[data-map-delregion]')) {
                const i = Number(S.region.slice(6));
                savedRegions.splice(i, 1);
                saveToStorage(MAP_CONFIG.regionsKey, savedRegions);
                S.region = 'custom'; save(); renderPanel();
            } else if (q('[data-map-diag]')) { S.diagOpen = !S.diagOpen; save(); renderPanel(); }
            else if (q('[data-map-key]')) { S.keyOpen = !S.keyOpen; save(); renderPanel(); }
            else if (q('[data-map-probemin]')) { S.probeOpen = !S.probeOpen; save(); renderProbe(); }
            else if (q('[data-map-goforecast]')) forecastHere();
            else if (q('[data-map-recatalog]')) loadCatalog(true);
        });
        view.addEventListener('change', e => {
            const el = e.target;
            if (el.matches('[data-map-source]')) {
                S.sources[el.dataset.mapSource] = el.value; save(); renderAllMapUi(); reloadFrames();
            } else if (el.matches('[data-map-style]')) {
                S.sources[`${el.dataset.mapStyle}#style`] = el.value; save(); reloadFrames();
            } else if (el.matches('[data-map-precip]')) {
                S.precipOn = el.checked; save(); renderAllMapUi(); reloadFrames();

            } else if (el.matches('[data-map-borders]')) {
                S.borders = el.checked; save(); updateBorders();
            } else if (el.matches('[data-map-region]')) {
                selectRegion(el.value);
            } else if (el.matches('[data-map-speed]')) {
                S.speed = Number(el.value); save();
            }
        });
        view.addEventListener('input', e => {
            const el = e.target;
            if (el.id === 'mapSlider') { play(false); showFrame(Number(el.value)); }
            else if (el.matches('[data-map-opacity]')) {
                const v = Number(el.value);
                if (el.dataset.mapOpacity === 'sat') { S.opacity = v; S.opacitySet = true; if (R.overlay) R.overlay.setOpacity(v); }
                else { S.precipOpacity = v; S.precipOpacitySet = true; if (R.precipOverlay) R.precipOverlay.setOpacity(v); }
                save();
            }
        });
        view.addEventListener('submit', e => {
            const form = e.target.closest('[data-map-saveform]');
            if (!form) return;
            e.preventDefault();
            const name = form.elements.name.value.trim();
            if (!name) return;
            const b = R.map.getBounds();
            savedRegions.push({ name, bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => Math.round(v * 100) / 100) });
            saveToStorage(MAP_CONFIG.regionsKey, savedRegions);
            S.region = `saved:${savedRegions.length - 1}`; save();
            renderPanel();
        });
        document.addEventListener('keydown', e => {
            if (!R.visible || e.target.closest('input, select, textarea, button, a')) return;
            if (e.key === 'Escape' && R.drawing) stopDrawing();
            else if (e.key === ' ') { e.preventDefault(); play(!R.playing); }
            else if (e.key === 'ArrowLeft') step(-1);
            else if (e.key === 'ArrowRight') step(1);
        });
        window.addEventListener('online', () => { renderStatus(); reloadFrames(); });
        window.addEventListener('offline', renderStatus);
    }

    // ================= Point readout (crosshair) =================
    // Values under the crosshair (= map centre) for the frame on screen,
    // read with WMS GetFeatureInfo:
    //  - RGB products only return the displayed colour, which is matched to
    //    EUMETSAT's colour key (CIE Lab distance) and shown as "likely";
    //  - MTG precipitation (h40b) returns the actual rain rate + quality;
    //  - plus the Open-Meteo model forecast at the same point and hour.
    const P = { timer: null, seq: 0, controller: null, gfi: new Map(), model: new Map(), result: null, loading: false };
    const MATCH_CLOSE = 15, MATCH_APPROX = 30, MATCH_TIE = 6;   // ΔE thresholds, tuned on live imagery

    function locKey() {
        return state.location ? `${state.location.latitude},${state.location.longitude}` : '';
    }

    function centerOnLocation(animate) {
        if (!R.map || !state.location) return;
        R.centeredLoc = locKey();
        R.anchor = L.latLng(state.location.latitude, state.location.longitude);
        R.map.setView(R.anchor, Math.max(R.map.getZoom(), 6), { animate });
    }

    // Leaflet keeps the centre on whole pixels, so after centring on the
    // forecast location the crosshair can sit ~1 km off it. Until the map is
    // moved away, the readout uses the exact location instead.
    function anchorCentred() {
        if (!R.anchor || !R.map) return false;
        const a = R.map.latLngToContainerPoint(R.anchor), c = R.map.getSize().divideBy(2);
        return Math.abs(a.x - c.x) <= 3 && Math.abs(a.y - c.y) <= 3;
    }

    function probePoint() {
        return anchorCentred() ? { ll: R.anchor, name: state.location && state.location.name } : { ll: R.map.getCenter(), name: null };
    }

    function fmtCoord(ll) {
        const f = (v, pos, neg) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? pos : neg}`;
        return `${f(ll.lat, 'N', 'S')} ${f(ll.lng, 'E', 'W')}`;
    }

    function toLab([r, g, b]) {
        const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        const [R_, G_, B_] = [lin(r), lin(g), lin(b)];
        const f = v => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
        const x = f((R_ * 0.4124 + G_ * 0.3576 + B_ * 0.1805) / 0.95047);
        const y = f(R_ * 0.2126 + G_ * 0.7152 + B_ * 0.0722);
        const z = f((R_ * 0.0193 + G_ * 0.1192 + B_ * 0.9505) / 1.08883);
        return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    }
    const hexRgb = hx => [1, 3, 5].map(i => parseInt(hx.slice(i, i + 2), 16));

    // Nearest colour-key entries for a pixel, best first: [{ i, d }].
    function matchKey(productId, rgb) {
        const key = RGB_KEYS[productId];
        if (!key) return null;
        const lab = toLab(rgb);
        const dist = hex => Math.hypot(...toLab(hexRgb(hex)).map((v, k) => v - lab[k]));
        return key.colors.map((c, i) => {
            const list = c === 'dots' ? ['#a02700'] : Array.isArray(c) ? c : [c];
            return { i, d: Math.min(...list.map(dist)) };
        }).sort((a, b) => a.d - b.d);
    }

    function featureInfoUrl(layerName, tm, ll) {
        const p = L.CRS.EPSG3857.project(ll), d = 500;
        return buildWmsUrl(MAP_CONFIG.wmsBase, {
            SERVICE: 'WMS', VERSION: MAP_CONFIG.version, REQUEST: 'GetFeatureInfo',
            LAYERS: layerName, QUERY_LAYERS: layerName, STYLES: '', CRS: MAP_CONFIG.crs,
            BBOX: [p.x - d, p.y - d, p.x + d, p.y + d].map(Math.round).join(','), WIDTH: 3, HEIGHT: 3, I: 1, J: 1,
            INFO_FORMAT: 'application/json', FEATURE_COUNT: 1,
            TIME: tm === null || tm === undefined ? undefined : new Date(tm).toISOString().replace('.000Z', 'Z')
        });
    }

    async function featureInfo(layerName, tm, ll, signal) {
        const url = featureInfoUrl(layerName, tm, ll);
        const key = `${layerName}|${tm}|${ll.lat.toFixed(3)},${ll.lng.toFixed(3)}`;
        if (P.gfi.has(key)) return P.gfi.get(key);
        const res = await fetch(url, { signal, credentials: 'omit' });
        const text = await res.text();
        if (!res.ok) throw new Error(parseServiceException(text) || `HTTP ${res.status}`);
        let data;
        try { data = JSON.parse(text); } catch (err) { throw new Error(parseServiceException(text) || 'bad response'); }
        const props = data.features && data.features[0] ? data.features[0].properties : null;
        if (P.gfi.size > 300) P.gfi.clear();
        P.gfi.set(key, props);
        return props;
    }

    // Open-Meteo best-match forecast at a point (hourly, UTC), cached 15 min.
    async function modelAt(ll, signal) {
        const key = `${ll.lat.toFixed(2)},${ll.lng.toFixed(2)},${state.precipUnit}`;
        const hit = P.model.get(key);
        if (hit && Date.now() - hit.at < 15 * 60e3) return hit.data;
        const url = buildWmsUrl('https://api.open-meteo.com/v1/forecast', {
            latitude: ll.lat.toFixed(3), longitude: ll.lng.toFixed(3), hourly: 'cloud_cover_low,visibility,precipitation',
            past_days: 1, forecast_days: 2, timezone: 'GMT', precipitation_unit: state.precipUnit === 'inch' ? 'inch' : undefined
        }, []);
        const res = await fetch(url, { signal });
        const body = await res.json();
        if (!res.ok || body.error) throw new Error(body.reason || `HTTP ${res.status}`);
        P.model.set(key, { at: Date.now(), data: body.hourly });
        return body.hourly;
    }

    function precipTimeFor(name, tm) {
        const info = R.times[name];
        if (!info || !info.list.length) return null;
        if (tm === null || tm === undefined) return info.list[info.list.length - 1];
        let best = null;
        info.list.forEach(v => { if (v <= tm + 5 * 60e3 && tm - v <= 30 * 60e3 && (best === null || Math.abs(v - tm) < Math.abs(best - tm))) best = v; });
        return best;
    }

    function scheduleProbe(delay = 350) {
        clearTimeout(P.timer);
        if (!R.built || !R.visible || !S.probe) return;
        P.timer = setTimeout(runProbe, delay);
    }

    async function runProbe() {
        if (!S.probe || !R.visible) return;
        if (R.playing) { P.result = { playing: true }; renderProbe(); return; }
        const { ll } = probePoint();
        const frame = timelineFrames()[R.index];
        const tm = frame ? frame.t : null;
        const layer = activeLayer();
        const rainLayer = R.precipLayers.find(l => l.name === 'mtg_fd:h40b') || R.precipLayers[0] || null;
        try { P.controller && P.controller.abort(); } catch (err) {}
        const controller = new AbortController();
        P.controller = controller;
        const id = ++P.seq;
        P.loading = true;
        renderProbe();
        const sat = layer ? featureInfo(layer.name, tm, ll, controller.signal) : Promise.resolve(undefined);
        const rain = rainLayer ? refreshTimes(rainLayer.name).then(() => {
            const pt = precipTimeFor(rainLayer.name, tm);
            return pt === null ? null : featureInfo(rainLayer.name, pt, ll, controller.signal).then(props => ({ props, t: pt }));
        }) : Promise.resolve(undefined);
        const model = navigator.onLine ? modelAt(ll, controller.signal) : Promise.reject(new Error(t('mapOffline')));
        const [s, r, m] = await Promise.allSettled([sat, rain, model]);
        if (id !== P.seq) return;
        P.loading = false;
        P.result = { ll, tm, layer, rainLayer, sat: s, rain: r, model: m };
        renderProbe();
    }

    function renderProbeHeader() {
        const el = $('mapProbeCoord');
        if (!el || !R.map) return;
        const { ll, name } = probePoint();
        el.textContent = name && name !== fmtCoord(ll) ? `${name} · ${fmtCoord(ll)}` : fmtCoord(ll);
    }

    function renderProbe() {
        if (!R.built) return;
        const on = !!S.probe;
        $('mapCrosshair').classList.toggle('hidden', !on);
        const btn = $('mapProbeBtn');
        btn.classList.toggle('!bg-cyan-500', on);
        btn.title = t('mapProbeToggle'); btn.setAttribute('aria-label', btn.title); btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        const cbtn = $('mapCenterBtn');
        cbtn.title = t('mapCenterLoc'); cbtn.setAttribute('aria-label', cbtn.title);
        cbtn.classList.toggle('hidden', !state.location);
        const card = $('mapProbe');
        card.classList.toggle('hidden', !on);
        if (!on) return;
        const res = P.result;
        const errText = reason => h(t('mapProbeError', { msg: reason instanceof TypeError ? t('mapErrNetwork') : (reason && reason.message) || '' }));
        const row = (icon, label, html) => `<div class="flex items-start gap-2"><i class="fa-solid ${icon} w-3.5 mt-0.5 text-center text-slate-500"></i><span class="text-slate-400 shrink-0">${h(label)}:</span><span class="min-w-0">${html}</span></div>`;
        let rows = '';
        if (P.loading && !res) rows = `<div class="text-slate-500">${h(t('mapProbeLoading'))}</div>`;
        else if (res && res.playing) rows = `<div class="text-slate-500">${h(t('mapProbePlaying'))}</div>`;
        else if (res) {
            // Satellite colour → colour key
            if (res.layer) {
                let html;
                if (res.sat.status === 'rejected') html = errText(res.sat.reason);
                else if (!res.sat.value) html = h(t('mapProbeNoData'));
                else {
                    const p = res.sat.value;
                    const rgb = ['RED_BAND', 'GREEN_BAND', 'BLUE_BAND'].map(k => p[k]);
                    if (rgb.every(Number.isFinite)) {
                        const sw = `<span class="inline-block w-3.5 h-3 rounded-sm align-[-2px] mr-1 border border-white/20" style="background: rgb(${rgb.join(',')})"></span>`;
                        const m = matchKey(S.product, rgb);
                        const texts = t('mapKey_' + S.product);
                        if (!m) html = sw + h(t('mapProbeNoKey'));
                        else if (m[0].d > MATCH_APPROX) html = sw + h(t('mapProbeUnclear', { label: texts[m[0].i] }));
                        else {
                            const second = m[1] && m[1].d - m[0].d < MATCH_TIE && m[1].d <= MATCH_APPROX ? ` <span class="text-slate-400">${h(t('mapProbeOr'))} ${h(texts[m[1].i])}</span>` : '';
                            html = `${sw}<span class="text-slate-100">${h(texts[m[0].i])}</span>${second} <span class="text-slate-500">· ${h(t(m[0].d <= MATCH_CLOSE ? 'mapProbeClose' : 'mapProbeApprox'))}</span>`;
                        }
                    } else {
                        html = h(Object.entries(p).map(([k, v]) => `${k} ${v}`).join(' · '));
                    }
                }
                rows += row('fa-satellite', t('mapProbeSat'), html);
            }
            // Satellite precipitation
            if (res.rainLayer) {
                let html;
                if (res.rain.status === 'rejected') html = errText(res.rain.reason);
                else if (!res.rain.value || !res.rain.value.props) html = h(t('mapProbeNoData'));
                else {
                    const p = res.rain.value.props;
                    const rate = p.Instantaneous_rain_rate ?? p.instantaneous_rain_rate ?? p.rain_rate;
                    if (Number.isFinite(rate)) {
                        const inch = state.precipUnit === 'inch';
                        const v = inch ? rate / 25.4 : rate;
                        const q = p.Quality_index ?? p.quality_index;
                        html = `<span class="text-slate-100 font-mono">${h(t('mapProbeRainValue', { v: v.toLocaleString(currentLang, { maximumFractionDigits: inch ? 2 : 1, minimumFractionDigits: inch ? 2 : 1 }), u: inch ? 'in' : 'mm' }))}</span>${Number.isFinite(q) ? ` <span class="text-slate-500">· ${h(t('mapProbeQuality', { q }))}</span>` : ''} <span class="text-slate-500">· ${h(fmtTime(res.rain.value.t))}</span>`;
                    } else html = h(t('mapProbeNoValue'));
                }
                rows += row('fa-cloud-rain', t('mapProbeRain'), html);
            }
            // Model forecast for the same hour
            {
                let html;
                if (res.model.status === 'rejected') html = errText(res.model.reason);
                else {
                    const hr = res.model.value;
                    const target = new Date(Math.round((res.tm ?? Date.now()) / 3600e3) * 3600e3).toISOString().slice(0, 13);
                    const i = hr.time.findIndex(x => x.slice(0, 13) === target);
                    if (i < 0) html = h(t('mapProbeNoData'));
                    else {
                        const num = (v, d) => (Number.isFinite(v) ? v.toLocaleString(currentLang, { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
                        html = `<span class="text-slate-100">${h(t('mapProbeModelValues', {
                            c: num(hr.cloud_cover_low[i], 0), v: num(hr.visibility[i] / 1000, 1),
                            p: num(hr.precipitation[i], state.precipUnit === 'inch' ? 2 : 1), u: state.precipUnit === 'inch' ? 'in' : 'mm'
                        }))}</span> <span class="text-slate-500">· ${h(fmtTime(Date.parse(hr.time[i] + 'Z')))}</span>`;
                    }
                }
                rows += row('fa-chart-area', t('mapProbeModel'), html);
            }
        }
        card.innerHTML = `
            <div class="flex items-center gap-2 px-3 py-1.5">
                <i class="fa-solid fa-crosshairs text-cyan-400"></i>
                <span id="mapProbeCoord" class="font-mono text-slate-100 truncate"></span>
                ${P.loading ? '<i class="fa-solid fa-circle-notch fa-spin text-cyan-400"></i>' : ''}
                <span class="flex-1"></span>
                <button type="button" data-map-goforecast class="shrink-0 px-2 py-0.5 rounded-md bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-200 font-semibold"><i class="fa-solid fa-chart-area mr-1"></i>${h(t('mapGoForecast'))}</button>
                <button type="button" data-map-probemin class="shrink-0 w-6 h-6 rounded-md text-slate-400 hover:text-white hover:bg-slate-800" title="${h(t('mapProbeCollapse'))}" aria-label="${h(t('mapProbeCollapse'))}" aria-expanded="${S.probeOpen}"><i class="fa-solid fa-chevron-down text-[10px] transition-transform" style="${S.probeOpen ? '' : 'transform: rotate(180deg)'}"></i></button>
            </div>
            ${S.probeOpen && rows ? `<div class="px-3 pb-2 space-y-1 leading-snug">${rows}</div>` : ''}`;
        renderProbeHeader();
    }

    // Opens the forecast for the point under the crosshair.
    function forecastHere() {
        const { ll: c, name } = probePoint();
        if (name) { setView('forecast'); return; }   // already the forecast location
        const round = v => Math.round(v * 1e4) / 1e4;
        selectLocation({ name: fmtCoord(c), latitude: round(c.lat), longitude: round(c.lng) });
        setView('forecast');
    }

    // ================= Public API =================
    function show() {
        R.visible = true;
        if (!R.built) {
            buildUi();
            renderAllMapUi();
            loadCatalog(false);
        } else {
            // A new forecast location since the map was last shown: go there.
            if (state.location && R.centeredLoc !== locKey()) centerOnLocation(false);
            R.map.invalidateSize();
            renderStatus();
            reloadFrames();
        }
        setTimeout(() => R.map && R.map.invalidateSize(), 50);
        clearInterval(R.refreshTimer);
        R.refreshTimer = setInterval(() => {
            if (document.visibilityState === 'visible' && R.visible) reloadFrames({ forceTimes: true });
        }, MAP_CONFIG.autoRefreshMs);
    }

    function hide() {
        R.visible = false;
        play(false);
        clearInterval(R.refreshTimer);
        if (R.drawing) stopDrawing();
    }

    function refresh() {
        if (!R.built) return;
        if (R.catalogStatus !== 'ok') loadCatalog(true);
        else reloadFrames({ forceTimes: true, newExtent: true });
    }

    function onLangChange() {
        if (R.built) renderAllMapUi();
    }

    function onLocationChange() {
        if (!R.built) return;
        updateLocationMarker();
        renderPanel();
        if (R.visible) centerOnLocation(true);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && R.visible) reloadFrames({ forceTimes: false });
    });

    window.FlySkyMap = { show, hide, refresh, onLangChange, onLocationChange,
        // exposed for tests / diagnostics
        _internals: { parseTimeDimension, parseCapabilities, buildWmsUrl, isoDurationMs, R, S, cache } };
})();
