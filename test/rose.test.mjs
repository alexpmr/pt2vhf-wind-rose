import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRose, toSeries, sectorOf, niceMax, isRaining, density, withOffset, windowMinutes, windowLabel, pointerSvg, plume, WindRoseCard, DEFAULTS,
} from '../pt2vhf-wind-rose-card.js';

// Value of an n×n grid at polar (rho in unit radius, bearing in degrees; 0 = N, clockwise).
const at = (g, n, rho, deg) => {
  const a = (deg * Math.PI) / 180;
  const i = Math.floor(((rho * Math.sin(a) + 1) / 2) * n);
  const j = Math.floor(((-rho * Math.cos(a) + 1) / 2) * n);
  return g[j * n + i];
};

test('plume: a steady wind paints from the centre out to its speed, then fades', () => {
  const n = 96;
  const g = plume([[0.66, 90]], n, 10);
  // Very close to the centre one grid cell spans several degrees, so start the check at 0.2.
  const ray = [0.2, 0.3, 0.5, 0.6, 0.72, 0.85].map((r) => at(g, n, r, 90));
  for (let k = 0; k < 4; k++) assert.ok(ray[k] > 0.9, `full up to the speed ${ray}`);
  assert.ok(ray[4] < 0.05 && ray[5] < 0.05, `empty past the speed ${ray}`);
  assert.ok(at(g, n, 0.5, 270) < 0.01, 'opposite side stays empty');
});

test('plume: equal time from N and S → equal heat at the centre, stronger one reaches further', () => {
  const n = 96;
  const pts = [...Array(50).fill([0.2, 0]), ...Array(50).fill([0.6, 180])];
  const g = plume(pts, n, 10);
  const nIn = at(g, n, 0.1, 0);
  const sIn = at(g, n, 0.1, 180);
  assert.ok(Math.abs(nIn - sIn) < 0.05, `centre ${nIn} vs ${sIn}`);
  assert.ok(at(g, n, 0.4, 0) < 0.05, 'N plume ends near 0.2');
  assert.ok(at(g, n, 0.4, 180) > 0.9, 'S plume still strong at 0.4');
});

test('plume: wraps at north, symmetric around it', () => {
  const n = 96;
  const g = plume([[0.5, 355], [0.5, 5]], n, 8);
  assert.ok(at(g, n, 0.3, 0) > 0.9);
  assert.ok(Math.abs(at(g, n, 0.3, 20) - at(g, n, 0.3, 340)) < 0.05);
  assert.ok(plume([], 8, 8).every((v) => v === 0));
});

test('new-card YAML lists every option of the visual editor, with the defaults the card uses', () => {
  const names = [];
  const walk = (schema) => schema.forEach((s) => (s.schema ? walk(s.schema) : names.push(s.name)));
  walk(WindRoseCard.getConfigForm().schema);
  const stub = WindRoseCard.getStubConfig({ states: {} });
  for (const n of names) assert.ok(n in stub, `missing in stub: ${n}`);
  for (const [k, v] of Object.entries(DEFAULTS)) assert.deepEqual(stub[k], v, k);
});

test('setConfig fills defaults but an old "hours" config still wins over the default window', () => {
  const card = new WindRoseCard();
  card.setConfig({ entity: 'sensor.s', direction_entity: 'sensor.d', hours: 3 });
  assert.equal(windowMinutes(card._config), 180);
  assert.equal(card._config.show_rings, true);
  card.setConfig({ entity: 'sensor.s', direction_entity: 'sensor.d' });
  assert.equal(windowMinutes(card._config), 60);
  assert.equal(card._config.heat_mode, 'plume');
});

test('computeRose exposes polar samples (r in unit radius, degrees)', () => {
  const r = computeRose([{ t: 0, v: 5 }], [{ t: 0, v: 90 }], { start, end, maxSpeed: 10 });
  assert.deepEqual(r.polar[0], [0.5, 90]);
});

test('withOffset adds degrees and wraps to [0, 360)', () => {
  assert.equal(withOffset(350, 20), 10);
  assert.equal(withOffset(10, -20), 350);
  assert.equal(withOffset(90, 0), 90);
  assert.equal(withOffset(90, 720), 90);
  assert.ok(Number.isNaN(withOffset(NaN, 10)));
});

test('windowMinutes reads window (m/h/plain minutes) and falls back to hours', () => {
  assert.equal(windowMinutes({}), 60);
  assert.equal(windowMinutes({ hours: 2 }), 120);
  assert.equal(windowMinutes({ window: '30m' }), 30);
  assert.equal(windowMinutes({ window: '15 min' }), 15);
  assert.equal(windowMinutes({ window: '6h' }), 360);
  assert.equal(windowMinutes({ window: '1.5h' }), 90);
  assert.equal(windowMinutes({ window: 45 }), 45);
  assert.equal(windowMinutes({ window: '2h', hours: 5 }), 120); // window wins
  assert.equal(windowMinutes({ window: 'nonsense', hours: 3 }), 180);
  assert.equal(windowMinutes({ window: '0m' }), 60);
});

test('windowLabel in pt and en', () => {
  assert.equal(windowLabel('pt', 60), 'Última hora');
  assert.equal(windowLabel('pt', 30), 'Últimos 30 min');
  assert.equal(windowLabel('pt', 360), 'Últimas 6 h');
  assert.equal(windowLabel('pt', 90), 'Últimas 1,5 h');
  assert.equal(windowLabel('en', 60), 'Last hour');
  assert.equal(windowLabel('en', 15), 'Last 15 min');
  assert.equal(windowLabel('en', 120), 'Last 2 h');
});

test('pointerSvg: every style draws, none draws nothing, unknown falls back to arrow', () => {
  assert.equal(pointerSvg('none', 90, 80), '');
  for (const s of ['arrow', 'chevron', 'dart', 'needle', 'compass', 'vane']) assert.match(pointerSvg(s, 90, 80), /<path/);
  assert.equal(pointerSvg('bogus', 90, 80), pointerSvg('arrow', 90, 80));
  // Wind from the east (90°): arrow tip sits on the +x axis inside the rim.
  assert.match(pointerSvg('arrow', 90, 80), /d="M65 0L/);
});

test('pointerSvg: the arrow guide line can be turned off', () => {
  assert.match(pointerSvg('arrow', 90, 80), /class="guide"/);
  const noGuide = pointerSvg('arrow', 90, 80, { guide: false });
  assert.doesNotMatch(noGuide, /class="guide"/);
  assert.match(noGuide, /class="arrow"/);
});

test('ring count never changes the heat map', () => {
  const sp = [{ t: 0, v: 3 }, { t: H / 3, v: 7 }, { t: H / 2, v: 1.8 }];
  const dr = [{ t: 0, v: 300 }, { t: H / 4, v: 20 }, { t: H / 2, v: 340 }];
  const a = computeRose(sp, dr, { start, end, rings: 3, maxSpeed: 10 });
  const b = computeRose(sp, dr, { start, end, rings: 9, maxSpeed: 10 });
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(Array.from(density(a.points, 32, 0.08)), Array.from(density(b.points, 32, 0.08)));
});

const argmax = (g) => g.reduce((b, v, i) => (v > g[b] ? i : b), 0);

test('density: single point peaks at its own cell, normalised to 1, symmetric', () => {
  const n = 40;
  const g = density([[0.525, -0.475]], n, 0.1); // centre of cell (30, 10)
  const k = argmax(g);
  const [i, j] = [k % n, Math.floor(k / n)];
  assert.equal(g[k], 1);
  assert.deepEqual([i, j], [30, 10]);
  assert.ok(Math.abs(g[j * n + i - 3] - g[j * n + i + 3]) < 1e-6);
  assert.ok(Math.abs(g[(j - 3) * n + i] - g[(j + 3) * n + i]) < 1e-6);
  assert.equal(g[0], 0); // far corner untouched (kernel cut-off)
});

test('density: points either side of north merge into one peak on the north axis', () => {
  const n = 40;
  const r = computeRose([{ t: 0, v: 5 }], [{ t: 0, v: 355 }, { t: H / 2, v: 5 }], { start, end, maxSpeed: 10 });
  const g = density(r.points, n, 0.08);
  const k = argmax(g);
  const x = ((k % n) + 0.5) * (2 / n) - 1;
  const y = (Math.floor(k / n) + 0.5) * (2 / n) - 1;
  assert.ok(Math.abs(x) <= 2 / n, `peak x ${x}`);
  assert.ok(y < -0.4 && y > -0.6, `peak y ${y}`);
});

test('density: empty input gives an all-zero grid', () => {
  assert.ok(density([], 10, 0.1).every((v) => v === 0));
});

test('computeRose exposes non-calm points in unit-disc x/y (north = -y)', () => {
  const r = computeRose([{ t: 0, v: 5 }], [{ t: 0, v: 90 }], { start, end, maxSpeed: 10 });
  assert.equal(r.points.length, r.total);
  const [x, y] = r.points[0];
  assert.ok(Math.abs(x - 0.5) < 1e-9 && Math.abs(y) < 1e-9);
});

test('isRaining accepts binary "on" and positive numbers only', () => {
  assert.equal(isRaining({ state: 'on' }), true);
  assert.equal(isRaining({ state: 'off' }), false);
  assert.equal(isRaining({ state: '0.4' }), true);
  assert.equal(isRaining({ state: '0' }), false);
  assert.equal(isRaining({ state: 'unavailable' }), false);
  assert.equal(isRaining(undefined), false);
});

const H = 3600 * 1000;
const start = 0;
const end = H;

test('sectorOf wraps and rounds to nearest sector', () => {
  assert.equal(sectorOf(0, 16), 0);
  assert.equal(sectorOf(359, 16), 0);
  assert.equal(sectorOf(-10, 16), 0);
  assert.equal(sectorOf(90, 16), 4);
  assert.equal(sectorOf(339, 16), 15); // NNW
  assert.equal(sectorOf(720 + 180, 8), 4);
});

test('niceMax picks a round ceiling', () => {
  assert.equal(niceMax(3), 4);
  assert.equal(niceMax(10.6), 12);
  assert.equal(niceMax(12.4), 15);
  assert.equal(niceMax(250), 250);
});

test('toSeries parses minimal history rows, keeps unknown as NaN, sorts', () => {
  const s = toSeries([{ s: '5', lu: 20 }, { s: 'unavailable', lc: 10 }]);
  assert.deepEqual(s.map((p) => p.t), [10000, 20000]);
  assert.ok(Number.isNaN(s[0].v));
  assert.equal(s[1].v, 5);
});

test('steady wind lands in a single cell', () => {
  const r = computeRose([{ t: 0, v: 7 }], [{ t: 0, v: 90 }], { start, end, sectors: 16, rings: 5, maxSpeed: 10 });
  assert.equal(r.counts[4][3], r.total); // 7/10*5 = ring 3
  assert.equal(r.prevailing, 4);
  assert.equal(r.calm, 0);
  assert.equal(r.avg, 7);
});

test('time-weighting: half the hour from N, half from S', () => {
  const r = computeRose(
    [{ t: 0, v: 4 }],
    [{ t: 0, v: 0 }, { t: H / 2, v: 180 }],
    { start, end, sectors: 8, rings: 4, maxSpeed: 8 },
  );
  assert.equal(r.counts[0][2], r.counts[4][2]);
  assert.equal(r.counts[0][2] + r.counts[4][2], r.total);
});

test('calm samples are counted apart and excluded from sectors', () => {
  const r = computeRose([{ t: 0, v: 0 }, { t: H / 4, v: 3 }], [{ t: 0, v: 270 }], { start, end, maxSpeed: 10 });
  assert.ok(Math.abs(r.calm - 0.25) < 0.01);
  assert.equal(r.counts.flat().reduce((a, b) => a + b, 0), Math.round(r.total * 0.75));
});

test('auto max uses observed peak; speed above max clamps to outer ring', () => {
  const r = computeRose([{ t: 0, v: 12 }, { t: H / 2, v: 30 }], [{ t: 0, v: 45 }], { start, end, rings: 5, maxSpeed: 20 });
  assert.equal(r.max, 20);
  assert.ok(r.counts[2][4] > 0);
  const auto = computeRose([{ t: 0, v: 12 }], [{ t: 0, v: 45 }], { start, end });
  assert.equal(auto.max, 12);
  const withGust = computeRose([{ t: 0, v: 12 }], [{ t: 0, v: 45 }], { start, end, atLeast: 13 });
  assert.equal(withGust.max, 15);
});

test('no data before first sample and unavailable values are skipped', () => {
  const r = computeRose([{ t: H / 2, v: 5 }], [{ t: 0, v: 10 }, { t: 3 * H / 4, v: NaN }], { start, end, maxSpeed: 10 });
  assert.ok(r.total > 0 && r.total < 1440 / 3);
  const none = computeRose([], [], { start, end });
  assert.equal(none.total, 0);
  assert.equal(none.prevailing, -1);
});
