import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRose, toSeries, sectorOf, niceMax, isRaining } from '../pt2vhf-wind-rose-card.js';

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
