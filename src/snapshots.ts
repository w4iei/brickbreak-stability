import type { Snap } from './protocol.ts';

// Lerp two equal-length arrays; mismatched lengths (body count changed) take the newer one.
function lerp(a: Float32Array | undefined, b: Float32Array | undefined, f: number) {
  if (!a || !b || a.length !== b.length) return b;
  return a.map((v, k) => v + (b[k] - v) * f);
}

// Buffer of future snapshots from the worker; sample(t) interpolates the bracketing pair.
export function createSnapshotBuffer() {
  let snaps: Snap[] = [];

  return {
    push(s: Snap[]) {
      snaps = snaps.concat(s);
    },
    clear() {
      snaps = [];
    },
    sample(t: number): Omit<Snap, 'epoch'> | undefined {
      const i = snaps.findIndex((s) => s.epoch > t);
      if (i === -1) return snaps.at(-1); // starved: hold last
      if (i === 0) return snaps[0];
      snaps = snaps.slice(i - 1); // drop the past
      const [a, b] = snaps;
      const f = (t - a.epoch) / (b.epoch - a.epoch);
      return { data: lerp(a.data, b.data, f)!, decor: lerp(a.decor, b.decor, f) };
    },
  };
}
