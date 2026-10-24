// FlySky — nearby hazard alerts (lightning and rain near the forecast location)
//
// Loaded by index.html once the forecast is shown (only while the alerts are
// switched on). Shares the page's globals: t(), translations, currentLang,
// state, escapeHtml(), loadFromStorage(), setView(), loadMapAssets().
//
// How it works
//  - Data: EUMETSAT EUMETView WMS — MTG Lightning Imager accumulated flash
//    area, and MTG (or MSG) blended precipitation. Both are transparent where
//    there is nothing, so any opaque pixel is a flash / rain.
//  - Only the LATEST image of each product is requested: a small one
//    (96 × 96 px, ~160 km across) around the forecast location, every 5 min
//    while the app is open. Earlier images are never fetched for this.
//  - Movement: the distance of the nearest flash / rain is compared between
//    the images seen so far — the ones polled here over time, the
//    lightning / precipitation images the satellite map loads (map.js feeds
//    them in), and, while an alert is on, a small image here for each time
//    the map shows (so playing the map tracks it, from the selected image
//    forward, at any zoom and with the overlays off). Too few images →
//    "no motion yet"; distances that jump about (several cells) → "no clear
//    movement".
//
// Satellite rain is an estimate and lightning has a few minutes' latency;
// the alert is a heads-up, not a warning service.
(function () {
    'use strict';

    const HZ = {
        wms: 'https://view.eumetsat.int/geoserver/wms',
        // Per-layer "virtual service": its capabilities only describe that
        // layer (~7 KB instead of ~280 KB).
        layerWms: name => {
            const [ws, layer] = String(name).split(':');
            return `https://view.eumetsat.int/geoserver/${encodeURIComponent(ws)}/${encodeURIComponent(layer)}/wms`;
        },
        alertKm: 50,              // a chip when something is this close
        scanKm: 80,               // tracked this far out (for movement)
        size: 96,                 // px, the polled image (~1.7 km per pixel)
        minCoverKm: 15,           // map images: at least this much around the location
        maxScanPx: 600,           // larger areas are sampled down to this
        pollMs: 5 * 60e3,
        timesTtlMs: 4 * 60e3,
        keepMs: 90 * 60e3,
        lightningMs: 30 * 60e3,   // a flash keeps the alert on for 30 min
        maxAgeMs: 45 * 60e3,      // older images no longer alert
        motionMs: 45 * 60e3,
        minMotionSpanMs: 8 * 60e3,
        storageKey: 'flysky_hazard'
    };

    // Precipitation classes of the h40b style (mm/h, upper bounds), from its
    // legend: light < 2, moderate 2–10, heavy ≥ 10.
    const H40B = [['#ccffcc', 2], ['#99e699', 4], ['#66cc66', 7], ['#33b333', 10], ['#3399cc', 15], ['#3366ff', 20],
        ['#0000ff', 25], ['#6600cc', 30], ['#9933cc', 40], ['#cc0099', 50], ['#800080', Infinity]]
        .map(([hex, max]) => ({ rgb: [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)), max }));

    const KINDS = [
        { id: 'lightning', icon: 'fa-bolt', layers: ['mtg_fd:li_afa'],
          cls: 'bg-yellow-950/90 border-yellow-700/60 text-yellow-100', accent: 'text-yellow-300', iconCls: 'bg-yellow-300 text-slate-950' },
        { id: 'rain', icon: 'fa-cloud-showers-heavy', layers: ['mtg_fd:h40b', 'msg_fes:h60b'],
          cls: 'bg-sky-950/90 border-sky-700/60 text-sky-100', accent: 'text-sky-300', iconCls: 'bg-sky-400 text-slate-950' }
    ];

    // ================= Translations =================
    const HZ_I18N = {
        en: {
            hzLightning: 'Lightning',
            hzRain: 'Rain',
            hzRainTier_light: 'light rain',
            hzRainTier_moderate: 'moderate rain',
            hzRainTier_heavy: 'heavy rain',
            hzAt: '{d} km {dir}',
            hzOverhead: 'at the location',
            hzAgo: '{n} min ago',
            hzJustNow: 'just now',
            hzApproach: 'approaching ~{v} km/h · ETA ~{eta}',
            hzApproachSlow: 'approaching slowly',
            hzAway: 'moving away',
            hzSteady: 'not getting closer',
            hzNoMotion: 'no motion yet — play the map to track it',
            hzUnclear: 'no clear movement',
            hzMin: '{n} min',
            hzHourMin: '{h} h {m} min',
            hzCompass: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
            hzOpenMap: 'Show on the satellite map',
            hzCollapse: 'Tap to fold into an icon',
            hzExpand: 'tap to show',
            hzStatusIdle: 'Not checked yet.',
            hzStatusClear: 'Checked {time}: no lightning or rain within {r} km.',
            hzStatusAlert: 'Checked {time}.',
            hzStatusError: 'Check failed ({msg}).',
            hzStatusOffline: 'Offline — not checking.'
        },
        uk: {
            hzLightning: 'Блискавки',
            hzRain: 'Опади',
            hzRainTier_light: 'слабкий дощ',
            hzRainTier_moderate: 'помірний дощ',
            hzRainTier_heavy: 'сильний дощ',
            hzAt: '{d} км {dir}',
            hzOverhead: 'над локацією',
            hzAgo: '{n} хв тому',
            hzJustNow: 'щойно',
            hzApproach: 'наближається ~{v} км/год · за ~{eta}',
            hzApproachSlow: 'повільно наближається',
            hzAway: 'віддаляється',
            hzSteady: 'не наближається',
            hzNoMotion: 'руху ще не видно — відтворіть карту, щоб відстежити',
            hzUnclear: 'чіткого руху немає',
            hzMin: '{n} хв',
            hzHourMin: '{h} год {m} хв',
            hzCompass: ['Пн', 'ПнСх', 'Сх', 'ПдСх', 'Пд', 'ПдЗх', 'Зх', 'ПнЗх'],
            hzOpenMap: 'Показати на супутниковій карті',
            hzCollapse: 'Натисніть, щоб згорнути в значок',
            hzExpand: 'натисніть, щоб показати',
            hzStatusIdle: 'Ще не перевірено.',
            hzStatusClear: 'Перевірено {time}: блискавок і опадів у межах {r} км немає.',
            hzStatusAlert: 'Перевірено {time}.',
            hzStatusError: 'Не вдалося перевірити ({msg}).',
            hzStatusOffline: 'Офлайн — перевірка не виконується.'
        },
        'pt-BR': {
            hzLightning: 'Raios',
            hzRain: 'Chuva',
            hzRainTier_light: 'chuva fraca',
            hzRainTier_moderate: 'chuva moderada',
            hzRainTier_heavy: 'chuva forte',
            hzAt: '{d} km {dir}',
            hzOverhead: 'no local',
            hzAgo: 'há {n} min',
            hzJustNow: 'agora',
            hzApproach: 'aproximando-se ~{v} km/h · chega em ~{eta}',
            hzApproachSlow: 'aproximando-se devagar',
            hzAway: 'afastando-se',
            hzSteady: 'não está se aproximando',
            hzNoMotion: 'sem movimento ainda — reproduza o mapa para acompanhar',
            hzUnclear: 'sem movimento claro',
            hzMin: '{n} min',
            hzHourMin: '{h} h {m} min',
            hzCompass: ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'],
            hzOpenMap: 'Mostrar no mapa de satélite',
            hzCollapse: 'Toque para recolher em um ícone',
            hzExpand: 'toque para mostrar',
            hzStatusIdle: 'Ainda não verificado.',
            hzStatusClear: 'Verificado às {time}: sem raios nem chuva a até {r} km.',
            hzStatusAlert: 'Verificado às {time}.',
            hzStatusError: 'Falha na verificação ({msg}).',
            hzStatusOffline: 'Offline — sem verificação.'
        }
    };
    Object.keys(HZ_I18N).forEach(lang => {
        if (translations[lang]) Object.assign(translations[lang], HZ_I18N[lang]);
    });

    // ================= State =================
    const H = {
        on: true, started: false, polling: false, lastPoll: 0,
        locKey: '',
        layer: {},                // kind -> layer name in use
        times: {},                // layer -> { at, t }
        obs: { lightning: [], rain: [] },   // [{ t, layer, km|null, dir, tier }], oldest first
        status: null              // { at, error }
    };

    // ================= Helpers =================
    const h = escapeHtml;

    function locKey() {
        const l = state.location;
        return l ? `${l.latitude},${l.longitude}` : '';
    }

    // Web Mercator (EPSG:3857) metres.
    function project(lat, lon) {
        const R = 6378137;
        const la = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
        return { x: R * lon * Math.PI / 180, y: R * Math.log(Math.tan(Math.PI / 4 + la / 2)) };
    }

    function isoTime(ms) {
        return new Date(ms).toISOString().replace('.000Z', 'Z');
    }

    function clockTime(ms) {
        return new Intl.DateTimeFormat(currentLang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    }

    async function fetchWithTimeout(url, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { signal: controller.signal, credentials: 'omit', mode: 'cors' });
        } catch (err) {
            throw new Error(controller.signal.aborted ? 'timeout' : 'network');
        } finally {
            clearTimeout(timer);
        }
    }

    // Latest time step of a layer, from its own small capabilities document.
    async function latestTime(name) {
        const known = H.times[name];
        if (known && Date.now() - known.at < HZ.timesTtlMs) return known.t;
        const url = `${HZ.layerWms(name)}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`;
        const res = await fetchWithTimeout(url, 45000);
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const dim = [...doc.getElementsByTagNameNS('*', 'Dimension')].find(d => (d.getAttribute('name') || '').toLowerCase() === 'time');
        if (!dim) throw new Error(/ServiceException/i.test(text) ? 'layer not offered' : 'no time steps');
        // "start/end/PT5M" or a list of values: the latest is the last one.
        const last = dim.textContent.trim().split(',').pop().split('/');
        let tm = Date.parse(last.length > 1 ? last[1] : last[0]);
        if (!Number.isFinite(tm)) tm = Date.parse(dim.getAttribute('default') || '');
        if (!Number.isFinite(tm)) throw new Error('no time steps');
        const step = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec((last[2] || '').trim());
        H.times[name] = { at: Date.now(), t: tm, step: step ? ((Number(step[1] || 0) * 60) + Number(step[2] || 0)) * 60e3 : 0 };
        return tm;
    }

    // The latest image of the kind's first layer that the service offers.
    async function latestOf(kind) {
        const order = H.layer[kind.id] ? [H.layer[kind.id], ...kind.layers.filter(n => n !== H.layer[kind.id])] : kind.layers;
        let lastErr = null;
        for (const name of order) {
            try {
                const tm = await latestTime(name);
                if (H.layer[kind.id] && H.layer[kind.id] !== name) H.obs[kind.id] = [];   // another product: start over
                H.layer[kind.id] = name;
                return { name, t: tm };
            } catch (err) { lastErr = err; }
        }
        throw lastErr || new Error('not offered');
    }

    function boxAround(lat, lon) {
        const p = project(lat, lon);
        // Mercator stretches by 1 / cos(lat): a box ~2 × scanKm wide on the ground.
        const half = HZ.scanKm * 1000 / Math.cos(lat * Math.PI / 180) + 2000;
        return [p.x - half, p.y - half, p.x + half, p.y + half];
    }

    async function fetchImage(name, tm, bbox) {
        const params = new URLSearchParams({
            SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: name, STYLES: '', CRS: 'EPSG:3857',
            BBOX: bbox.map(v => Math.round(v)).join(','), WIDTH: HZ.size, HEIGHT: HZ.size,
            FORMAT: 'image/png; mode=8bit', TRANSPARENT: 'TRUE', EXCEPTIONS: 'XML', TIME: isoTime(tm)
        });
        const res = await fetchWithTimeout(`${HZ.wms}?${params}`, 45000);
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.startsWith('image/')) throw new Error(`HTTP ${res.status}`);
        return decodeBlob(await res.blob());
    }

    async function decodeBlob(blob) {
        if (window.createImageBitmap) return createImageBitmap(blob);
        const url = URL.createObjectURL(blob);
        try { return await loadImage(url); } finally { URL.revokeObjectURL(url); }
    }

    function loadImage(url) {
        return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('image')); img.src = url; });
    }

    // Nearest flash / rain pixel to the location within scanKm, from an image
    // of the EPSG:3857 box `bbox` drawn at w × h. A map image may cover less
    // than scanKm around the location (zoomed in, location off-centre): a
    // hit within the covered radius is still the true nearest, as anything
    // outside the image is further away; no hit there says nothing (null).
    function analyse(src, bbox, w, hgt, kindId, layerName) {
        const loc = state.location;
        const p = project(loc.latitude, loc.longitude);
        const [x0, y0, x1, y1] = bbox;
        const px = (p.x - x0) / (x1 - x0) * w, py = (y1 - p.y) / (y1 - y0) * hgt;
        const kmPerPx = (x1 - x0) / w * Math.cos(loc.latitude * Math.PI / 180) / 1000;
        const coverKm = Math.min(px, py, w - px, hgt - py) * kmPerPx;
        if (coverKm < HZ.minCoverKm) return null;
        const scanKm = Math.min(HZ.scanKm, coverKm);
        const r = scanKm / kmPerPx;
        const sx0 = Math.max(0, Math.floor(px - r)), sy0 = Math.max(0, Math.floor(py - r));
        const sw = Math.min(w, Math.ceil(px + r)) - sx0, sh = Math.min(hgt, Math.ceil(py + r)) - sy0;
        // Large areas (zoomed in) are sampled down; a flash or rain area is
        // then many pixels across, so nothing is lost.
        const k = Math.min(1, HZ.maxScanPx / Math.max(sw, sh));
        const cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        const srcW = src.naturalWidth || src.width, srcH = src.naturalHeight || src.height;
        const kx = srcW / w, ky = srcH / hgt;
        g.imageSmoothingEnabled = false;
        g.drawImage(src, sx0 * kx, sy0 * ky, sw * kx, sh * ky, 0, 0, cw, ch);
        const d = g.getImageData(0, 0, cw, ch).data;
        const tiers = kindId === 'rain' && /h40b/.test(layerName);
        const fx = sw / cw, fy = sh / ch;
        let best = null, maxMm = 0;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            const i = (y * cw + x) * 4;
            if (d[i + 3] < 80) continue;
            const dx = sx0 + (x + 0.5) * fx - px, dy = sy0 + (y + 0.5) * fy - py;
            const km = Math.hypot(dx, dy) * kmPerPx;
            if (km > scanKm) continue;
            if (!best || km < best.km) best = { km, dx, dy };
            if (tiers && km <= HZ.alertKm) {
                let cls = null, dist = Infinity;
                H40B.forEach(c => { const e = Math.abs(c.rgb[0] - d[i]) + Math.abs(c.rgb[1] - d[i + 1]) + Math.abs(c.rgb[2] - d[i + 2]); if (e < dist) { dist = e; cls = c; } });
                if (cls && cls.max > maxMm) maxMm = cls.max;
            }
        }
        if (!best) return scanKm >= HZ.scanKm ? { km: null } : null;
        const deg = (Math.atan2(best.dx, -best.dy) * 180 / Math.PI + 360) % 360;
        // Rain strength only when the whole alert radius was seen.
        const tier = !tiers || !maxMm || scanKm < HZ.alertKm ? null : maxMm <= 2 ? 'light' : maxMm <= 10 ? 'moderate' : 'heavy';
        return { km: best.km, dir: Math.round(deg / 45) % 8, tier };
    }

    function addObs(kindId, layerName, tm, result) {
        if (!result) return;
        const list = H.obs[kindId];
        if (list.some(o => o.t === tm && o.layer === layerName)) return;
        list.push({ t: tm, layer: layerName, km: result.km, dir: result.dir, tier: result.tier || null });
        list.sort((a, b) => a.t - b.t);
        const keepFrom = Date.now() - HZ.keepMs;
        H.obs[kindId] = list.filter(o => o.t >= keepFrom);
    }

    function resetIfMoved() {
        const key = locKey();
        if (key === H.locKey) return;
        H.locKey = key;
        H.obs = { lightning: [], rain: [] };
        H.status = null;
    }

    // ================= Polling =================
    async function poll() {
        if (!H.on || !state.location || H.polling) return;
        if (!navigator.onLine) { emit(); return; }
        resetIfMoved();
        const key = H.locKey;
        H.polling = true;
        H.lastPoll = Date.now();
        const errors = [];
        await Promise.all(KINDS.map(async kind => {
            try {
                const { name, t: tm } = await latestOf(kind);
                if (H.obs[kind.id].some(o => o.t === tm && o.layer === name)) return;
                const loc = state.location;
                const bbox = boxAround(loc.latitude, loc.longitude);
                const img = await fetchImage(name, tm, bbox);
                if (key !== locKey()) return;
                addObs(kind.id, name, tm, analyse(img, bbox, HZ.size, HZ.size, kind.id, name));
                if (img.close) img.close();
            } catch (err) {
                errors.push(`${t(kind.id === 'rain' ? 'hzRain' : 'hzLightning')}: ${err.message}`);
            }
        }));
        H.polling = false;
        if (key !== locKey()) { poll(); return; }
        H.status = { at: Date.now(), error: errors.join('; ') };
        emit();
    }

    // ---- Tracking at the times the map shows
    const T = { queue: [], active: 0, seen: new Set() };

    // `times`: the image the map shows and the later ones (ms, in order).
    // Queued requests for times no longer ahead are dropped.
    function track(times) {
        if (!H.on || !state.location) return;
        const jobs = [];
        KINDS.forEach(kind => {
            const name = H.layer[kind.id], info = H.times[name];
            if (!name || !info || !info.step || !assess(kind.id)) return;
            times.forEach(tm => {
                // The layer's step at or before the image time.
                const at = tm >= info.t ? info.t : info.t - Math.ceil((info.t - tm) / info.step) * info.step;
                if (Date.now() - at > HZ.keepMs) return;
                const key = `${H.locKey}|${name}|${at}`;
                if (T.seen.has(key) || jobs.some(j => j.key === key) || H.obs[kind.id].some(o => o.t === at && o.layer === name)) return;
                jobs.push({ kindId: kind.id, name, t: at, loc: H.locKey, key });
            });
        });
        T.queue = jobs.sort((a, b) => a.t - b.t);
        pumpTrack();
    }

    function pumpTrack() {
        while (T.active < 2 && T.queue.length) {
            const job = T.queue.shift();
            if (job.loc !== locKey()) continue;
            T.seen.add(job.key);
            T.active++;
            const loc = state.location;
            const bbox = boxAround(loc.latitude, loc.longitude);
            fetchImage(job.name, job.t, bbox).then(img => {
                if (job.loc !== locKey()) return;
                addObs(job.kindId, job.name, job.t, analyse(img, bbox, HZ.size, HZ.size, job.kindId, job.name));
                if (img.close) img.close();
                emit();
            }).catch(() => T.seen.delete(job.key)).finally(() => { T.active--; pumpTrack(); });
        }
    }

    function due() {
        return H.on && state.location && document.visibilityState === 'visible' && navigator.onLine && Date.now() - H.lastPoll >= HZ.pollMs;
    }

    function start() {
        if (H.started) return;
        H.started = true;
        setInterval(() => { if (due()) poll(); else emit(); }, 60e3);
        document.addEventListener('visibilitychange', () => { if (due()) poll(); });
        window.addEventListener('online', () => { if (due()) poll(); });
        window.addEventListener('offline', emit);
        document.getElementById('hazardChips').addEventListener('click', e => {
            const el = e.target.closest('[data-hazard]');
            if (el) openMap(el.dataset.hazard);
        });
    }

    // ================= Assessment =================
    // Least-squares closing speed (km/h, > 0 = approaching) from the nearest
    // distances seen in the last 45 min, with how well a steady movement
    // explains them (r², 0–1); null with too few images.
    function closingSpeed(list, upTo) {
        const pts = list.filter(o => o.km !== null && o.t <= upTo && upTo - o.t <= HZ.motionMs);
        if (pts.length < 2 || pts[pts.length - 1].t - pts[0].t < HZ.minMotionSpanMs) return null;
        const n = pts.length;
        const mt = pts.reduce((s, o) => s + o.t, 0) / n, mk = pts.reduce((s, o) => s + o.km, 0) / n;
        let num = 0, den = 0, tot = 0;
        pts.forEach(o => { num += (o.t - mt) * (o.km - mk); den += (o.t - mt) ** 2; tot += (o.km - mk) ** 2; });
        if (!den) return null;
        return { v: -(num / den) * 3600e3, r2: tot ? num * num / (den * tot) : 1 };
    }

    function assess(kindId) {
        const list = H.obs[kindId].filter(o => o.layer === H.layer[kindId]);
        if (!list.length) return null;
        const now = Date.now();
        const newest = list[list.length - 1];
        if (now - newest.t > HZ.maxAgeMs) return null;
        let hit = null;
        if (kindId === 'lightning') {
            // The latest image with a flash within the alert radius (in the
            // last 30 min): where the storm is now, not where it was closest.
            hit = list.filter(o => o.km !== null && o.km <= HZ.alertKm && newest.t - o.t <= HZ.lightningMs).pop() || null;
        } else if (newest.km !== null && newest.km <= HZ.alertKm) hit = newest;
        if (!hit) return null;
        return { kind: kindId, km: hit.km, dir: hit.dir, t: hit.t, tier: hit.tier, motion: closingSpeed(list, newest.t) };
    }

    function etaText(min) {
        const m = Math.max(5, Math.round(min / 5) * 5);
        return m < 60 ? t('hzMin', { n: m }) : t('hzHourMin', { h: Math.floor(m / 60), m: m % 60 });
    }

    function motionText(a) {
        if (a.km < 3) return '';
        if (!a.motion) return t('hzNoMotion');
        const { v, r2 } = a.motion;
        // Several cells or a storm building in place: distances jump about.
        if (Math.abs(v) >= 5 && r2 < 0.5) return t('hzUnclear');
        if (v >= 5) {
            const eta = a.km / v * 60;
            return eta <= 180 ? t('hzApproach', { v: Math.round(v), eta: etaText(eta) }) : t('hzApproachSlow');
        }
        return v <= -5 ? t('hzAway') : t('hzSteady');
    }

    function ageText(ms) {
        const min = Math.round((Date.now() - ms) / 60000);
        return min < 2 ? t('hzJustNow') : t('hzAgo', { n: min });
    }

    // Chips for the current alerts ('' when there are none). `variant`:
    // 'forecast' (inline chips) or 'map' (full-width pills like the map's
    // other notes).
    function chipsHtml(variant) {
        if (!H.on || !state.location) return '';
        return KINDS.map(kind => {
            const a = assess(kind.id);
            if (!a) return '';
            const where = a.km < 3 ? t('hzOverhead') : t('hzAt', { d: Math.max(1, Math.round(a.km)), dir: t('hzCompass')[a.dir] });
            const label = kind.id === 'rain' && a.tier ? t('hzRainTier_' + a.tier) : t(kind.id === 'rain' ? 'hzRain' : 'hzLightning');
            const sub = [ageText(a.t), motionText(a)].filter(Boolean).join(' · ');
            const title = `${t('hzOpenMap')} — ${clockTime(a.t)}`;
            const head = `<i class="fa-solid ${kind.icon} ${kind.accent}"></i><span class="font-semibold">${h(label.charAt(0).toUpperCase() + label.slice(1))} ${h(where)}</span>`;
            // Folded on the map: an icon in the map's button column.
            if (variant === 'icon') {
                const full = `${label.charAt(0).toUpperCase() + label.slice(1)} ${where} · ${sub} — ${t('hzExpand')}`;
                return `<button type="button" data-hazard="${kind.id}" title="${h(full)}" aria-label="${h(full)}" class="w-[34px] h-[34px] rounded-lg border-2 border-black/20 flex items-center justify-center shadow-lg transition hover:brightness-110 ${kind.iconCls}"><i class="fa-solid ${kind.icon}"></i></button>`;
            }
            // Two lines on the map: what and where, then age and movement
            // (wrapping, never cut off). A tap folds them into icons.
            if (variant === 'map') {
                return `<button type="button" data-hazard="${kind.id}" title="${h(t('hzCollapse'))}" class="pointer-events-auto w-full flex items-start gap-2 px-3 py-1.5 rounded-xl text-[11px] leading-snug text-left shadow-lg backdrop-blur-md border ${kind.cls}">
                    <i class="fa-solid ${kind.icon} ${kind.accent} mt-0.5"></i><span class="flex-1 min-w-0"><span class="block font-semibold">${h(label.charAt(0).toUpperCase() + label.slice(1))} ${h(where)}</span><span class="block opacity-80">${h(sub)}</span></span></button>`;
            }
            return `<button type="button" data-hazard="${kind.id}" title="${h(title)}" class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2.5 py-1 rounded-lg text-xs text-left border ${kind.cls} hover:brightness-125 transition">
                ${head}<span class="text-[11px] opacity-80">${h(sub)}</span><i class="fa-solid fa-satellite text-[10px] opacity-60"></i></button>`;
        }).join('');
    }

    function statusText() {
        if (!navigator.onLine) return t('hzStatusOffline');
        const st = H.status;
        if (!st) return t('hzStatusIdle');
        if (st.error) return t('hzStatusError', { msg: st.error });
        const any = KINDS.some(k => assess(k.id));
        return any ? t('hzStatusAlert', { time: clockTime(st.at) }) : t('hzStatusClear', { time: clockTime(st.at), r: HZ.alertKm });
    }

    // ================= Rendering =================
    function render() {
        const el = document.getElementById('hazardChips');
        if (el) {
            const html = state.location ? chipsHtml('forecast') : '';
            el.innerHTML = html;
            el.classList.toggle('hidden', !html);
        }
        const st = document.getElementById('hazardStatus');
        if (st) st.textContent = H.on ? statusText() : '';
    }

    function emit() {
        render();
        if (window.FlySkyMap && window.FlySkyMap.onHazardChange) window.FlySkyMap.onHazardChange();
    }

    // Images the map loaded before (another location, or before this file
    // was loaded) are measured again from here.
    function replayMap() {
        if (H.on && window.FlySkyMap && window.FlySkyMap.replayHazard) window.FlySkyMap.replayHazard();
    }

    function openMap(kindId) {
        setView('map');
        loadMapAssets().then(() => { if (window.FlySkyMap) window.FlySkyMap.focusHazard(kindId); }).catch(() => {});
    }

    // ================= Public API =================
    window.FlySkyHazard = {
        start() { start(); resetIfMoved(); replayMap(); if (H.on) poll(); },
        setEnabled(on) {
            H.on = !!on;
            if (H.on && Date.now() - H.lastPoll >= HZ.pollMs) poll();
            emit();
        },
        onLocationChange() { resetIfMoved(); H.lastPoll = 0; emit(); replayMap(); if (H.on) poll(); },
        onLangChange: emit,
        // An image the satellite map has loaded (kind 'lightning' | 'rain').
        // Only one of the alert's own products is used, so all distances
        // come from the same retrieval.
        feed(kindId, layerName, tm, url, bbox, w, hgt) {
            if (!H.on || !state.location || !H.obs[kindId] || !Number.isFinite(tm)) return;
            if (H.layer[kindId] ? H.layer[kindId] !== layerName : !KINDS.find(k => k.id === kindId).layers.includes(layerName)) return;
            if (Date.now() - tm > HZ.keepMs || H.obs[kindId].some(o => o.t === tm && o.layer === layerName)) return;
            resetIfMoved();
            const key = H.locKey;
            loadImage(url).then(img => {
                if (key !== locKey()) return;
                const res = analyse(img, bbox, w, hgt, kindId, layerName);
                if (!res) return;
                H.layer[kindId] = layerName;
                addObs(kindId, layerName, tm, res);
                emit();
            }).catch(() => {});
        },
        chipsHtml,
        statusText,
        // The map shows an image taken at `tm` (ms).
        track,
        alertKm: HZ.alertKm,
        // exposed for tests / diagnostics
        _internals: { H, HZ, analyse, assess, closingSpeed, poll }
    };
})();
