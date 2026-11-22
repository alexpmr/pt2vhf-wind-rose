import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRose, toSeries, sectorOf, niceMax, isRaining, density } from '../pt2vhf-wind-rose-card.js';

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
