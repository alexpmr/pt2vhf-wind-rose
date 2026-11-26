/*
 * PT2VHF Wind Rose Card — compact wind direction/speed card for Home Assistant.
 * The rose is a polar heat map of the last N hours: angle = direction the wind
 * comes FROM, distance from the centre = speed, colour = how much time it blew there.
 * https://github.com/alexpmr/pt2vhf-wind-rose
 */
const VERSION = '0.12.1';
const TAG = 'pt2vhf-wind-rose-card';

const STR = {
  en: {
    dirs: ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'],
    gust: 'Gust', max: 'max',
    hour: 'Last hour', mins: (m) => `Last ${m} min`, hours: (h) => `Last ${h} h`, nodata: 'No history yet', unavailable: 'Unavailable',
    raining: 'rain', wind: 'Wind', direction: 'Direction',
  },
  pt: {
    dirs: ['N', 'NNE', 'NE', 'ENE', 'L', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'],
    gust: 'Rajada', max: 'máx',
    hour: 'Última hora', mins: (m) => `Últimos ${m} min`, hours: (h) => `Últimas ${h} h`, nodata: 'Sem histórico ainda', unavailable: 'Indisponível',
    raining: 'chuva', wind: 'Vento', direction: 'Direção',
  },
};

// Sequential palette (low → high time share). Readable on light and dark themes.
const STOPS = ['#2b4c9b', '#3e8fc4', '#5cc8a8', '#c6e05a', '#f6b73c', '#e8553e'];
const HEAT_GRID = 96; // density grid resolution (cells per side)
const NICE =[4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200];

/** History rows ({s, lu|lc} in seconds) → sorted [{t ms, v number|NaN}]. */
export function toSeries(rows) {
  return (rows || [])
    .map((r) => ({ t: (r.lu ?? r.lc) * 1000, v: parseFloat(r.s) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

/** Rain from a binary_sensor ("on") or a numeric sensor (rate/amount > 0). */
export function isRaining(stateObj) {
  const s = stateObj?.state;
  if (s === 'on') return true;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0;
}

/** Direction + offset (degrees), wrapped to [0, 360). NaN stays NaN. */
export function withOffset(deg, offset = 0) {
  return (((deg + (Number(offset) || 0)) % 360) + 360) % 360;
}

/** History window in minutes: `window` ("30m", "15 min", "6h", "1.5h" or plain minutes) wins over `hours`. */
export function windowMinutes(c) {
  const m = String(c.window ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h)?$/i);
  const v = m ? parseFloat(m[1]) * (/^h$/i.test(m[2] || '') ? 60 : 1) : 0;
  if (v > 0) return v;
  return (Number(c.hours) > 0 ? Number(c.hours) : 1) * 60;
}

export function windowLabel(lang, minutes) {
  const L = STR[lang] || STR.en;
  if (minutes === 60) return L.hour;
  if (minutes < 60) return L.mins(Math.round(minutes));
  return L.hours(new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(minutes / 60));
}

export function niceMax(v) {
  return NICE.find((n) => n >= v) ?? Math.ceil(v / 50) * 50;
}

export function sectorOf(deg, sectors) {
  const d = ((deg % 360) + 360) % 360;
  return Math.round(d / (360 / sectors)) % sectors;
}

/**
 * Samples both series on an even time grid (last known value wins) and bins
 * them into sectors × rings. Time-weighted by construction.
 */
export function computeRose(speed, dir, { start, end, sectors = 16, rings = 5, maxSpeed, calm = 0.5, atLeast = 0 }) {
  const n = Math.min(1440, Math.max(1, Math.round((end - start) / 10000)));
  const step = (end - start) / n;
  const samples = [];
  let i = -1;
  let j = -1;
  for (let k = 0; k < n; k++) {
    const t = start + (k + 0.5) * step;
    while (i + 1 < speed.length && speed[i + 1].t <= t) i++;
    while (j + 1 < dir.length && dir[j + 1].t <= t) j++;
    if (i < 0 || j < 0) continue;
    const s = speed[i].v;
    const d = dir[j].v;
    if (Number.isFinite(s) && Number.isFinite(d) && s >= 0) samples.push([s, d]);
  }
  const peak = samples.reduce((m, [s]) => Math.max(m, s), 0);
  const max = maxSpeed > 0 ? maxSpeed : niceMax(Math.max(peak, atLeast, 1));
  const counts = Array.from({ length: sectors }, () => new Array(rings).fill(0));
  const bySector = new Array(sectors).fill(0);
  const points = [];
  const polar = [];
  let calmN = 0;
  let sum = 0;
  for (const [s, d] of samples) {
    sum += s;
    if (s < calm) { calmN++; continue; }
    const r = Math.min(1, s / max);
    const rad = (d * Math.PI) / 180;
    points.push([r * Math.sin(rad), -r * Math.cos(rad)]);
    polar.push([r, d]);
    const a = sectorOf(d, sectors);
    counts[a][Math.min(rings - 1, Math.floor((s / max) * rings))]++;
    bySector[a]++;
  }
  const total = samples.length;
  const best = bySector.indexOf(Math.max(...bySector));
  return {
    counts, total, max, peak, points, polar,
    calm: total ? calmN / total : 0,
    avg: total ? sum / total : 0,
    prevailing: total > calmN ? best : -1,
  };
}

/**
 * Gaussian kernel density of unit-disc points on an n×n grid spanning [-1, 1]²
 * (row-major, row 0 = top). Normalised so the densest cell is 1. Working in x/y
 * means no sector or ring edges, and directions wrap around north naturally.
 */
export function density(points, n = 96, sigma = 0.08) {
  const g = new Float32Array(n * n);
  const cell = 2 / n;
  const reach = Math.ceil((3 * sigma) / cell);
  const inv = 1 / (2 * sigma * sigma);
  for (const [x, y] of points) {
    const ci = Math.floor((x + 1) / cell);
    const cj = Math.floor((y + 1) / cell);
    for (let j = Math.max(0, cj - reach); j <= Math.min(n - 1, cj + reach); j++) {
      const dy = (j + 0.5) * cell - 1 - y;
      for (let i = Math.max(0, ci - reach); i <= Math.min(n - 1, ci + reach); i++) {
        const dx = (i + 0.5) * cell - 1 - x;
        g[j * n + i] += Math.exp(-(dx * dx + dy * dy) * inv);
      }
    }
  }
  let top = 0;
  for (const v of g) if (v > top) top = v;
  if (top > 0) for (let k = 0; k < g.length; k++) g[k] /= top;
  return g;
}

/**
 * heat_motion: wraps the heat-map SVG so it sways side to side like a windsock and flickers like a
 * flame. Both follow mostly the gusts (how far they exceed the speed); the speed adds a little.
 * CSS only; the negative delay keeps the phase across re-renders. Strengths are rounded so small
 * changes don't jump.
 */
export function heatMotion(heat, { on, speed, gust, max, now = 0 }) {
  if (!on || !heat) return heat;
  const m = Number(max) > 0 ? Number(max) : 1;
  const q = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 4) / 4;
  const k = q((Number(speed) || 0) / m);
  const g = q(((Number(gust) || 0) - (Number(speed) || 0)) / m * 2);
  const sway = 1 + 1.5 * k + 5 * g;     // degrees each way
  const pulse = +(0.02 + 0.03 * k + 0.07 * g).toFixed(3); // relative stretch of the plumes
  const tSway = Math.round(3200 - 500 * k - 1500 * g);
  const tFlick = Math.round(1800 - 700 * k - 600 * g);
  const delay = (t) => `animation-delay:${-Math.round(now % t)}ms`;
  return `<g class="sway" style="--wr-sway:${sway}deg;animation-duration:${tSway}ms;${delay(tSway)}">`
    + `<g class="flick" style="--wr-pulse:${pulse};animation-duration:${tFlick}ms;${delay(tFlick)}">${heat}</g></g>`;
}

/**
 * Radial "plume" heat map on an n×n grid over [-1, 1]² (row 0 = top), normalised to 1.
 * Each sample [r, deg] paints the whole ray from the centre out to its speed r (soft tip),
 * so intensity at (bearing, radius) = time the wind came from ~bearing AND reached at least
 * that radius. Smoothed across bearings with a Gaussian of sigmaDeg; wraps at north.
 */
export function plume(polar, n = 96, sigmaDeg = 10, tip = 0.04) {
  const B = 360; // 1° bearing bins
  const K = 64; // radial levels
  const E = new Float32Array(B * K);
  for (const [r, d] of polar) {
    const b = Math.round(withOffset(d, 0)) % B;
    for (let k = 0; k < K; k++) {
      const t = Math.min(1, Math.max(0, ((r - (k + 0.5) / K) / tip) * 0.5 + 0.5));
      if (t === 0) break;
      E[b * K + k] += t * t * (3 - 2 * t); // smoothstep: plume fades just past its speed
    }
  }
  // Circular Gaussian blur across bearings.
  const w = Math.max(1, Math.ceil(3 * sigmaDeg));
  const kern = Array.from({ length: 2 * w + 1 }, (_, o) => Math.exp(-((o - w) ** 2) / (2 * sigmaDeg * sigmaDeg)));
  const P = new Float32Array(B * K);
  for (let b = 0; b < B; b++) {
    for (let o = -w; o <= w; o++) {
      const src = ((b + o) % B + B) % B;
      const g = kern[o + w];
      for (let k = 0; k < K; k++) P[b * K + k] += g * E[src * K + k];
    }
  }
  // Sample the polar table on the cartesian grid (bilinear in bearing and radius).
  const out = new Float32Array(n * n);
  let top = 0;
  for (let j = 0; j < n; j++) {
    const y = ((j + 0.5) * 2) / n - 1;
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) * 2) / n - 1;
      const rho = Math.hypot(x, y);
      if (rho > 1) continue;
      const phi = withOffset((Math.atan2(x, -y) * 180) / Math.PI, 0);
      const b0 = Math.floor(phi) % B;
      const b1 = (b0 + 1) % B;
      const tb = phi - Math.floor(phi);
      const kf = Math.min(K - 1, Math.max(0, rho * K - 0.5));
      const k0 = Math.floor(kf);
      const k1 = Math.min(K - 1, k0 + 1);
      const tk = kf - k0;
      const v = (P[b0 * K + k0] * (1 - tb) + P[b1 * K + k0] * tb) * (1 - tk)
        + (P[b0 * K + k1] * (1 - tb) + P[b1 * K + k1] * tb) * tk;
      out[j * n + i] = v;
      if (v > top) top = v;
    }
  }
  if (top > 0) for (let k = 0; k < out.length; k++) out[k] /= top;
  return out;
}

function rgbAt(f) {
  const x = Math.min(1, Math.max(0, f)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const t = x - i;
  const a = parseInt(STOPS[i].slice(1), 16);
  const b = parseInt(STOPS[i + 1].slice(1), 16);
  const ch = (sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return [ch(16), ch(8), ch(0)];
}

/** Density grid → PNG data URL; alpha fades with density so the edges are soft. */
function heatImage(g, n) {
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let k = 0; k < g.length; k++) {
    const f = g[k];
    if (f < 0.005) continue;
    const [r, gg, b] = rgbAt(f);
    img.data.set([r, gg, b, Math.round(Math.min(1, f * 2.5) * 242)], k * 4);
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL();
}

// Percentage option → 0..1; empty or invalid = 100 %.
const pct = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? 1 : Math.min(1, Math.max(0, Number(v) / 100)));

const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [+(r * Math.sin(a)).toFixed(2), +(-r * Math.cos(a)).toFixed(2)];
};

/** Polygon in rose-local coords: u along the wind's "from" bearing, v to its right. */
function poly(dir, pts) {
  const a = (dir * Math.PI) / 180;
  const [s, c] = [Math.sin(a), Math.cos(a)];
  return `M${pts.map(([u, v]) => `${+(u * s + v * c).toFixed(2)} ${+(-u * c + v * s).toFixed(2)}`).join('L')}Z`;
}

export const POINTERS = ['arrow', 'chevron', 'dart', 'needle', 'compass', 'vane', 'none'];

/** Current-direction pointer. All styles mark the side the wind comes FROM. */
export function pointerSvg(style, dir, R, { guide = true } = {}) {
  switch (POINTERS.includes(style) ? style : 'arrow') {
    case 'none':
      return '';
    case 'needle':
      // Compass needle through the centre: coloured head toward "from", plain tail opposite.
      return `<path class="needle-tail" d="${poly(dir, [[-(R - 6), 0], [0, -5], [0, 5]])}"/>`
        + `<path class="needle-head" d="${poly(dir, [[R - 4, 0], [0, -5], [0, 5]])}"/>`
        + '<circle class="needle-cap" r="3.5"/>';
    case 'chevron':
      // Open "V" on the rim pointing in: light, doesn't hide the heat map.
      return `<path class="chevron" d="${poly(dir, [[R + 5, -13], [R - 14, 0], [R + 5, 13]]).slice(0, -1)}"/>`;
    case 'dart':
      // Slim notched arrowhead on the rim pointing in.
      return `<path class="arrow" d="${poly(dir, [[R - 18, 0], [R + 5, -10], [R - 1, 0], [R + 5, 10]])}"/>`;
    case 'vane':
      // Weather vane across the rose: feathers on the "from" side, head where the wind blows to.
      return `<line class="vane-shaft" x1="${pt(R - 8, dir)[0]}" y1="${pt(R - 8, dir)[1]}" x2="${pt(-(R - 16), dir)[0]}" y2="${pt(-(R - 16), dir)[1]}"/>`
        + `<path class="arrow" d="${poly(dir, [[R - 2, 0], [R + 4, -9], [R - 12, -9], [R - 18, 0]])}"/>`
        + `<path class="arrow" d="${poly(dir, [[R - 2, 0], [R + 4, 9], [R - 12, 9], [R - 18, 0]])}"/>`
        + `<path class="arrow" d="${poly(dir, [[-(R - 4), 0], [-(R - 20), -8], [-(R - 20), 8]])}"/>`;
    case 'compass':
      // Wide arrow from the rim to the centre, pointing where the wind blows to.
      return `<path class="arrow" d="${poly(dir, [[R - 2, -4], [R - 2, 4], [32, 4], [32, 12], [8, 0], [32, -12], [32, -4]])}"/>`;
    default:
      // Triangle on the rim pointing in, with a dashed guide to the centre.
      return (guide ? `<line class="guide" x2="${pt(R - 15, dir)[0]}" y2="${pt(R - 15, dir)[1]}"/>` : '')
        + `<path class="arrow" d="${poly(dir, [[R - 15, 0], [R + 5, -13], [R + 5, 13]])}"/>`;
  }
}

// Background map providers (standard XYZ tiles, no API key). The attribution is drawn under the rose.
const MAPS = {
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  // Not tile.openstreetmap.org: it rejects requests without a Referer, and HA pages use referrer=same-origin.
  streets: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', max: 19, attribution: '© Esri, HERE, Garmin, © OpenStreetMap' },
  topo: { url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', max: 17, attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap' },
  // Esri Canvas basemaps: keyless, detail up to zoom 16 (the card caps the zoom there).
  light: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', max: 16, attribution: '© Esri, HERE, Garmin, © OpenStreetMap' },
  dark: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', max: 16, attribution: '© Esri, HERE, Garmin, © OpenStreetMap' },
};
export const MAP_TYPES = ['none', ...Object.keys(MAPS), 'custom'];

/** Tile source for the config, or null for no map. `custom` takes an http(s) template from map_url. */
export function mapSource(c) {
  let s = MAPS[c.map];
  if (c.map === 'custom') {
    const u = String(c.map_url ?? '').trim();
    if (!/^https?:\/\//i.test(u) || !/\{z\}/.test(u)) return null;
    s = { url: u, max: 22, attribution: c.map_attribution || '' };
  }
  if (!s) return null;
  return { max: s.max, attribution: s.attribution, url: (z, x, y) => s.url.replace('{z}', z).replace('{x}', x).replace('{y}', y) };
}

/**
 * Web-Mercator tiles that cover the rose: centre (lat, lon) at (0, 0), radiusM metres at R units.
 * The zoom is picked so the rose radius is ~pxRadius map pixels (sharp at that screen size).
 * Returns { z, size (tile edge in rose units), tiles: [{ x, y, left, top }] }.
 */
export function mapTiles(lat, lon, radiusM, R = 80, pxRadius = 300, maxZoom = 19) {
  const none = { z: 0, size: 0, tiles: [] };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM > 0) || Math.abs(lat) > 85) return none;
  const la = (lat * Math.PI) / 180;
  const z = Math.min(maxZoom, Math.max(1, Math.round(Math.log2((pxRadius * 156543.03392 * Math.cos(la)) / radiusM))));
  const n = 2 ** z;
  const mpp = (156543.03392 * Math.cos(la)) / n; // metres per map pixel
  const cx = ((lon + 180) / 360) * n * 256;
  const cy = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n * 256;
  const rpx = radiusM / mpp;
  const k = R / rpx; // rose units per map pixel
  const tiles = [];
  for (let ty = Math.floor((cy - rpx) / 256); ty <= Math.floor((cy + rpx) / 256); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor((cx - rpx) / 256); tx <= Math.floor((cx + rpx) / 256); tx++) {
      tiles.push({ x: ((tx % n) + n) % n, y: ty, left: (tx * 256 - cx) * k, top: (ty * 256 - cy) * k });
    }
  }
  return { z, size: 256 * k, tiles };
}

const rwyId = (h) => String(Math.round(withOffset(h, 0) / 10) % 36 || 36).padStart(2, '0');

/**
 * Runway with one end heading `heading` (degrees): both idents, and for the wind (from windDir at speed)
 * the end in use (largest headwind) with its headwind and crosswind; side R/L = wind from the right/left.
 */
export function runwayInfo(heading, windDir, speed, name = '') {
  if (heading === '' || heading == null || !Number.isFinite(Number(heading))) return null;
  const h = withOffset(Number(heading), 0);
  // Painted numbers are magnetic; runway_name (e.g. "12/30") shows them while heading stays true.
  const nm = String(name ?? '').split('/').map((p) => p.trim());
  const named = nm.length === 2 && nm.every((p) => p && p.length <= 4);
  const ends = [{ id: named ? nm[0] : rwyId(h), heading: h }, { id: named ? nm[1] : rwyId(h + 180), heading: withOffset(h, 180) }];
  if (!Number.isFinite(windDir) || !Number.isFinite(speed)) return { ends, active: null };
  const comp = (e) => {
    const a = ((windDir - e.heading) * Math.PI) / 180;
    return { ...e, head: speed * Math.cos(a), cross: Math.abs(speed * Math.sin(a)), side: Math.sin(a) >= 0 ? 'R' : 'L' };
  };
  const [a, b] = ends.map(comp);
  return { ends, active: a.head >= b.head ? a : b };
}

const M_PER_DEG = 111320; // metres per degree of latitude (spherical approximation, fine at map scale)
const cosd = (d) => Math.cos((d * Math.PI) / 180);

/** Moves a point `north` / `east` metres (negative = south / west). */
export function shiftLatLon(lat, lon, north = 0, east = 0) {
  return [lat + (Number(north) || 0) / M_PER_DEG, lon + (Number(east) || 0) / (M_PER_DEG * cosd(lat))];
}

/**
 * Map centre. Priority: map_latitude/longitude > map_center (device / an entity with latitude and
 * longitude) > the aerodrome of `icao` > Home Assistant home. map_shift_north/east (metres) apply last.
 * extra = { device: [lat, lon], aerodrome: [lat, lon] } when known.
 */
export function mapCenter(c, hass, extra = {}) {
  const num = (v) => (v === '' || v == null ? NaN : Number(v));
  let p = null;
  let source = 'none';
  const ll = (lat, lon) => (Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null);
  if ((p = ll(num(c.map_latitude), num(c.map_longitude)))) source = 'manual';
  else if (c.map_center === 'device' && (p = extra.device && ll(...extra.device))) source = 'device';
  else if (String(c.map_center || '').includes('.')
    && (p = ll(num(hass?.states?.[c.map_center]?.attributes?.latitude), num(hass?.states?.[c.map_center]?.attributes?.longitude)))) source = 'entity';
  else if ((p = extra.aerodrome && ll(...extra.aerodrome))) source = 'aerodrome';
  else if ((p = ll(num(hass?.config?.latitude), num(hass?.config?.longitude)))) source = 'home';
  if (!p) return { lat: NaN, lon: NaN, source };
  const [lat, lon] = shiftLatLon(p[0], p[1], c.map_shift_north, c.map_shift_east);
  return { lat, lon, source };
}

/** Initial great-circle bearing from point 1 to point 2, degrees. */
function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return withOffset((Math.atan2(y, x) * 180) / Math.PI, 0);
}

/** One CSV line → fields (handles "quoted, fields"). */
function csvFields(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Runways of one aerodrome from the OurAirports runways.csv text. True headings come from the data,
 * else from the threshold coordinates, else from the ident (×10, magnetic — approximate).
 */
export function parseRunways(csv, icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!code) return [];
  const lines = String(csv).split(/\r?\n/);
  const head = csvFields(lines[0]);
  const col = (n) => head.indexOf(n);
  const tag = `"${code}"`;
  const out = [];
  for (const line of lines) {
    if (!line.includes(tag)) continue; // cheap pre-filter: the file has ~45 000 runways
    const f = csvFields(line);
    if (f[col('airport_ident')] !== code) continue;
    const n = (k) => (f[col(k)] === '' || f[col(k)] == null ? NaN : Number(f[col(k)]));
    const end = (p) => ({ id: f[col(`${p}_ident`)] || '', lat: n(`${p}_latitude_deg`), lon: n(`${p}_longitude_deg`), heading: n(`${p}_heading_degT`) });
    const le = end('le');
    const he = end('he');
    const hasLL = [le.lat, le.lon, he.lat, he.lon].every(Number.isFinite);
    if (!Number.isFinite(le.heading)) {
      if (hasLL) le.heading = bearing(le.lat, le.lon, he.lat, he.lon);
      else if (Number.isFinite(he.heading)) le.heading = withOffset(he.heading, 180);
      else le.heading = withOffset((parseInt(le.id, 10) || 0) * 10, 0) || (parseInt(le.id, 10) ? 360 : 0);
    }
    if (!Number.isFinite(he.heading)) he.heading = withOffset(le.heading, 180);
    out.push({
      name: `${le.id}/${he.id}`,
      closed: f[col('closed')] === '1',
      lengthM: n('length_ft') * 0.3048,
      widthM: n('width_ft') * 0.3048,
      le, he, hasLL,
    });
  }
  return out;
}

/** Runways to draw: `runways` (list or "a, b" text) by name; empty = every open runway. */
export function selectRunways(all, runways) {
  const want = (Array.isArray(runways) ? runways : String(runways ?? '').split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  return want.length ? all.filter((r) => want.includes(r.name.toUpperCase())) : all.filter((r) => !r.closed);
}

/** Where a runway sits on the map, in rose units with north up: centre x/y, true heading h (le end), length L, width W. */
export function runwayPlacement(rw, center, radiusM, R = 80) {
  if (!rw.hasLL || !Number.isFinite(center?.lat) || !(radiusM > 0)) return null;
  const k = R / radiusM;
  const mLat = (rw.le.lat + rw.he.lat) / 2;
  const mLon = (rw.le.lon + rw.he.lon) / 2;
  const east = (mLon - center.lon) * M_PER_DEG * cosd(center.lat);
  const north = (mLat - center.lat) * M_PER_DEG;
  const dx = (rw.he.lon - rw.le.lon) * M_PER_DEG * cosd(mLat);
  const dy = (rw.he.lat - rw.le.lat) * M_PER_DEG;
  const len = Number.isFinite(rw.lengthM) && rw.lengthM > 0 ? rw.lengthM : Math.hypot(dx, dy);
  return { x: east * k, y: -north * k, h: rw.le.heading, L: len * k, W: (Number.isFinite(rw.widthM) && rw.widthM > 0 ? rw.widthM : 30) * k };
}

/** Runway end with the most headwind among runways [{ name, le: { heading } }]; null if none. */
export function bestRunwayEnd(list, windDir, speed) {
  let best = null;
  for (const r of list) {
    const a = runwayInfo(r.le.heading, windDir, speed, r.name)?.active;
    if (a && (!best || a.head > best.head)) best = a;
  }
  return best;
}

// OurAirports public data (CC0, CORS-enabled). Parsed runways are cached per code for 30 days.
const RWY_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const RWY_TTL = 30 * 864e5;
const rwyMem = new Map();
let rwyCsv = null;
const store = {
  get(k) { try { return JSON.parse(globalThis.localStorage?.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { globalThis.localStorage?.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
};

/** Runways of an aerodrome (cached). Rejects when the data cannot be downloaded. */
export function loadRunways(icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,8}$/.test(code)) return Promise.resolve([]);
  if (rwyMem.has(code)) return rwyMem.get(code);
  const key = `pt2vhf-wind-rose:rwy:${code}`;
  const hit = store.get(key);
  const p = hit && Date.now() - hit.t < RWY_TTL
    ? Promise.resolve(hit.r)
    : (rwyCsv ??= fetch(RWY_URL).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .catch((e) => { rwyCsv = null; throw e; }))
      .then((csv) => { const r = parseRunways(csv, code); if (r.length) store.set(key, { t: Date.now(), r }); return r; });
  p.catch(() => rwyMem.delete(code));
  rwyMem.set(code, p);
  return p;
}

const DEVICE_KEY = 'pt2vhf-wind-rose:device';

/** This device's position (browser geolocation; asks permission). Saved, so the map does not wander. */
export function deviceLocation() {
  return new Promise((resolve, reject) => {
    const g = globalThis.navigator?.geolocation;
    if (!g) { reject(new Error('Geolocation unavailable (needs HTTPS)')); return; }
    g.getCurrentPosition((p) => {
      const ll = [+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6)];
      store.set(DEVICE_KEY, ll);
      resolve(ll);
    }, (e) => reject(new Error(e?.message || 'Location denied')), { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  });
}
const savedDevice = () => { const v = store.get(DEVICE_KEY); return Array.isArray(v) && v.length === 2 ? v : null; };

/** Runway along bearing h, centred at (x, y): asphalt, threshold stripes, dashed centreline, idents. L, W in rose units. */
function runwaySvg(rw, h, L, W, x = 0, y = 0) {
  const f2 = (v) => +v.toFixed(2);
  W = Math.max(2.5, W);
  const y0 = L / 2; // local frame: -y points to bearing h, so the threshold of the "h" end is at +y (approach side)
  const fs = f2(Math.min(W * 0.7, 9));
  const kh = W * 0.6; // threshold stripe length
  const keys = (yStart) => {
    let out = '';
    const n = 4; // stripes on each side of the centreline
    const g = W / (2 * n + 1);
    for (let i = 0; i < 2 * n + 1; i++) {
      if (i === n) continue; // gap on the centreline
      out += `<rect x="${f2(-W / 2 + i * g + g * 0.2)}" y="${f2(yStart)}" width="${f2(g * 0.6)}" height="${f2(kh)}"/>`;
    }
    return out;
  };
  const idAt = (id, y, flip) => `<text class="rwy-id" x="0" y="${f2(y)}" font-size="${fs}"${flip ? ` transform="rotate(180 0 ${f2(y)})"` : ''}>${esc(id)}</text>`;
  const idGap = kh + 1.5 + fs * 0.6;
  return `<g class="runway" transform="${x || y ? `translate(${f2(x)} ${f2(y)}) ` : ''}rotate(${f2(h)})">`
    + `<rect class="rwy" x="${f2(-W / 2)}" y="${f2(-y0)}" width="${f2(W)}" height="${f2(L)}"/>`
    + `<g class="rwy-mark">${keys(y0 - 1 - kh)}${keys(-y0 + 1)}</g>`
    + idAt(rw.ends[0].id, y0 - idGap, false)
    + idAt(rw.ends[1].id, -y0 + idGap, true)
    + (L > 4 * idGap ? `<line class="rwy-cl" y1="${f2(-y0 + idGap + fs)}" y2="${f2(y0 - idGap - fs)}"/>` : '')
    + '</g>';
}

const EDITOR = {
  en: {
    labels: {
      entity: 'Wind speed', direction_entity: 'Wind direction (degrees)', gust_entity: 'Gust', rain_entity: 'Rain',
      name: 'Name', window: 'Heat-map window', direction_offset: 'Rotate rose (display only)', max_speed: 'Max speed (0 = auto)',
      heat_mode: 'Heat-map style', heat_direction: 'Heat-map points', plume_width: 'Plume thickness', plume_fade: 'Plume tip fade',
      smooth: 'Spot softness', heat_motion: 'Animate heat map', pointer: 'Pointer style', pointer_color: 'Pointer colour (CSS)',
      show_guide: 'Arrow guide line', show_speed: 'Current speed dot', show_gust: 'Gust ring', show_rim: 'Outer circle',
      show_rings: 'Speed rings', show_spokes: 'Spokes', show_scale: 'Scale label', rings: 'Ring count',
      sectors: 'Prevailing bins', calm: 'Calm below (speed)', refresh: 'History refresh', max_width: 'Max size', tap_action: 'Tap action',
      map: 'Background map', map_radius: 'Map radius', map_opacity: 'Map opacity', heat_opacity: 'Heat-map opacity',
      map_latitude: 'Map centre latitude', map_longitude: 'Map centre longitude', map_url: 'Custom tile URL',
      map_center: 'Map centre', map_shift_north: 'Shift north (m)', map_shift_east: 'Shift east (m)',
      icao: 'Aerodrome ICAO code', runways: 'Runways to draw',
      runway_heading: 'Runway heading (true)', runway_name: 'Runway numbers', runway_length: 'Runway length', runway_width: 'Runway width', runway_wind: 'Headwind / crosswind',
    },
    helpers: {
      entity: `PT2VHF Wind Rose ${VERSION}`,
      heat_direction: 'from: heat points to where the wind came from. to: heat is blown downwind.',
      plume_fade: 'How gradually each plume tip fades. Higher removes hard arcs; 0 = sharp tip.',
      smooth: 'Only used when the heat-map style is "spots".',
      heat_motion: 'Sways like a windsock and flickers like a flame, mostly with the gusts (the speed adds a little). Off when the device asks for reduced motion.',
      direction_offset: 'Turns the whole rose clockwise to match how you face the screen. Values stay true.',
      show_guide: 'Only for the "arrow" pointer.',
      map: 'Tiles are downloaded from the provider for the map centre (your home by default).',
      map_radius: 'Distance from the centre to the rim, in metres.',
      map_latitude: 'Empty = Home Assistant home location.',
      map_url: 'Only for "custom", e.g. https://…/{z}/{x}/{y}.png',
      runway_heading: 'True heading of one end in degrees (as on the map). Empty = no runway.',
      runway_name: 'Painted numbers, e.g. 12/30 (they are magnetic). Empty = from the heading.',
      runway_wind: 'Headwind (↓; ↑ = tailwind) and crosswind (← →) for the runway end in use.',
      map_center: 'home, device (this phone/computer) or an entity with coordinates, e.g. person.me. Latitude/longitude win when filled.',
      map_shift_north: 'Fine adjustment in metres; negative = south / west. The map preview below sets it by dragging.',
      icao: 'e.g. SBMT. Runways come from OurAirports; over a map they are drawn at their real place and size, and the map centres on the aerodrome.',
      runways: 'Empty = all open runways.',
    },
    position: 'Map position', useLocation: 'Use my location', reset: 'Reset adjustment', step: 'Step',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', dragHint: 'Drag to move · wheel, pinch or + − to zoom',
    north: 'North', south: 'South', west: 'West', east: 'East', locating: 'Locating…',
    noDevice: 'This device has no saved location yet, so the home / aerodrome is used. Press “Use my location”.',
    found: (code, list) => `${code}: ${list}`, none: (code) => `${code}: no runways found`, loading: 'Loading runways…',
    appearance: 'Appearance',
    mapSection: 'Background map',
    runwaySection: 'Runway',
  },
  pt: {
    labels: {
      entity: 'Velocidade do vento', direction_entity: 'Direção do vento (graus)', gust_entity: 'Rajada', rain_entity: 'Chuva',
      name: 'Nome', window: 'Janela do mapa de calor', direction_offset: 'Girar a rosa (só exibição)', max_speed: 'Velocidade máxima (0 = auto)',
      heat_mode: 'Estilo do mapa de calor', heat_direction: 'Sentido do mapa de calor', plume_width: 'Espessura das plumas',
      plume_fade: 'Esmaecimento da ponta', smooth: 'Suavidade das manchas', heat_motion: 'Animar o mapa de calor', pointer: 'Estilo do ponteiro', pointer_color: 'Cor do ponteiro (CSS)',
      show_guide: 'Linha guia da seta', show_speed: 'Ponto da velocidade', show_gust: 'Círculo da rajada', show_rim: 'Círculo externo',
      show_rings: 'Anéis de velocidade', show_spokes: 'Linhas dos setores', show_scale: 'Número da escala', rings: 'Quantidade de anéis',
      sectors: 'Setores da predominante', calm: 'Calmaria abaixo de', refresh: 'Atualização do histórico', max_width: 'Tamanho máximo', tap_action: 'Ação ao tocar',
      map: 'Mapa de fundo', map_radius: 'Raio do mapa', map_opacity: 'Opacidade do mapa', heat_opacity: 'Opacidade do mapa de calor',
      map_latitude: 'Latitude do centro', map_longitude: 'Longitude do centro', map_url: 'URL de tiles própria',
      map_center: 'Centro do mapa', map_shift_north: 'Deslocar ao norte (m)', map_shift_east: 'Deslocar a leste (m)',
      icao: 'Código ICAO do aeródromo', runways: 'Pistas a desenhar',
      runway_heading: 'Rumo da pista (verdadeiro)', runway_name: 'Números da pista', runway_length: 'Comprimento da pista', runway_width: 'Largura da pista', runway_wind: 'Vento de proa / cruzado',
    },
    helpers: {
      entity: `PT2VHF Wind Rose ${VERSION}`,
      heat_direction: 'from: a mancha aponta de onde o vento veio. to: a mancha é soprada pelo vento.',
      plume_fade: 'Quanto a ponta de cada pluma se desfaz. Maior tira os arcos duros; 0 = ponta seca.',
      smooth: 'Só vale quando o estilo do mapa é "spots".',
      heat_motion: 'Balança como biruta e tremula como chama, principalmente com as rajadas (a velocidade soma um pouco). Desliga se o aparelho pedir menos movimento.',
      direction_offset: 'Gira a rosa inteira no sentido horário para combinar com a sua posição. Os valores continuam reais.',
      show_guide: 'Só para o ponteiro "arrow".',
      map: 'As imagens são baixadas do provedor para o centro do mapa (sua casa por padrão).',
      map_radius: 'Distância do centro até a borda, em metros.',
      map_latitude: 'Vazio = local da casa no Home Assistant.',
      map_url: 'Só para "custom", ex.: https://…/{z}/{x}/{y}.png',
      runway_heading: 'Rumo verdadeiro de uma cabeceira em graus (como no mapa). Vazio = sem pista.',
      runway_name: 'Números pintados, ex.: 12/30 (são magnéticos). Vazio = calculado pelo rumo.',
      runway_wind: 'Vento de proa (↓; ↑ = de cauda) e cruzado (← →) para a cabeceira em uso.',
      map_center: 'home (casa), device (este celular/computador) ou uma entidade com coordenadas, ex.: person.eu. Latitude/longitude preenchidas têm prioridade.',
      map_shift_north: 'Ajuste fino em metros; negativo = sul / oeste. A prévia do mapa abaixo ajusta arrastando.',
      icao: 'ex.: SBMT. As pistas vêm do OurAirports; sobre um mapa ficam no lugar e tamanho reais, e o mapa centraliza no aeródromo.',
      runways: 'Vazio = todas as pistas abertas.',
    },
    position: 'Posição do mapa', useLocation: 'Usar minha localização', reset: 'Zerar ajuste', step: 'Passo',
    zoomIn: 'Aproximar', zoomOut: 'Afastar', dragHint: 'Arraste para mover · roda, pinça ou + − para o zoom',
    north: 'Norte', south: 'Sul', west: 'Oeste', east: 'Leste', locating: 'Localizando…',
    noDevice: 'Este aparelho ainda não tem localização salva; usando a casa / o aeródromo. Toque em “Usar minha localização”.',
    found: (code, list) => `${code}: ${list}`, none: (code) => `${code}: nenhuma pista encontrada`, loading: 'Carregando pistas…',
    appearance: 'Aparência',
    mapSection: 'Mapa de fundo',
    runwaySection: 'Pista',
  },
};

/** Editor labels/helpers for a language ("pt", "en"…); unknown languages fall back to English. */
export function editorText(lang) {
  return EDITOR[String(lang || '').slice(0, 2)] || EDITOR.en;
}

// The visual editor has no hass argument, so use the page language HA sets on <html>.
const pageLang = () => globalThis.document?.documentElement?.lang || globalThis.navigator?.language || 'en';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const Base = globalThis.HTMLElement ?? class {};

/** Every optional setting with the value the card uses when it is missing. */
export const DEFAULTS = {
  window: '1h',
  heat_mode: 'plume',
  heat_direction: 'from',
  plume_width: 15,
  plume_fade: 40,
  smooth: 8,
  heat_motion: false,
  calm: 0.5,
  max_speed: 0,
  direction_offset: 0,
  pointer: 'arrow',
  pointer_color: '',
  show_guide: true,
  show_speed: true,
  show_gust: true,
  show_rim: true,
  show_rings: true,
  show_spokes: true,
  show_scale: true,
  rings: 5,
  sectors: 16,
  max_width: 380,
  refresh: 60,
  map: 'none',
  map_radius: 150,
  map_opacity: 100,
  heat_opacity: 100,
  map_latitude: '',
  map_longitude: '',
  map_url: '',
  map_center: 'home',
  map_shift_north: 0,
  map_shift_east: 0,
  icao: '',
  runways: [],
  runway_heading: '',
  runway_length: 70,
  runway_width: 8,
  runway_name: '',
  runway_wind: true,
  tap_action: { action: 'more-info' },
};

export class WindRoseCard extends Base {
  static VERSION = VERSION;

  // A new card's YAML lists every option (same set as the visual editor), so it can be edited later.
  static getStubConfig(hass) {
    const ids = Object.keys(hass?.states || {});
    const dc = (cls) => ids.find((id) => hass.states[id].attributes?.device_class === cls);
    return {
      entity: dc('wind_speed') || '',
      direction_entity: ids.find((id) => /wind.*(dir|bearing)|(dir|bearing).*wind/i.test(id)) || '',
      gust_entity: ids.find((id) => /wind.*gust|gust/i.test(id)) || '',
      rain_entity: '',
      name: '',
      ...structuredClone(DEFAULTS),
    };
  }

  static getConfigElement() { return document.createElement(EDITOR_TAG); }

  static getConfigForm() {
    const T = editorText(pageLang());
    const form = {
      schema: [
        { name: 'entity', required: true, selector: { entity: { domain: 'sensor' } } },
        { name: 'direction_entity', required: true, selector: { entity: { domain: 'sensor' } } },
        { name: 'gust_entity', selector: { entity: { domain: 'sensor' } } },
        { name: 'rain_entity', selector: { entity: { domain: ['binary_sensor', 'sensor'] } } },
        { name: 'name', selector: { text: {} } },
        {
          type: 'grid', name: '', schema: [
            {
              name: 'window',
              selector: {
                select: {
                  mode: 'dropdown', custom_value: true,
                  options: ['15m', '30m', '1h', '2h', '3h', '6h', '12h', '24h'],
                },
              },
            },
            { name: 'direction_offset', selector: { number: { min: -180, max: 180, step: 1, mode: 'box', unit_of_measurement: '°' } } },
            { name: 'max_speed', selector: { number: { min: 0, mode: 'box' } } },
            { name: 'heat_mode', selector: { select: { mode: 'dropdown', options: ['plume', 'spots'] } } },
            {
              name: 'heat_direction',
              selector: {
                select: {
                  mode: 'dropdown',
                  options: [{ value: 'from', label: 'from (where it came from)' }, { value: 'to', label: 'to (blown downwind)' }],
                },
              },
            },
            { name: 'plume_width', selector: { number: { min: 2, max: 45, step: 1, mode: 'slider', unit_of_measurement: '°' } } },
            { name: 'plume_fade', selector: { number: { min: 0, max: 80, step: 1, mode: 'slider', unit_of_measurement: '%' } } },
            { name: 'smooth', selector: { number: { min: 2, max: 25, step: 1, mode: 'slider' } } },
            { name: 'heat_motion', selector: { boolean: {} } },
          ],
        },
        {
          type: 'expandable', name: '', title: T.appearance, schema: [
            {
              name: 'pointer',
              selector: { select: { mode: 'dropdown', options: POINTERS } },
            },
            { name: 'pointer_color', selector: { text: {} } },
            {
              type: 'grid', name: '', schema: [
                { name: 'show_guide', selector: { boolean: {} } },
                { name: 'show_speed', selector: { boolean: {} } },
                { name: 'show_gust', selector: { boolean: {} } },
                { name: 'show_rim', selector: { boolean: {} } },
                { name: 'show_rings', selector: { boolean: {} } },
                { name: 'show_spokes', selector: { boolean: {} } },
                { name: 'show_scale', selector: { boolean: {} } },
                { name: 'rings', selector: { number: { min: 2, max: 12, mode: 'box' } } },
                { name: 'sectors', selector: { number: { min: 4, max: 64, mode: 'box' } } },
                { name: 'calm', selector: { number: { min: 0, max: 5, step: 0.1, mode: 'box' } } },
                { name: 'refresh', selector: { number: { min: 10, max: 3600, mode: 'box', unit_of_measurement: 's' } } },
                { name: 'max_width', selector: { number: { min: 120, max: 1000, mode: 'box', unit_of_measurement: 'px' } } },
              ],
            },
          ],
        },
        {
          type: 'expandable', name: '', title: T.mapSection, schema: [
            { name: 'map', selector: { select: { mode: 'dropdown', options: MAP_TYPES } } },
            { name: 'map_center', selector: { select: { mode: 'dropdown', custom_value: true, options: ['home', 'device'] } } },
            {
              type: 'grid', name: '', schema: [
                { name: 'map_radius', selector: { number: { min: 10, max: 50000, mode: 'box', unit_of_measurement: 'm' } } },
                { name: 'map_opacity', selector: { number: { min: 0, max: 100, step: 5, mode: 'slider', unit_of_measurement: '%' } } },
                { name: 'heat_opacity', selector: { number: { min: 0, max: 100, step: 5, mode: 'slider', unit_of_measurement: '%' } } },
                { name: 'map_latitude', selector: { number: { min: -85, max: 85, step: 'any', mode: 'box' } } },
                { name: 'map_longitude', selector: { number: { min: -180, max: 180, step: 'any', mode: 'box' } } },
                { name: 'map_shift_north', selector: { number: { min: -5000, max: 5000, step: 0.1, mode: 'box', unit_of_measurement: 'm' } } },
                { name: 'map_shift_east', selector: { number: { min: -5000, max: 5000, step: 0.1, mode: 'box', unit_of_measurement: 'm' } } },
              ],
            },
            { name: 'map_url', selector: { text: {} } },
          ],
        },
        {
          type: 'expandable', name: '', title: T.runwaySection, schema: [
            { name: 'icao', selector: { text: {} } },
            { name: 'runways', selector: { select: { multiple: true, custom_value: true, options: [] } } },
            {
              type: 'grid', name: '', schema: [
                { name: 'runway_heading', selector: { number: { min: 0, max: 360, step: 1, mode: 'box', unit_of_measurement: '°' } } },
                { name: 'runway_name', selector: { text: {} } },
                { name: 'runway_wind', selector: { boolean: {} } },
                { name: 'runway_length', selector: { number: { min: 10, max: 100, step: 5, mode: 'slider', unit_of_measurement: '%' } } },
                { name: 'runway_width', selector: { number: { min: 2, max: 30, step: 1, mode: 'slider', unit_of_measurement: '%' } } },
              ],
            },
          ],
        },
        { name: 'tap_action', selector: { ui_action: {} } },
      ],
      computeLabel: (s) => T.labels[s.name],
      computeHelper: (s) => T.helpers[s.name],
    };
    // Show the real defaults (e.g. toggles that are on) even when a key is missing from the YAML.
    const fill = (schema) => schema.forEach((s) => (s.schema ? fill(s.schema) : (s.name in DEFAULTS && DEFAULTS[s.name] !== '' && (s.default = DEFAULTS[s.name]))));
    fill(form.schema);
    return form;
  }

  setConfig(config) {
    if (!config?.entity || !config?.direction_entity) {
      throw new Error('entity (wind speed) and direction_entity are required');
    }
    this._config = {
      ...structuredClone(DEFAULTS),
      ...config,
    };
    // A config that only sets the older 'hours' keeps using it.
    if (config.window == null && config.hours != null) delete this._config.window;
    this._config.sectors = Number(this._config.sectors) || 16;
    this._rose = null;
    this._fetchedAt = 0;
    if (this._hass) this._update(true);
  }

  set hass(hass) {
    this._hass = hass;
    this._update(false);
  }

  getCardSize() { return 3; }

  // Full width by default, height follows content (rows: auto) so nothing gets clipped.
  getGridOptions() { return { columns: 12, min_columns: 3 }; }

  _update(force) {
    if (!this._config || !this._hass) return;
    const c = this._config;
    const watched = [c.entity, c.direction_entity, c.gust_entity, c.rain_entity, String(c.map_center || '').includes('.') ? c.map_center : null]
      .map((id) => this._hass.states[id]);
    const changed = force || watched.some((s, k) => s !== this._last?.[k]);
    this._last = watched;
    if (Date.now() - this._fetchedAt > c.refresh * 1000) this._fetch();
    this._extras();
    if (changed) this._render();
  }

  // Aerodrome runways (icao) and this device's location (map_center: device), loaded once.
  _extras() {
    const c = this._config;
    const code = String(c.icao || '').trim().toUpperCase();
    if (code !== (this._rwyCode ?? '')) {
      this._rwyCode = code;
      this._rwys = [];
      this._rwyErr = null;
      if (code) {
        loadRunways(code).then((r) => {
          if (this._rwyCode !== code) return;
          this._rwys = r;
          this._rwyErr = r.length ? null : `${code}: no runways found`;
          this._render();
        }).catch((e) => { if (this._rwyCode === code) { this._rwyErr = `${code}: ${e.message}`; this._render(); } });
      }
    }
    if (c.map !== 'none' && c.map_center === 'device' && !this._geo && !this._geoAsked) {
      this._geoAsked = true;
      this._geo = savedDevice();
      if (!this._geo) {
        deviceLocation().then((ll) => { this._geo = ll; this._render(); }).catch((e) => { this._geoErr = e.message; this._render(); });
      }
    }
  }

  async _fetch() {
    if (this._busy) return;
    this._busy = true;
    this._fetchedAt = Date.now();
    const c = this._config;
    const end = Date.now();
    const start = end - windowMinutes(c) * 60 * 1000;
    try {
      const res = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        entity_ids: [c.entity, c.direction_entity],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      this._rose = computeRose(toSeries(res[c.entity]), toSeries(res[c.direction_entity]), {
        start, end, sectors: c.sectors, rings: c.rings, maxSpeed: c.max_speed, calm: c.calm,
        // Auto scale also fits the current speed and gust, so their markers stay inside the rose.
        atLeast: Math.max(0, ...[c.entity, c.gust_entity].map((id) => parseFloat(this._hass.states[id]?.state)).filter(Number.isFinite)),
      });
      // The heat image is built once per history refresh, not on every state update.
      this._heat = this._rose.points.length
        ? heatImage(c.heat_mode === 'spots'
          ? density(this._rose.points, HEAT_GRID, (c.smooth ?? 8) / 100)
          // plume_width = angular thickness (σ, degrees); plume_fade = tip fade length, % of the radius
          : plume(this._rose.polar, HEAT_GRID, Math.max(1, Number(c.plume_width) || 15),
            Math.max(0.01, (Number(c.plume_fade) || 0) / 200)), HEAT_GRID) : '';
      this._error = null;
    } catch (e) {
      this._error = e?.message || String(e);
    } finally {
      this._busy = false;
    }
    this._render();
  }

  // HA's frontend runs the standard action (more-info, navigate, toggle, ...) for "hass-action".
  _tap() {
    const c = this._config;
    if ((c.tap_action?.action ?? 'more-info') === 'none') return;
    this.dispatchEvent(new CustomEvent('hass-action', {
      bubbles: true,
      composed: true,
      detail: { config: { entity: c.entity, tap_action: c.tap_action ?? { action: 'more-info' } }, action: 'tap' },
    }));
  }

  _render() {
    const c = this._config;
    const hass = this._hass;
    const lang = (hass.locale?.language || hass.language || 'en').slice(0, 2);
    const L = STR[lang] || STR.en;
    const nf = new Intl.NumberFormat(hass.locale?.language || 'en', { maximumFractionDigits: 1 });
    const sp = hass.states[c.entity];
    const dr = hass.states[c.direction_entity];
    const gu = c.gust_entity ? hass.states[c.gust_entity] : null;
    const unit = sp?.attributes?.unit_of_measurement || '';
    const speed = parseFloat(sp?.state);
    const dir = parseFloat(dr?.state);
    // direction_offset only rotates the drawing (clockwise) to match how the viewer faces the
    // dashboard; measured values and the text stay true.
    const off = withOffset(0, c.direction_offset);
    const view = (a) => withOffset(a, off);
    const gust = parseFloat(gu?.state);
    const raining = c.rain_entity ? isRaining(hass.states[c.rain_entity]) : false;
    const tappable = (c.tap_action?.action ?? 'more-info') !== 'none';
    const rose = this._rose;
    const R = 80;
    const max = rose?.max || c.max_speed || niceMax(Math.max(speed || 0, gust || 0, 1));
    const step = 360 / c.sectors;
    const rr = (v) => Math.min(R, (Math.max(0, v) / max) * R);
    const dirName = (d) => L.dirs[sectorOf(d, 16)];

    // heat_direction "to": the heat is drawn downwind, as if blown by the wind (rotated 180°).
    const heatRot = withOffset(off, c.heat_direction === 'to' ? 180 : 0);
    // The grid spans [-1, 1]² of the unit disc, i.e. exactly the rose's bounding square.
    const heat = this._heat
      ? `<image href="${this._heat}" x="${-R}" y="${-R}" width="${2 * R}" height="${2 * R}" preserveAspectRatio="none"${
        heatRot ? ` transform="rotate(${heatRot})"` : ''}/>` : '';

    // Background map (satellite, streets…) centred on the home location, rotated with the rose.
    let map = '';
    let credit = '';
    let tilesCredit = '';
    const src = mapSource(c);
    const rwys = selectRunways(this._rwys || [], c.runways);
    const ll = rwys.filter((r) => r.hasLL);
    const aerodrome = ll.length
      ? [ll.reduce((a, r) => a + r.le.lat + r.he.lat, 0) / (2 * ll.length), ll.reduce((a, r) => a + r.le.lon + r.he.lon, 0) / (2 * ll.length)] : null;
    const centre = mapCenter(c, hass, { device: this._geo, aerodrome });
    const radiusM = Number(c.map_radius) || 150;
    if (src) {
      const { lat, lon } = centre;
      const px = Math.max(128, (Number(c.max_width) || 380) * 0.4 * (globalThis.devicePixelRatio || 1));
      const m = mapTiles(lat, lon, radiusM, R, px, src.max);
      // +0.2 overlap hides hairline seams between tiles.
      const tiles = m.tiles.map((t) => `<image href="${esc(src.url(m.z, t.x, t.y))}" x="${+t.left.toFixed(3)}" y="${+t.top.toFixed(3)}" width="${+(m.size + 0.2).toFixed(3)}" height="${+(m.size + 0.2).toFixed(3)}" preserveAspectRatio="none"/>`).join('');
      const op = pct(c.map_opacity);
      if (tiles) map = `<g${off ? ` transform="rotate(${off})"` : ''} opacity="${op}">${tiles}</g>`;
      if (tiles) tilesCredit = src.attribution;
      if (tiles && src.attribution) credit = `<text class="credit" x="0" y="98">${esc(src.attribution)}</text>`;
    }
    const heatOp = pct(c.heat_opacity);

    // Runways rotate with the rose. Aerodrome runways with coordinates sit at their real place and size
    // over a map; otherwise (and the manual runway_heading) they are drawn through the centre.
    const lenU = (2 * R * Math.min(100, Math.max(10, Number(c.runway_length) || 70))) / 100;
    const widU = (2 * R * Math.min(30, Math.max(2, Number(c.runway_width) || 8))) / 100;
    const manual = runwayInfo(c.runway_heading, dir, speed, c.runway_name);
    let runway = manual ? runwaySvg(manual, manual.ends[0].heading, lenU, widU) : '';
    for (const r of rwys) {
      const info = runwayInfo(r.le.heading, dir, speed, r.name);
      const p = src ? runwayPlacement(r, centre, radiusM, R) : null;
      runway += p ? runwaySvg(info, p.h, p.L, p.W, p.x, p.y) : runwaySvg(info, r.le.heading, lenU, widU);
    }
    if (runway) runway = `<g clip-path="url(#disc)"><g${off ? ` transform="rotate(${off})"` : ''}>${runway}</g></g>`;
    const rwEnd = bestRunwayEnd([...(manual ? [{ name: manual.ends.map((e) => e.id).join('/'), le: { heading: manual.ends[0].heading } }] : []), ...rwys], dir, speed);
    if (this._rwyErr) credit = `<text class="credit" x="0" y="98">${esc([tilesCredit, this._rwyErr].filter(Boolean).join(' · '))}</text>`;

    // Grid is decoration only: ring count/visibility never touches the heat map.
    let grid = c.show_rim === false ? '' : `<circle r="${R}"/>`;
    if (c.show_rings !== false) for (let r = 1; r < c.rings; r++) grid += `<circle r="${(R * r) / c.rings}"/>`;
    if (c.show_spokes !== false) for (let a = 0; a < 360; a += 45) { const [x, y] = pt(R, view(a)); grid += `<line x2="${x}" y2="${y}"/>`; }
    const labels = [0, 90, 180, 270].map((a) => {
      const [x, y] = pt(R + 10, view(a));
      return `<text class="card" x="${x}" y="${y}">${L.dirs[a / 22.5]}</text>`;
    }).join('');
    // Rim speed, just outside the ring at the lower right.
    const [sx, sy] = pt(R + 7, view(135)); // rotates with the rose, always between E and S
    const scale = c.show_scale === false ? '' : `<text class="scale" x="${sx}" y="${sy}">${nf.format(max)}</text>`;

    let marker = '';
    if (Number.isFinite(dir)) {
      marker = pointerSvg(c.pointer, view(dir), R, { guide: c.show_guide !== false });
      // Speed/gust markers sit on the same side as the heat map (downwind when heat_direction is "to").
      const markDir = withOffset(view(dir), c.heat_direction === 'to' ? 180 : 0);
      if (c.show_gust !== false && Number.isFinite(gust)) { const [x, y] = pt(rr(gust), markDir); marker += `<circle class="gust" cx="${x}" cy="${y}" r="4.5"/>`; }
      if (c.show_speed !== false && Number.isFinite(speed)) { const [x, y] = pt(rr(speed), markDir); marker += `<circle class="now" cx="${x}" cy="${y}" r="4.5"/>`; }
    }

    // Numbers live in the four corners, outside the rose, as secondary information.
    const corner = (x, y, anchor, label, value) => `<text class="lbl" x="${x}" y="${y}" text-anchor="${anchor}">${label}</text>`
      + `<text class="val" x="${x}" y="${y + 12}" text-anchor="${anchor}">${value}</text>`;
    const u = (s) => `<tspan class="unit">${esc(s)}</tspan>`;
    const rain = raining ? ` <tspan class="rain">· ${L.raining}</tspan>` : '';
    let hist = '';
    if (this._error) hist = `<tspan class="err">!</tspan>`;
    else if (rose?.total) {
      const pv = rose.prevailing >= 0 ? `${L.dirs[sectorOf(rose.prevailing * step, 16)]} · ` : '';
      hist = `${pv}${u(`${L.max} `)}${nf.format(rose.peak)}`;
    } else if (rose) hist = u(L.nodata);
    const big = Number.isFinite(speed) ? nf.format(speed) : '—';
    const corners = corner(-98, -92, 'start', `${esc(c.name || L.wind)}${rain}`, `${big}${u(` ${unit}`)}`)
      + corner(98, -92, 'end', L.direction, Number.isFinite(dir) ? `${dirName(dir)} ${u(`${Math.round(dir)}°`)}` : u(L.unavailable))
      + (Number.isFinite(gust) ? corner(-98, 78, 'start', L.gust, `${nf.format(gust)}${u(` ${gu.attributes?.unit_of_measurement || unit}`)}`) : '')
      + (hist ? corner(98, 78, 'end', windowLabel(lang, windowMinutes(c)), hist) : '');

    let rwyWind = '';
    if (rwEnd && c.runway_wind !== false) {
      const a = rwEnd;
      rwyWind = `<text class="rwy-wind" x="-98" y="-66" text-anchor="start"><tspan class="unit">${esc(a.id)} </tspan>${a.head >= 0 ? '↓' : '↑'} ${nf.format(Math.abs(a.head))}</text>`
        + `<text class="rwy-wind" x="98" y="-66" text-anchor="end">${a.side === 'R' ? '←' : '→'} ${nf.format(a.cross)}</text>`;
    }

    if (!this._root) {
      this._root = this.attachShadow({ mode: 'open' });
      // Listeners live on the shadow root so they survive innerHTML re-renders.
      this._root.addEventListener('click', () => this._tap());
      this._root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._tap(); }
      });
    }
    this._root.innerHTML = `
<style>
  ha-card { display: block; padding: 8px; height: 100%; box-sizing: border-box;
    --wr-pointer: ${/^[#\w(),.%\s-]+$/.test(c.pointer_color ?? '') ? c.pointer_color : 'var(--primary-text-color)'}; }
  svg { display: block; width: 100%; max-width: ${c.max_width ?? 380}px; margin: 0 auto; height: auto; aspect-ratio: 1; }
  .grid circle, .grid line { fill: none; stroke: var(--divider-color, #8884); stroke-width: .6; }
  text { fill: var(--secondary-text-color); dominant-baseline: central; font-family: inherit; }
  text.card { font-size: 9px; text-anchor: middle; }
  .rwy { fill: #1d1d1d; fill-opacity: .9; stroke: #fff; stroke-opacity: .7; stroke-width: .5; }
  .rwy-mark rect { fill: #fff; }
  .rwy-cl { stroke: #fff; stroke-width: .7; stroke-dasharray: 3 2.5; }
  text.rwy-id { fill: #fff; text-anchor: middle; font-weight: 700; }
  text.rwy-wind { font-size: 7.5px; fill: var(--primary-text-color); opacity: .85; }
  text.credit { font-size: 4px; text-anchor: middle; opacity: .6; }
  text.scale { font-size: 6.5px; text-anchor: middle; opacity: .8; }
  text.lbl { font-size: 7.5px; opacity: .8; }
  text.val { font-size: 11px; fill: var(--primary-text-color); opacity: .85; }
  tspan.unit { font-size: 7.5px; fill: var(--secondary-text-color); }
  tspan.rain { fill: var(--info-color, #039be5); }
  tspan.err { fill: var(--error-color, #db4437); }
  .arrow, .needle-head { fill: var(--wr-pointer); stroke: var(--card-background-color, #fff); stroke-width: 1; stroke-linejoin: round; }
  .chevron { fill: none; stroke: var(--wr-pointer); stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
  .vane-shaft { stroke: var(--wr-pointer); stroke-width: 2; }
  .needle-tail { fill: var(--secondary-text-color); opacity: .6; }
  .needle-cap { fill: var(--wr-pointer); stroke: var(--card-background-color, #fff); stroke-width: 1; }
  .guide { stroke: var(--primary-text-color); stroke-width: 1; stroke-dasharray: 2 2; opacity: .55; }
  .now { fill: var(--primary-text-color); stroke: var(--card-background-color, #fff); stroke-width: 1.5; }
  .gust { fill: none; stroke: var(--primary-text-color); stroke-width: 1.5; stroke-dasharray: 2 1.5; }
  .sway, .flick { transform-box: view-box; transform-origin: 0 0; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
  .sway { animation-name: wr-sway; }
  .flick { animation-name: wr-flick; }
  @keyframes wr-sway { 0%, 100% { transform: rotate(calc(-1 * var(--wr-sway))); } 50% { transform: rotate(var(--wr-sway)); } }
  @keyframes wr-flick {
    0%, 100% { transform: scale(1); opacity: 1; }
    25% { transform: scale(calc(1 + var(--wr-pulse))); opacity: .85; }
    55% { transform: scale(calc(1 - var(--wr-pulse) / 2)); opacity: 1; }
    80% { transform: scale(calc(1 + var(--wr-pulse) / 2)); opacity: .9; }
  }
  @media (prefers-reduced-motion: reduce) { .sway, .flick { animation: none; } }
  ha-card.tap { cursor: pointer; }
  ha-card:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
</style>
<ha-card class="${tappable ? 'tap' : ''}" ${tappable ? 'role="button" tabindex="0"' : ''}>
  <svg viewBox="-100 -100 200 200" role="img" aria-label="${esc(`${big} ${unit} ${Number.isFinite(dir) ? dirName(dir) : ''}`)}">
    ${this._error ? `<title>${esc(this._error)}</title>` : ''}
    <defs>
      <clipPath id="disc"><circle r="${R}"/></clipPath>
    </defs>
    <g clip-path="url(#disc)">${map}<g opacity="${heatOp}">${heatMotion(heat, { on: c.heat_motion === true, speed, gust, max, now: globalThis.performance?.now() ?? 0 })}</g></g>
    ${runway}
    <g class="grid">${grid}</g>
    ${labels}${scale}${marker}${corners}${rwyWind}${credit}
  </svg>
</ha-card>`;
  }
}

const EDITOR_TAG = `${TAG}-editor`;

/**
 * Visual editor: HA's own form (same fields as getConfigForm) plus a "Map position" panel with a live
 * map preview — drag to move, wheel / pinch / + − to zoom, arrow buttons, "use my location".
 * Everything it changes is saved in the card config (map_shift_north/east, map_radius, map_latitude/longitude).
 */
export class WindRoseEditor extends Base {
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    if (first) this._render();
  }

  connectedCallback() {
    // ha-form is lazy-loaded by HA; loading a built-in card editor makes sure it is defined.
    if (!customElements.get('ha-form')) {
      Promise.resolve(window.loadCardHelpers?.())
        .then((h) => h?.createCardElement({ type: 'entities', entities: [] }))
        .then((el) => el?.constructor?.getConfigElement?.())
        .catch(() => {});
    }
    this._render();
  }

  _emit(patch) {
    this._config = { ...this._config, ...patch };
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
    this._render();
  }

  _render() {
    if (!this._config || !this.isConnected) return;
    const T = editorText(this._hass?.locale?.language || this._hass?.language || pageLang());
    if (!this._root) {
      this._root = this.attachShadow({ mode: 'open' });
      this._root.innerHTML = `<style>
  .pos { margin-top: 16px; border: 1px solid var(--divider-color, #8884); border-radius: 12px; padding: 12px; }
  .pos h3 { margin: 0 0 8px; font-size: 1rem; font-weight: 500; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  svg.mini { width: 200px; max-width: 100%; aspect-ratio: 1; touch-action: none; cursor: grab; border-radius: 50%; background: var(--secondary-background-color, #8882); }
  svg.mini.drag { cursor: grabbing; }
  .rim { fill: none; stroke: var(--primary-text-color); stroke-opacity: .5; stroke-width: 1; }
  .cross { stroke: #e8553e; stroke-width: 1.5; }
  .ctl { display: grid; grid-template-columns: repeat(3, 40px); gap: 6px; }
  button { font: inherit; min-width: 40px; min-height: 40px; border-radius: 8px; border: 1px solid var(--divider-color, #8884);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); cursor: pointer; }
  button:hover { border-color: var(--primary-color); }
  button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
  .side { display: flex; flex-direction: column; gap: 8px; }
  .side label { display: flex; gap: 6px; align-items: center; font-size: .9rem; }
  select { font: inherit; padding: 4px; border-radius: 6px; }
  .wide { padding: 0 12px; }
  .note { font-size: .85rem; color: var(--secondary-text-color); margin-top: 8px; }
  .err { color: var(--error-color, #db4437); }
  .rwy { fill: #1d1d1d; fill-opacity: .85; stroke: #fff; stroke-width: .6; }
</style><div id="form"></div><div id="pos"></div>`;
      this._form = document.createElement('ha-form');
      this._form.addEventListener('value-changed', (e) => {
        e.stopPropagation();
        this._emit(e.detail.value);
      });
      this._root.getElementById('form').append(this._form);
    }
    const c = this._config;
    // Runway list for the ICAO code, offered in the "Runways to draw" dropdown.
    const code = String(c.icao || '').trim().toUpperCase();
    if (code !== (this._code ?? '')) {
      this._code = code;
      this._rwyList = [];
      this._rwyNote = code ? T.loading : '';
      if (code) {
        loadRunways(code).then((r) => {
          if (this._code !== code) return;
          this._rwyList = r;
          this._rwyNote = r.length ? T.found(code, r.map((x) => x.name + (x.closed ? ' ✕' : '')).join(', ')) : T.none(code);
          this._render();
        }).catch((e) => { if (this._code === code) { this._rwyNote = `${code}: ${e.message}`; this._render(); } });
      }
    }
    const form = (this._schema ??= WindRoseCard.getConfigForm());
    const patch = (schema) => schema.forEach((s) => {
      if (s.schema) patch(s.schema);
      if (s.name === 'runways') s.selector.select.options = (this._rwyList || []).map((r) => r.name);
    });
    if (this._patched !== this._rwyList) { this._patched = this._rwyList; patch(form.schema); form.schema = [...form.schema]; }
    this._form.hass = this._hass;
    this._form.data = c;
    this._form.schema = form.schema;
    this._form.computeLabel = form.computeLabel;
    this._form.computeHelper = (s) => (s.name === 'icao' && this._rwyNote ? this._rwyNote : form.computeHelper(s));
    this._renderPosition(T);
  }

  _renderPosition(T) {
    const pos = this._root.getElementById('pos');
    const c = { ...DEFAULTS, ...this._config };
    const src = mapSource(c);
    if (!src) { pos.innerHTML = ''; return; }
    const rwys = selectRunways(this._rwyList || [], c.runways);
    const ll = rwys.filter((r) => r.hasLL);
    const aerodrome = ll.length
      ? [ll.reduce((a, r) => a + r.le.lat + r.he.lat, 0) / (2 * ll.length), ll.reduce((a, r) => a + r.le.lon + r.he.lon, 0) / (2 * ll.length)] : null;
    const centre = mapCenter(c, this._hass, { device: savedDevice(), aerodrome });
    const radius = Number(c.map_radius) || 150;
    const R = 80;
    const m = mapTiles(centre.lat, centre.lon, radius, R, 100 * (globalThis.devicePixelRatio || 1), src.max);
    const tiles = m.tiles.map((t) => `<image href="${esc(src.url(m.z, t.x, t.y))}" x="${+t.left.toFixed(3)}" y="${+t.top.toFixed(3)}" width="${+(m.size + 0.2).toFixed(3)}" height="${+(m.size + 0.2).toFixed(3)}" preserveAspectRatio="none"/>`).join('');
    const runways = rwys.map((r) => {
      const p = runwayPlacement(r, centre, radius, R);
      return p ? `<rect class="rwy" x="${-p.W / 2}" y="${-p.L / 2}" width="${Math.max(1.5, p.W)}" height="${p.L}" transform="translate(${p.x} ${p.y}) rotate(${p.h})"/>` : '';
    }).join('');
    const step = this._step || 5;
    const focus = ['data-move', 'data-zoom', 'data-reset', 'id'].map((k) => { const v = this._root.activeElement?.getAttribute(k); return v == null ? '' : `[${k}="${v}"]`; }).find(Boolean);
    const fmt = (v) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(v);
    pos.innerHTML = `<div class="pos">
  <h3>${T.position}</h3>
  <div class="row">
    <svg class="mini" viewBox="-80 -80 160 160" role="img" aria-label="${esc(T.dragHint)}">
      <clipPath id="c"><circle r="80"/></clipPath>
      <g clip-path="url(#c)"><g id="pan">${tiles}${runways}</g></g>
      <circle class="rim" r="79.5"/>
      <path class="cross" d="M-8 0H8M0-8V8"/>
    </svg>
    <div class="side">
      <div class="ctl">
        <span></span><button data-move="n" title="${T.north}" aria-label="${T.north}">↑</button><button data-zoom="in" title="${T.zoomIn}" aria-label="${T.zoomIn}">+</button>
        <button data-move="w" title="${T.west}" aria-label="${T.west}">←</button><button data-reset title="${T.reset}" aria-label="${T.reset}">⌖</button><button data-move="e" title="${T.east}" aria-label="${T.east}">→</button>
        <span></span><button data-move="s" title="${T.south}" aria-label="${T.south}">↓</button><button data-zoom="out" title="${T.zoomOut}" aria-label="${T.zoomOut}">−</button>
      </div>
      <label>${T.step} <select id="step">${[1, 5, 25, 100].map((v) => `<option value="${v}"${v === step ? ' selected' : ''}>${v} m</option>`).join('')}</select></label>
      <button class="wide" id="locate">${T.useLocation}</button>
    </div>
  </div>
  <div class="note">${esc(T.dragHint)} · ${fmt(radius)} m · ${Number.isFinite(centre.lat) ? `${fmt(centre.lat)}, ${fmt(centre.lon)}` : '—'}
    ${c.map_center === 'device' && centre.source !== 'device' && centre.source !== 'manual' ? `<div class="err">${T.noDevice}</div>` : ''}
    ${this._geoNote ? `<div class="${this._geoErr ? 'err' : ''}">${esc(this._geoNote)}</div>` : ''}</div>
</div>`;
    this._wirePosition(pos, c, radius, R);
    if (focus) pos.querySelector(focus)?.focus();
  }

  _wirePosition(pos, c, radius, R) {
    const svg = pos.querySelector('svg.mini');
    const pan = pos.querySelector('#pan');
    const round = (v) => Math.round(v * 10) / 10;
    const shift = (north, east) => this._emit({
      map_shift_north: round((Number(c.map_shift_north) || 0) + north),
      map_shift_east: round((Number(c.map_shift_east) || 0) + east),
    });
    const zoom = (f) => this._emit({ map_radius: Math.round(Math.min(50000, Math.max(10, radius / f))) });
    const step = () => this._step || 5;
    pos.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const d = { n: [1, 0], s: [-1, 0], e: [0, 1], w: [0, -1] }[b.dataset.move];
      shift(d[0] * step(), d[1] * step());
    }));
    pos.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => zoom(b.dataset.zoom === 'in' ? 1.25 : 0.8)));
    pos.querySelector('[data-reset]').addEventListener('click', () => this._emit({ map_shift_north: 0, map_shift_east: 0 }));
    pos.querySelector('#step').addEventListener('change', (e) => { this._step = Number(e.target.value); });
    pos.querySelector('#locate').addEventListener('click', () => {
      const T = editorText(this._hass?.locale?.language || pageLang());
      this._geoNote = T.locating;
      this._geoErr = false;
      this._render();
      deviceLocation().then(([lat, lon]) => {
        this._geoNote = '';
        this._emit({ map_latitude: lat, map_longitude: lon, map_shift_north: 0, map_shift_east: 0 });
      }).catch((e) => { this._geoNote = e.message; this._geoErr = true; this._render(); });
    });

    // Drag to move, pinch / wheel to zoom. The preview moves live; the config is saved on release.
    const unit = () => 160 / svg.getBoundingClientRect().width; // svg units per CSS px
    const pts = new Map();
    let start = null;
    let dx = 0;
    let dy = 0;
    let k = 1;
    const live = () => pan.setAttribute('transform', `translate(${dx} ${dy}) scale(${k})`);
    const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      start = { x: e.clientX, y: e.clientY, dx, dy, k, d: pts.size === 2 ? spread() : 0 };
      svg.classList.add('drag');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !start) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && start.d) k = Math.min(8, Math.max(0.125, start.k * (spread() / start.d)));
      else if (pts.size === 1) { dx = start.dx + (e.clientX - start.x) * unit(); dy = start.dy + (e.clientY - start.y) * unit(); }
      live();
    });
    const end = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size) { const [p] = pts.values(); start = { x: p.x, y: p.y, dx, dy, k, d: 0 }; return; }
      svg.classList.remove('drag');
      start = null;
      const mpu = radius / R / k; // metres per svg unit after the zoom
      const patch = {};
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        // Dragging the map right brings what was west to the centre: the centre moves west.
        patch.map_shift_north = round((Number(c.map_shift_north) || 0) + dy * mpu);
        patch.map_shift_east = round((Number(c.map_shift_east) || 0) - dx * mpu);
      }
      if (Math.abs(k - 1) > 0.01) patch.map_radius = Math.round(Math.min(50000, Math.max(10, radius / k)));
      if (Object.keys(patch).length) this._emit(patch);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    let wheelT = 0;
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      k = Math.min(8, Math.max(0.125, k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      live();
      clearTimeout(wheelT);
      wheelT = setTimeout(() => { const kk = k; k = 1; dx = 0; dy = 0; this._emit({ map_radius: Math.round(Math.min(50000, Math.max(10, radius / kk))) }); }, 350);
    }, { passive: false });
  }
}

// Only the first copy that loads is used. A second dashboard resource (often an older version left
// behind) silently wins the race, so say so loudly — this is the usual cause of "option X does nothing".
const loaded = globalThis.customElements?.get(TAG);
if (loaded && loaded.VERSION !== VERSION) {
  console.warn(`PT2VHF Wind Rose: version ${loaded.VERSION ?? '< 0.9.0'} is already loaded, so this copy (${VERSION}) is ignored. `
    + 'Remove the extra pt2vhf-wind-rose-card.js entry in Settings → Dashboards → ⋮ → Resources and clear the browser cache.');
}
if (globalThis.customElements && !loaded) {
  customElements.define(TAG, WindRoseCard);
  if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, WindRoseEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: TAG,
    name: 'PT2VHF Wind Rose',
    description: 'Compact wind direction & speed card with a heat-map rose of the last hours.',
    preview: true,
    documentationURL: 'https://github.com/alexpmr/pt2vhf-wind-rose',
  });
  console.info(`%c PT2VHF-WIND-ROSE %c ${VERSION} `, 'background:#2b4c9b;color:#fff', 'background:#e8553e;color:#fff');
}
