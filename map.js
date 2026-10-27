// FlySky — satellite map view (EUMETSAT EUMETView WMS)
//
// Loaded on demand (together with Leaflet) the first time the Map view is
// opened. Shares the page's globals: t(), translations, currentLang, state,
// escapeHtml(), loadFromStorage(), saveToStorage(), sunAltitudeDeg(),
// selectLocation(), locationKey(), showToast(), setView(), hazardEnabled(),
// setHazardEnabled() — and window.FlySkyHazard (hazard.js) when loaded.
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
        // Copernicus Sentinel-3 layers are polar passes (a few a day).
        excludeNamespaces: ['eps', 'mumi', 'backgrounds', 'osmgray', 'copernicus'],
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
        // …and at most this many bytes of images (RGB frames are 60–170 KB).
        cacheBytes: 25 * 1048576,
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
        // Key-free basemaps only (CARTO's tiles now need an API key; the
        // EUMETView "osmgray" maps are mid-grey with country names only).
        // "Dark" is the OSM map darkened in the browser (CSS filter).
        basemaps: {
            osmDark: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, className: 'fs-tiles-dark', background: '#1b2433',
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
            osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, background: '#aad3df',
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }
        },
        openMeteo: 'https://api.open-meteo.com/v1/forecast',
        eumetsatAttribution: '&copy; <a href="https://www.eumetsat.int/" target="_blank" rel="noopener">EUMETSAT</a>'
    };

    // Products, in priority order. `test` runs on "<name> <title>" of every
    // layer in the capabilities; `prefer` names win when present.
    const PRODUCTS = [
        // EUMETView's "Fog / Low Clouds RGB" is the Night Microphysics RGB
        // (EUMETSAT quick guide: "also sometimes referred to as the Fog RGB").
        { id: 'fog', role: 'night', icon: 'fa-smog', prefer: ['msg_fes:rgb_fog'],
          test: s => /rgb_fog|\bfog\b|night.?micro/i.test(s) && !/day.?micro/i.test(s) },
        // True colour by day; at night low cloud blue, high cloud white.
        { id: 'geocolour', role: 'any', icon: 'fa-globe',
          test: s => /geo.?colou?r/i.test(s) },
        { id: 'dayMicro', role: 'day', icon: 'fa-sun', prefer: ['msg_fes:rgb_microphysics'],
          test: s => /micro/i.test(s) && !/night|24/i.test(s) },
        // Low / mid / high cloud, and supercooled water (icing).
        { id: 'cloudType', role: 'day', icon: 'fa-layer-group',
          test: s => /cloud.?type/i.test(s) },
        // Water vs ice cloud and droplet size.
        { id: 'cloudPhase', role: 'day', icon: 'fa-droplet',
          test: s => /cloud.?phase/i.test(s) },
        { id: 'natural', role: 'day', icon: 'fa-earth-europe',
          test: s => /natural.?colou?r|rgb_natural/i.test(s) },
        // Cloud / clear land / clear sea, day and night (exact classes).
        { id: 'clm', role: 'any', icon: 'fa-cloud', prefer: ['msg_fes:clm'],
          test: s => /(^|:)clm\b|cloud.?mask/i.test(s) },
        // MSG measures at 10.8 µm, MTG's FCI at 10.5 µm.
        { id: 'ir108', role: 'any', icon: 'fa-temperature-half',
          test: s => /ir[_\s-]?10[._]?[58]|10[.,][58]\s*[µμ]?m/i.test(s) }
    ];
    // "Auto": each image uses the best product for the sun at its time
    // (first one the service offers). Twilight falls back to the night or
    // day list by the sign of the sun's altitude.
    const AUTO = {
        night: ['fog', 'geocolour', 'ir108'],
        day: ['dayMicro', 'natural', 'geocolour'],
        twilight: ['geocolour']
    };
    // Distance rings around the forecast location (km).
    const RINGS_KM = [5, 10, 25];
    // Colour keys from EUMETSAT's RGB quick guides; swatches sampled from
    // the official colour-interpretation charts. Texts: mapKey_<id>.
    const GUIDE = 'https://user.eumetsat.int/resources/user-guides/';
    const RGB_KEYS = {
        fog: { guide: GUIDE + 'night-microphysics-rgb-quick-guide',
            colors: [['#785af0', '#b06fd9'], '#9cd0d9', '#aad7b0', '#a6797b', '#820a14', 'dots', '#1b009c', '#7800c8', '#c80078'] },
        dayMicro: { guide: GUIDE + 'day-microphysics-rgb-quick-guide',
            colors: ['#b4d878', '#8665ac', '#54a28c', '#e6661b', '#a34448', '#ce4698', '#5d9eba', '#064ab5'] },
        natural: { guide: GUIDE + 'natural-colour-rgb-quick-guide',
            colors: ['#f2f2f2', '#dae3f4', '#6bd4c6', '#57f6da', '#7b8745', '#b99774', '#156c7d', '#131d29'] },
        // Described by EUMETSAT (no colour chart): illustrative swatches, so
        // the readout shows the pixel colour without matching it.
        geocolour: { guide: GUIDE + 'limitations-of-mtg-geo-colour-rgb-for-low-clouds-over-western-cape', noMatch: true,
            colors: ['#7fa6d6', '#dde1e7', '#141a26', '#f2c46b', '#f2f2f2', '#5d6b34', '#14233d'] },
        cloudType: { guide: GUIDE + 'cloud-type-rgb-quick-guide',
            colors: ['#8ffdec', '#45ad70', '#fefffe', '#cc3f8b', '#c50c00', '#ffff3e', '#5eff10', '#443799'] },
        cloudPhase: { guide: GUIDE + 'cloud-phase-rgb-quick-guide',
            colors: ['#ffeabf', '#feadcd', '#8d46a2', '#786547', '#7a9272', '#73e1fa', '#496ae4', '#592a23', '#000000', '#ffe429', '#3232a1'] },
        // Exact class colours of the service's Cloud Mask style.
        clm: { guide: 'https://user.eumetsat.int/data/map/EO:EUM:DAT:MSG:CLM', exact: true,
            colors: ['#ffffff', '#01c001', '#0101ff'] }
    };

    // Overlays drawn above the product, each with its own time steps:
    //  - precipitation: the image nearest to the product's time;
    //  - lightning: every image of the 30 min up to the product's time;
    //  - fires: every image from the start of the window ("risk areas").
    const OVERLAYS = [
        { id: 'precip', icon: 'fa-cloud-showers-heavy', prefer: ['mtg_fd:h40b', 'msg_fes:h60b'], show: 'nearest',
          test: s => /precip|rain.?rate/i.test(s) },
        { id: 'lightning', icon: 'fa-bolt', prefer: ['mtg_fd:li_afa'], show: 30,
          test: s => /li_afa|lightning|flash.?area/i.test(s) },
        { id: 'fire', icon: 'fa-fire', prefer: ['mtg_fd:frp', 'msg_fes:fire'], show: 'window',
          test: s => /(^|:)(frp|fire)$|fire.?radiative|active.?fire/i.test(s) && !/rgb/i.test(s) }
    ];
    const PRECIP = OVERLAYS[0];
    // Readout: nearest lightning / fire within this distance.
    const SCAN_KM = 50;

    // Place names drawn above the imagery (no tile service needed):
    // [lat, lon, rank, en, uk, pt]; rank 1 from zoom 4, 2 from 6, 3 from 7.
    const PLACES = [
        [50.45, 30.52, 1, 'Kyiv', 'Київ', 'Kiev'], [49.84, 24.03, 2, 'Lviv', 'Львів'], [49.99, 36.23, 2, 'Kharkiv', 'Харків', 'Carcóvia'],
        [46.48, 30.72, 2, 'Odesa', 'Одеса', 'Odessa'], [48.46, 35.05, 2, 'Dnipro', 'Дніпро'], [47.84, 35.14, 2, 'Zaporizhzhia', 'Запоріжжя'],
        [48.0, 37.8, 2, 'Donetsk', 'Донецьк'], [48.57, 39.31, 2, 'Luhansk', 'Луганськ'], [46.97, 32.0, 2, 'Mykolaiv', 'Миколаїв'],
        [46.64, 32.61, 2, 'Kherson', 'Херсон'], [44.95, 34.1, 2, 'Simferopol', 'Сімферополь'], [44.62, 33.52, 3, 'Sevastopol', 'Севастополь'],
        [49.59, 34.55, 2, 'Poltava', 'Полтава'], [50.91, 34.8, 2, 'Sumy', 'Суми'], [51.49, 31.29, 2, 'Chernihiv', 'Чернігів'],
        [50.25, 28.66, 2, 'Zhytomyr', 'Житомир'], [49.23, 28.47, 2, 'Vinnytsia', 'Вінниця'], [49.42, 27.0, 2, 'Khmelnytskyi', 'Хмельницький'],
        [49.55, 25.59, 2, 'Ternopil', 'Тернопіль'], [48.92, 24.71, 2, 'Ivano-Frankivsk', 'Івано-Франківськ'], [48.62, 22.29, 2, 'Uzhhorod', 'Ужгород'],
        [48.29, 25.94, 2, 'Chernivtsi', 'Чернівці'], [50.75, 25.33, 2, 'Lutsk', 'Луцьк'], [50.62, 26.25, 2, 'Rivne', 'Рівне'],
        [49.44, 32.06, 2, 'Cherkasy', 'Черкаси'], [48.51, 32.26, 2, 'Kropyvnytskyi', 'Кропивницький'], [47.91, 33.39, 3, 'Kryvyi Rih', 'Кривий Ріг'],
        [47.1, 37.55, 3, 'Mariupol', 'Маріуполь'], [49.8, 30.11, 3, 'Bila Tserkva', 'Біла Церква'], [48.74, 37.58, 3, 'Kramatorsk', 'Краматорськ'],
        [52.23, 21.01, 1, 'Warsaw', 'Варшава', 'Varsóvia'], [53.9, 27.56, 1, 'Minsk', 'Мінськ'], [47.01, 28.86, 1, 'Chișinău', 'Кишинів', 'Chisinau'],
        [44.43, 26.1, 1, 'Bucharest', 'Бухарест', 'Bucareste'], [47.5, 19.04, 1, 'Budapest', 'Будапешт', 'Budapeste'], [48.15, 17.11, 1, 'Bratislava', 'Братислава'],
        [54.69, 25.28, 1, 'Vilnius', 'Вільнюс'], [55.76, 37.62, 1, 'Moscow', 'Москва', 'Moscou'], [51.25, 22.57, 3, 'Lublin', 'Люблін'],
        [50.04, 22.0, 3, 'Rzeszów', 'Жешув'], [50.06, 19.94, 2, 'Kraków', 'Краків', 'Cracóvia'], [52.1, 23.69, 3, 'Brest', 'Брест'],
        [52.44, 30.98, 2, 'Homel', 'Гомель'], [50.6, 36.59, 2, 'Belgorod', 'Бєлгород'], [53.24, 34.36, 3, 'Bryansk', 'Брянськ'],
        [51.73, 36.19, 3, 'Kursk', 'Курськ'], [47.23, 39.72, 2, 'Rostov-on-Don', 'Ростов-на-Дону', 'Rostov do Don'], [47.16, 27.59, 2, 'Iași', 'Ясси', 'Iasi']
    ];
    const BORDERS = { id: 'borders', test: s => /boundar|border|coastline/i.test(s) };

    // ================= Translations =================
    const MAP_I18N = {
        en: {
            mapProductTitle: 'Satellite product',
            mapSettingsTitle: 'Map settings',
            mapProduct_geocolour: 'GeoColour (day & night)',
            mapProduct_cloudType: 'Cloud Type RGB',
            mapProduct_cloudPhase: 'Cloud Phase RGB',
            mapProduct_clm: 'Cloud Mask',
            mapKey_geocolour: [
                'Night: low cloud / fog (blue)',
                'Night: high cloud (white / grey)',
                'Night: clear ground (dark)',
                'Night: city lights',
                'Day: cloud (white)',
                'Day: land (green / brown)',
                'Day: sea and lakes (dark blue)'
            ],
            mapKey_geocolour_note: 'True colour by day, infrared at night. It can miss some low cloud at night — check the Fog / Low Clouds RGB.',
            mapKey_cloudType: [
                'Low / mid-level water cloud (incl. fog)',
                'Mixed-phase cloud, low / mid level',
                'Supercooled water cloud — icing risk',
                'High, thin water cloud (more orange with ice)',
                'Thin cirrus',
                'Thick ice cloud (multi-layer, ice on top)',
                'Snow and ice on the ground',
                'Land'
            ],
            mapKey_cloudType_note: 'Daytime only. Snow can look like low / mid ice cloud; colours vary with moisture.',
            mapKey_cloudPhase: [
                'Thick water cloud, small droplets (fog, stratus)',
                'Thick water cloud, larger droplets',
                'Thick water cloud, very large droplets or mixed phase',
                'Thin water cloud over sea',
                'Thin ice cloud',
                'Thick ice cloud, small particles',
                'Thick ice cloud, large particles',
                'Vegetated land',
                'Sea',
                'Desert',
                'Snow on the ground or sea ice'
            ],
            mapKey_cloudPhase_note: 'Daytime only. Thin clouds take on the colour of the surface below.',
            mapKey_clm: ['Cloud (any height)', 'Clear — land', 'Clear — sea'],
            mapKey_clm_note: 'Cloud of any height: use Fog / Low Clouds or Cloud Type to tell low cloud.',
            mapSourceTitle: 'Source',
            mapSat_msg_fes: 'Meteosat MSG · 0°',
            mapSat_mtg_fd: 'Meteosat MTG · 0°',
            mapSat_msg_rss: 'MSG Rapid Scan · Europe',
            mapSat_msg_iodc: 'MSG · Indian Ocean',
            mapEvery: 'every {n} min',
            mapEnhanced: 'enhanced',
            mapOverlaysTitle: 'Overlays',
            mapOv_precip: 'Precipitation',
            mapOv_lightning: 'Lightning',
            mapOv_fire: 'Fires',
            mapOvKind_lightning: 'Flashes seen by MTG’s Lightning Imager during the 30 min up to each image (counted from the selected image).',
            mapOvKind_fire: 'Fires and hot spots detected by satellite, from the selected image up to each image — pick an earlier time and play to see risk areas build up. Smoke can lower visibility.',
            mapOvNone: 'Not offered by the service.',
            mapOvImages: '{n} images · {from} – {to}',
            mapOvImage: 'Image: {time}',
            mapOv_wind: 'Forecast wind',
            mapWindKind: 'Model forecast (Open-Meteo) for the hour of the image. Arrows point where the wind blows; colour follows your flight thresholds (wind aloft limits above 120 m). The flight time calculator uses the same height.',
            mapWindAt: 'Wind for {time}',
            mapWindErr: 'Wind forecast unavailable ({msg})',
            mapBase_osmDark: 'Dark',
            mapLabels: 'Place names on top',
            mapProbeLightning: 'Lightning',
            mapProbeFire: 'Fires',
            mapProbeNearest: '{d} km {dir} · {time}',
            mapProbeNoneWithin: 'none within {r} km',
            mapProbeWind: 'Wind (model)',
            mapProbeWindValue: 'from {dir} · {w} {u}, gusts {g} {u}',
            mapProbeClass: '{label} · exact',
            mapProbePixel: 'pixel colour — see the colour key',
            mapCompass: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
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
            mapLatestShort: 'latest',
            mapImageAge: 'Image {time} · {age} ago',
            mapImageTime: 'Time of the satellite image shown',
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
            mapGoForecast: 'Set location',
            mapProbeCollapse: 'Collapse / expand',
            mapNow: 'latest available',
            mapProduct_auto: 'Auto (day / night)',
            mapRole_auto: 'Auto',
            mapAutoDesc: 'Fog / Low Clouds RGB at night, Day Microphysics by day, GeoColour at twilight — chosen for each image by the sun at the forecast location (at the map centre when the location is out of view).',
            mapAutoNow: 'This image: {name}',
            mapRings: 'Distance rings (5 / 10 / 25 km)',
            mapFavs: 'Favourites on the map',
            mapFavSelected: 'Forecast location: {name}',
            mapHazardAlerts: 'Nearby hazard alerts',
            mapHazardKind: 'Lightning and rain within {r} km of the forecast location, from the latest satellite images (checked every 5 min while the app is open).',
            mapWindForecast: 'Forecast wind for {time} · latest satellite image',
            mapWindForecastClear: 'Back to the image time',
            mapProbeModelsN: 'Models (median of {n})',
            mapVsRain: 'Rain: sat vs models',
            mapVsCloud: 'Low cloud: sat vs models',
            mapVsRainWet: 'satellite: rain within 10 km',
            mapVsRainDry: 'satellite: no rain within 15 km',
            mapVsLow: 'satellite: likely fog / low cloud',
            mapVsClear: 'satellite: no low cloud',
            mapVsAll: 'all {n} models agree',
            mapVsDry: 'dry',
            mapVsLowPct: 'low clouds {v}%',
            rtTool: "Flight time calculator",
            rtTitle: "Flight time",
            rtSwap: "Swap A and B",
            rtClear: "Clear the points",
            rtClose: "Close",
            rtAirspeed: "Airspeed",
            rtWindAt: "Wind at",
            rtDepart: "Departure",
            rtNow: "now",
            rtIn: "in {n} h",
            rtLevel_10m: "10 m",
            rtLevel_120m: "120 m",
            rtLevel_500m: "~500 m",
            rtLevel_800m: "~800 m",
            rtLevel_1500m: "~1500 m",
            rtStartHere: "Start A here (at the crosshair)",
            rtModeAim: "Aim",
            rtModeAimTip: "Aim: B is the crosshair. Pan the map to measure; zooming keeps B in place.",
            rtModeTap: "Tap",
            rtModeTapTip: "Tap: tap the map to set B. Pan and zoom freely to look around the route.",
            rtEditA: "Start A: tap to paste MGRS",
            rtEditB: "Destination B: tap to paste MGRS",
            rtMgrsPlaceholder: "MGRS, e.g. 36U VU 12345 67890",
            rtMgrsGo: "Go",
            rtMgrsCancel: "Cancel",
            rtMgrsBad: "Not an MGRS reference: {text}",
            rtMgrsNone: "Paste an MGRS reference (for B, several make waypoints).",
            rtHintPan: "Pan the map: B follows the crosshair. Switch to Tap to look around without moving B.",
            rtHintTap: "Tap the map to set B. Pan and zoom freely; drag A or B to move them.",
            rtWaypoints: "+{n} via",
            rtReading: "Reading the wind along the route…",
            rtNoWind: "Wind unavailable ({msg}).",
            rtBlocked: "Can't make headway: on part of the route the crosswind or headwind is too strong for {v} m/s airspeed.",
            rtStill: "in still air",
            rtNoHeadway: "No headway",
            rtBackShort: "back {time}",
            rtEta: "ETA {time}",
            rtBack: "Back: {time} · ETA {eta}",
            rtBackBlocked: "Back: can't make headway against this wind.",
            rtBackNoWind: "Back: no wind data for the return.",
            rtDurMin: "{m} min",
            rtDurHourMin: "{h} h {m} min"
        },
        uk: {
            mapProductTitle: 'Супутниковий продукт',
            mapSettingsTitle: 'Налаштування карти',
            mapProduct_geocolour: 'GeoColour (день і ніч)',
            mapProduct_cloudType: 'Тип хмар RGB',
            mapProduct_cloudPhase: 'Фаза хмар RGB',
            mapProduct_clm: 'Маска хмарності',
            mapKey_geocolour: [
                'Ніч: низька хмарність / туман (синій)',
                'Ніч: висока хмарність (білий / сірий)',
                'Ніч: безхмарна поверхня (темна)',
                'Ніч: вогні міст',
                'День: хмари (білі)',
                'День: суходіл (зелений / коричневий)',
                'День: море та озера (темно-сині)'
            ],
            mapKey_geocolour_note: 'Удень — природні кольори, вночі — інфрачервоний. Вночі може пропускати частину низької хмарності — перевіряйте на «Туман / низька хмарність».',
            mapKey_cloudType: [
                'Водяна хмарність нижнього / середнього ярусу (зокрема туман)',
                'Змішана хмарність нижнього / середнього ярусу',
                'Переохолоджена водяна хмарність — ризик обмерзання',
                'Висока тонка водяна хмарність (оранжевіша з льодом)',
                'Тонкі перисті хмари',
                'Щільна льодяна хмарність (багатошарова, лід угорі)',
                'Сніг і лід на поверхні',
                'Суходіл'
            ],
            mapKey_cloudType_note: 'Лише вдень. Сніг схожий на льодяну хмарність нижнього / середнього ярусу; кольори залежать від вологості.',
            mapKey_cloudPhase: [
                'Щільна водяна хмарність, дрібні краплі (туман, шаруваті)',
                'Щільна водяна хмарність, більші краплі',
                'Щільна водяна хмарність, дуже великі краплі або змішана фаза',
                'Тонка водяна хмарність над морем',
                'Тонка льодяна хмарність',
                'Щільна льодяна хмарність, дрібні частинки',
                'Щільна льодяна хмарність, великі частинки',
                'Суходіл із рослинністю',
                'Море',
                'Пустеля',
                'Сніг на поверхні або морський лід'
            ],
            mapKey_cloudPhase_note: 'Лише вдень. Тонкі хмари набувають кольору поверхні під ними.',
            mapKey_clm: ['Хмарність (будь-якої висоти)', 'Ясно — суходіл', 'Ясно — море'],
            mapKey_clm_note: 'Хмарність будь-якої висоти: низьку визначайте за «Туман / низька хмарність» або «Тип хмар».',
            mapSourceTitle: 'Джерело',
            mapSat_msg_fes: 'Meteosat MSG · 0°',
            mapSat_mtg_fd: 'Meteosat MTG · 0°',
            mapSat_msg_rss: 'MSG швидке сканування · Європа',
            mapSat_msg_iodc: 'MSG · Індійський океан',
            mapEvery: 'кожні {n} хв',
            mapEnhanced: 'посилений',
            mapOverlaysTitle: 'Накладання',
            mapOv_precip: 'Опади',
            mapOv_lightning: 'Блискавки',
            mapOv_fire: 'Пожежі',
            mapOvKind_lightning: 'Спалахи, зафіксовані блискавковим сенсором MTG за 30 хв до кожного знімка (від вибраного знімка).',
            mapOvKind_fire: 'Пожежі та гарячі точки, виявлені супутником, від вибраного знімка до кожного наступного — оберіть ранніший час і відтворіть, щоб побачити, як накопичуються зони ризику. Дим може погіршувати видимість.',
            mapOvNone: 'Сервіс не надає.',
            mapOvImages: '{n} знімків · {from} – {to}',
            mapOvImage: 'Знімок: {time}',
            mapOv_wind: 'Прогноз вітру',
            mapWindKind: 'Прогноз моделі (Open-Meteo) на годину знімка. Стрілки показують, куди дме вітер; колір — за вашими порогами польоту (вище 120 м — пороги вітру на висоті). Калькулятор часу польоту використовує ту саму висоту.',
            mapWindAt: 'Вітер на {time}',
            mapWindErr: 'Прогноз вітру недоступний ({msg})',
            mapBase_osmDark: 'Темна',
            mapLabels: 'Назви місць зверху',
            mapProbeLightning: 'Блискавки',
            mapProbeFire: 'Пожежі',
            mapProbeNearest: '{d} км {dir} · {time}',
            mapProbeNoneWithin: 'немає в межах {r} км',
            mapProbeWind: 'Вітер (модель)',
            mapProbeWindValue: 'з {dir} · {w} {u}, пориви {g} {u}',
            mapProbeClass: '{label} · точно',
            mapProbePixel: 'колір пікселя — див. пояснення кольорів',
            mapCompass: ['Пн', 'ПнСх', 'Сх', 'ПдСх', 'Пд', 'ПдЗх', 'Зх', 'ПнЗх'],
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
            mapLatestShort: 'останній',
            mapImageAge: 'Знімок {time} · {age} тому',
            mapImageTime: 'Час показаного супутникового знімка',
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
            mapGoForecast: 'Встановити локацію',
            mapProbeCollapse: 'Згорнути / розгорнути',
            mapNow: 'останнє доступне',
            mapProduct_auto: 'Авто (день / ніч)',
            mapRole_auto: 'Авто',
            mapAutoDesc: 'Уночі — Туман / низька хмарність RGB, удень — Денна мікрофізика, у сутінках — GeoColour; вибирається для кожного знімка за положенням сонця над локацією прогнозу (над центром карти, якщо локації не видно).',
            mapAutoNow: 'Цей знімок: {name}',
            mapRings: 'Кола відстані (5 / 10 / 25 км)',
            mapFavs: 'Обране на карті',
            mapFavSelected: 'Локація прогнозу: {name}',
            mapHazardAlerts: 'Попередження про небезпеку поруч',
            mapHazardKind: 'Блискавки та опади в межах {r} км від локації прогнозу за останніми супутниковими знімками (перевірка кожні 5 хв, поки застосунок відкритий).',
            mapWindForecast: 'Прогноз вітру на {time} · останній супутниковий знімок',
            mapWindForecastClear: 'Повернутися до часу знімка',
            mapProbeModelsN: 'Моделі (медіана з {n})',
            mapVsRain: 'Опади: супутник і моделі',
            mapVsCloud: 'Низька хмарність: супутник і моделі',
            mapVsRainWet: 'супутник: опади в межах 10 км',
            mapVsRainDry: 'супутник: опадів у межах 15 км немає',
            mapVsLow: 'супутник: ймовірно туман / низька хмарність',
            mapVsClear: 'супутник: низької хмарності немає',
            mapVsAll: 'усі {n} моделей згодні',
            mapVsDry: 'сухо',
            mapVsLowPct: 'низька хмарність {v}%',
            rtTool: "Калькулятор часу польоту",
            rtTitle: "Час польоту",
            rtSwap: "Поміняти A і B",
            rtClear: "Очистити точки",
            rtClose: "Закрити",
            rtAirspeed: "Повітряна швидкість",
            rtWindAt: "Вітер на",
            rtDepart: "Виліт",
            rtNow: "зараз",
            rtIn: "через {n} год",
            rtLevel_10m: "10 м",
            rtLevel_120m: "120 м",
            rtLevel_500m: "~500 м",
            rtLevel_800m: "~800 м",
            rtLevel_1500m: "~1500 м",
            rtStartHere: "Старт A тут (під прицілом)",
            rtModeAim: "Приціл",
            rtModeAimTip: "Приціл: B — під прицілом. Рухайте карту, щоб виміряти; масштабування не зсуває B.",
            rtModeTap: "Дотик",
            rtModeTapTip: "Дотик: торкніться карти, щоб задати B. Карту можна вільно рухати й масштабувати.",
            rtEditA: "Старт A: торкніться, щоб вставити MGRS",
            rtEditB: "Ціль B: торкніться, щоб вставити MGRS",
            rtMgrsPlaceholder: "MGRS, напр. 36U VU 12345 67890",
            rtMgrsGo: "Перейти",
            rtMgrsCancel: "Скасувати",
            rtMgrsBad: "Не схоже на MGRS: {text}",
            rtMgrsNone: "Вставте координату MGRS (для B кілька — проміжні точки).",
            rtHintPan: "Рухайте карту: B слідує за прицілом. Режим «Дотик» — щоб роздивитися карту, не зсуваючи B.",
            rtHintTap: "Торкніться карти, щоб задати B. Карту можна вільно рухати; A чи B можна перетягувати.",
            rtWaypoints: "+{n} через",
            rtReading: "Читаю вітер уздовж маршруту…",
            rtNoWind: "Вітер недоступний ({msg}).",
            rtBlocked: "Не пролетіти: на частині маршруту бічний чи зустрічний вітер завеликий для повітряної швидкості {v} m/s.",
            rtStill: "у штиль",
            rtNoHeadway: "Не пролетіти",
            rtBackShort: "назад {time}",
            rtEta: "прибуття {time}",
            rtBack: "Назад: {time} · прибуття {eta}",
            rtBackBlocked: "Назад: проти цього вітру не пролетіти.",
            rtBackNoWind: "Назад: немає даних про вітер.",
            rtDurMin: "{m} хв",
            rtDurHourMin: "{h} год {m} хв"
        },
        'pt-BR': {
            mapProductTitle: 'Produto de satélite',
            mapSettingsTitle: 'Ajustes do mapa',
            mapProduct_geocolour: 'GeoColour (dia e noite)',
            mapProduct_cloudType: 'Tipo de nuvem RGB',
            mapProduct_cloudPhase: 'Fase da nuvem RGB',
            mapProduct_clm: 'Máscara de nuvens',
            mapKey_geocolour: [
                'Noite: nuvem baixa / nevoeiro (azul)',
                'Noite: nuvem alta (branco / cinza)',
                'Noite: solo sem nuvens (escuro)',
                'Noite: luzes das cidades',
                'Dia: nuvens (brancas)',
                'Dia: terra (verde / marrom)',
                'Dia: mar e lagos (azul-escuro)'
            ],
            mapKey_geocolour_note: 'Cor verdadeira de dia, infravermelho à noite. À noite pode perder parte das nuvens baixas — confira no Nevoeiro / Nuvens baixas RGB.',
            mapKey_cloudType: [
                'Nuvem de água baixa / média (inclui nevoeiro)',
                'Nuvem de fase mista, baixa / média',
                'Nuvem de água super-resfriada — risco de gelo',
                'Nuvem de água alta e fina (mais laranja com gelo)',
                'Cirrus fino',
                'Nuvem de gelo espessa (várias camadas, gelo no topo)',
                'Neve e gelo no solo',
                'Terra'
            ],
            mapKey_cloudType_note: 'Só de dia. A neve pode parecer nuvem de gelo baixa / média; as cores variam com a umidade.',
            mapKey_cloudPhase: [
                'Nuvem de água espessa, gotas pequenas (nevoeiro, estrato)',
                'Nuvem de água espessa, gotas maiores',
                'Nuvem de água espessa, gotas muito grandes ou fase mista',
                'Nuvem de água fina sobre o mar',
                'Nuvem de gelo fina',
                'Nuvem de gelo espessa, partículas pequenas',
                'Nuvem de gelo espessa, partículas grandes',
                'Terra com vegetação',
                'Mar',
                'Deserto',
                'Neve no solo ou gelo marinho'
            ],
            mapKey_cloudPhase_note: 'Só de dia. Nuvens finas assumem a cor da superfície abaixo.',
            mapKey_clm: ['Nuvem (qualquer altura)', 'Céu limpo — terra', 'Céu limpo — mar'],
            mapKey_clm_note: 'Nuvem de qualquer altura: use Nevoeiro / Nuvens baixas ou Tipo de nuvem para ver as baixas.',
            mapSourceTitle: 'Fonte',
            mapSat_msg_fes: 'Meteosat MSG · 0°',
            mapSat_mtg_fd: 'Meteosat MTG · 0°',
            mapSat_msg_rss: 'MSG Varredura rápida · Europa',
            mapSat_msg_iodc: 'MSG · Oceano Índico',
            mapEvery: 'a cada {n} min',
            mapEnhanced: 'realçado',
            mapOverlaysTitle: 'Sobreposições',
            mapOv_precip: 'Precipitação',
            mapOv_lightning: 'Raios',
            mapOv_fire: 'Incêndios',
            mapOvKind_lightning: 'Descargas vistas pelo Lightning Imager do MTG nos 30 min até cada imagem (a partir da imagem selecionada).',
            mapOvKind_fire: 'Incêndios e pontos quentes detectados por satélite, da imagem selecionada até cada imagem — escolha um horário anterior e reproduza para ver as áreas de risco se acumularem. A fumaça pode reduzir a visibilidade.',
            mapOvNone: 'Não oferecido pelo serviço.',
            mapOvImages: '{n} imagens · {from} – {to}',
            mapOvImage: 'Imagem: {time}',
            mapOv_wind: 'Vento previsto',
            mapWindKind: 'Previsão de modelo (Open-Meteo) para a hora da imagem. As setas apontam para onde o vento sopra; a cor segue seus limites de voo (acima de 120 m, os limites de vento em altitude). A calculadora de tempo de voo usa a mesma altura.',
            mapWindAt: 'Vento para {time}',
            mapWindErr: 'Previsão de vento indisponível ({msg})',
            mapBase_osmDark: 'Escuro',
            mapLabels: 'Nomes de lugares por cima',
            mapProbeLightning: 'Raios',
            mapProbeFire: 'Incêndios',
            mapProbeNearest: '{d} km {dir} · {time}',
            mapProbeNoneWithin: 'nenhum a até {r} km',
            mapProbeWind: 'Vento (modelo)',
            mapProbeWindValue: 'de {dir} · {w} {u}, rajadas {g} {u}',
            mapProbeClass: '{label} · exato',
            mapProbePixel: 'cor do pixel — veja a legenda de cores',
            mapCompass: ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'],
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
            mapLatestShort: 'mais recente',
            mapImageAge: 'Imagem {time} · há {age}',
            mapImageTime: 'Hora da imagem de satélite mostrada',
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
            mapGoForecast: 'Definir local',
            mapProbeCollapse: 'Recolher / expandir',
            mapNow: 'mais recente',
            mapProduct_auto: 'Automático (dia / noite)',
            mapRole_auto: 'Auto',
            mapAutoDesc: 'Nevoeiro / Nuvens baixas RGB à noite, Microfísica diurna de dia, GeoColour no crepúsculo — escolhido para cada imagem pela posição do sol no local da previsão (no centro do mapa quando o local está fora da vista).',
            mapAutoNow: 'Esta imagem: {name}',
            mapRings: 'Círculos de distância (5 / 10 / 25 km)',
            mapFavs: 'Favoritos no mapa',
            mapFavSelected: 'Local da previsão: {name}',
            mapHazardAlerts: 'Alertas de perigo próximo',
            mapHazardKind: 'Raios e chuva a até {r} km do local da previsão, pelas imagens de satélite mais recentes (verificado a cada 5 min com o app aberto).',
            mapWindForecast: 'Vento previsto para {time} · imagem de satélite mais recente',
            mapWindForecastClear: 'Voltar ao horário da imagem',
            mapProbeModelsN: 'Modelos (mediana de {n})',
            mapVsRain: 'Chuva: satélite x modelos',
            mapVsCloud: 'Nuvem baixa: satélite x modelos',
            mapVsRainWet: 'satélite: chuva a até 10 km',
            mapVsRainDry: 'satélite: sem chuva a até 15 km',
            mapVsLow: 'satélite: provável nevoeiro / nuvem baixa',
            mapVsClear: 'satélite: sem nuvem baixa',
            mapVsAll: 'todos os {n} modelos concordam',
            mapVsDry: 'seco',
            mapVsLowPct: 'nuvens baixas {v}%',
            rtTool: "Calculadora de tempo de voo",
            rtTitle: "Tempo de voo",
            rtSwap: "Trocar A e B",
            rtClear: "Limpar os pontos",
            rtClose: "Fechar",
            rtAirspeed: "Velocidade do ar",
            rtWindAt: "Vento a",
            rtDepart: "Partida",
            rtNow: "agora",
            rtIn: "em {n} h",
            rtLevel_10m: "10 m",
            rtLevel_120m: "120 m",
            rtLevel_500m: "~500 m",
            rtLevel_800m: "~800 m",
            rtLevel_1500m: "~1500 m",
            rtStartHere: "Partida A aqui (na mira)",
            rtModeAim: "Mira",
            rtModeAimTip: "Mira: B é a mira. Mova o mapa para medir; o zoom mantém B no lugar.",
            rtModeTap: "Toque",
            rtModeTapTip: "Toque: toque no mapa para marcar B. Mova e aproxime o mapa livremente.",
            rtEditA: "Partida A: toque para colar MGRS",
            rtEditB: "Destino B: toque para colar MGRS",
            rtMgrsPlaceholder: "MGRS, ex. 36U VU 12345 67890",
            rtMgrsGo: "Ir",
            rtMgrsCancel: "Cancelar",
            rtMgrsBad: "Não é uma referência MGRS: {text}",
            rtMgrsNone: "Cole uma referência MGRS (para B, várias viram pontos intermediários).",
            rtHintPan: "Mova o mapa: B segue a mira. Mude para Toque para olhar o mapa sem mover B.",
            rtHintTap: "Toque no mapa para marcar B. Mova e aproxime livremente; arraste A ou B para movê-los.",
            rtWaypoints: "+{n} via",
            rtReading: "Lendo o vento ao longo da rota…",
            rtNoWind: "Vento indisponível ({msg}).",
            rtBlocked: "Não dá para avançar: em parte da rota o vento lateral ou contrário é forte demais para {v} m/s de velocidade do ar.",
            rtStill: "sem vento",
            rtNoHeadway: "Sem avanço",
            rtBackShort: "volta {time}",
            rtEta: "chegada {time}",
            rtBack: "Volta: {time} · chegada {eta}",
            rtBackBlocked: "Volta: não dá para avançar contra este vento.",
            rtBackNoWind: "Volta: sem dados de vento.",
            rtDurMin: "{m} min",
            rtDurHourMin: "{h} h {m} min"
        }
    };
    Object.keys(MAP_I18N).forEach(lang => {
        if (translations[lang]) Object.assign(translations[lang], MAP_I18N[lang]);
    });

    // Map-only styles (dark tiles, place names, wind arrows, switches).
    (() => {
        const st = document.createElement('style');
        st.textContent = `
            .fs-tiles-dark img.leaflet-tile { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.85) saturate(0.5); }
            .fs-place { display: flex; align-items: center; gap: 4px; white-space: nowrap; pointer-events: none; }
            .fs-place-dot { width: 5px; height: 5px; border-radius: 9999px; background: #f8fafc; box-shadow: 0 0 0 1.5px #020617; flex-shrink: 0; }
            .fs-place-name { font: 600 11px/1.1 Inter, system-ui, sans-serif; color: #f1f5f9; text-shadow: 0 0 3px #020617, 0 0 2px #020617, 0 0 1px #020617; }
            .fs-place-major { font-size: 12.5px; letter-spacing: 0.01em; }
            .fs-wind { display: flex; flex-direction: column; align-items: center; pointer-events: none; }
            .fs-wind span { font: 700 10px/1 Inter, system-ui, sans-serif; color: #f8fafc; text-shadow: 0 0 3px #020617, 0 0 2px #020617; margin-top: 1px; }
            .fs-ring-label { font: 600 10px/1 Inter, system-ui, sans-serif; color: #f8fafc; text-shadow: 0 0 3px #020617, 0 0 2px #020617, 0 0 1px #020617; white-space: nowrap; pointer-events: none; }
            .fs-fav { display: flex; align-items: center; gap: 3px; white-space: nowrap; cursor: pointer; }
            .fs-fav i { color: #fbbf24; font-size: 12px; filter: drop-shadow(0 0 1.5px #020617) drop-shadow(0 0 1px #020617); }
            .fs-fav span { font: 600 11px/1.1 Inter, system-ui, sans-serif; color: #fde68a; text-shadow: 0 0 3px #020617, 0 0 2px #020617, 0 0 1px #020617; }
            .fs-route-pt span { display: flex; width: 26px; height: 26px; border-radius: 9999px; align-items: center; justify-content: center; font: 700 12px/1 Inter, system-ui, sans-serif; color: #020617; border: 2px solid #020617; box-shadow: 0 0 0 2px #f8fafc, 0 2px 6px rgba(0, 0, 0, 0.5); cursor: grab; }
            .fs-route-tag { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 3px 8px 4px; border-radius: 8px; background: rgba(2, 6, 23, 0.9); border: 1px solid rgba(34, 211, 238, 0.65); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); white-space: nowrap; pointer-events: none; font: 600 10px/1.2 Inter, system-ui, sans-serif; color: #cbd5e1; }
            .fs-route-tag b { display: flex; align-items: center; gap: 4px; font: 700 13px/1.15 Inter, system-ui, sans-serif; color: #f8fafc; }
            .fs-route-tag b i { font-size: 10px; color: #22d3ee; }
            .fs-route-tag b.bad { color: #fda4af; }
            .fs-route-dot { display: inline-flex; flex-shrink: 0; width: 15px; height: 15px; border-radius: 9999px; align-items: center; justify-content: center; font: 700 9px/1 Inter, system-ui, sans-serif; color: #020617; }
            /* No time bar: the notes and panels move down. */
            .fs-nobar #mapSide { bottom: 1.75rem; }
            /* The notes and readout never reach the crosshair (they scroll
               instead); while the map moves the readout shows its header only. */
            #mapSide { max-height: calc(50% - 7.75rem - 1.75rem); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
            /* Scrollable once taller than that (pointer events for the scroll). */
            #mapSide.fs-scroll { pointer-events: auto; }
            .fs-nobar #mapSide { max-height: calc(50% - 1.75rem - 1.75rem); }
            .fs-moving #mapProbeRows { display: none; }
            /* Phones in landscape: timeline bottom-left, notes + readout in a
               scrolling column bottom-right (left of the map buttons), so
               the middle of the map (crosshair) stays clear. */
            @media (max-height: 520px) and (orientation: landscape) {
                #mapBar { left: 0.5rem; bottom: 0.5rem; transform: none; translate: none; width: min(26rem, calc(50vw - 1rem)); padding: 0.375rem; border-radius: 0.875rem; }
                #mapBar #mapTicks { margin-bottom: 0.25rem; }
                #mapBar button { width: 2rem; height: 2rem; }
                #mapSide { left: auto; right: 3.5rem; bottom: 0.5rem; transform: none; translate: none; width: min(22rem, calc(50vw - 4.5rem)); max-height: calc(100% - 1rem); overflow-y: auto; pointer-events: auto; scrollbar-width: thin; }
                #mapPanelBtn { top: 0.5rem; left: 0.5rem; }
                #mapView .leaflet-top.leaflet-right .leaflet-control-zoom { margin-top: 0.5rem; }
                #mapTools { top: 5rem; }
                .fs-nobar #mapSide { bottom: 0.5rem; max-height: calc(100% - 1rem); }
                #mapTimePill { top: 3rem; left: 0.5rem; }
            }`;
        document.head.appendChild(st);
    })();

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
    // Lightning and fire marks are small, so they start fully visible; the
    // imagery and precipitation start at 40%.
    const OV_DEFAULT_OPACITY = { precip: 0.4, lightning: 0.9, fire: 0.9 };
    // Wind heights (Open-Meteo variable suffix), shared by the wind arrows
    // and the flight time calculator: one setting for both.
    const WIND_LEVELS = { '10m': '10m', '120m': '120m', '500m': '950hPa', '800m': '925hPa', '1500m': '850hPa' };
    const defaults = {
        product: null, productAt: 0, sources: {}, opacity: 0.4,
        overlays: { precip: { on: false, opacity: 0.4 }, lightning: { on: false, opacity: 0.9 }, fire: { on: false, opacity: 0.9 } },
        wind: { on: true, level: '120m' },
        // The basemaps already show place names and borders; wind arrows on;
        // times in local time.
        basemap: 'osmDark', labels: false, borders: false, rings: true, favs: true, hazardMin: false, windowH: 6, utc: false, speed: 1,
        view: null, region: 'ukraine', diagOpen: false, keyOpen: true, probe: true, probeOpen: true,
        // Flight time calculator: airspeed m/s, departure in hours from now,
        // mode aim / tap (the points are not kept; the wind height is S.wind's).
        route: { on: false, airspeed: 22, depart: 0, mode: 'aim' }
    };
    const stored = loadFromStorage(MAP_CONFIG.settingsKey, {}) || {};
    const S = Object.assign({}, defaults, stored);
    S.overlays = {};
    OVERLAYS.forEach(o => { S.overlays[o.id] = Object.assign({}, defaults.overlays[o.id], (stored.overlays || {})[o.id]); });
    S.wind = Object.assign({}, defaults.wind, stored.wind);
    S.route = Object.assign({}, defaults.route, stored.route, { on: false });
    delete S.route.a; delete S.route.b; delete S.route.open;
    if (!['aim', 'tap'].includes(S.route.mode)) S.route.mode = 'aim';
    if (!(S.route.airspeed >= 18 && S.route.airspeed <= 30)) S.route.airspeed = 22;
    if (![0, 1, 2, 3, 6].includes(S.route.depart)) S.route.depart = 0;
    // Earlier versions kept precipitation settings at the top level.
    if (stored.precipOn !== undefined) S.overlays.precip.on = !!stored.precipOn;
    if (stored.precipOpacitySet) { S.overlays.precip.opacity = stored.precipOpacity; S.overlays.precip.opacitySet = true; }
    ['precipOn', 'precipOpacity', 'precipOpacitySet', 'panelOpen'].forEach(k => delete S[k]);
    // Defaults only apply until the user changes a value (earlier versions
    // stored their defaults unasked).
    if (!S.opacitySet) S.opacity = defaults.opacity;
    OVERLAYS.forEach(o => { if (!S.overlays[o.id].opacitySet) S.overlays[o.id].opacity = OV_DEFAULT_OPACITY[o.id]; });
    if (!S.basemapSet) S.basemap = defaults.basemap;
    if (!MAP_CONFIG.windows.includes(S.windowH)) S.windowH = 6;
    if (!MAP_CONFIG.speeds.includes(S.speed)) S.speed = 1;
    if (!MAP_CONFIG.basemaps[S.basemap] && S.basemap !== 'none') S.basemap = defaults.basemap;
    // Earlier versions: the arrows had 10 m / '925', the calculator its own height.
    if (S.wind.level === '925') S.wind.level = '800m';
    if (!WIND_LEVELS[S.wind.level]) S.wind.level = WIND_LEVELS[S.route.level] ? S.route.level : defaults.wind.level;
    delete S.route.level;
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
        ovLayers: {},             // overlayId -> [layer, ...] ordered
        ovFrames: {},             // overlayId -> [{ t, key, url }]
        ovShown: {},              // overlayId -> Map(frameKey -> L.imageOverlay, or the stack's layer)
        ovStack: {},              // overlayId -> { ext, canvas, g, layer, pending } for stacked overlays
        ovWant: {},               // overlayId -> Set(frameKey) for the shown time
        times: {},                // layerName -> { at, list:[ms], ok, error }
        frames: [],               // [{ t, key }]
        index: -1, playing: false, playTimer: null,
        extent: null,             // { key, bounds, bbox3857, w, h, zoom }
        extents: [],              // recently used image areas, newest first
        overlay: null, bordersLayer: null, baseLayer: null, locMarker: null, labelsLayer: null,
        lastOk: null, lastError: null, requestMode: 'fetch', fetchWorked: false,
        refreshTimer: null, moveTimer: null, drawing: null, gen: 0,
        ovMeta: new Map(),        // overlay frame key -> { id, layer, t, ext } (hazard alerts)
        ringsLayer: null, favLayer: null,
        pendingHour: null,        // forecast hour to show once frames are known
        shownProduct: null
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

    function dropEntry(key, e) {
        if (e.url && e.url.startsWith('blob:')) URL.revokeObjectURL(e.url);
        cache.delete(key);
    }

    // Oldest unused images go first once the cache has too many images or
    // too many bytes.
    function evict() {
        let bytes = 0;
        cache.forEach(e => { bytes += e.bytes || 0; });
        const over = () => cache.size > MAP_CONFIG.cacheLimit || bytes > MAP_CONFIG.cacheBytes;
        if (!over()) return;
        const inUse = new Set(R.frames.map(f => f.key).concat(...Object.values(R.ovFrames).map(l => l.map(f => f.key))));
        for (const [key, e] of cache) {
            if (!over()) break;
            if (inUse.has(key) || e.status === 'loading' || e.status === 'queued') continue;
            bytes -= e.bytes || 0;
            dropEntry(key, e);
        }
    }

    // App in the background: keep only the images on screen, so Android is
    // less likely to close the app for its memory. Coming back loads the
    // latest image again (and forward from a picked one, as always).
    function trimCache() {
        const f = timelineFrames()[R.index];
        const keep = new Set(f ? [f.key] : []);
        Object.values(R.ovWant).forEach(set => set && set.forEach(k => keep.add(k)));
        for (const [key, e] of [...cache]) {
            if (!keep.has(key) && e.status !== 'loading' && e.status !== 'queued') dropEntry(key, e);
        }
        renderProgress();
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
        // A retry runs as its own load() with its own controller; this one
        // must then leave the entry alone (or it could not be cancelled).
        let retried = false;
        try {
            const res = await fetch(e.src, { signal: controller.signal, mode: 'cors', credentials: 'omit' });
            // Rate limit or a transient gateway error: back off and retry.
            if ([429, 502, 503, 504].includes(res.status)) {
                clearTimeout(timer);
                if (attempt < 2) {
                    noteError(res.status === 429 ? t('mapErrRate') : `HTTP ${res.status}`, e.src);
                    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                    if (!cache.has(e.key)) return;
                    retried = true;
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
            e.url = url; e.status = 'ok'; e.bytes = blob.size;
            R.lastOk = { url: e.src, at: Date.now() };
            // Lightning / precipitation images also feed the nearby-hazard
            // alert (its movement estimate), at no extra cost.
            const meta = R.ovMeta.get(e.key);
            if (meta && window.FlySkyHazard) window.FlySkyHazard.feed(meta.id === 'precip' ? 'rain' : meta.id, meta.layer, meta.t, url, meta.ext.bbox3857, meta.ext.w, meta.ext.h);
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
            // Only a finished request settles; a retry or the <img> fallback
            // carries on with the same entry.
            if (!retried) {
                e.controller = null;
                if (e.status === 'ok' || e.status === 'error') settle(e);
            }
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

    // Update interval in minutes, from "start/end/PT10M" or a value list.
    function stepMinutes(values) {
        const m = /\/(P[^,\/\s]*)\s*$/.exec(String(values || '').trim());
        if (m) return Math.round(isoDurationMs(m[1]) / 60000) || null;
        const list = parseTimeDimension(values).slice(-6);
        if (list.length < 2) return null;
        const diffs = list.slice(1).map((v, i) => v - list[i]).sort((a, b) => a - b);
        return Math.round(diffs[Math.floor(diffs.length / 2)] / 60000) || null;
    }

    function slimLayer(l) {
        return { name: l.name, title: l.title, abstract: l.abstract, bbox: l.bbox, styles: l.styles, crs3857: l.crs3857, hasTime: !!l.time,
            step: l.time ? stepMinutes(l.time.values) : null };
    }

    function matchCatalog(layers) {
        const keep = new Map();
        const add = l => keep.set(l.name, l);
        layers.forEach(l => {
            const s = `${l.name} ${l.title}`;
            if (BORDERS.test(s) && !l.time) { add(l); return; }
            if (excluded(l.name)) return;
            const hit = x => (x.prefer || []).includes(l.name) || x.test(s);
            if (PRODUCTS.some(hit) || OVERLAYS.some(hit) || BORDERS.test(s)) add(l);
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
        OVERLAYS.forEach(o => {
            R.ovLayers[o.id] = layers.filter(l => l.hasTime && ((o.prefer || []).includes(l.name) || o.test(`${l.name} ${l.title}`)))
                .sort((a, b) => sourceRank(a, o, region) - sourceRank(b, o, region) || a.name.localeCompare(b.name));
        });
        R.precipLayers = R.ovLayers.precip;
        // Preferred boundary/coastline layers with their white-line style;
        // otherwise any boundary layer the service offers, default style.
        const byName = new Map(all.map(l => [l.name, l]));
        R.borderLayers = MAP_CONFIG.borders.filter(b => byName.has(b.name));
        if (!R.borderLayers.length) {
            const any = all.find(l => BORDERS.test(`${l.name} ${l.title}`) && !l.hasTime);
            if (any) R.borderLayers = [{ name: any.name, style: '' }];
        }
        // New users (nothing picked by hand yet) start on "Auto"; a product
        // picked by hand stays as picked.
        const unavailable = S.product === 'auto' ? !autoAvailable() : S.product !== 'none' && !(R.resolved[S.product] || []).length;
        if (!S.product || !S.productAt || unavailable) {
            S.product = autoAvailable() ? 'auto' : suggestedProduct();
        }
        updateBorders();
        renderAllMapUi();
        reloadFrames();
    }

    function productLayer(id) {
        const list = R.resolved[id] || [];
        return list.find(l => l.name === S.sources[id]) || list[0] || null;
    }

    // The product's layer; for "Auto" the layer of the image on screen (or
    // the first one Auto can use before any image is known).
    function activeLayer() {
        if (S.product === 'none') return null;
        if (S.product !== 'auto') return productLayer(S.product);
        const f = R.frames[R.index];
        if (f && f.layer) return f.layer;
        const id = ['night', 'day', 'twilight'].map(role => autoProduct(role)).find(Boolean);
        return id ? productLayer(id) : null;
    }

    // Product of the image on screen (differs from S.product for "Auto").
    function shownProduct() {
        if (S.product !== 'auto') return S.product;
        const f = R.frames[R.index];
        return f && f.product ? f.product : ['night', 'day', 'twilight'].map(role => autoProduct(role)).find(Boolean) || 'fog';
    }

    // ---- Auto (day / night)
    function autoProduct(role, alt) {
        let list = AUTO[role] || [];
        if (role === 'twilight') list = list.concat(AUTO[alt >= 0 ? 'day' : 'night']);
        return list.find(id => productLayer(id)) || null;
    }

    function autoAvailable() {
        return ['night', 'day', 'twilight'].some(role => autoProduct(role, 0));
    }

    // The sun is judged at the forecast location while it is in view,
    // otherwise at the map centre.
    function autoSunPoint() {
        const loc = state.location;
        if (loc && R.map && R.map.getBounds().contains([loc.latitude, loc.longitude])) return { lat: loc.latitude, lng: loc.longitude };
        return R.map ? R.map.getCenter() : { lat: 48.5, lng: 31.5 };
    }

    function sunRole(ms, pt) {
        const alt = sunAltitudeDeg(ms, pt.lat, pt.lng);
        return { role: alt < -3 ? 'night' : alt > 6 ? 'day' : 'twilight', alt };
    }

    function overlayLayer(id) {
        const list = R.ovLayers[id] || [];
        return list.find(l => l.name === S.sources[id]) || list[0] || null;
    }

    function activeOverlay(id) {
        return S.overlays[id] && S.overlays[id].on ? overlayLayer(id) : null;
    }

    function activeOverlays() {
        return OVERLAYS.filter(o => activeOverlay(o.id));
    }

    // Without a product, the first enabled overlay drives the timeline.
    function drivingOverlay() {
        return activeLayer() ? null : activeOverlays()[0] || null;
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
        const order = sun === 'day' ? ['dayMicro', 'geocolour', 'natural', 'fog', 'ir108'] : sun === 'night' ? ['fog', 'geocolour', 'ir108', 'dayMicro'] : ['geocolour', 'fog', 'dayMicro', 'ir108'];
        return order.find(has) || PRODUCTS.map(p => p.id).find(has) || 'fog';
    }

    // ================= Extent =================
    // Satellite pixels here are ~1–5 km; an image drawn for zoom 8 (~400 m
    // per pixel at 50°N) already samples them finely, so closer views only
    // magnify it: the image is the zoom-8 view around the centre, with a
    // wider margin (same pixel count), and zooming in or panning inside it
    // needs no new image.
    const SAT_MAX_ZOOM = 8;
    const EXTENTS_KEPT = 6;
    function satZoom() {
        return Math.min(R.map.getZoom(), SAT_MAX_ZOOM);
    }

    function computeExtent() {
        const map = R.map;
        const size = map.getSize();
        if (!size.x || !size.y) return null;
        const z = satZoom();
        const c = map.project(map.getCenter(), z);
        const view = L.latLngBounds(map.unproject(c.subtract(size.divideBy(2)), z), map.unproject(c.add(size.divideBy(2)), z));
        // At the cap the image covers 1.6× the (zoom-8) view: more room to
        // pan; below it 1.2×, keeping the detail of zoomed-out views.
        const b = view.pad(z === SAT_MAX_ZOOM ? 0.3 : 0.1);
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
        return { key: bbox3857.join(','), bbox3857, bounds, w, h: hh, zoom: z };
    }

    // An image area serves the view when it covers it at least as finely
    // as needed.
    function extentFits(ext) {
        return !!ext && ext.zoom >= satZoom() && ext.bounds.contains(R.map.getBounds());
    }

    function extentStillGood() {
        return extentFits(R.extent);
    }

    // After a move: the current area, else a recently used one (its images
    // may still be cached — going back needs no download), else a new one.
    function updateExtent() {
        if (extentStillGood()) return;
        const old = R.extents.find(extentFits);
        if (old) { R.extent = old; rememberExtent(old); reloadFrames(); }
        else reloadFrames({ newExtent: true });
    }

    function rememberExtent(ext) {
        R.extents = [ext, ...R.extents.filter(e => e.key !== ext.key || e.w !== ext.w || e.h !== ext.h)].slice(0, EXTENTS_KEPT);
    }

    // ================= Frames =================
    async function reloadFrames(opts = {}) {
        if (!R.map || !R.visible) return;
        const gen = ++R.gen;
        if (!navigator.onLine) { renderStatus(); return; }
        if (opts.newExtent || !R.extent) { R.extent = computeExtent(); if (R.extent) rememberExtent(R.extent); }
        const ext = R.extent;
        if (!ext) return;
        // Product layers in use: one, or for "Auto" the night / day /
        // twilight ones (each image then picks one of them).
        const auto = S.product === 'auto';
        const autoIds = auto ? [...new Set(['night', 'day', 'twilight', 'twilightDay'].map(r => r === 'twilightDay' ? autoProduct('twilight', 1) : autoProduct(r, -1)).filter(Boolean))] : [];
        const satLayers = auto ? autoIds.map(id => ({ id, layer: productLayer(id) })) : S.product !== 'none' && activeLayer() ? [{ id: S.product, layer: activeLayer() }] : [];
        const overlays = activeOverlays().map(o => ({ o, layer: activeOverlay(o.id) }));
        const winMs = S.windowH * 3600e3;

        const times = await Promise.all([
            ...satLayers.map(x => refreshTimes(x.layer.name, opts.forceTimes)),
            ...overlays.map(x => refreshTimes(x.layer.name, opts.forceTimes))
        ]);
        if (gen !== R.gen) return;
        const satTimes = times.slice(0, satLayers.length), ovTimes = times.slice(satLayers.length);

        const pick = (info, fromMs) => {
            if (!info || !info.list.length) return info && (info.noTime || !info.ok) ? [null] : [];
            const latest = info.list[info.list.length - 1];
            return info.list.filter(v => v >= (fromMs ?? latest - winMs));
        };
        const prevT = timelineFrames()[R.index] ? timelineFrames()[R.index].t : undefined;
        const wasLatest = R.index === timelineFrames().length - 1;

        const makeFrame = (id, lay, tm) => {
            const style = styleOf(lay);
            return { t: tm, product: id, layer: lay, key: frameKey(lay.name, style, tm, ext, MAP_CONFIG.format), url: getMapUrl(lay.name, style, tm, ext, MAP_CONFIG.format) };
        };
        if (!auto) {
            R.frames = satLayers.length ? pick(satTimes[0]).map(tm => makeFrame(satLayers[0].id, satLayers[0].layer, tm)) : [];
        } else {
            // Every time step of the layers involved, in order; a step is kept
            // when it belongs to the product the sun calls for at that time.
            const lists = satLayers.map((x, i) => pick(satTimes[i]).filter(v => v !== null));
            const latest = Math.max(-Infinity, ...lists.map(l => (l.length ? l[l.length - 1] : -Infinity)));
            const pt = autoSunPoint();
            const all = [...new Set(lists.flat())].filter(v => v >= latest - winMs).sort((a, b) => a - b);
            R.frames = [];
            all.forEach(tm => {
                const { role, alt } = sunRole(tm, pt);
                const id = autoProduct(role, alt);
                const i = satLayers.findIndex(x => x.id === id);
                if (i >= 0 && lists[i].includes(tm)) R.frames.push(makeFrame(id, satLayers[i].layer, tm));
            });
            // No time steps known: the latest image of today's product.
            if (!R.frames.length && satLayers.length) {
                const { role, alt } = sunRole(Date.now(), pt);
                const x = satLayers.find(s => s.id === autoProduct(role, alt)) || satLayers[0];
                R.frames = [makeFrame(x.id, x.layer, null)];
            }
        }
        // Overlay steps cover the product's window, plus 30 min before it
        // for lightning (each image shows the previous 30 min).
        const windowStart = R.frames.length && R.frames[0].t !== null ? R.frames[0].t : null;
        R.ovFrames = {};
        R.ovMeta = new Map();
        overlays.forEach((x, i) => {
            const extra = typeof x.o.show === 'number' ? x.o.show * 60e3 : x.o.show === 'nearest' ? 30 * 60e3 : 0;
            const list = pick(ovTimes[i], windowStart === null ? undefined : windowStart - extra);
            const style = styleOf(x.layer);
            R.ovFrames[x.o.id] = list.map(tm => ({ t: tm, key: frameKey(x.layer.name, style, tm, ext, MAP_CONFIG.overlayFormat), url: getMapUrl(x.layer.name, style, tm, ext, MAP_CONFIG.overlayFormat) }));
            if (x.o.id !== 'fire') R.ovFrames[x.o.id].forEach(f => { if (f.t !== null) R.ovMeta.set(f.key, { id: x.o.id, layer: x.layer.name, t: f.t, ext }); });
        });

        const wanted = new Set(R.frames.map(f => f.key).concat(...Object.values(R.ovFrames).map(l => l.map(f => f.key))));
        cancelExcept(wanted);
        // Opens on the latest image; only it is loaded until another time
        // is picked (showFrame() then loads from there forward).
        const timeline = timelineFrames();
        let idx = prevT === undefined || wasLatest ? timeline.length - 1 : timeline.findIndex(f => f.t === prevT);
        if (idx < 0) idx = timeline.length - 1;
        R.index = idx;
        renderAllMapUi();
        showFrame(R.index, true);
        if (R.pendingHour !== null && timeline.length) applyPendingHour();
    }

    // Frames needed once frame `from` is selected: that frame, then every
    // later one up to the latest (with the overlay images each one shows).
    function framesFrom(from) {
        const tl = timelineFrames();
        const ovs = activeOverlays();
        const out = [], seen = new Set();
        const add = f => { if (f && !seen.has(f.key)) { seen.add(f.key); out.push(f); } };
        for (let i = Math.max(0, from); i < tl.length; i++) {
            add(tl[i]);
            ovs.forEach(o => overlayFramesFor(o, tl[i].t).forEach(add));
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

    // The timeline follows the satellite product, or the first enabled
    // overlay when no product is selected.
    function timelineFrames() {
        if (activeLayer()) return R.frames;
        const d = drivingOverlay();
        return d ? R.ovFrames[d.id] || [] : [];
    }

    // Overlay images shown with a product image taken at `tm`.
    function overlayFramesFor(o, tm) {
        const list = R.ovFrames[o.id] || [];
        if (!list.length) return [];
        if (tm === null || tm === undefined) tm = list[list.length - 1].t;
        if (tm === null) return [list[list.length - 1]];
        const upTo = f => f.t !== null && f.t <= tm + 5 * 60e3;
        if (o.show === 'nearest') {
            let best = null;
            list.forEach(f => { if (upTo(f) && tm - f.t <= 30 * 60e3 && (!best || Math.abs(f.t - tm) < Math.abs(best.t - tm))) best = f; });
            return best ? [best] : [];
        }
        // Stacks start at the selected image (R.anchorT): from the overlay
        // image nearest to it, so nothing earlier is ever loaded.
        let from = -Infinity;
        if (R.anchorT !== null && R.anchorT !== undefined) {
            const before = list.filter(f => f.t !== null && f.t <= R.anchorT + 5 * 60e3);
            from = before.length ? before[before.length - 1].t : R.anchorT;
        }
        if (o.show === 'window') return list.filter(f => upTo(f) && f.t >= from);
        return list.filter(f => upTo(f) && f.t >= from && f.t > tm - o.show * 60e3);
    }

    // keepAnchor: moving forward from the selection (next / play) keeps the
    // start of the lightning / fire stacks; any other pick starts a new one.
    async function showFrame(i, keepAnchor = false) {
        const tl = timelineFrames();
        if (!tl.length || i < 0) { setOverlay('overlay', null); OVERLAYS.forEach(o => showOverlayFrames(o, [])); renderTimeLabel(); return; }
        R.index = Math.max(0, Math.min(i, tl.length - 1));
        const ft = tl[R.index].t;
        if (!keepAnchor || R.anchorT === null || R.anchorT === undefined || ft === null || ft < R.anchorT) R.anchorT = ft;
        loadFrom(R.index);
        renderSlider();
        renderTimeLabel();
        renderProgress();   // moves the current-frame marker
        const f = tl[R.index];
        const gen = R.gen;
        const satFrame = activeLayer() ? f : null;
        const satEntry = satFrame ? cache.get(satFrame.key) || ensureFrame(satFrame, true) : null;
        if (satEntry) whenReady(satEntry).then(e => { if (gen === R.gen && timelineFrames()[R.index] === f && e.status === 'ok') setOverlay('overlay', e.url); });
        else setOverlay('overlay', null);
        OVERLAYS.forEach(o => showOverlayFrames(o, activeOverlay(o.id) ? overlayFramesFor(o, f.t) : []));
        renderOverlayInfo();
        // A nearby-hazard alert tracks movement from this image forward
        // (like the frames themselves, never earlier ones).
        if (window.FlySkyHazard) window.FlySkyHazard.track(tl.slice(R.index).map(x => x.t).filter(x => x !== null));
        // "Auto" switched product with this image: its colour key follows.
        if (R.shownProduct !== shownProduct()) { R.shownProduct = shownProduct(); renderPanel(); }
        if (windShown() && windHour() !== W.hour) updateWind();
        if (!R.playing) scheduleProbe();
    }

    function setOverlay(which, url) {
        const ov = R[which];
        if (!url) { if (ov) ov.setUrl(transparentPixel); return; }
        if (!ov) {
            R[which] = L.imageOverlay(url, R.extent.bounds, {
                pane: 'sat', opacity: S.opacity, interactive: false,
                attribution: MAP_CONFIG.eumetsatAttribution
            }).addTo(R.map);
            return;
        }
        ov.setUrl(url);
        ov.setBounds(R.extent.bounds);
        ov.setOpacity(S.opacity);
    }

    // Shows exactly `frames` for an overlay (one image, or several stacked
    // for lightning / fires). Images already on the map stay put, so
    // stepping through time only adds or removes the difference.
    function showOverlayFrames(o, frames) {
        const shown = R.ovShown[o.id] || (R.ovShown[o.id] = new Map());
        const want = new Set(frames.map(f => f.key));
        R.ovWant[o.id] = want;
        const gen = R.gen;
        const opacity = S.overlays[o.id].opacity;
        // A single image (precipitation) is swapped only once the new one is
        // ready, so the overlay never blinks off between steps.
        const single = o.show === 'nearest';
        if (!single) { showStack(o, frames, gen); return; }
        if (!frames.length) { shown.forEach(ov => R.map.removeLayer(ov)); shown.clear(); }
        frames.forEach(f => {
            if (shown.has(f.key)) return;
            const entry = cache.get(f.key) || ensureFrame(f, true);
            whenReady(entry).then(e => {
                if (gen !== R.gen || e.status !== 'ok' || !R.ovWant[o.id] || !R.ovWant[o.id].has(f.key) || shown.has(f.key)) return;
                const ov = L.imageOverlay(e.url, R.extent.bounds, { pane: 'ov_' + o.id, opacity, interactive: false, attribution: MAP_CONFIG.eumetsatAttribution }).addTo(R.map);
                shown.set(f.key, ov);
                shown.forEach((old, key) => { if (key !== f.key) { R.map.removeLayer(old); shown.delete(key); } });
            });
        });
    }

    // Stacked overlays (lightning: 30 min of images, fires: the whole
    // window) are drawn into one canvas per layer — one picture on the map
    // instead of up to dozens of full-size ones (each its own GPU texture:
    // enough of them made phones drop parts of the map while panning).
    // New images are drawn on top as they arrive; an image leaving the stack
    // or a new image area redraws it.
    function showStack(o, frames, gen) {
        const shown = R.ovShown[o.id];   // frame key -> the stack's layer (drawn images)
        const want = R.ovWant[o.id];
        const ext = R.extent;
        let st = R.ovStack[o.id];
        const gone = st ? [...shown.keys()].filter(k => !want.has(k)) : [];
        // Lightning's 30 min slide along while playing: its few images are
        // kept, so dropping the oldest only redraws the rest.
        if (st && st.ext === ext && gone.length && st.kept && frames.length) {
            gone.forEach(k => { shown.delete(k); st.kept.delete(k); });
            st.g.clearRect(0, 0, st.canvas.width, st.canvas.height);
            frames.forEach(f => { const img = st.kept.get(f.key); if (img) st.g.drawImage(img, 0, 0, st.canvas.width, st.canvas.height); });
        } else if (st && (st.ext !== ext || gone.length || !frames.length)) {
            R.map.removeLayer(st.layer);
            shown.clear();
            st = R.ovStack[o.id] = null;
        }
        if (!frames.length || !ext) return;
        if (!st) {
            const canvas = document.createElement('canvas');
            canvas.width = ext.w; canvas.height = ext.h;
            st = R.ovStack[o.id] = { ext, canvas, g: canvas.getContext('2d'), pending: new Set(), kept: typeof o.show === 'number' ? new Map() : null,
                layer: L.svgOverlay(canvas, ext.bounds, { pane: 'ov_' + o.id, opacity: S.overlays[o.id].opacity, interactive: false, attribution: MAP_CONFIG.eumetsatAttribution }).addTo(R.map) };
        }
        frames.forEach(f => {
            if (shown.has(f.key) || st.pending.has(f.key)) return;
            st.pending.add(f.key);
            const entry = cache.get(f.key) || ensureFrame(f, true);
            whenReady(entry).then(e => {
                if (e.status !== 'ok') return null;
                const img = new Image();
                img.src = e.url;
                return img.decode().then(() => img);
            }).then(img => {
                st.pending.delete(f.key);
                if (!img || gen !== R.gen || R.ovStack[o.id] !== st || !R.ovWant[o.id] || !R.ovWant[o.id].has(f.key) || shown.has(f.key)) return;
                st.g.drawImage(img, 0, 0, st.canvas.width, st.canvas.height);
                if (st.kept) st.kept.set(f.key, img);
                shown.set(f.key, st.layer);
                // The readout's nearest lightning / fire uses these images.
                if (!R.playing) scheduleProbe(700);
            }).catch(() => st.pending.delete(f.key));
        });
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
        showFrame(next, next !== 0);   // wrapping to the start begins a new stack
        const hold = next === tl.length - 1 ? 1500 : 0;   // pause on the newest image
        R.playTimer = setTimeout(tick, MAP_CONFIG.baseFrameMs / S.speed + hold);
    }

    function step(d) {
        clearForecastHour();
        play(false);
        const tl = timelineFrames();
        if (tl.length) { const n = (R.index + d + tl.length) % tl.length; showFrame(n, d > 0 && n !== 0); }
    }

    // ================= Formatting =================
    // One formatter per language and UTC / local (building one per call was
    // the top cost while playing).
    const timeFormats = new Map();
    function fmtTime(ms) {
        if (ms === null || ms === undefined) return t('mapDiagNone');
        const key = `${currentLang}|${S.utc}`;
        let f = timeFormats.get(key);
        if (!f) {
            f = new Intl.DateTimeFormat(currentLang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: S.utc ? 'UTC' : undefined });
            timeFormats.set(key, f);
        }
        if (S.utc) return `${f.format(ms)} UTC`;
        const off = -new Date(ms).getTimezoneOffset();
        const sign = off >= 0 ? '+' : '−';
        const hm = `${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? ':' + String(Math.abs(off) % 60).padStart(2, '0') : ''}`;
        return `${f.format(ms)} (UTC${sign}${hm})`;
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
            <button type="button" id="mapPanelBtn" class="absolute top-3 left-3 z-[500] flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/95 border border-slate-700 text-xs text-slate-200 shadow-xl hover:border-cyan-600 transition max-w-[calc(100vw-5.5rem)]">
                <i class="fa-solid fa-layer-group text-cyan-400"></i><span id="mapPanelBtnLabel" class="truncate"></span><span id="mapPanelBtnBadges" class="flex items-center gap-1 text-[10px]"></span><i class="fa-solid fa-sliders text-[11px] text-slate-500"></i>
            </button>
            <button type="button" id="mapTimePill" class="hidden absolute top-[3.4rem] left-3 z-[500] flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900/95 border border-slate-700 text-[11px] text-slate-300 shadow-lg max-w-[calc(100vw-5.5rem)]"></button>
            <div id="mapCrosshair" class="hidden absolute left-1/2 top-1/2 z-[420] -translate-x-1/2 -translate-y-1/2 pointer-events-none">
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
                    <g stroke="#020617" stroke-width="4" stroke-linecap="round"><path d="M22 3v12M22 29v12M3 22h12M29 22h12"/><circle cx="22" cy="22" r="3"/></g>
                    <g stroke="#f8fafc" stroke-width="2" stroke-linecap="round"><path d="M22 3v12M22 29v12M3 22h12M29 22h12"/><circle cx="22" cy="22" r="3"/></g>
                </svg>
            </div>
            <div id="mapTools" class="absolute top-[5.75rem] right-[10px] z-[500] flex flex-col gap-1.5">
                <button type="button" id="mapProbeBtn" class="w-[34px] h-[34px] rounded-lg border-2 border-black/20 bg-white text-slate-800 hover:bg-slate-100 transition"><i class="fa-solid fa-crosshairs"></i></button>
                <button type="button" id="mapCenterBtn" class="w-[34px] h-[34px] rounded-lg border-2 border-black/20 bg-white text-slate-800 hover:bg-slate-100 transition"><i class="fa-solid fa-location-dot"></i></button>
                <button type="button" id="mapFullBtn" class="hidden w-[34px] h-[34px] rounded-lg border-2 border-black/20 bg-white text-slate-800 hover:bg-slate-100 transition"><i class="fa-solid fa-expand"></i></button>
                <button type="button" id="mapRouteBtn" class="w-[34px] h-[34px] rounded-lg border-2 border-black/20 bg-white text-slate-800 hover:bg-slate-100 transition"><i class="fa-solid fa-stopwatch"></i></button>
                <div id="mapHazardIcons" class="contents"></div>
            </div>
            <div id="mapSide" class="absolute bottom-[7.75rem] left-1/2 -translate-x-1/2 z-[450] w-[min(30rem,calc(100vw-1rem))] flex flex-col gap-1.5 pointer-events-none">
                <div id="mapStatus" class="space-y-1.5"></div>
                <div id="mapRoute" class="hidden pointer-events-auto rounded-xl bg-slate-900/95 border border-slate-700 shadow-xl text-[11px] text-slate-300"></div>
                <div id="mapProbe" class="hidden pointer-events-auto rounded-xl bg-slate-900/95 border border-slate-700 shadow-xl text-[11px] text-slate-300"></div>
            </div>
            <div id="mapBar" class="absolute bottom-7 left-1/2 -translate-x-1/2 z-[500] w-[min(44rem,calc(100vw-1rem))] p-2 rounded-2xl bg-slate-900/95 border border-slate-700 shadow-2xl"></div>`;
        const map = L.map('satMap', { zoomControl: false, worldCopyJump: false, minZoom: 3, maxZoom: 18, attributionControl: true });
        R.map = map;
        L.control.zoom({ position: 'topright' }).addTo(map);
        map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
        [['sat', 410], ['ov_precip', 420], ['ov_fire', 430], ['ov_lightning', 440], ['borders', 600], ['rings', 610], ['wind', 620], ['labels', 640], ['loc', 650], ['route', 660]].forEach(([name, z]) => {
            const pane = map.createPane(name);
            pane.style.zIndex = z;
            if (name !== 'loc' && name !== 'route') pane.style.pointerEvents = 'none';
        });
        if (state.location) {
            R.anchor = L.latLng(state.location.latitude, state.location.longitude);
            map.setView(R.anchor, S.view && S.view.zoom ? S.view.zoom : 6);
            R.centeredLoc = locKey();
        } else if (S.view && S.view.center) map.setView(S.view.center, S.view.zoom);
        else fitRegion(MAP_CONFIG.regions.ukraine, false);
        setBasemap(S.basemap, true);
        updateLocationMarker();
        updatePlaces();
        updateRings();
        updateFavorites();
        map.on('zoomend', () => { updatePlaces(); updateRings(); updateFavorites(); });

        // While the map moves the readout folds to its header (the crosshair
        // stays in view, less to redraw) and nothing is asked for it; it
        // reads again once the map has settled.
        map.on('movestart', () => {
            clearTimeout(R.moveTimer);
            clearTimeout(P.timer);
            try { P.controller && P.controller.abort(); } catch (err) {}
            if (P.loading) { P.loading = false; P.seq++; renderProbe(); }
            root.classList.add('fs-moving');
            fitSide();
        });
        map.on('move', renderProbeHeader);
        map.on('moveend', () => {
            S.view = { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() };
            save();
            clearTimeout(R.moveTimer);
            R.moveTimer = setTimeout(() => {
                updateExtent();
                renderStatus();
            }, 450);
            // Moved away from the forecast location: follow the crosshair.
            if (R.anchor && !anchorCentred()) R.anchor = null;
            root.classList.remove('fs-moving');
            fitSide();
            scheduleProbe(700);
            updatePlaces();
            if (windShown()) { clearTimeout(W.timer); W.timer = setTimeout(updateWind, 400); }
        });
        // Flight time calculator: taps, and B / the route tag following the map.
        map.on('click', e => { if (S.route.on && !R.drawing) routeTap(e.latlng); });
        map.on('move zoomend resize', () => { if (S.route.on) routeMoved(); });
        map.on('resize', fitSide);
        setupDrawing();
        setupUiEvents();
        R.built = true;
    }

    function fitRegion(bbox, animate = true) {
        R.map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { animate, padding: [8, 8] });
    }

    function setBasemap(id, init) {
        S.basemap = id;
        if (!init) S.basemapSet = true;
        if (R.baseLayer) { R.map.removeLayer(R.baseLayer); R.baseLayer = null; }
        const cfg = MAP_CONFIG.basemaps[id];
        if (cfg) R.baseLayer = L.tileLayer(cfg.url, { subdomains: cfg.subdomains || 'abc', maxZoom: cfg.maxZoom, attribution: cfg.attribution, className: cfg.className || '', detectRetina: false }).addTo(R.map);
        $('satMap').style.background = cfg ? cfg.background : '#020617';
        if (!init) { save(); renderPanel(); }
    }

    // ---- Place names (built-in list, current language)
    function placeName(p) {
        return currentLang === 'uk' ? p[4] : currentLang === 'pt-BR' ? (p[5] || p[3]) : p[3];
    }

    function updatePlaces() {
        if (!R.map) return;
        if (!R.labelsLayer) R.labelsLayer = L.layerGroup().addTo(R.map);
        R.labelsLayer.clearLayers();
        if (!S.labels) return;
        const z = R.map.getZoom();
        const maxRank = z >= 7 ? 3 : z >= 6 ? 2 : z >= 4 ? 1 : 0;
        const b = R.map.getBounds().pad(0.1);
        PLACES.forEach(p => {
            if (p[2] > maxRank || !b.contains([p[0], p[1]])) return;
            L.marker([p[0], p[1]], {
                pane: 'labels', interactive: false, keyboard: false,
                icon: L.divIcon({ className: 'fs-place', html: `<span class="fs-place-dot"></span><span class="fs-place-name${p[2] === 1 ? ' fs-place-major' : ''}">${h(placeName(p))}</span>`, iconSize: null, iconAnchor: [3, 3] })
            }).addTo(R.labelsLayer);
        });
    }

    // ---- Forecast wind arrows (Open-Meteo, one request for the grid)
    // forecastHour: a later hour picked in the forecast view; the arrows
    // then show that hour (with the latest image) until another image is
    // picked.
    const W = { cache: new Map(), group: null, seq: 0, hour: null, error: '', loading: false, timer: null, forecastHour: null };

    function windShown() {
        return S.wind.on || W.forecastHour !== null;
    }

    function windHour() {
        if (W.forecastHour !== null) return W.forecastHour;
        const f = timelineFrames()[R.index];
        const tm = f && f.t !== null && f.t !== undefined ? f.t : Date.now();
        return Math.round(tm / 3600e3) * 3600e3;
    }

    function clearForecastHour() {
        if (W.forecastHour === null) return;
        W.forecastHour = null;
        updateWind();
        renderStatus();
    }

    function windGrid() {
        const z = R.map.getZoom();
        const degPerPx = 360 / (256 * 2 ** z);
        const spacing = window.innerWidth < 640 ? 80 : 100;
        const step = [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 10].find(v => v / degPerPx >= spacing) || 10;
        const b = R.map.getBounds();
        const pts = [];
        for (let la = Math.ceil(b.getSouth() / step) * step; la <= b.getNorth() && pts.length < 220; la += step) {
            if (Math.abs(la) > 80) continue;
            for (let lo = Math.ceil(b.getWest() / step) * step; lo <= b.getEast() && pts.length < 220; lo += step) {
                const lat = Math.round(la * 100) / 100, lon = Math.round(lo * 100) / 100;
                pts.push({ lat, lon, key: `${lat},${lon}` });
            }
        }
        // Zoomed in past the finest grid: one arrow by the crosshair, with
        // the wind of the nearest grid point.
        if (!pts.length) {
            const c = R.map.getCenter();
            const lat = Math.round(c.lat / step) * step, lon = Math.round(c.lng / step) * step;
            const k = [Math.round(lat * 100) / 100, Math.round(lon * 100) / 100];
            pts.push({ lat: k[0], lon: k[1], key: k.join(','), at: c });
        }
        return pts;
    }

    // Two days ahead normally; up to a week for a forecast hour. Only the
    // level shown: Open-Meteo counts every variable at every point.
    async function fetchWind(pts, hour, lvl) {
        const days = Math.min(7, Math.max(2, Math.ceil((hour - Date.now()) / 864e5) + 1));
        for (let i = 0; i < pts.length; i += 100) {
            const chunk = pts.slice(i, i + 100);
            const url = buildWmsUrl(MAP_CONFIG.openMeteo, {
                latitude: chunk.map(p => p.lat).join(','), longitude: chunk.map(p => p.lon).join(','),
                hourly: `wind_speed_${lvl},wind_direction_${lvl}`,
                past_days: 1, forecast_days: days, timezone: 'GMT', wind_speed_unit: 'ms'
            }, []);
            const res = await fetch(url);
            const body = await res.json();
            if (!res.ok || body.error) throw new Error(body.reason || `HTTP ${res.status}`);
            const list = Array.isArray(body) ? body : [body];
            chunk.forEach((p, k) => {
                const hr = list[k] && list[k].hourly;
                if (hr) W.cache.set(`${lvl}|${p.key}`, { at: Date.now(), hourly: hr, until: Date.parse(hr.time[hr.time.length - 1] + 'Z') });
            });
        }
    }

    // The wind height, from the side menu or the calculator: arrows and
    // calculator follow it together.
    function setWindLevel(level) {
        if (!WIND_LEVELS[level]) return;
        S.wind.level = level;
        save();
        renderPanel();
        const sel = document.querySelector('#mapRoute [data-route-level]');
        if (sel) sel.value = level;
        W.hour = null;
        updateWind();
        if (S.route.on) loadRouteWind();
    }

    async function updateWind() {
        if (!R.map) return;
        if (!W.group) W.group = L.layerGroup().addTo(R.map);
        const id = ++W.seq;
        if (!windShown()) { W.group.clearLayers(); W.hour = null; renderWindInfo(); return; }
        const hour = windHour();
        const pts = windGrid();
        // Forget points not refreshed for 30 min (they'd be fetched again
        // anyway), and never keep more than 1500.
        W.cache.forEach((c, k) => { if (Date.now() - c.at > 30 * 60e3) W.cache.delete(k); });
        for (const k of W.cache.keys()) { if (W.cache.size <= 1500) break; W.cache.delete(k); }
        const lvl = WIND_LEVELS[S.wind.level];
        const missing = pts.filter(p => { const c = W.cache.get(`${lvl}|${p.key}`); return !c || Date.now() - c.at > 30 * 60e3 || !(c.until >= hour); });
        W.error = '';
        if (missing.length) {
            W.loading = true; renderWindInfo();
            try { await fetchWind(missing, hour, lvl); } catch (err) { W.error = err instanceof TypeError ? t('mapErrNetwork') : err.message; }
            W.loading = false;
        }
        if (id !== W.seq) return;
        W.hour = hour;
        W.group.clearLayers();
        const key = new Date(hour).toISOString().slice(0, 13);
        const R_ = state.flightRules || {};
        const toUnit = WIND_TO_MS[state.windUnit] || 1;
        pts.forEach(p => {
            const c = W.cache.get(`${lvl}|${p.key}`);
            if (!c) return;
            const i = c.hourly.time.findIndex(x => x.slice(0, 13) === key);
            const ms = i < 0 ? null : (c.hourly[`wind_speed_${lvl}`] || [])[i], dir = i < 0 ? null : (c.hourly[`wind_direction_${lvl}`] || [])[i];
            if (!Number.isFinite(ms) || !Number.isFinite(dir)) return;
            // Up to 120 m by the wind limits, higher by the wind-aloft limits.
            const [good, bad] = lvl === '10m' || lvl === '120m' ? [R_.windGood, R_.windBad] : [R_.aloftGood ?? R_.windGood, R_.aloftBad ?? R_.windBad];
            const color = ms >= bad ? FLIGHT_STATUS.bad.color : ms >= good ? FLIGHT_STATUS.marginal.color : FLIGHT_STATUS.good.color;
            const shown = ms / toUnit;
            const html = `<svg width="24" height="24" viewBox="0 0 24 24" style="transform: rotate(${(dir + 180) % 360}deg)"><path d="M12 2 L17.5 11 H13.6 V22 H10.4 V11 H6.5 Z" fill="${color}" stroke="#020617" stroke-width="1.2" stroke-linejoin="round"/></svg><span>${shown < 10 ? shown.toFixed(1) : Math.round(shown)}</span>`;
            L.marker(p.at || [p.lat, p.lon], { pane: 'wind', interactive: false, keyboard: false, icon: L.divIcon({ className: 'fs-wind', html, iconSize: [40, 36], iconAnchor: p.at ? [-14, 46] : [20, 12] }) }).addTo(W.group);
        });
        renderWindInfo();
    }

    function renderWindInfo() {
        const el = $('mapWindInfo');
        if (!el) return;
        if (!S.wind.on) { el.textContent = ''; return; }
        el.innerHTML = W.loading ? `<i class="fa-solid fa-circle-notch fa-spin text-cyan-400"></i> ${h(t('mapProbeLoading'))}`
            : W.error ? `<span class="text-rose-300">${h(t('mapWindErr', { msg: W.error }))}</span>`
            : W.hour ? h(`${t('mapWindAt', { time: fmtTime(W.hour) })} · ${UNIT_LABELS.wind[state.windUnit]}`) : '';
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

    // 5 / 10 / 25 km around the forecast location; rings too small to read
    // at this zoom are left out, labels need a bit more room.
    function updateRings() {
        if (!R.map) return;
        if (!R.ringsLayer) R.ringsLayer = L.layerGroup().addTo(R.map);
        R.ringsLayer.clearLayers();
        const loc = state.location;
        if (!S.rings || !loc) return;
        const mPerPx = 40075016.686 * Math.cos(loc.latitude * Math.PI / 180) / (256 * 2 ** R.map.getZoom());
        RINGS_KM.forEach(km => {
            const px = km * 1000 / mPerPx;
            if (px < 10) return;
            L.circle([loc.latitude, loc.longitude], { radius: km * 1000, pane: 'rings', color: '#f8fafc', weight: 1.25, opacity: 0.7, dashArray: '4 5', fill: false, interactive: false }).addTo(R.ringsLayer);
            if (px < 28) return;
            L.marker([loc.latitude + km / 111.32, loc.longitude], {
                pane: 'rings', interactive: false, keyboard: false,
                icon: L.divIcon({ className: 'fs-ring-label', html: `${km} km`, iconSize: [40, 12], iconAnchor: [20, 14] })
            }).addTo(R.ringsLayer);
        });
    }

    // Favourite locations as stars (names from zoom 6); a tap makes one the
    // forecast location.
    function updateFavorites() {
        if (!R.map) return;
        if (!R.favLayer) R.favLayer = L.layerGroup().addTo(R.map);
        R.favLayer.clearLayers();
        if (!S.favs) return;
        const current = state.location ? locationKey(state.location) : '';
        const named = R.map.getZoom() >= 6;
        (state.favorites || []).forEach(f => {
            if (locationKey(f) === current) return;
            L.marker([f.latitude, f.longitude], {
                pane: 'loc', keyboard: true, title: f.name, alt: f.name,
                icon: L.divIcon({ className: 'fs-fav', html: `<i class="fa-solid fa-star"></i>${named ? `<span>${h(f.name)}</span>` : ''}`, iconSize: null, iconAnchor: [6, 7] })
            }).on('click', () => {
                selectLocation({ ...f });
                showToast(t('mapFavSelected', { name: f.name }), 'success');
            }).addTo(R.favLayer);
        });
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
        if (typeof setSettingsDrawer === 'function') setSettingsDrawer(false);
    }

    function stopDrawing() {
        R.drawing = null;
        R.map.dragging.enable();
        R.map.getContainer().style.cursor = '';
        $('mapDrawHint').classList.add('hidden');
    }

    const seg = (name, items, current) => `<div class="seg" role="group">${items.map(([v, label]) =>
        `<button type="button" data-map-${name}="${v}" class="${String(v) === String(current) ? 'active' : ''}">${label}</button>`).join('')}</div>`;
    const sectionTitle = (icon, key) => `<h3 class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2"><i class="fa-solid ${icon} mr-1.5"></i>${h(t(key))}</h3>`;

    // Satellite name + interval for a source layer (polished picker).
    function sourceLabel(l) {
        const ns = l.name.split(':')[0];
        const base = translations.en['mapSat_' + ns] ? t('mapSat_' + ns) : ns;
        return /enh/i.test(l.name) ? `${base} · ${t('mapEnhanced')}` : base;
    }

    function sourceSub(l) {
        const step = l.step || (R.times[l.name] && R.times[l.name].list.length > 1 ? Math.round((R.times[l.name].list.at(-1) - R.times[l.name].list.at(-2)) / 60000) : null);
        return [step ? t('mapEvery', { n: step }) : '', l.title || l.name].filter(Boolean).join(' · ');
    }

    function sourcePicker(group, list, current) {
        if (list.length < 2) return '';
        return `<div class="mt-2.5">
            <div class="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">${h(t('mapSourceTitle'))}</div>
            <div class="space-y-1" role="radiogroup">${list.map(l => {
                const on = current && l.name === current.name;
                return `<button type="button" role="radio" aria-checked="${on}" data-map-src="${h(group)}" data-value="${h(l.name)}" title="${h(l.name)}"
                    class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl border text-left transition ${on ? 'border-cyan-500/70 bg-cyan-950/40' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}">
                    <span class="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${on ? 'border-cyan-400' : 'border-slate-600'}">${on ? '<span class="w-2 h-2 rounded-full bg-cyan-400"></span>' : ''}</span>
                    <span class="flex-1 min-w-0"><span class="block text-[11.5px] ${on ? 'text-white' : 'text-slate-200'}">${h(sourceLabel(l))}</span><span class="block text-[10px] text-slate-500 truncate">${h(sourceSub(l))}</span></span>
                </button>`;
            }).join('')}</div></div>`;
    }

    const switchRow = (attr, on, icon, label, extra = '') => `<label class="flex items-center gap-2.5 cursor-pointer select-none">
        <input type="checkbox" class="sr-only" ${attr} ${on ? 'checked' : ''}><span class="fs-switch" aria-hidden="true"></span>
        ${icon ? `<i class="fa-solid ${icon} w-4 text-center ${on ? 'text-cyan-400' : 'text-slate-500'}"></i>` : ''}<span class="flex-1 text-[12px] text-slate-200">${h(label)}</span>${extra}</label>`;

    function renderPanel() {
        const root = $('drawerMap');
        if (!R.built || !root) return;
        const layer = activeLayer();
        const auto = S.product === 'auto';
        const autoOk = autoAvailable();
        const autoRow = `<button type="button" data-map-product="auto" ${autoOk ? '' : 'disabled'} class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left border transition ${auto ? 'border-cyan-500/70 bg-cyan-950/40 text-white' : 'border-transparent hover:bg-slate-800/70'} ${autoOk ? '' : 'opacity-40 cursor-not-allowed'}">
                <i class="fa-solid fa-circle-half-stroke w-4 text-center ${auto ? 'text-cyan-400' : 'text-slate-500'}"></i>
                <span class="flex-1 min-w-0"><span class="block truncate text-[12px]">${h(t('mapProduct_auto'))}</span>${auto ? `<span class="block text-[10px] text-slate-400 whitespace-normal leading-snug mt-0.5">${h(t('mapAutoDesc'))}</span>` : ''}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">${h(t('mapRole_auto'))}</span>
            </button>`;
        const productRows = autoRow + PRODUCTS.map(p => {
            const list = R.resolved[p.id] || [];
            const available = list.length > 0;
            const active = S.product === p.id;
            return `<button type="button" data-map-product="${p.id}" ${available ? '' : 'disabled'} class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left border transition ${active ? 'border-cyan-500/70 bg-cyan-950/40 text-white' : 'border-transparent hover:bg-slate-800/70'} ${available ? '' : 'opacity-40 cursor-not-allowed'}">
                <i class="fa-solid ${p.icon} w-4 text-center ${active ? 'text-cyan-400' : 'text-slate-500'}"></i>
                <span class="flex-1 min-w-0"><span class="block truncate text-[12px]">${h(t('mapProduct_' + p.id))}</span>${available ? '' : `<span class="block text-[10px] text-slate-500">${h(t('mapNotFound'))}</span>`}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">${h(t('mapRole_' + p.role))}</span>
            </button>`;
        }).join('') + `<button type="button" data-map-product="none" class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left border transition ${S.product === 'none' ? 'border-cyan-500/70 bg-cyan-950/40 text-white' : 'border-transparent hover:bg-slate-800/70'}">
                <i class="fa-solid fa-ban w-4 text-center text-slate-500"></i><span class="flex-1 text-[12px]">${h(t('mapProduct_none'))}</span></button>`;
        const sources = S.product !== 'none' && !auto ? (R.resolved[S.product] || []) : [];
        const styleSelect = layer && (layer.styles || []).length > 1 ? `<label class="block mt-2"><span class="block text-[10px] text-slate-500 mb-1">Style</span>
            <select data-map-style="${h(layer.name)}" class="unit-select w-full"><option value="">default</option>${layer.styles.map(st => `<option value="${h(st.name)}" ${styleOf(layer) === st.name ? 'selected' : ''}>${h(st.title || st.name)}</option>`).join('')}</select></label>` : '';
        const opacity = (key, value) => `<label class="flex items-center gap-2 mt-2.5"><span class="text-[10px] text-slate-500 w-20 shrink-0">${h(t('mapOpacity'))}</span>
            <input type="range" min="0.1" max="1" step="0.05" value="${value}" data-map-opacity="${key}" class="flex-1 accent-cyan-500"></label>`;

        const overlayBlocks = OVERLAYS.map(o => {
            const list = R.ovLayers[o.id] || [];
            const cfg = S.overlays[o.id];
            const lay = overlayLayer(o.id);
            if (!list.length) {
                return `<div class="flex items-center gap-2.5 opacity-50"><span class="fs-switch" aria-hidden="true"></span><i class="fa-solid ${o.icon} w-4 text-center text-slate-500"></i>
                    <span class="flex-1 text-[12px] text-slate-300">${h(t('mapOv_' + o.id))}</span><span class="text-[10px] text-slate-500">${h(R.catalogStatus === 'loading' ? t('mapProbeLoading') : t('mapOvNone'))}</span></div>`;
            }
            const kind = o.id === 'precip' ? t('mapPrecipKind') : t('mapOvKind_' + o.id);
            const legend = lay ? legendUrl(lay) : '';
            return `<div>
                ${switchRow(`data-map-ov="${o.id}"`, cfg.on, o.icon, t('mapOv_' + o.id))}
                ${cfg.on ? `<div class="pl-[3.6rem] mt-1.5">
                    <p class="text-[10.5px] leading-snug text-slate-500">${h(kind)}</p>
                    ${sourcePicker(o.id, list, lay)}
                    ${opacity(o.id, cfg.opacity)}
                    ${lay && !covers(lay.bbox, regionBbox()) ? `<p class="text-[10px] text-amber-300 mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${h(t('mapPrecipPartial'))}</p>` : ''}
                    <p id="mapOvInfo_${o.id}" class="text-[10.5px] text-slate-400 mt-1.5"></p>
                    ${legend ? `<img src="${h(legend)}" alt="" class="mt-2 max-w-full rounded bg-white/90 p-1" loading="lazy" onerror="this.remove()">` : ''}
                </div>` : ''}
            </div>`;
        }).join('');
        const windBlock = `<div>
            ${switchRow('data-map-wind', S.wind.on, 'fa-wind', t('mapOv_wind'))}
            ${S.wind.on ? `<div class="pl-[3.6rem] mt-1.5 space-y-1.5">
                ${seg('windlevel', Object.keys(WIND_LEVELS).map(k => [k, h(t('rtLevel_' + k))]), S.wind.level)}
                <p class="text-[10.5px] leading-snug text-slate-500">${h(t('mapWindKind'))}</p>
                <p id="mapWindInfo" class="text-[10.5px] text-slate-400"></p>
            </div>` : ''}
        </div>`;

        const hz = window.FlySkyHazard;
        const hazardBlock = `<div>
            ${switchRow('data-map-hazard', hazardEnabled(), 'fa-triangle-exclamation', t('mapHazardAlerts'))}
            <div class="pl-[3.6rem] mt-1.5">
                <p class="text-[10.5px] leading-snug text-slate-500">${h(t('mapHazardKind', { r: hz ? hz.alertKm : 50 }))}</p>
                ${hazardEnabled() && hz ? `<p id="mapHazardStatus" class="text-[10.5px] text-slate-400 mt-1">${h(hz.statusText())}</p>` : ''}
            </div>
        </div>`;

        const regions = regionOptions();
        root.innerHTML = `
            <section>${sectionTitle('fa-satellite', 'mapProductTitle')}
                <div class="space-y-1">${productRows}</div>
                ${sourcePicker(S.product, sources, layer)}${styleSelect}
                ${layer ? opacity('sat', S.opacity) : ''}
                ${auto && layer ? `<p class="text-[10.5px] text-slate-400 mt-2"><i class="fa-solid fa-circle-half-stroke mr-1 text-slate-500"></i>${h(t('mapAutoNow', { name: t('mapProduct_' + shownProduct()) }))}</p>` : ''}
                ${layer ? colourKeyHtml(layer) : ''}
                <p class="text-[10px] text-slate-500 mt-2"><i class="fa-solid fa-circle-info mr-1"></i>${h(t('mapDisclaimer'))}</p>
            </section>
            <section>${sectionTitle('fa-layer-group', 'mapOverlaysTitle')}
                <div class="space-y-3">${overlayBlocks}${windBlock}${hazardBlock}</div>
            </section>
            <section>${sectionTitle('fa-map', 'mapBaseTitle')}
                ${seg('basemap', [['osmDark', h(t('mapBase_osmDark'))], ['osm', h(t('mapBase_osm'))], ['none', h(t('mapBase_none'))]], S.basemap)}
                <div class="space-y-2.5 mt-3">
                    ${switchRow('data-map-labels', S.labels, 'fa-font', t('mapLabels'))}
                    ${R.borderLayers.length ? switchRow('data-map-borders', S.borders, 'fa-draw-polygon', t('mapBorders')) : ''}
                    ${switchRow('data-map-rings', S.rings, 'fa-bullseye', t('mapRings'))}
                    ${switchRow('data-map-favs', S.favs, 'fa-star', t('mapFavs'))}
                </div>
            </section>
            <section>${sectionTitle('fa-crop-simple', 'mapRegionTitle')}
                <select data-map-region class="unit-select w-full">${regions.map(r => `<option value="${h(r.id)}" ${r.id === S.region ? 'selected' : ''}>${h(r.label)}</option>`).join('')}</select>
                <div class="flex flex-wrap gap-1.5 mt-2">
                    <button type="button" data-map-draw class="chip py-1"><i class="fa-regular fa-square"></i> ${h(t('mapDraw'))}</button>
                    <button type="button" data-map-saveview class="chip py-1"><i class="fa-regular fa-bookmark"></i> ${h(t('mapSaveView'))}</button>
                    ${S.region.startsWith('saved:') ? `<button type="button" data-map-delregion class="chip py-1" title="${h(t('mapDeleteRegion'))}" aria-label="${h(t('mapDeleteRegion'))}"><i class="fa-regular fa-trash-can"></i></button>` : ''}
                </div>
                <form data-map-saveform class="hidden mt-2 flex gap-1.5"><input name="name" maxlength="40" placeholder="${h(t('mapSaveName'))}" class="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"><button class="chip py-1"><i class="fa-solid fa-check"></i></button></form>
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
        renderOverlayInfo();
        renderWindInfo();
    }

    // Colour key of the active product: EUMETSAT's interpretation for the
    // RGBs, the service's own legend image for quantitative layers (CTH).
    function colourKeyHtml(layer) {
        const product = shownProduct();
        const key = RGB_KEYS[product];
        let body = '';
        if (key) {
            const texts = t('mapKey_' + product);
            const swatch = c => {
                const bg = c === 'dots' ? 'radial-gradient(circle, #9be05a 24%, transparent 30%) 0 0 / 5px 5px, #a02700'
                    : Array.isArray(c) ? `linear-gradient(90deg, ${c[0]} 50%, ${c[1]} 50%)` : c;
                return `<span class="w-5 h-3.5 rounded-sm shrink-0 mt-px border border-white/10" style="background: ${bg}"></span>`;
            };
            body = `<ul class="space-y-1">${key.colors.map((c, i) => `<li class="flex items-start gap-2">${swatch(c)}<span>${h(texts[i] || '')}</span></li>`).join('')}</ul>
                ${translations.en['mapKey_' + product + '_note'] ? `<p class="mt-1.5 text-slate-400">${h(t('mapKey_' + product + '_note'))}</p>` : ''}
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

    // "Image: 21:30" for precipitation; "6 images · 21:00 – 21:30" for
    // stacked overlays.
    function renderOverlayInfo() {
        const f = timelineFrames()[R.index];
        OVERLAYS.forEach(o => {
            const el = $('mapOvInfo_' + o.id);
            if (!el) return;
            if (!activeOverlay(o.id)) { el.textContent = ''; return; }
            const frames = overlayFramesFor(o, f ? f.t : null);
            if (!frames.length) { el.textContent = (R.ovFrames[o.id] || []).length ? t('mapPrecipNoFrame') : ''; return; }
            el.textContent = frames.length === 1 ? t('mapOvImage', { time: fmtTime(frames[0].t) })
                : t('mapOvImages', { n: frames.length, from: fmtTime(frames[0].t), to: fmtTime(frames[frames.length - 1].t) });
        });
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
        renderBarVisibility();
    }

    // The time bar: hidden with the calculator open (a small pill keeps the
    // image time) and when nothing on the map has times (no satellite
    // product, no precipitation / lightning / fire layer).
    function renderBarVisibility() {
        const hasTimes = S.product !== 'none' || OVERLAYS.some(o => S.overlays[o.id].on);
        const hide = S.route.on || !hasTimes;
        $('mapBar').classList.toggle('hidden', hide);
        $('mapView').classList.toggle('fs-nobar', hide);
        renderTimePill();
    }

    // Image time and age; when an earlier image is shown, a tap goes to the latest.
    function renderTimePill() {
        const el = $('mapTimePill');
        if (!el) return;
        const tl = timelineFrames(), f = tl[R.index];
        const on = S.route.on && f && f.t !== null;
        el.classList.toggle('hidden', !on);
        if (!on) return;
        const latest = R.index === tl.length - 1;
        el.disabled = latest;
        el.title = latest ? t('mapImageTime') : t('mapLatest');
        el.innerHTML = `<i class="fa-regular fa-clock text-slate-400"></i><span class="truncate">${h(t('mapImageAge', { time: fmtClock(f.t), age: fmtAge(Date.now() - f.t) }))}</span>`
            + (latest ? '' : `<span class="shrink-0 font-semibold text-cyan-300"><i class="fa-solid fa-forward-fast mr-1"></i>${h(t('mapLatestShort'))}</span>`);
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
        const d = drivingOverlay();
        const name = activeLayer() ? (S.product === 'auto' ? `${t('mapRole_auto')}: ${t('mapProduct_' + (f.product || shownProduct()))}` : t('mapProduct_' + S.product)) : d ? t('mapOv_' + d.id) : '';
        el.textContent = `${f.t === null ? t('mapNow') : fmtTime(f.t)} · ${name}`;
        el.title = `${t('mapFrameOf', { i: R.index + 1, n: tl.length })}`;
        renderTimePill();
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
            const what = S.product === 'auto' && f.product ? ` · ${t('mapProduct_' + f.product)}` : '';
            return `<span class="flex-1" ${current ? 'data-current' : ''} style="background:${color};${mark}" title="${h(fmtTime(f.t) + what)}${e && e.error ? ' — ' + h(e.error) : ''}"></span>`;
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
        const pill = (cls, icon, text, action) => `<div class="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px] shadow-lg ${cls}"><i class="fa-solid ${icon}"></i><span class="flex-1">${h(text)}</span>${action || ''}</div>`;
        if (!navigator.onLine) notes.push(pill('bg-amber-950/90 border border-amber-800/60 text-amber-200', 'fa-wifi', t('mapOffline')));
        if (R.catalogStatus === 'loading') notes.push(pill('bg-slate-900/90 border border-slate-700 text-slate-300', 'fa-circle-notch fa-spin', t('mapLoadingCatalog')));
        if (R.catalogStatus === 'error') {
            // Without the list only the two published layer names can be tried.
            const none = !Object.values(R.resolved).some(l => l.length);
            notes.push(pill(none ? 'bg-rose-950/90 border border-rose-800/60 text-rose-200' : 'bg-amber-950/90 border border-amber-800/60 text-amber-200',
                'fa-triangle-exclamation', t('mapErrCatalog', { msg: R.catalogError })));
        }
        const layer = activeLayer();
        // The calculator keeps the crosshair clear: no product hints.
        if (layer && !S.route.on) {
            const info = R.times[layer.name];
            if (info && (info.noTime || !info.ok) && R.frames.length === 1) notes.push(pill('bg-slate-900/90 border border-slate-700 text-slate-300', 'fa-clock', t('mapNoTimes')));
            if (info && info.list.length) {
                const age = Date.now() - info.list[info.list.length - 1];
                if (age > 90 * 60e3) notes.push(pill('bg-amber-950/90 border border-amber-800/60 text-amber-200', 'fa-clock-rotate-left', t('mapStale', { age: fmtAge(age) })));
            }
            if (!covers(layer.bbox, regionBbox())) notes.push(pill('bg-amber-950/90 border border-amber-800/60 text-amber-200', 'fa-crop', t('mapPartial')));
            // Only when the product doesn't suit the time of day (a daytime
            // RGB at night or the night RGB by day); day & night products never.
            const sun = sunState();
            const role = (PRODUCTS.find(p => p.id === S.product) || {}).role;   // none for "Auto"
            const recommended = sun === 'night' && role === 'day' ? ['fog'] : sun === 'day' && role === 'night' ? ['dayMicro', 'natural'] : null;
            if (recommended) {
                const target = recommended.find(id => (R.resolved[id] || []).length);
                if (target) notes.push(pill('bg-indigo-950/90 border border-indigo-800/60 text-indigo-100', sun === 'night' ? 'fa-moon' : 'fa-sun',
                    t(sun === 'night' ? 'mapNight' : 'mapDay'),
                    `<button type="button" data-map-product="${target}" class="px-2 py-0.5 rounded-md bg-indigo-500/30 hover:bg-indigo-500/50 font-semibold">${h(t('mapUse'))}</button>`));
            } else if (sun === 'twilight' && (role === 'day' || role === 'night')) {
                notes.push(pill('bg-slate-900/90 border border-slate-700 text-slate-300', 'fa-circle-half-stroke', t('mapTwilight')));
            }
        }
        if (W.forecastHour !== null) {
            notes.push(pill('bg-cyan-950/90 border border-cyan-800/60 text-cyan-100', 'fa-wind', t('mapWindForecast', { time: fmtTime(W.forecastHour) }),
                `<button type="button" data-map-windclear class="w-6 h-6 -mr-1.5 rounded-md hover:bg-cyan-500/30" title="${h(t('mapWindForecastClear'))}" aria-label="${h(t('mapWindForecastClear'))}"><i class="fa-solid fa-xmark"></i></button>`));
        }
        // Nearby lightning / rain first: it matters most. A tap folds the
        // chips into icons in the button column (and back); with the
        // calculator open they start as icons.
        const hz = window.FlySkyHazard && hazardEnabled() ? window.FlySkyHazard : null;
        const folded = S.route.on ? !RT.hazardOpen : S.hazardMin;
        const hazards = hz && !folded ? hz.chipsHtml('map', { showable: id => { const o = S.overlays[id === 'rain' ? 'precip' : id]; return !!o && !o.on; } }) : '';
        $('mapHazardIcons').innerHTML = hz && folded ? hz.chipsHtml('icon') : '';
        el.innerHTML = hazards + notes.join('');
        fitSide();
    }

    function renderAllMapUi() {
        if (!R.built) return;
        $('mapPanelBtnLabel').textContent = t('mapProduct_' + S.product);
        $('mapPanelBtnBadges').innerHTML = activeOverlays().map(o => `<i class="fa-solid ${o.icon} text-cyan-300"></i>`).join('') + (S.wind.on ? '<i class="fa-solid fa-wind text-cyan-300"></i>' : '');
        $('mapPanelBtn').title = t('mapSettingsTitle');
        renderPanel();
        renderControls();
        renderStatus();
        renderProbe();
        renderRoute();
    }

    function setupUiEvents() {
        $('mapPanelBtn').addEventListener('click', () => { if (typeof setSettingsDrawer === 'function') setSettingsDrawer(true); });
        $('mapProbeBtn').addEventListener('click', () => { S.probe = !S.probe; save(); renderProbe(); scheduleProbe(0); });
        $('mapCenterBtn').addEventListener('click', () => centerOnLocation(true));
        $('mapFullBtn').addEventListener('click', toggleFullscreen);
        $('mapRouteBtn').addEventListener('click', () => setRouteOn(!S.route.on));
        $('mapTimePill').addEventListener('click', () => { const n = timelineFrames().length; if (n) { clearForecastHour(); showFrame(n - 1); } });
        document.addEventListener('fullscreenchange', renderFullBtn);
        document.addEventListener('webkitfullscreenchange', renderFullBtn);
        const view = $('mapView');
        // Map controls live both on the map and in the side menu.
        [view, $('drawerMap')].filter(Boolean).forEach(root => bindUi(root));
        document.addEventListener('keydown', e => {
            if (!R.visible || e.target.closest('input, select, textarea, button, a')) return;
            if (!$('settingsDrawer').classList.contains('-translate-x-full')) return;
            if (e.key === 'Escape' && R.drawing) stopDrawing();
            else if (e.key === ' ') { e.preventDefault(); clearForecastHour(); play(!R.playing); }
            else if (e.key === 'ArrowLeft') step(-1);
            else if (e.key === 'ArrowRight') step(1);
        });
        window.addEventListener('online', () => { renderStatus(); reloadFrames(); });
        window.addEventListener('offline', renderStatus);
    }

    function bindUi(view) {
        view.addEventListener('click', e => {
            const q = sel => e.target.closest(sel);
            let el;
            if ((el = q('[data-map-product]')) && !el.disabled) {
                S.product = el.dataset.mapProduct; S.productAt = Date.now(); save();
                play(false); renderAllMapUi(); reloadFrames();
            } else if ((el = q('[data-map-src]'))) {
                S.sources[el.dataset.mapSrc] = el.dataset.value; save(); renderAllMapUi(); reloadFrames();
            } else if ((el = q('[data-map-windlevel]'))) {
                setWindLevel(el.dataset.mapWindlevel);
            } else if ((el = q('[data-map-basemap]'))) setBasemap(el.dataset.mapBasemap);
            else if ((el = q('[data-map-window]'))) { S.windowH = Number(el.dataset.mapWindow); save(); renderPanel(); reloadFrames(); }
            else if ((el = q('[data-map-utc]'))) { S.utc = el.dataset.mapUtc === '1'; save(); renderPanel(); renderTimeLabel(); renderProgress(); }
            else if (q('[data-map-play]')) { clearForecastHour(); play(!R.playing); }
            else if (q('[data-map-prev]')) step(-1);
            else if (q('[data-map-next]')) step(1);
            else if (q('[data-map-latest]')) { clearForecastHour(); play(false); showFrame(timelineFrames().length - 1); }
            else if (q('[data-map-windclear]')) clearForecastHour();
            else if (q('[data-route-close]')) setRouteOn(false);
            else if (q('[data-route-clear]')) { RT.a = R.map.getCenter(); RT.pts = []; RT.edit = null; RT.editMsg = ''; renderRoute(); routeChanged(false); }
            else if (q('[data-route-start]')) { RT.a = R.map.getCenter(); routeChanged(); }
            else if (q('[data-route-mode]')) setRouteMode(q('[data-route-mode]').dataset.routeMode);
            else if (q('[data-route-edit]')) { RT.edit = q('[data-route-edit]').dataset.routeEdit; RT.editMsg = ''; renderRouteRow(); renderRouteResult(); }
            else if (q('[data-route-editcancel]')) { RT.edit = null; RT.editMsg = ''; renderRouteRow(); renderRouteResult(); }
            else if (q('[data-route-swap]')) {
                // Aiming, the map goes to the old A (now B).
                const rev = routeLine().reverse();
                if (rev.length > 1) { RT.a = rev[0]; RT.pts = rev.slice(1); if (RT.follow) R.map.panTo(rev[rev.length - 1]); routeChanged(); }
            }
            else if (q('[data-hazard-show]')) showHazard(q('[data-hazard-show]').dataset.hazardShow);
            else if (q('[data-hazard]')) { if (S.route.on) RT.hazardOpen = !RT.hazardOpen; else { S.hazardMin = !S.hazardMin; save(); } renderStatus(); }
            else if (q('[data-map-draw]')) startDrawing();
            else if (q('[data-map-saveview]')) { const f = $('drawerMap').querySelector('[data-map-saveform]'); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.elements.name.focus(); }
            else if (q('[data-map-delregion]')) {
                const i = Number(S.region.slice(6));
                savedRegions.splice(i, 1);
                saveToStorage(MAP_CONFIG.regionsKey, savedRegions);
                S.region = 'custom'; save(); renderPanel();
            } else if (q('[data-map-diag]')) { S.diagOpen = !S.diagOpen; save(); renderPanel(); }
            else if (q('[data-map-key]')) { S.keyOpen = !S.keyOpen; save(); renderPanel(); }
            else if (q('[data-map-probemin]')) { S.probeOpen = !S.probeOpen; save(); renderProbe(); }
            else if (q('[data-map-goforecast]')) setLocationHere();
            else if (q('[data-map-recatalog]')) loadCatalog(true);
        });
        view.addEventListener('change', e => {
            const el = e.target;
            if (el.matches('[data-map-source]')) {
                S.sources[el.dataset.mapSource] = el.value; save(); renderAllMapUi(); reloadFrames();
            } else if (el.matches('[data-map-style]')) {
                S.sources[`${el.dataset.mapStyle}#style`] = el.value; save(); reloadFrames();
            } else if (el.matches('[data-map-ov]')) {
                S.overlays[el.dataset.mapOv].on = el.checked; save(); renderAllMapUi(); reloadFrames();
            } else if (el.matches('[data-map-wind]')) {
                S.wind.on = el.checked; save(); renderAllMapUi(); updateWind();
            } else if (el.matches('[data-map-labels]')) {
                S.labels = el.checked; save(); renderPanel(); updatePlaces();
            } else if (el.matches('[data-map-borders]')) {
                S.borders = el.checked; save(); renderPanel(); updateBorders();
            } else if (el.matches('[data-map-rings]')) {
                S.rings = el.checked; save(); renderPanel(); updateRings();
            } else if (el.matches('[data-map-favs]')) {
                S.favs = el.checked; save(); renderPanel(); updateFavorites();
            } else if (el.matches('[data-map-hazard]')) {
                setHazardEnabled(el.checked); renderPanel(); renderStatus();
            } else if (el.matches('[data-map-region]')) {
                selectRegion(el.value);
            } else if (el.matches('[data-route-level]')) {
                setWindLevel(el.value);
            } else if (el.matches('[data-route-depart]')) {
                S.route.depart = Number(el.value); save(); renderRouteResult();
            } else if (el.matches('[data-map-speed]')) {
                S.speed = Number(el.value); save();
            }
        });
        view.addEventListener('input', e => {
            const el = e.target;
            if (el.id === 'mapSlider') { clearForecastHour(); play(false); showFrame(Number(el.value)); }
            else if (el.matches('[data-route-speed]')) { S.route.airspeed = Number(el.value); save(); renderRouteResult(); }
            else if (el.matches('[data-map-opacity]')) {
                const v = Number(el.value);
                const id = el.dataset.mapOpacity;
                if (id === 'sat') { S.opacity = v; S.opacitySet = true; if (R.overlay) R.overlay.setOpacity(v); }
                else { S.overlays[id].opacity = v; S.overlays[id].opacitySet = true; (R.ovShown[id] || new Map()).forEach(ov => ov.setOpacity(v)); }
                save();
            }
        });
        view.addEventListener('submit', e => {
            const mg = e.target.closest('[data-route-mgrs]');
            if (mg) { e.preventDefault(); routeFromMgrs(RT.edit, mg.elements.mgrs.value); return; }
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
    }

    // ================= Point readout (crosshair) =================
    // Values under the crosshair (= map centre) for the frame on screen,
    // read with WMS GetFeatureInfo:
    //  - RGB products only return the displayed colour, which is matched to
    //    EUMETSAT's colour key (CIE Lab distance) and shown as "likely";
    //  - MTG precipitation (h40b) returns the actual rain rate + quality;
    //  - plus the Open-Meteo model forecast at the same point and hour.
    const P = { timer: null, seq: 0, controller: null, gfi: new Map(), model: new Map(), area: new Map(), result: null, loading: false };
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
        if (!key || key.noMatch) return null;
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

    // The models of the forecast's Models mode at a point (hourly, UTC), in
    // one request, cached 15 min: { ids, per: { id: hourly }, merged } where
    // `merged` holds the median across the models (wind direction: the
    // average direction).
    const MODEL_VARS = ['cloud_cover_low', 'visibility', 'precipitation', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
    function readoutModels() {
        return ((state.modelsByMode && state.modelsByMode.deterministic) || []).slice();
    }

    function readoutModelName(id) {
        const m = (MODES.deterministic.models || []).find(x => x.id === id);
        return m ? m.name : id;
    }

    async function modelAt(ll, signal) {
        const ids = readoutModels();
        // On a 0.05° grid (~4–6 km; the models' own grids are 2–25 km): one
        // request per cell, so panning nearby reuses it (Open-Meteo counts
        // every model of every request).
        const lat = (Math.round(ll.lat * 20) / 20).toFixed(2), lon = (Math.round(ll.lng * 20) / 20).toFixed(2);
        const key = `${lat},${lon},${state.precipUnit},${state.windUnit},${ids.join('+')}`;
        const hit = P.model.get(key);
        if (hit && Date.now() - hit.at < 15 * 60e3) return hit.data;
        const url = buildWmsUrl(MAP_CONFIG.openMeteo, {
            latitude: lat, longitude: lon, hourly: MODEL_VARS.join(','), models: ids.length ? ids.join(',') : undefined,
            past_days: 1, forecast_days: 2, timezone: 'GMT', precipitation_unit: state.precipUnit === 'inch' ? 'inch' : undefined,
            wind_speed_unit: state.windUnit && state.windUnit !== 'ms' ? state.windUnit : undefined
        }, []);
        const res = await fetch(url, { signal });
        const body = await res.json();
        if (!res.ok || body.error) throw new Error(body.reason || `HTTP ${res.status}`);
        const data = splitModels(body.hourly, ids);
        if (P.model.size >= 40) P.model.delete(P.model.keys().next().value);
        P.model.set(key, { at: Date.now(), data });
        return data;
    }

    // One response with several models has one column per variable and
    // model ("precipitation_icon_seamless"); one model has plain names.
    function splitModels(hourly, ids) {
        const per = {};
        if (ids.length <= 1) per[ids[0] || 'best_match'] = hourly;
        else {
            const vars = MODEL_VARS.slice().sort((a, b) => b.length - a.length);
            Object.keys(hourly).forEach(k => {
                const v = vars.find(x => k.startsWith(x + '_'));
                if (!v) return;
                const sfx = k.slice(v.length + 1);
                const id = ids.find(m => m === sfx) || ids.find(m => m.startsWith(sfx + '_') || sfx.startsWith(m + '_'));
                if (!id) return;
                (per[id] || (per[id] = { time: hourly.time }))[v] = hourly[k];
            });
        }
        const list = Object.values(per);
        const merged = { time: hourly.time };
        const med = vals => { const v = vals.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
        MODEL_VARS.forEach(v => {
            merged[v] = hourly.time.map((_, i) => {
                const vals = list.map(hr => (hr[v] ? hr[v][i] : null));
                if (v !== 'wind_direction_10m') return med(vals);
                const ok = vals.filter(Number.isFinite);
                if (!ok.length) return null;
                const x = ok.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0), y = ok.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
                return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
            });
        });
        return { ids: Object.keys(per), per, merged };
    }

    // Rain around a point in a small precipitation image (34 × 34 px, about
    // 1 km per pixel): distance of the nearest rain within 17 km, or null.
    async function rainAround(name, tm, ll, signal) {
        const key = `${name}|${tm}|${ll.lat.toFixed(3)},${ll.lng.toFixed(3)}`;
        if (P.area.has(key)) return P.area.get(key);
        const n = 34;
        const p = L.CRS.EPSG3857.project(ll), half = 17000 / Math.cos(ll.lat * Math.PI / 180);
        const url = buildWmsUrl(MAP_CONFIG.wmsBase, {
            SERVICE: 'WMS', VERSION: MAP_CONFIG.version, REQUEST: 'GetMap', LAYERS: name, STYLES: '', CRS: MAP_CONFIG.crs,
            BBOX: [p.x - half, p.y - half, p.x + half, p.y + half].map(Math.round).join(','), WIDTH: n, HEIGHT: n,
            FORMAT: MAP_CONFIG.overlayFormat, TRANSPARENT: 'TRUE', EXCEPTIONS: 'XML', TIME: new Date(tm).toISOString().replace('.000Z', 'Z')
        });
        const res = await fetch(url, { signal, credentials: 'omit' });
        if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) throw new Error(`HTTP ${res.status}`);
        const img = await createImageBitmap(await res.blob());
        const c = document.createElement('canvas');
        c.width = n; c.height = n;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, n, n);
        const d = g.getImageData(0, 0, n, n).data;
        let nearest = null;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            if (d[(y * n + x) * 4 + 3] < 80) continue;
            const km = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) * (2 * 17 / n);
            if (km <= 17 && (nearest === null || km < nearest)) nearest = km;
        }
        const out = { nearest };
        if (P.area.size > 200) P.area.clear();
        P.area.set(key, out);
        return out;
    }

    // ---- Satellite vs models
    // Colour-key entries that mean fog / low cloud, or no cloud (land, sea),
    // per product; only close colour matches count. Cloud Mask is exact.
    const LOW_CLOUD_KEYS = { fog: [1, 2], dayMicro: [0, 1], natural: [0], cloudType: [0], cloudPhase: [0, 1] };
    const CLEAR_KEYS = { fog: [0], dayMicro: [6, 7], natural: [4, 5, 7], cloudType: [7], cloudPhase: [7, 8, 9], clm: [1, 2] };

    // 'low' | 'clear' | null from the satellite pixel under the crosshair.
    function satCloudState(res) {
        const p = res.sat && res.sat.status === 'fulfilled' ? res.sat.value : null;
        if (!p || !res.product) return null;
        const rgb = ['RED_BAND', 'GREEN_BAND', 'BLUE_BAND'].map(k => p[k]);
        if (!rgb.every(Number.isFinite)) return null;
        const key = RGB_KEYS[res.product];
        if (!key || key.noMatch) return null;
        // Night-only / day-only RGBs say nothing at the wrong time of day.
        const role = (PRODUCTS.find(x => x.id === res.product) || {}).role;
        const alt = sunAltitudeDeg(res.tm ?? Date.now(), res.ll.lat, res.ll.lng);
        if ((role === 'night' && alt > -3) || (role === 'day' && alt < 6)) return null;
        let i;
        if (key.exact) i = key.colors.findIndex(c => hexRgb(c).every((v, k) => Math.abs(v - rgb[k]) <= 12));
        else {
            const m = matchKey(res.product, rgb);
            if (!m || m[0].d > MATCH_CLOSE) return null;
            i = m[0].i;
        }
        if ((LOW_CLOUD_KEYS[res.product] || []).includes(i)) return 'low';
        if ((CLEAR_KEYS[res.product] || []).includes(i)) return 'clear';
        return null;
    }

    // 'wet' (rain within 10 km, or a rain rate at the point) | 'dry' (none
    // within 15 km) | null.
    function satRainState(res) {
        const r = res.rain && res.rain.status === 'fulfilled' && res.rain.value && res.rain.value.props;
        const rate = r ? (r.Instantaneous_rain_rate ?? r.instantaneous_rain_rate ?? r.rain_rate) : null;
        if (Number.isFinite(rate) && rate > 0) return 'wet';
        const a = res.area && res.area.status === 'fulfilled' ? res.area.value : null;
        if (!a) return null;
        if (a.nearest !== null && a.nearest <= 10) return 'wet';
        if (a.nearest === null || a.nearest > 15) return 'dry';
        return null;
    }

    // Each model against the satellite, an hour either side of the image:
    // [{ check, sat, agree: [names], disagree: [{ name, note }] }].
    function compareModels(res) {
        const m = res.model && res.model.status === 'fulfilled' ? res.model.value : null;
        if (!m || !m.ids.length) return [];
        const target = new Date(Math.round((res.tm ?? Date.now()) / 3600e3) * 3600e3).toISOString().slice(0, 13);
        const inch = state.precipUnit === 'inch';
        const mm = v => (inch ? v * 25.4 : v);
        const fmtP = v => `${v.toLocaleString(currentLang, { maximumFractionDigits: inch ? 2 : 1, minimumFractionDigits: inch ? 2 : 1 })} ${inch ? 'in' : 'mm'}`;
        const out = [];
        const around = (hr, v) => {
            const i = hr.time.findIndex(x => x.slice(0, 13) === target);
            if (i < 0 || !hr[v]) return null;
            const vals = [hr[v][i - 1], hr[v][i], hr[v][i + 1]].filter(Number.isFinite);
            return vals.length ? { now: hr[v][i], min: Math.min(...vals), max: Math.max(...vals) } : null;
        };
        const run = (check, sat, judge) => {
            if (!sat) return;
            const row = { check, sat, agree: [], disagree: [] };
            m.ids.forEach(id => {
                const verdict = judge(m.per[id]);
                if (!verdict) return;
                if (verdict.ok) row.agree.push(readoutModelName(id));
                else row.disagree.push({ name: readoutModelName(id), note: verdict.note });
            });
            if (row.agree.length || row.disagree.length) out.push(row);
        };
        run('rain', satRainState(res), hr => {
            const p = around(hr, 'precipitation');
            if (!p) return null;
            if (satRainState(res) === 'wet') return mm(p.max) >= 0.1 ? { ok: true } : { ok: false, note: t('mapVsDry') };
            if (mm(p.max) < 0.1) return { ok: true };
            return Number.isFinite(p.now) && mm(p.now) >= 1 ? { ok: false, note: fmtP(p.now) } : null;
        });
        run('cloud', satCloudState(res), hr => {
            const c = around(hr, 'cloud_cover_low');
            if (!c) return null;
            const note = t('mapVsLowPct', { v: Math.round(c.now ?? c.max) });
            if (satCloudState(res) === 'low') return c.max >= 60 ? { ok: true } : c.max < 30 ? { ok: false, note } : null;
            return c.min <= 30 ? { ok: true } : c.min >= 70 ? { ok: false, note } : null;
        });
        return out;
    }

    function precipTimeFor(name, tm) {
        const info = R.times[name];
        if (!info || !info.list.length) return null;
        if (tm === null || tm === undefined) return info.list[info.list.length - 1];
        let best = null;
        info.list.forEach(v => { if (v <= tm + 5 * 60e3 && tm - v <= 30 * 60e3 && (best === null || Math.abs(v - tm) < Math.abs(best - tm))) best = v; });
        return best;
    }

    // Nearest lightning / fire mark within SCAN_KM of a point, read from the
    // overlay images already on the map (no extra requests). Needs readable
    // pixels, i.e. images fetched with CORS (the normal case).
    const imgCache = new WeakMap();
    function pixelsOf(entry) {
        if (imgCache.has(entry)) return imgCache.get(entry);
        const p = new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = entry.url; });
        imgCache.set(entry, p);
        return p;
    }

    async function scanNearest(o, ll) {
        const want = R.ovWant[o.id];
        const ext = R.extent;
        if (!want || !want.size || !ext) return null;
        if (R.requestMode !== 'fetch') throw new Error(t('mapErrNetwork'));
        const frames = (R.ovFrames[o.id] || []).filter(f => want.has(f.key));
        const pt = L.CRS.EPSG3857.project(ll);
        const [x0, y0, x1, y1] = ext.bbox3857;
        const px = (pt.x - x0) / (x1 - x0) * ext.w, py = (y1 - pt.y) / (y1 - y0) * ext.h;
        const kmPerPx = (x1 - x0) / ext.w * Math.cos(ll.lat * Math.PI / 180) / 1000;
        const r = Math.ceil(SCAN_KM / kmPerPx);
        const sx0 = Math.max(0, Math.floor(px - r)), sy0 = Math.max(0, Math.floor(py - r));
        const sw = Math.min(ext.w, Math.ceil(px + r)) - sx0, sh = Math.min(ext.h, Math.ceil(py + r)) - sy0;
        if (sw <= 0 || sh <= 0) return { none: true };
        const canvas = document.createElement('canvas');
        canvas.width = sw; canvas.height = sh;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        let best = null;
        for (const f of frames) {
            const e = cache.get(f.key);
            if (!e || e.status !== 'ok') continue;
            const img = await pixelsOf(e);
            const kx = img.naturalWidth / ext.w, ky = img.naturalHeight / ext.h;
            g.clearRect(0, 0, sw, sh);
            g.drawImage(img, sx0 * kx, sy0 * ky, sw * kx, sh * ky, 0, 0, sw, sh);
            const d = g.getImageData(0, 0, sw, sh).data;
            for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
                if (d[(y * sw + x) * 4 + 3] < 80) continue;
                const dx = sx0 + x + 0.5 - px, dy = sy0 + y + 0.5 - py;
                const km = Math.hypot(dx, dy) * kmPerPx;
                if (km <= SCAN_KM && (!best || km < best.km - 0.5 || (Math.abs(km - best.km) <= 0.5 && f.t > best.t))) best = { km, dx, dy, t: f.t };
            }
        }
        if (!best) return { none: true };
        const deg = (Math.atan2(best.dx, -best.dy) * 180 / Math.PI + 360) % 360;
        return { ...best, dir: Math.round(deg / 45) % 8 };
    }

    function scheduleProbe(delay = 350) {
        clearTimeout(P.timer);
        if (!R.built || !R.visible || !S.probe || S.route.on) return;
        P.timer = setTimeout(runProbe, delay);
    }

    async function runProbe() {
        if (!S.probe || !R.visible) return;
        if (R.playing) { P.result = { playing: true }; renderProbe(); return; }
        const { ll } = probePoint();
        // Satellite reads on a ~1 km grid (its pixels are 1–5 km): small
        // moves reuse what was read.
        const q = L.latLng(Math.round(ll.lat * 100) / 100, Math.round(ll.lng * 100) / 100);
        const frame = timelineFrames()[R.index];
        const tm = frame ? frame.t : null;
        const layer = activeLayer();
        const product = shownProduct();
        const rainLayer = R.precipLayers.find(l => l.name === 'mtg_fd:h40b') || R.precipLayers[0] || null;
        try { P.controller && P.controller.abort(); } catch (err) {}
        const controller = new AbortController();
        P.controller = controller;
        const id = ++P.seq;
        P.loading = true;
        renderProbe();
        const sat = layer ? featureInfo(layer.name, tm, q, controller.signal) : Promise.resolve(undefined);
        const rain = rainLayer ? refreshTimes(rainLayer.name).then(() => {
            const pt = precipTimeFor(rainLayer.name, tm);
            return pt === null ? null : featureInfo(rainLayer.name, pt, q, controller.signal).then(props => ({ props, t: pt }));
        }) : Promise.resolve(undefined);
        const model = navigator.onLine ? modelAt(ll, controller.signal) : Promise.reject(new Error(t('mapOffline')));
        // Rain around the point, for the satellite-vs-models check.
        const area = rainLayer && R.requestMode === 'fetch' ? refreshTimes(rainLayer.name).then(() => {
            const pt = precipTimeFor(rainLayer.name, tm);
            return pt === null ? null : rainAround(rainLayer.name, pt, q, controller.signal);
        }) : Promise.resolve(null);
        const scans = ['lightning', 'fire'].map(id => (activeOverlay(id) ? scanNearest(OVERLAYS.find(o => o.id === id), ll) : Promise.resolve(undefined)));
        const [s, r, m, lt, fi, ar] = await Promise.allSettled([sat, rain, model, ...scans, area]);
        if (id !== P.seq) return;
        P.loading = false;
        P.result = { ll, tm, layer, product, rainLayer, sat: s, rain: r, model: m, lightning: lt, fire: fi, area: ar };
        renderProbe();
    }

    function renderProbeHeader() {
        const el = $('mapProbeCoord');
        if (!el || !R.map) return;
        const { ll, name } = probePoint();
        el.textContent = name && name !== fmtCoord(ll) ? `${name} · ${fmtCoord(ll)}` : fmtCoord(ll);
        // Nothing to set while the crosshair is on the forecast location.
        const btn = $('mapProbe').querySelector('[data-map-goforecast]');
        if (btn) btn.classList.toggle('hidden', !!name);
    }

    function renderProbe() {
        if (!R.built) return;
        // The flight time tool takes the place of the readout while open.
        const on = !!S.probe && !S.route.on;
        // The tool measures from / to the crosshair: it stays visible.
        $('mapCrosshair').classList.toggle('hidden', !on && !S.route.on);
        const btn = $('mapProbeBtn');
        btn.classList.toggle('!bg-cyan-500', !!S.probe);
        btn.title = t('mapProbeToggle'); btn.setAttribute('aria-label', btn.title); btn.setAttribute('aria-pressed', S.probe ? 'true' : 'false');
        const cbtn = $('mapCenterBtn');
        cbtn.title = t('mapCenterLoc'); cbtn.setAttribute('aria-label', cbtn.title);
        cbtn.classList.toggle('hidden', !state.location);
        renderFullBtn();
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
                        const key = RGB_KEYS[res.product];
                        const m = matchKey(res.product, rgb);
                        const texts = t('mapKey_' + res.product);
                        if (key && key.noMatch) html = sw + h(t('mapProbePixel'));
                        else if (key && key.exact) {
                            const i = key.colors.findIndex(c => hexRgb(c).every((v, k) => Math.abs(v - rgb[k]) <= 12));
                            html = sw + (i >= 0 ? `<span class="text-slate-100">${h(t('mapProbeClass', { label: texts[i] }))}</span>` : h(t('mapProbeNoData')));
                        } else if (!m) html = sw + h(t('mapProbeNoKey'));
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
            // Nearest lightning / fire (from the overlay images)
            [['lightning', 'fa-bolt', 'mapProbeLightning'], ['fire', 'fa-fire', 'mapProbeFire']].forEach(([id, icon, label]) => {
                const v = res[id];
                if (!v || (v.status === 'fulfilled' && v.value === undefined)) return;
                let html;
                if (v.status === 'rejected') html = errText(v.reason);
                else if (!v.value) html = h(t('mapProbeLoading'));
                else if (v.value.none) html = h(t('mapProbeNoneWithin', { r: SCAN_KM }));
                else html = `<span class="font-semibold ${id === 'fire' ? 'text-orange-300' : 'text-yellow-200'}">${h(t('mapProbeNearest', { d: Math.max(1, Math.round(v.value.km)), dir: t('mapCompass')[v.value.dir], time: fmtTime(v.value.t) }))}</span>`;
                rows += row(icon, t(label), html);
            });
            // Model forecast for the same hour
            let windHtml = '';
            {
                let html;
                if (res.model.status === 'rejected') html = errText(res.model.reason);
                else {
                    const hr = res.model.value.merged;
                    const target = new Date(Math.round((res.tm ?? Date.now()) / 3600e3) * 3600e3).toISOString().slice(0, 13);
                    const i = hr.time.findIndex(x => x.slice(0, 13) === target);
                    if (i < 0) html = h(t('mapProbeNoData'));
                    else {
                        const num = (v, d) => (Number.isFinite(v) ? v.toLocaleString(currentLang, { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
                        html = `<span class="text-slate-100">${h(t('mapProbeModelValues', {
                            c: num(hr.cloud_cover_low[i], 0), v: num(hr.visibility[i] / 1000, 1),
                            p: num(hr.precipitation[i], state.precipUnit === 'inch' ? 2 : 1), u: state.precipUnit === 'inch' ? 'in' : 'mm'
                        }))}</span> <span class="text-slate-500">· ${h(fmtTime(Date.parse(hr.time[i] + 'Z')))}</span>`;
                        if (hr.wind_speed_10m && Number.isFinite(hr.wind_speed_10m[i])) {
                            const d = Math.round(hr.wind_direction_10m[i] / 45) % 8;
                            const digits = state.windUnit === 'kmh' || state.windUnit === 'mph' ? 0 : 1;
                            windHtml = `<span class="text-slate-100">${h(t('mapProbeWindValue', { dir: t('mapCompass')[d], w: num(hr.wind_speed_10m[i], digits), g: num(hr.wind_gusts_10m[i], digits), u: UNIT_LABELS.wind[state.windUnit] }))}</span>`;
                        }
                    }
                }
                const nModels = res.model.status === 'fulfilled' ? res.model.value.ids.length : 0;
                rows += row('fa-chart-area', nModels > 1 ? t('mapProbeModelsN', { n: nModels }) : t('mapProbeModel'), html);
                if (windHtml) rows += row('fa-wind', t('mapProbeWind'), windHtml);
                // Satellite vs each model: shown where a check could be made.
                compareModels(res).forEach(c => {
                    const satText = t(c.check === 'rain' ? (c.sat === 'wet' ? 'mapVsRainWet' : 'mapVsRainDry') : (c.sat === 'low' ? 'mapVsLow' : 'mapVsClear'));
                    const agree = c.agree.length ? `<span class="text-emerald-300"><i class="fa-solid fa-check mr-0.5"></i>${h(c.disagree.length ? c.agree.join(', ') : t('mapVsAll', { n: c.agree.length }))}</span>` : '';
                    const dis = c.disagree.length ? `<span class="text-amber-300 font-semibold"><i class="fa-solid fa-xmark mr-0.5"></i>${h(c.disagree.map(d => `${d.name} (${d.note})`).join(', '))}</span>` : '';
                    rows += row(c.check === 'rain' ? 'fa-scale-balanced' : 'fa-scale-balanced', t(c.check === 'rain' ? 'mapVsRain' : 'mapVsCloud'),
                        `<span class="text-slate-300">${h(satText)}</span> <span class="text-slate-500">·</span> ${[agree, dis].filter(Boolean).join(' <span class="text-slate-500">·</span> ')}`);
                });
            }
        }
        card.innerHTML = `
            <div class="flex items-center gap-2 px-3 py-1.5">
                <i class="fa-solid fa-crosshairs text-cyan-400"></i>
                <span id="mapProbeCoord" class="font-mono text-slate-100 truncate"></span>
                ${P.loading ? '<i class="fa-solid fa-circle-notch fa-spin text-cyan-400"></i>' : ''}
                <span class="flex-1"></span>
                <button type="button" data-map-goforecast class="shrink-0 px-2 py-0.5 rounded-md bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-200 font-semibold"><i class="fa-solid fa-location-dot mr-1"></i>${h(t('mapGoForecast'))}</button>
                <button type="button" data-map-probemin class="shrink-0 w-6 h-6 rounded-md text-slate-400 hover:text-white hover:bg-slate-800" title="${h(t('mapProbeCollapse'))}" aria-label="${h(t('mapProbeCollapse'))}" aria-expanded="${S.probeOpen}"><i class="fa-solid fa-chevron-down text-[10px] transition-transform" style="${S.probeOpen ? '' : 'transform: rotate(180deg)'}"></i></button>
            </div>
            ${S.probeOpen && rows ? `<div id="mapProbeRows" class="px-3 pb-2 space-y-1 leading-snug">${rows}</div>` : ''}`;
        renderProbeHeader();
        fitSide();
    }

    // The notes / readout column scrolls (and takes touches) only when it
    // is taller than its room above the timeline; otherwise touches between
    // its cards reach the map.
    function fitSide() {
        const el = $('mapSide');
        if (el) el.classList.toggle('fs-scroll', el.scrollHeight > el.clientHeight + 1);
    }

    function renderFullBtn() {
        const btn = $('mapFullBtn');
        if (!btn) return;
        const full = isFullscreen();
        btn.classList.toggle('hidden', !fullscreenSupported());
        btn.innerHTML = `<i class="fa-solid ${full ? 'fa-compress' : 'fa-expand'}"></i>`;
        btn.title = t(full ? 'fullscreenOff' : 'fullscreenOn');
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', full ? 'true' : 'false');
    }

    // Makes the point under the crosshair the forecast location (staying
    // on the map).
    function setLocationHere() {
        const { ll: c, name } = probePoint();
        if (name) return;   // already the forecast location
        const round = v => Math.round(v * 1e4) / 1e4;
        selectLocation({ name: fmtCoord(c), latitude: round(c.lat), longitude: round(c.lng) });
        showToast(t('mapFavSelected', { name: fmtCoord(c) }), 'success');
        renderProbeHeader();
    }

    // ================= Flight time calculator =================
    // An optional tool. Opening it puts the start A at the crosshair. Two
    // modes: Aim — B is the crosshair, so panning measures live (zooming
    // keeps the crosshair in place, a tap takes the crosshair there); Tap —
    // a tap sets B and the map pans and zooms freely around the route. A
    // and B can also be pasted as MGRS (several for B: waypoints … B), and
    // dragged. Airspeed 18–30 m/s and the forecast wind along the route at a
    // chosen height (Open-Meteo, sampled about every 15 km on a 0.1° grid)
    // give the flight time, ETA and the way back. Each part of the route
    // uses the wind of the hour the drone gets there, with the wind triangle
    // (heading into the crosswind, then ground speed).
    const ROUTE_DEPART = [0, 1, 2, 3, 6];
    const RT = { group: null, casing: null, line: null, label: null, markers: [], tagHtml: '', tagShown: '', a: null, pts: [], follow: true,
        edit: null, editMsg: '', hazardOpen: false, wind: new Map(), seq: 0, loading: false, error: '', raf: 0, windTimer: null };

    // ---- MGRS (military grid reference) ⇄ latitude / longitude, WGS84 / UTM.
    const MGRS = (() => {
        const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
        const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
        const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
        const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
        const ROWS = 'ABCDEFGHJKLMNPQRSTUV';
        const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
        const M = phi => a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
            + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
        function zoneOf(lat, lon) {
            let z = Math.floor((lon + 180) / 6) + 1;
            if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
            if (lat >= 72 && lat < 84) {
                if (lon >= 0 && lon < 9) z = 31; else if (lon >= 9 && lon < 21) z = 33; else if (lon >= 21 && lon < 33) z = 35; else if (lon >= 33 && lon < 42) z = 37;
            }
            return Math.min(60, Math.max(1, z));
        }
        function toUtm(lat, lon, zone = zoneOf(lat, lon)) {
            const phi = rad(lat), lam = rad(lon), lam0 = rad((zone - 1) * 6 - 180 + 3);
            const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
            const e = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
            let n = k0 * (M(phi) + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
            if (lat < 0) n += 10000000;
            return { zone, e, n };
        }
        function fromUtm(zone, e, n, south) {
            const x = e - 500000, y = south ? n - 10000000 : n;
            const mu = y / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
            const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
            const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
                + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
            const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2), T1 = Math.tan(phi1) ** 2, C1 = ep2 * Math.cos(phi1) ** 2;
            const R1 = a * (1 - e2) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5, D = x / (N1 * k0);
            const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
                + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
            const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
            return { lat: deg(lat), lon: (zone - 1) * 6 - 180 + 3 + deg(lon) };
        }
        // "36U VU 12345 67890" (1 m) from latitude / longitude.
        function forward(lat, lon, digits = 5) {
            if (lat < -80 || lat > 84) return null;
            const { zone, e, n } = toUtm(lat, lon);
            const band = BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
            const set = (zone - 1) % 3, even = zone % 2 === 0;
            const col = COLS[set][Math.floor(e / 100000) - 1];
            const row = ROWS[(Math.floor(n / 100000) + (even ? 5 : 0)) % 20];
            const div = 10 ** (5 - digits);
            const pad = v => String(Math.floor((v % 100000) / div)).padStart(digits, '0');
            return `${zone}${band} ${col}${row} ${pad(e)} ${pad(n)}`;
        }
        // One reference → { lat, lon } (the centre of its square), or null.
        function parse(text) {
            const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/.exec(String(text).toUpperCase().replace(/\s+/g, ''));
            if (!m || m[5].length % 2 || m[5].length > 10) return null;
            const zone = +m[1];
            if (zone < 1 || zone > 60) return null;
            const set = (zone - 1) % 3, even = zone % 2 === 0;
            const ci = COLS[set].indexOf(m[3]);
            let ri = ROWS.indexOf(m[4]) - (even ? 5 : 0);
            if (ci < 0) return null;
            ri = (ri + 20) % 20;
            const half = m[5].length / 2, unit = 10 ** (5 - half);
            const dE = half ? +m[5].slice(0, half) * unit : 0, dN = half ? +m[5].slice(half) * unit : 0;
            const e = (ci + 1) * 100000 + dE + unit / 2;
            let n = ri * 100000 + dN + unit / 2;
            // Lift the northing into the band (the letters repeat every 2000 km).
            const bandLat = -80 + BANDS.indexOf(m[2]) * 8, south = bandLat < 0;
            // Lowest northing of the band's southern edge: on the central
            // meridian in the north, at the zone's edge in the south.
            const cm = (zone - 1) * 6 - 180 + 3, edgeLat = Math.max(bandLat, -79.99);
            const minN = Math.min(toUtm(edgeLat, cm, zone).n, toUtm(edgeLat, cm - 3, zone).n);
            while (n < minN - 1e3) n += 2000000;
            const ll = fromUtm(zone, e, n, south);
            return Number.isFinite(ll.lat) && Number.isFinite(ll.lon) ? ll : null;
        }
        // Every reference in a pasted text, in order: { refs: [{ text, lat, lon }], bad: [text] }.
        function parseAll(text) {
            const chunks = String(text || '').toUpperCase()
                .replace(/\s+(?=\d{1,2}\s*[C-HJ-NP-X]\s*[A-HJ-NP-Z]\s*[A-HJ-NP-V])/g, '\n')
                .split(/[\n,;|]+/).map(x => x.trim()).filter(Boolean);
            const refs = [], bad = [];
            chunks.forEach(c => { const ll = parse(c); if (ll) refs.push({ text: c, ...ll }); else bad.push(c); });
            return { refs, bad };
        }
        return { forward, parse, parseAll };
    })();

    function setRouteOn(on) {
        S.route.on = !!on;
        save();
        RT.edit = null; RT.hazardOpen = false;
        if (on) { play(false); RT.a = R.map.getCenter(); RT.pts = []; RT.follow = S.route.mode === 'aim'; }
        renderBarVisibility();
        setRouteZoom();
        renderProbe();
        renderStatus();
        if (!on) scheduleProbe(0);
        renderRoute();
        updateRouteLayer();
        if (on) loadRouteWind();
    }

    // Aim: zooming (pinch, wheel, double tap) keeps the crosshair, so B
    // stays put. Otherwise zoom around the fingers / pointer as usual.
    function setRouteZoom() {
        const z = S.route.on && RT.follow ? 'center' : true;
        Object.assign(R.map.options, { touchZoom: z, scrollWheelZoom: z, doubleClickZoom: z });
    }

    // Aim ⇄ Tap. Aim takes the map to B so B stays where it was; Tap pins
    // B where the crosshair is.
    function setRouteMode(mode) {
        const aim = mode === 'aim';
        S.route.mode = aim ? 'aim' : 'tap';
        save();
        if (aim !== RT.follow) {
            if (aim) {
                const b = RT.pts[RT.pts.length - 1];
                RT.follow = true;
                if (b) R.map.panTo(b);
            } else {
                RT.pts = routeLine().slice(1);
                RT.follow = false;
            }
        }
        setRouteZoom();
        renderRoute();
        routeChanged();
    }

    // A, the waypoints and B; when aiming, B is the crosshair.
    function routeLine() {
        if (!RT.a) return [];
        const pts = RT.pts.slice();
        if (RT.follow) { if (pts.length) pts[pts.length - 1] = R.map.getCenter(); else pts.push(R.map.getCenter()); }
        return [RT.a, ...pts];
    }

    function routeChanged(fetchWind = true) {
        updateRouteLayer();
        renderRouteResult();
        if (fetchWind) loadRouteWind();
    }

    // Aim: a tap takes the crosshair (and B) there. Tap: a tap sets B.
    function routeTap(ll) {
        if (RT.follow) { R.map.panTo(ll); return; }
        if (RT.pts.length) RT.pts[RT.pts.length - 1] = ll;
        else RT.pts = [ll];
        routeChanged();
    }

    // While the map moves: B (when aiming), the label and the numbers follow.
    function routeMoved() {
        if (!RT.raf) {
            RT.raf = requestAnimationFrame(() => {
                RT.raf = 0;
                if (!S.route.on) return;
                if (RT.follow) {
                    const line = routeLine();
                    const mb = RT.markers[RT.markers.length - 1];
                    if (mb && line.length > 1) mb.setLatLng(line[line.length - 1]);
                    renderRouteResult();
                } else placeRouteLabel();
            });
        }
        if (RT.follow) { clearTimeout(RT.windTimer); RT.windTimer = setTimeout(loadRouteWind, 450); }
    }

    const toRad = d => d * Math.PI / 180;
    function distM(a, b) {
        const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
    }
    function courseDeg(a, b) {
        const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
        const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }
    function lineLength(line) {
        let d = 0;
        for (let i = 1; i < line.length; i++) d += distM(line[i - 1], line[i]);
        return d;
    }

    // Points along the route about every 15 km (at most 16), each with the
    // 0.1° grid cell its wind comes from.
    function routeSamples(line) {
        const total = lineLength(line);
        const step = Math.max(15000, total / 15);
        const out = [];
        const add = ll => out.push({ ll, key: `${ll.lat.toFixed(1)},${ll.lng.toFixed(1)}` });
        for (let i = 1; i < line.length; i++) {
            const a = line[i - 1], b = line[i];
            const n = Math.max(1, Math.ceil(distM(a, b) / step));
            for (let k = i === 1 ? 0 : 1; k <= n; k++) add(L.latLng(a.lat + (b.lat - a.lat) * k / n, a.lng + (b.lng - a.lng) * k / n));
        }
        return out;
    }

    // Forecast wind for the grid cells along the route (one request for the
    // missing ones).
    async function loadRouteWind() {
        const line = routeLine();
        if (!S.route.on || line.length < 2 || lineLength(line) < 50) { renderRouteResult(); return; }
        const lvl = WIND_LEVELS[S.wind.level];
        const cells = [...new Map(routeSamples(line).map(p => [p.key, p])).values()];
        const missing = cells.filter(p => { const c = RT.wind.get(`${lvl}|${p.key}`); return !c || Date.now() - c.at > 30 * 60e3; });
        const id = ++RT.seq;
        RT.error = '';
        if (missing.length) {
            RT.loading = true;
            renderRouteResult();
            try {
                const url = buildWmsUrl(MAP_CONFIG.openMeteo, {
                    latitude: missing.map(p => p.key.split(',')[0]).join(','), longitude: missing.map(p => p.key.split(',')[1]).join(','),
                    hourly: `wind_speed_${lvl},wind_direction_${lvl}`, forecast_days: 2, timezone: 'GMT', wind_speed_unit: 'ms'
                }, []);
                const res = await fetch(url);
                const body = await res.json();
                if (!res.ok || body.error) throw new Error(body.reason || `HTTP ${res.status}`);
                const list = Array.isArray(body) ? body : [body];
                missing.forEach((p, k) => { if (list[k] && list[k].hourly) RT.wind.set(`${lvl}|${p.key}`, { at: Date.now(), hourly: list[k].hourly }); });
                if (RT.wind.size > 400) [...RT.wind.keys()].slice(0, RT.wind.size - 400).forEach(k => RT.wind.delete(k));
            } catch (err) {
                if (id === RT.seq) RT.error = err instanceof TypeError ? t('mapErrNetwork') : err.message;
            }
            if (id === RT.seq) RT.loading = false;
        }
        if (id === RT.seq) renderRouteResult();
    }

    // Wind at a sample point for time `ms`, as the vector it blows towards
    // (east, north; m/s), or null.
    function windVector(p, ms, lvl) {
        const c = RT.wind.get(`${lvl}|${p.key}`);
        if (!c) return null;
        const key = new Date(Math.round(ms / 3600e3) * 3600e3).toISOString().slice(0, 13);
        const i = c.hourly.time.findIndex(x => x.slice(0, 13) === key);
        const sp = i < 0 ? null : (c.hourly[`wind_speed_${lvl}`] || [])[i], dir = i < 0 ? null : (c.hourly[`wind_direction_${lvl}`] || [])[i];
        if (!Number.isFinite(sp) || !Number.isFinite(dir)) return null;
        const to = toRad(dir + 180);
        return { u: sp * Math.sin(to), v: sp * Math.cos(to) };
    }

    // One way over the sample points, leaving at t0: { ms, dist, gs, along
    // (+ tailwind / − headwind, distance-weighted), cross (largest) },
    // { blocked } when the wind is too strong, { missing } without wind.
    function flyLeg(pts, V, t0, lvl) {
        let t = t0, dist = 0, alongSum = 0, cross = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const p = pts[i], q = pts[i + 1];
            const d = distM(p.ll, q.ll);
            if (d < 1) continue;
            const w1 = windVector(p, t, lvl), w2 = windVector(q, t, lvl);
            if (!w1 || !w2) return { missing: true };
            const u = (w1.u + w2.u) / 2, v = (w1.v + w2.v) / 2;
            const W = Math.hypot(u, v);
            const delta = Math.atan2(u, v) - toRad(courseDeg(p.ll, q.ll));
            const along = W * Math.cos(delta), cr = W * Math.sin(delta);
            if (Math.abs(cr) >= V) return { blocked: true };
            const gs = Math.sqrt(V * V - cr * cr) + along;
            if (gs < 1) return { blocked: true };
            t += d / gs * 1000;
            dist += d; alongSum += along * d; cross = Math.max(cross, Math.abs(cr));
        }
        const ms = t - t0;
        return { ms, dist, gs: ms ? dist / (ms / 1000) : V, along: dist ? alongSum / dist : 0, cross };
    }

    function fmtDuration(ms) {
        const m = Math.max(1, Math.round(ms / 60000));
        return m < 60 ? t('rtDurMin', { m }) : t('rtDurHourMin', { h: Math.floor(m / 60), m: m % 60 });
    }

    function fmtClock(ms) {
        const key = `${currentLang}|clock|${S.utc}`;
        let f = timeFormats.get(key);
        if (!f) { f = new Intl.DateTimeFormat(currentLang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: S.utc ? 'UTC' : undefined }); timeFormats.set(key, f); }
        return f.format(ms) + (S.utc ? ' UTC' : '');
    }

    const num1 = v => v.toLocaleString(currentLang, { maximumFractionDigits: 1, minimumFractionDigits: 1 });

    // Markers A, 1, 2 …, B (draggable; B not while aiming, so panning the
    // map never grabs it) and the line between them.
    const ROUTE_COLORS = { a: '#4ade80', b: '#f87171', via: '#e2e8f0' };
    function updateRouteLayer() {
        if (!R.map) return;
        if (!RT.group) RT.group = L.layerGroup();
        RT.group.clearLayers();
        RT.markers = [];
        RT.casing = RT.line = RT.label = null;
        if (!S.route.on || !RT.a) { if (R.map.hasLayer(RT.group)) R.map.removeLayer(RT.group); return; }
        if (!R.map.hasLayer(RT.group)) RT.group.addTo(R.map);
        const line = routeLine();
        line.forEach((ll, i) => {
            const last = i === line.length - 1 && i > 0;
            const letter = i === 0 ? 'A' : last ? 'B' : String(i);
            const color = i === 0 ? ROUTE_COLORS.a : last ? ROUTE_COLORS.b : ROUTE_COLORS.via;
            const aiming = last && RT.follow;
            const m = L.marker(ll, { pane: 'route', draggable: !aiming, interactive: !aiming, autoPan: true, keyboard: false, title: letter, zIndexOffset: 1000,
                icon: L.divIcon({ className: 'fs-route-pt', html: `<span style="background: ${color}${aiming ? '; opacity: 0.85' : ''}">${letter}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) });
            m.on('drag', () => { setRoutePoint(i, m.getLatLng()); renderRouteResult(); });
            m.on('dragend', () => { setRoutePoint(i, m.getLatLng()); renderRouteResult(); loadRouteWind(); });
            RT.markers.push(m.addTo(RT.group));
        });
        drawRouteLine();
    }

    function setRoutePoint(i, ll) {
        if (i === 0) RT.a = ll;
        else RT.pts[i - 1] = ll;
    }

    // The line through the markers and its tag (time, distance, ground speed).
    function drawRouteLine() {
        if (!RT.group || !R.map.hasLayer(RT.group)) return;
        const line = RT.markers.map(m => m.getLatLng());
        if (!RT.line) {
            RT.casing = L.polyline([], { pane: 'route', color: '#020617', weight: 5, opacity: 0.55, interactive: false }).addTo(RT.group);
            RT.line = L.polyline([], { pane: 'route', color: '#f8fafc', weight: 2.5, dashArray: '7 6', interactive: false }).addTo(RT.group);
        }
        RT.casing.setLatLngs(line.length > 1 ? line : []);
        RT.line.setLatLngs(line.length > 1 ? line : []);
        if (!RT.tagHtml || line.length < 2) {
            if (RT.label) { RT.group.removeLayer(RT.label); RT.label = null; }
            return;
        }
        if (!RT.label) {
            RT.label = L.marker(line[0], { pane: 'route', interactive: false, keyboard: false,
                icon: L.divIcon({ className: 'fs-route-tag-wrap', html: '<div class="fs-route-tag"></div>', iconSize: [0, 0] }) }).addTo(RT.group);
        }
        const tag = RT.label.getElement().firstElementChild;
        if (RT.tagShown !== RT.tagHtml || !tag.innerHTML) { tag.innerHTML = RT.tagHtml; RT.tagShown = RT.tagHtml; }
        placeRouteLabel();
    }

    // The part of the map not covered by the controls and panels (container px).
    function routeFreeRect() {
        const size = R.map.getSize();
        const top = R.map.getContainer().getBoundingClientRect().top;
        let b = size.y - 8;
        ['mapSide', 'mapBar'].forEach(id => {
            const el = $(id);
            const r = el && el.getBoundingClientRect();
            if (r && r.height && r.top - top - 6 < b) b = r.top - top - 6;
        });
        return { l: 8, t: 60, r: size.x - 56, b: Math.max(100, b) };
    }

    // The part [t0, t1] of segment p–q inside box (Liang–Barsky), or null.
    function clipSegment(p, q, box) {
        let t0 = 0, t1 = 1;
        const dx = q.x - p.x, dy = q.y - p.y;
        for (const [pp, qq] of [[-dx, p.x - box.l], [dx, box.r - p.x], [-dy, p.y - box.t], [dy, box.b - p.y]]) {
            if (pp === 0) { if (qq < 0) return null; continue; }
            const r = qq / pp;
            if (pp < 0) { if (r > t1) return null; t0 = Math.max(t0, r); } else { if (r < t0) return null; t1 = Math.min(t1, r); }
        }
        return t1 > t0 ? [t0, t1] : null;
    }

    // Controls and panels over the map (container px, with a margin).
    function routeObstacles() {
        const c = R.map.getContainer(), box = c.getBoundingClientRect();
        return [$('mapSide'), $('mapBar'), $('mapTools'), $('mapPanelBtn'), c.querySelector('.leaflet-control-zoom')]
            .filter(Boolean).map(el => el.getBoundingClientRect()).filter(r => r.width && r.height)
            .map(r => ({ l: r.left - box.left - 6, r: r.right - box.left + 6, t: r.top - box.top - 6, b: r.bottom - box.top + 6 }));
    }

    // The tag sits beside the middle of the part of the route on screen
    // (not under a panel), so it stays in view while any of the line is
    // (hidden when none is) and doesn't cover the line or its points.
    function placeRouteLabel() {
        if (!RT.label || !RT.label.getElement()) return;
        const wrap = RT.label.getElement(), tag = wrap.firstElementChild;
        const w = tag.offsetWidth / 2, hh = tag.offsetHeight / 2;
        const size = R.map.getSize(), view = { l: 4, t: 4, r: size.x - 4, b: size.y - 4 };
        const obstacles = routeObstacles();
        const pts = RT.markers.map(m => R.map.latLngToContainerPoint(m.getLatLng()));
        const pieces = [];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
            const p = pts[i - 1], q = pts[i], len = p.distanceTo(q);
            let spans = [clipSegment(p, q, view)].filter(Boolean);
            obstacles.forEach(o => {
                const cut = clipSegment(p, q, o);
                if (cut) spans = spans.flatMap(([a, b]) => [[a, Math.min(b, cut[0])], [Math.max(a, cut[1]), b]].filter(([x, y]) => y > x));
            });
            spans.forEach(([a, b]) => { pieces.push({ p, q, a, b, d: (b - a) * len }); total += (b - a) * len; });
        }
        if (!pieces.length || !total) { wrap.style.visibility = 'hidden'; return; }
        let half = total / 2, at = null, dir = null;
        for (const s of pieces) {
            if (half <= s.d || s === pieces[pieces.length - 1]) {
                dir = s.q.subtract(s.p); dir = dir.divideBy(dir.distanceTo(L.point(0, 0)) || 1);
                const t = s.a + (s.b - s.a) * Math.min(1, half / (s.d || 1));
                at = s.p.add(s.q.subtract(s.p).multiplyBy(t));
                break;
            }
            half -= s.d;
        }
        // Off the line: above it (right of it when near vertical), else the
        // other side, else on the line, whichever is clear of the panels.
        let n = L.point(-dir.y, dir.x);
        if (Math.abs(n.y) >= 0.3 ? n.y > 0 : n.x < 0) n = n.multiplyBy(-1);
        const off = n.multiplyBy(Math.abs(n.x) * w + Math.abs(n.y) * hh + 16);
        const clear = c => c.x - w >= view.l && c.x + w <= view.r && c.y - hh >= view.t && c.y + hh <= view.b
            && !obstacles.some(o => c.x - w < o.r && c.x + w > o.l && c.y - hh < o.b && c.y + hh > o.t);
        const spot = [at.add(off), at.subtract(off), at].find(clear) || at;
        RT.label.setLatLng(R.map.containerPointToLatLng(spot));
        wrap.style.visibility = '';
    }

    // Zoom that shows `p` with `c` at the centre (clear of the panels).
    function zoomToShow(c, p, max = 15) {
        const size = R.map.getSize(), f = routeFreeRect();
        const hx = Math.max(40, Math.min(size.x / 2 - f.l, f.r - size.x / 2)), hy = Math.max(40, Math.min(size.y / 2 - f.t, f.b - size.y / 2));
        const bounds = L.latLngBounds([c, p, L.latLng(2 * c.lat - p.lat, 2 * c.lng - p.lng)]);
        return Math.min(max, R.map.getBoundsZoom(bounds, false, L.point(size.x - 2 * hx + 40, size.y - 2 * hy + 40)));
    }
    // Zoom that shows A around the crosshair at `c` (B, when aiming).
    const aimZoom = c => zoomToShow(c, RT.a);

    // Pasted MGRS for A or B (several for B: waypoints … B). The map goes
    // there: aiming, B is the crosshair; otherwise it shows the route.
    function routeFromMgrs(which, text) {
        const { refs, bad } = MGRS.parseAll(text);
        if (!refs.length || bad.length) {
            RT.editMsg = bad.length ? t('rtMgrsBad', { text: bad[0] }) : t('rtMgrsNone');
            renderRouteResult();
            return;
        }
        const pts = refs.map(r => L.latLng(r.lat, r.lon));
        RT.edit = null; RT.editMsg = '';
        if (which === 'a') RT.a = pts[0];
        else {
            if (pts.length > 1 && RT.follow) { RT.follow = false; S.route.mode = 'tap'; save(); setRouteZoom(); }
            RT.pts = pts;
        }
        if (RT.follow) {
            const c = which === 'b' ? pts[0] : R.map.getCenter();
            R.map.setView(c, aimZoom(c));
        } else {
            const size = R.map.getSize(), f = routeFreeRect();
            R.map.fitBounds(L.latLngBounds([RT.a, ...RT.pts]), { paddingTopLeft: [f.l + 24, f.t + 24], paddingBottomRight: [size.x - f.r + 24, size.y - f.b + 24], maxZoom: 15 });
        }
        renderRoute();
        routeChanged();
    }

    function renderRoute() {
        const el = $('mapRoute');
        if (!el) return;
        const btn = $('mapRouteBtn');
        btn.classList.toggle('!bg-cyan-500', S.route.on);
        btn.title = t('rtTool'); btn.setAttribute('aria-label', btn.title); btn.setAttribute('aria-pressed', S.route.on ? 'true' : 'false');
        el.classList.toggle('hidden', !S.route.on);
        fitSide();
        if (!S.route.on) return;
        const iconBtn = (attr, icon, key) => `<button type="button" ${attr} class="shrink-0 w-7 h-7 rounded-md text-slate-400 hover:text-white hover:bg-slate-800" title="${h(t(key))}" aria-label="${h(t(key))}"><i class="fa-solid ${icon}"></i></button>`;
        const modeBtn = (mode, icon, key) => {
            const on = (mode === 'aim') === RT.follow;
            return `<button type="button" data-route-mode="${mode}" aria-pressed="${on}" title="${h(t(key + 'Tip'))}" class="flex items-center gap-1.5 px-2.5 py-1 rounded-md font-semibold transition ${on ? 'bg-cyan-500 text-slate-950' : 'text-slate-300 hover:text-white'}"><i class="fa-solid ${icon}"></i>${h(t(key))}</button>`;
        };
        const sel = 'unit-select !py-0.5 !text-[11px]';
        el.innerHTML = `
            <div class="flex items-center gap-0.5 pl-3 pr-1 pt-1">
                <i class="fa-solid fa-stopwatch text-cyan-400 mr-1.5"></i><div id="mapRouteHead" class="flex-1 min-w-0 truncate text-slate-100"></div>
                ${iconBtn('data-route-start', 'fa-location-crosshairs', 'rtStartHere')}${iconBtn('data-route-swap', 'fa-right-left', 'rtSwap')}${iconBtn('data-route-clear', 'fa-trash-can', 'rtClear')}${iconBtn('data-route-close', 'fa-xmark', 'rtClose')}
            </div>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-0.5">
                <div class="inline-flex p-0.5 rounded-lg bg-slate-950 border border-slate-700" role="group">${modeBtn('aim', 'fa-crosshairs', 'rtModeAim')}${modeBtn('tap', 'fa-hand-pointer', 'rtModeTap')}</div>
                <label class="ml-auto flex items-center gap-1 text-slate-400" title="${h(t('rtWindAt'))}"><i class="fa-solid fa-wind"></i>
                    <select data-route-level class="${sel}" aria-label="${h(t('rtWindAt'))}">${Object.keys(WIND_LEVELS).map(k => `<option value="${k}" ${k === S.wind.level ? 'selected' : ''}>${h(t('rtLevel_' + k))}</option>`).join('')}</select></label>
                <label class="flex items-center gap-1 text-slate-400" title="${h(t('rtDepart'))}"><i class="fa-regular fa-clock"></i>
                    <select data-route-depart class="${sel}" aria-label="${h(t('rtDepart'))}">${ROUTE_DEPART.map(n => `<option value="${n}" ${n === S.route.depart ? 'selected' : ''}>${h(n ? t('rtIn', { n }) : t('rtNow'))}</option>`).join('')}</select></label>
            </div>
            <div id="mapRouteRow" class="px-2 pt-2 pb-1.5"></div>
            <p id="mapRouteMsg" class="px-3 pb-2 -mt-0.5 text-[10.5px] text-slate-400 leading-snug empty:hidden"></p>`;
        renderRouteRow();
        renderRouteResult();
    }

    // A (MGRS) · airspeed · B (MGRS); tapping A or B opens a field to paste MGRS.
    function renderRouteRow() {
        const row = $('mapRouteRow');
        if (!row) return;
        const dot = which => `<span class="fs-route-dot" style="background: ${ROUTE_COLORS[which]}">${which.toUpperCase()}</span>`;
        if (RT.edit) {
            const line = routeLine();
            const ll = RT.edit === 'a' ? line[0] : line.length > 1 ? line[line.length - 1] : null;
            row.innerHTML = `<form data-route-mgrs class="flex items-center gap-1.5">${dot(RT.edit)}
                <input name="mgrs" value="${h(ll ? MGRS.forward(ll.lat, ll.lng) || '' : '')}" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="${h(t('rtMgrsPlaceholder'))}" aria-label="${h(t(RT.edit === 'a' ? 'rtEditA' : 'rtEditB'))}" class="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-slate-950 border border-cyan-600 font-mono text-[12px] text-slate-100 focus:outline-none">
                <button class="chip py-1 shrink-0">${h(t('rtMgrsGo'))}</button>
                <button type="button" data-route-editcancel class="shrink-0 w-7 h-7 rounded-md text-slate-400 hover:text-white hover:bg-slate-800" title="${h(t('rtMgrsCancel'))}" aria-label="${h(t('rtMgrsCancel'))}"><i class="fa-solid fa-xmark"></i></button></form>`;
            const input = row.querySelector('input');
            input.focus(); input.select();
            return;
        }
        const block = which => `<button type="button" data-route-edit="${which}" title="${h(t(which === 'a' ? 'rtEditA' : 'rtEditB'))}" class="min-w-0 text-left rounded-lg bg-slate-950/70 border border-slate-700 hover:border-cyan-600 px-2 py-1 transition">
                <span class="flex items-center gap-1 text-[10px] text-slate-400">${dot(which)}<span id="mapRouteZ_${which}" class="truncate font-mono"></span></span>
                <span id="mapRouteN_${which}" class="block font-mono text-[11.5px] text-slate-100 truncate"></span></button>`;
        row.innerHTML = `<div class="grid grid-cols-[1fr_1.1fr_1fr] gap-1.5">${block('a')}
            <label class="min-w-0 flex flex-col justify-center rounded-lg bg-slate-950/70 border border-slate-700 px-2 py-1" title="${h(t('rtAirspeed'))}">
                <span class="flex items-baseline justify-between gap-1"><span id="mapRouteSpeed" class="font-mono font-semibold text-[11.5px] text-slate-100"></span><span id="mapRouteKmh" class="text-[10px] text-slate-400"></span></span>
                <input type="range" min="18" max="30" step="1" value="${S.route.airspeed}" data-route-speed class="w-full h-4 accent-cyan-500" aria-label="${h(t('rtAirspeed'))}"></label>
            ${block('b')}</div>`;
    }

    function renderRouteResult() {
        const head = $('mapRouteHead');
        if (!head || !S.route.on) return;
        const V = S.route.airspeed;
        if ($('mapRouteSpeed')) { $('mapRouteSpeed').textContent = `${V} m/s`; $('mapRouteKmh').textContent = `${Math.round(V * 3.6)} km/h`; }
        const line = routeLine();
        [['a', line[0]], ['b', line.length > 1 ? line[line.length - 1] : null]].forEach(([which, ll]) => {
            const z = $('mapRouteZ_' + which), n = $('mapRouteN_' + which);
            if (!z) return;
            const p = ((ll && MGRS.forward(ll.lat, ll.lng)) || '').split(' ');
            z.textContent = p.length === 4 ? `${p[0]} ${p[1]}${which === 'b' && line.length > 2 ? ` · ${t('rtWaypoints', { n: line.length - 2 })}` : ''}` : '';
            n.textContent = p.length === 4 ? `${p[2]} ${p[3]}` : '—';
        });
        const dist = lineLength(line);
        let headHtml, msg = '', tag = '';
        if (line.length < 2 || dist < 50) {
            headHtml = `<span class="font-semibold">${h(t('rtTitle'))}</span>`;
            msg = h(t(RT.follow ? 'rtHintPan' : 'rtHintTap'));
        } else {
            const pts = routeSamples(line);
            const lvl = WIND_LEVELS[S.wind.level];
            const t0 = Date.now() + S.route.depart * 3600e3;
            const out = flyLeg(pts, V, t0, lvl);
            const km = `${num1(dist / 1000)} km`;
            if (out.missing) {
                const still = fmtDuration(dist / V * 1000);
                headHtml = `<span class="text-base font-semibold">≈ ${h(still)}</span> <span class="text-slate-400">${h(t('rtStill'))}</span>`;
                msg = RT.loading ? `<i class="fa-solid fa-circle-notch fa-spin text-cyan-400"></i> ${h(t('rtReading'))}` : `<span class="text-amber-300">${h(t('rtNoWind', { msg: RT.error || t('mapProbeNoData') }))}</span>`;
                tag = `<b>≈ ${h(still)}</b><span>${h(km)}</span>`;
            } else if (out.blocked) {
                headHtml = `<span class="font-semibold text-rose-300">${h(t('rtNoHeadway'))}</span>`;
                msg = `<span class="text-rose-300">${h(t('rtBlocked', { v: V }))}</span>`;
                tag = `<b class="bad">${h(t('rtNoHeadway'))}</b><span>${h(km)}</span>`;
            } else {
                const eta = t0 + out.ms;
                const back = flyLeg(pts.slice().reverse(), V, eta, lvl);
                const backOk = !back.missing && !back.blocked;
                const backTitle = backOk ? t('rtBack', { time: fmtDuration(back.ms), eta: fmtClock(eta + back.ms) }) : t(back.blocked ? 'rtBackBlocked' : 'rtBackNoWind');
                headHtml = `<span class="text-base font-semibold">${h(fmtDuration(out.ms))}</span> <span class="text-slate-300">· ${h(t('rtEta', { time: fmtClock(eta) }))}</span>`
                    + ` <span class="text-slate-400" title="${h(backTitle)}">· ${h(t('rtBackShort', { time: backOk ? fmtDuration(back.ms) : '—' }))}</span>`;
                tag = `<b><i class="fa-solid fa-stopwatch"></i>${h(fmtDuration(out.ms))}</b><span>${h(km)} · ${h(num1(out.gs))} m/s</span>`;
            }
        }
        head.innerHTML = headHtml;
        const m = $('mapRouteMsg');
        if (m) m.innerHTML = RT.editMsg ? `<span class="text-amber-300">${h(RT.editMsg)}</span>` : RT.edit ? h(t('rtMgrsNone')) : msg;
        RT.tagHtml = tag;
        drawRouteLine();
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
            updateFavorites();   // may have changed in the forecast view
            renderStatus();
            reloadFrames();
        }
        setTimeout(() => R.map && R.map.invalidateSize(), 50);
        clearInterval(R.refreshTimer);
        R.refreshTimer = setInterval(() => {
            if (document.visibilityState === 'visible' && R.visible) { reloadFrames({ forceTimes: true }); renderTimePill(); }
        }, MAP_CONFIG.autoRefreshMs);
    }

    function hide() {
        R.visible = false;
        play(false);
        clearInterval(R.refreshTimer);
        if (R.drawing) stopDrawing();
    }

    // Nearby-hazard alert changed (hazard.js): the chips and the status line.
    function onHazardChange() {
        if (!R.built) return;
        renderStatus();
        const st = $('mapHazardStatus');
        if (st && window.FlySkyHazard) st.textContent = window.FlySkyHazard.statusText();
    }

    // Measures every lightning / precipitation image already loaded again
    // (forecast location changed, or the alert started after they loaded).
    function replayHazard() {
        if (!R.built || !window.FlySkyHazard || R.requestMode !== 'fetch') return;
        R.ovMeta.forEach((m, key) => {
            const e = cache.get(key);
            if (e && e.status === 'ok' && e.url) window.FlySkyHazard.feed(m.id === 'precip' ? 'rain' : m.id, m.layer, m.t, e.url, m.ext.bbox3857, m.ext.w, m.ext.h);
        });
    }

    // Opens on the location with the overlay of that hazard switched on.
    function focusHazard(kindId) {
        if (!R.built) return;
        const id = kindId === 'rain' ? 'precip' : kindId;
        // On even before the layer list is in (it applies once it is).
        if (S.overlays[id] && !S.overlays[id].on) {
            S.overlays[id].on = true;
            save();
            renderAllMapUi();
            reloadFrames();
        }
        clearForecastHour();
        frameHazard(kindId, true);
    }

    // The location in the middle, zoomed out as far as needed to show the
    // alert's flash / rain too (never zoomed in past 10 for it).
    function frameHazard(kindId, always) {
        const loc = state.location, w = window.FlySkyHazard && window.FlySkyHazard.where(kindId);
        if (!loc || !w) { if (always) centerOnLocation(true); return; }
        R.centeredLoc = locKey();
        const c = L.latLng(loc.latitude, loc.longitude);
        const r = w.deg * Math.PI / 180, km = Math.max(w.km, 5) + 5;
        const p = L.latLng(c.lat + km / 111.32 * Math.cos(r), c.lng + km / (111.32 * Math.cos(c.lat * Math.PI / 180)) * Math.sin(r));
        if (!always) {
            // Already in view (clear of the panels): leave the map alone.
            const f = routeFreeRect(), q = [c, p].map(x => R.map.latLngToContainerPoint(x));
            if (q.every(x => x.x >= f.l && x.x <= f.r && x.y >= f.t && x.y <= f.b)) return;
        }
        R.anchor = c;
        R.map.setView(c, Math.max(4, zoomToShow(c, p, 10)), { animate: true });
    }

    // "Show" on an alert: its layer on, and the flash / rain in view.
    function showHazard(kindId) {
        const id = kindId === 'rain' ? 'precip' : kindId;
        if (S.overlays[id] && !S.overlays[id].on) {
            S.overlays[id].on = true;
            save();
            renderAllMapUi();
            reloadFrames();
        }
        frameHazard(kindId, false);
    }

    // Forecast hour picked in the forecast view (UTC ms). Satellite images
    // only exist up to now, so a later hour shows the latest image with the
    // forecast wind arrows for that hour.
    function showHour(ms) {
        if (!R.built) return;
        R.pendingHour = ms;
        W.forecastHour = ms > Date.now() ? Math.round(ms / 3600e3) * 3600e3 : null;
        updateWind();
        renderStatus();
        if (state.location && R.centeredLoc !== locKey()) centerOnLocation(false);
        if (timelineFrames().length) applyPendingHour();
    }

    function applyPendingHour() {
        const ms = R.pendingHour;
        R.pendingHour = null;
        const tl = timelineFrames();
        if (ms === null || !tl.length) return;
        let idx = tl.length - 1;
        const last = tl[idx].t;
        if (last !== null && ms < last) {
            tl.forEach((f, i) => { if (f.t !== null && Math.abs(f.t - ms) < Math.abs(tl[idx].t - ms)) idx = i; });
        }
        play(false);
        if (idx !== R.index) showFrame(idx);
    }

    function refresh() {
        if (!R.built) return;
        if (R.catalogStatus !== 'ok') loadCatalog(true);
        else reloadFrames({ forceTimes: true, newExtent: true });
    }

    function onLangChange() {
        if (!R.built) return;
        renderAllMapUi();
        updatePlaces();
    }

    function onLocationChange() {
        if (!R.built) return;
        updateLocationMarker();
        updateRings();
        updateFavorites();
        renderPanel();
        if (R.visible) centerOnLocation(true);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { if (R.visible) reloadFrames({ forceTimes: false }); return; }
        // To the background: stop playing (no downloads while unseen) and
        // free the images that aren't on screen.
        if (!R.built) return;
        if (R.playing) play(false);
        trimCache();
    });

    window.FlySkyMap = { show, hide, refresh, onLangChange, onLocationChange, onHazardChange, replayHazard, focusHazard, showHour, renderDrawer: () => renderPanel(),
        // exposed for tests / diagnostics
        _internals: { parseTimeDimension, parseCapabilities, buildWmsUrl, isoDurationMs, R, S, W, RT, MGRS, cache } };
})();
