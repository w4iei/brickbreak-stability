import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PARAMS, type SimParams } from '../../protocol.ts';
import { mulberry32 } from '../../rng.ts';
import { breakout } from './breakout.ts';
import { rapierReady } from './index.ts';
import type { Forecast, RawEvent } from './scene.ts';
import { boxToi } from './toi.ts';

const DT = 0.001;
const base: SimParams = { ...DEFAULT_PARAMS, palette: 'emotions', seed: 5, autoplay: true };

function run(p: SimParams, seconds: number) {
  const scene = breakout(p, mulberry32(p.seed));
  const events: RawEvent[] = [];
  const forecasts: { at: number; hits: Forecast[]; ms: number }[] = [];
  for (let i = 0; i < seconds / DT; i++) {
    const t0 = performance.now();
    events.push(...scene.step(i * DT, DT));
    const f = scene.forecast?.();
    if (f) forecasts.push({ at: (i + 1) * DT, hits: f, ms: performance.now() - t0 });
  }
  scene.dispose?.();
  return { events, forecasts };
}

test('boxToi: ball meets a box face, misses beside it, is inside it', () => {
  const c = { x: 0, y: 2 };
  assert.ok(Math.abs(boxToi({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, c, [0.5, 0.2], 0.1)! - 1.7) < 1e-12);
  assert.equal(boxToi({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, c, [0.5, 0.2], 0.1), undefined);
  assert.ok(boxToi({ x: 0, y: 2, z: 0 }, { x: 0, y: 1, z: 0 }, c, [0.5, 0.2], 0.1)! < 0);
});

test('same seed + params → identical hits', async () => {
  await rapierReady;
  const a = run(base, 40).events;
  assert.ok(a.length > 10, `expected brick hits, got ${a.length}`);
  assert.deepEqual(run(base, 40).events, a);
});

test('jelly bricks let go on the beat: every hit lands on the grid; without jelly they land anywhere', async () => {
  await rapierReady;
  const beat = 60 / 140; // the scene's own grid until the worker hands over the music's
  const offGrid = (events: RawEvent[], unit: number) => events.filter((e) => Math.abs(e.simTime / unit - Math.round(e.simTime / unit)) > 1e-6);
  const beats = run({ ...base, jelly: 'beat' }, 40).events;
  const bars = run({ ...base, jelly: 'bar' }, 40).events;
  const off = run({ ...base, jelly: 'off' }, 40).events;
  assert.ok(beats.length > 10 && bars.length > 5 && off.length > 10);
  assert.equal(offGrid(beats, beat).length, 0);
  assert.equal(offGrid(bars, 4 * beat).length, 0);
  assert.ok(offGrid(off, beat).length > off.length / 2);
});

test('one permanent row: every climb ends in one brick hit, and bricks never go', async () => {
  await rapierReady;
  const { events } = run(base, 60);
  const ids = new Set(events.map((e) => e.bodyId));
  assert.ok(ids.size >= 8, `only ${ids.size} bricks hit in 60 s`);
  assert.ok(events.every((e) => e.type === 'brick'));
  // The ball goes back down to the paddle between hits: no two hits close together.
  const gaps = events.slice(1).map((e, i) => e.simTime - events[i].simTime);
  assert.ok(Math.min(...gaps) > 1, `two hits ${Math.min(...gaps).toFixed(3)} s apart`);
});

test('certain forecast hits happen: same brick, same moment', async () => {
  await rapierReady;
  const { events, forecasts } = run(base, 60);
  const certain = forecasts.flatMap((f) => f.hits.filter((h) => h.weight === 1).map((h) => ({ ...h, at: f.at + h.inSec })));
  assert.ok(certain.length > 10, `only ${certain.length} certain forecast hits`);
  const met = certain.filter((h) => events.some((e) => e.bodyId === h.bodyId && Math.abs(e.simTime - h.at) < 0.02));
  const rate = met.length / certain.length;
  const ms = forecasts.map((f) => f.ms).sort((a, b) => a - b);
  console.log(`certain hits met ${met.length}/${certain.length}; forecast step ms median ${ms[ms.length >> 1].toFixed(2)} max ${ms.at(-1)!.toFixed(2)}`);
  assert.ok(rate > 0.9, `only ${(rate * 100).toFixed(0)} % of certain forecast hits happened`);
});

test('autoplay branch: the first hit after the next paddle bounce is usually the one forecast', async () => {
  await rapierReady;
  const { events, forecasts } = run(base, 60);
  // For each forecast, its first branch hit (weight < 1) against the first real hit after the last certain one.
  let tried = 0;
  let met = 0;
  for (const f of forecasts) {
    const branch = f.hits.find((h) => h.weight < 1);
    if (!branch) continue;
    tried++;
    const at = f.at + branch.inSec;
    if (events.some((e) => e.bodyId === branch.bodyId && Math.abs(e.simTime - at) < 0.1)) met++;
  }
  console.log(`autoplay branch first hits met ${met}/${tried}`);
  assert.ok(tried > 5 && met / tried > 0.6, `branch forecast met ${met}/${tried}`);
});
