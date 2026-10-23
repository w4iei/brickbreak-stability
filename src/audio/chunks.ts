// The track is cut into overlapping chunks on a fixed grid: chunk k covers [k·hop, k·hop + length] and neighbours
// crossfade over length − hop. Every brick state renders on the same grid, so a switch at any moment only needs the new
// state's chunk under that moment, and a forecast hit says exactly which chunk to render ahead of time.
export interface Grid {
  length: number; // s, one render
  hop: number; // s between chunk starts
  origin?: number; // s, where chunk 0 starts (a downbeat, so every chunk starts on a bar line)
}

export const chunkAt = (g: Grid, pos: number) => Math.max(0, Math.floor((pos - (g.origin ?? 0)) / g.hop));
export const chunkStart = (g: Grid, k: number) => (g.origin ?? 0) + k * g.hop;

export interface Expected {
  brick: number;
  pos: number; // track s when the hit lands
  weight: number; // forecast weight
}

export interface Need {
  brick: number;
  k: number;
  due: number; // track s by which it must be playing
  weight: number;
}

const SURE = 0.9; // forecast weights at or above this count as sure
const MIN_USE = 0.5; // s: a chunk a state would play for less than this (before the next hit) isn't worth rendering

// Renders wanted, most urgent first. Sure hits lay out which state plays when: the active one until the first sure hit,
// that hit's brick until the next, and so on; each state needs the chunks it will actually play, and the last one
// `ahead` more. A maybe hit needs just the chunk it lands in. Sure needs come before maybes, earliest due first within
// each. Past hits and chunks starting after `end` are dropped.
export function plan(g: Grid, pos: number, active: number | undefined, hits: Expected[], ahead = 1, end = Infinity): Need[] {
  const needs = new Map<string, Need>();
  const add = (n: Need) => {
    if (chunkStart(g, n.k) >= end) return;
    const key = `${n.brick}:${n.k}`;
    const old = needs.get(key);
    if (!old || n.weight > old.weight || (n.weight === old.weight && n.due < old.due)) needs.set(key, n);
  };
  const future = hits.filter((h) => h.pos >= pos);
  const sure = future.filter((h) => h.weight >= SURE).sort((a, b) => a.pos - b.pos);
  const states = [{ brick: active, pos, weight: 1 }, ...sure];
  states.forEach((s, i) => {
    if (s.brick === undefined) return;
    const until = states[i + 1]?.pos;
    const first = chunkAt(g, s.pos);
    const last = until === undefined ? first + ahead : Math.max(first, chunkAt(g, until - MIN_USE));
    for (let k = first; k <= last; k++) add({ brick: s.brick, k, due: Math.max(s.pos, chunkStart(g, k)), weight: s.weight });
  });
  for (const h of future) if (h.weight < SURE) add({ brick: h.brick, k: chunkAt(g, h.pos), due: h.pos, weight: h.weight });
  const tier = (n: Need) => (n.weight >= SURE ? 0 : 1);
  return [...needs.values()].sort((a, b) => tier(a) - tier(b) || a.due - b.due);
}

// The hits that will change the state: each at least `hold` s after the previous change (the last real one at `since`),
// and not on the brick that is already on. The state machine ignores the rest, so they need no renders.
export function holdFilter(hits: Expected[], active: number | undefined, since: number, hold: number): Expected[] {
  let [current, last] = [active, since];
  const kept: Expected[] = [];
  for (const h of [...hits].sort((a, b) => a.pos - b.pos)) {
    if (h.brick === current || h.pos - last < hold) continue;
    kept.push(h);
    if (h.weight >= SURE) [current, last] = [h.brick, h.pos];
  }
  return kept;
}

// The first beat (or bar line) at or after pos; pos itself when there are none.
export const quantise = (pos: number, beats: number[]) => beats.find((b) => b >= pos) ?? pos;
