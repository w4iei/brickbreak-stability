import type { SimParams } from '../../protocol.ts';

export interface RawEvent {
  type: string;
  bodyId: number;
  simTime: number; // exact moment, may fall slightly outside the step that detected it
  force: number; // 0..1 normalised
  position: [number, number, number];
}

// Static description for the renderer.
export interface SceneInfo {
  radii: number[];
  flat: { center: [number, number]; size: [number, number] }; // drawn face-on, framing this xy rectangle
  walls?: number[]; // straight walls, flattened x0 y0 x1 y1
  // Breakout: brick centres (flattened xy) and their palette entries, in decor order (decor = paddle x, then 1 for
  // the brick holding the ball).
  bricks?: { at: number[]; half: [number, number]; id: number[]; label: string[]; color: string[] };
  paddle?: { y: number; half: [number, number] };
}

// Live player input, applied at the sim head.
export interface SceneInput {
  dir: -1 | 0 | 1;
  launch: boolean;
  target?: number; // x the paddle heads for (a finger or a slider); arrow keys clear it
}

// The music's beat grid, in sim time (the worker maps it through the time warp).
export interface BeatClock {
  next(simTime: number, every: 'beat' | 'bar'): number; // sim time of the first beat / bar line after simTime
}

// A hit expected inSec sim-seconds after the end of the current step.
export interface Forecast {
  bodyId: number;
  inSec: number;
  weight: number; // 1 = certain; branches of an undecided future split the weight
}

export interface Scene {
  // Advance from sim time t by dt seconds; return events detected during this step.
  step(t: number, dt: number): RawEvent[];
  positions(): Float32Array; // fresh copy, xyz per body
  decor?(): Float32Array; // per-snapshot extras the renderer animates (breakout: paddle x, the brick holding the ball)
  energy(): number;
  info(): SceneInfo;
  setParams(p: SimParams): void; // live, non-structural changes
  dispose?(): void; // free engine memory (Rapier WASM)
  input?(i: SceneInput): void;
  setClock?(c: BeatClock): void;
  forecast?(): Forecast[] | undefined; // a fresh forecast made during the last step, handed over once
}

export type SceneFactory = (params: SimParams, rng: () => number) => Scene;
