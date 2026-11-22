/*
 * PT2VHF Wind Rose Card — compact wind direction/speed card for Home Assistant.
 * The rose is a polar heat map of the last N hours: angle = direction the wind
 * comes FROM, distance from the centre = speed, colour = how much time it blew there.
 * https://github.com/alexpmr/pt2vhf-wind-rose
 */
const VERSION = '0.6.0';
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
  let calmN = 0;
  let sum = 0;
  for (const [s, d] of samples) {
    sum += s;
    if (s < calm) { calmN++; continue; }
    const r = Math.min(1, s / max);
    const rad = (d * Math.PI) / 180;
    points.push([r * Math.sin(rad), -r * Math.cos(rad)]);
    const a = sectorOf(d, sectors);
    counts[a][Math.min(rings - 1, Math.floor((s / max) * rings))]++;
    bySector[a]++;
  }
  const total = samples.length;
  const best = bySector.indexOf(Math.max(...bySector));
  return {
    counts, total, max, peak, points,
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

const LABELS = {
  entity: 'Wind speed', direction_entity: 'Wind direction (degrees)', gust_entity: 'Gust', rain_entity: 'Rain',
  name: 'Name', window: 'Heat-map window', direction_offset: 'Rotate rose (display only)', max_speed: 'Max speed (0 = auto)',
  smooth: 'Heat-map softness', pointer: 'Pointer style', pointer_color: 'Pointer colour (CSS)',
  show_guide: 'Arrow guide line', show_speed: 'Current speed dot', show_gust: 'Gust ring', show_rim: 'Outer circle', show_rings: 'Speed rings', show_spokes: 'Spokes', show_scale: 'Scale label', rings: 'Ring count',
  sectors: 'Prevailing bins', max_width: 'Max size', tap_action: 'Tap action',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const Base = globalThis.HTMLElement ?? class {};

class WindRoseCard extends Base {
  static getStubConfig(hass) {
    const ids = Object.keys(hass?.states || {});
    const dc = (cls) => ids.find((id) => hass.states[id].attributes?.device_class === cls);
    return {
      entity: dc('wind_speed') || '',
      direction_entity: ids.find((id) => /wind.*(dir|bearing)|(dir|bearing).*wind/i.test(id)) || '',
    };
  }

  static getConfigForm() {
    return {
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
            { name: 'smooth', selector: { number: { min: 2, max: 25, step: 1, mode: 'slider' } } },
          ],
        },
        {
          type: 'expandable', name: '', title: 'Appearance', schema: [
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
                { name: 'sectors', selector: { select: { options: ['8', '16', '32'] } } },
                { name: 'max_width', selector: { number: { min: 120, max: 1000, mode: 'box', unit_of_measurement: 'px' } } },
              ],
            },
          ],
        },
        { name: 'tap_action', selector: { ui_action: {} } },
      ],
      computeLabel: (s) => LABELS[s.name],
    };
  }

  setConfig(config) {
    if (!config?.entity || !config?.direction_entity) {
      throw new Error('entity (wind speed) and direction_entity are required');
    }
    this._config = {
      sectors: 16, rings: 5, calm: 0.5, refresh: 60, ...config,
    };
    this._config.sectors = Number(this._config.sectors);
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
    const watched = [c.entity, c.direction_entity, c.gust_entity, c.rain_entity].map((id) => this._hass.states[id]);
    const changed = force || watched.some((s, k) => s !== this._last?.[k]);
    this._last = watched;
    if (Date.now() - this._fetchedAt > c.refresh * 1000) this._fetch();
    if (changed) this._render();
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
        ? heatImage(density(this._rose.points, HEAT_GRID, (c.smooth ?? 8) / 100), HEAT_GRID) : '';
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

    // The grid spans [-1, 1]² of the unit disc, i.e. exactly the rose's bounding square.
    const heat = this._heat
      ? `<image href="${this._heat}" x="${-R}" y="${-R}" width="${2 * R}" height="${2 * R}" preserveAspectRatio="none"${
        off ? ` transform="rotate(${off})"` : ''}/>` : '';

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
      if (c.show_gust !== false && Number.isFinite(gust)) { const [x, y] = pt(rr(gust), view(dir)); marker += `<circle class="gust" cx="${x}" cy="${y}" r="4.5"/>`; }
      if (c.show_speed !== false && Number.isFinite(speed)) { const [x, y] = pt(rr(speed), view(dir)); marker += `<circle class="now" cx="${x}" cy="${y}" r="4.5"/>`; }
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
  ha-card.tap { cursor: pointer; }
  ha-card:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
</style>
<ha-card class="${tappable ? 'tap' : ''}" ${tappable ? 'role="button" tabindex="0"' : ''}>
  <svg viewBox="-100 -100 200 200" role="img" aria-label="${esc(`${big} ${unit} ${Number.isFinite(dir) ? dirName(dir) : ''}`)}">
    ${this._error ? `<title>${esc(this._error)}</title>` : ''}
    <defs>
      <clipPath id="disc"><circle r="${R}"/></clipPath>
    </defs>
    <g clip-path="url(#disc)">${heat}</g>
    <g class="grid">${grid}</g>
    ${labels}${scale}${marker}${corners}
  </svg>
</ha-card>`;
  }
}

if (globalThis.customElements && !customElements.get(TAG)) {
  customElements.define(TAG, WindRoseCard);
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
