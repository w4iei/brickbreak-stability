import type { RawEvent, Scene } from './scenes/scene.ts';

export interface TimedEvent extends RawEvent {
  at: number; // warped seconds since start
}

// Pure fixed-step core, no timers or messaging, so it runs headless in Node.
// Sim time → output time: warped += dt * rate(); events land at their exact fractional moment.
export function createEngine(scene: Scene, dt: number, rate: () => number) {
  let steps = 0;
  let warped = 0;

  return {
    scene,
    get warped() {
      return warped;
    },
    get t() {
      return steps * dt; // sim time at the start of the next step
    },
    step(): TimedEvent[] {
      const t = steps * dt;
      const r = rate();
      const events = scene.step(t, dt).map((e) => ({ ...e, at: warped + (e.simTime - t) * r }));
      steps++;
      warped += dt * r;
      return events;
    },
  };
}
