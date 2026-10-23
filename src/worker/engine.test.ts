import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from './engine.ts';
import type { RawEvent, Scene } from './scenes/scene.ts';

const DT = 0.001;
const PERIOD = 0.5003; // off the 1 ms grid

// One event every PERIOD sim seconds, at its exact moment inside the step that contains it.
function ticker(): Scene {
  return {
    step(t, dt) {
      const k = Math.floor((t + dt) / PERIOD);
      const at = k * PERIOD;
      const out: RawEvent[] = [];
      if (k > 0 && at > t && at <= t + dt) out.push({ type: 'tick', bodyId: 0, simTime: at, force: 1, position: [0, 0, 0] });
      return out;
    },
    positions: () => new Float32Array(3),
    energy: () => 0,
    info: () => ({ radii: [0.1], flat: { center: [0, 0], size: [1, 1] } }),
    setParams() {},
  };
}

function run(rate: number, seconds: number) {
  const engine = createEngine(ticker(), DT, () => rate);
  const events = [];
  for (let i = 0; i < seconds * 1000; i++) events.push(...engine.step());
  return events;
}

test('events land at their exact fractional moment, not on the 1 ms grid', () => {
  const events = run(1, 20);
  assert.equal(events.length, Math.floor(20 / PERIOD));
  events.forEach((e, k) => assert.ok(Math.abs(e.simTime - (k + 1) * PERIOD) < 1e-9, `event ${k}: ${e.simTime}`));
});

test('warp rate scales output time', () => {
  const events = run(2, 5);
  events.forEach((e) => assert.ok(Math.abs(e.at - e.simTime * 2) < 1e-9));
});
