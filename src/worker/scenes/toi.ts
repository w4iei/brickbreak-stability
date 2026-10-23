// Time of impact from pre-step state, so collision events get their exact moment.
// Rapier reports contacts early (within its prediction distance), so τ can be several steps ahead.

type V3 = { x: number; y: number; z: number };

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

// Earliest τ where two spheres' centres are `reach` apart. Negative if already touching.
// Exact under uniform gravity too: it cancels in relative motion.
export function sphereToi(pa: V3, va: V3, pb: V3, vb: V3, reach: number): number | undefined {
  const dp = sub(pb, pa);
  const dv = sub(vb, va);
  const a = dot(dv, dv);
  const b = 2 * dot(dp, dv);
  const c = dot(dp, dp) - reach * reach;
  const disc = b * b - 4 * a * c;
  if (a < 1e-12 || disc < 0) return undefined;
  return (-b - Math.sqrt(disc)) / (2 * a);
}

// Earliest τ at which a ball (radius r) moving in a straight line in the xy plane touches an axis-aligned box
// (centre c, half extents h): slab test against the box grown by r, corners treated as square. Negative if inside.
export function boxToi(p: V3, v: V3, c: { x: number; y: number }, h: [number, number], r: number): number | undefined {
  let enter = -Infinity;
  let exit = Infinity;
  for (const [pk, vk, ck, hk] of [
    [p.x, v.x, c.x, h[0] + r],
    [p.y, v.y, c.y, h[1] + r],
  ]) {
    if (Math.abs(vk) < 1e-12) {
      if (Math.abs(pk - ck) > hk) return undefined;
      continue;
    }
    const [t1, t2] = [(ck - hk - pk) / vk, (ck + hk - pk) / vk];
    enter = Math.max(enter, Math.min(t1, t2));
    exit = Math.min(exit, Math.max(t1, t2));
  }
  return exit >= enter && exit >= 0 ? enter : undefined;
}

// Earliest τ ≥ 0 at which coordinate p (velocity v, acceleration a) reaches `limit`.
export function planeToi(p: number, v: number, limit: number, a = 0): number | undefined {
  const c = p - limit;
  if (Math.abs(a) < 1e-12) return Math.abs(v) < 1e-9 ? undefined : -c / v;
  const disc = v * v - 2 * a * c;
  if (disc < 0) return undefined;
  const roots = [(-v - Math.sqrt(disc)) / a, (-v + Math.sqrt(disc)) / a].filter((r) => r >= 0);
  return roots.length ? Math.min(...roots) : undefined;
}
