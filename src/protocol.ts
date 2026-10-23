import type { PaletteBrick } from './palette.ts';
import type { RawEvent, SceneInfo, SceneInput } from './worker/scenes/scene.ts';

export interface SimParams {
  seed: number;
  rate: number; // time warp: sim seconds per second of music (2 = half speed, so a state change can be followed)
  lookaheadMs: number; // the sim runs this far ahead of the music; keys act at its head, so the paddle lags by it
  palette: string; // key in palettes.json: what each brick id means
  extra: PaletteBrick[]; // bricks made on this computer (New emotion), after the palette's own
  ballSpeed: number; // m/s, held constant
  paddle: number; // m, the paddle's half width
  top: number; // m, the field's height
  width: number; // m, its half width; 0 = as its bricks need
  autoplay: boolean; // the paddle plays itself; arrow keys take over
  jelly: string; // 'off' | 'beat' | 'bar': a brick holds the ball until the next beat or bar line, then lets go
}

export const DEFAULT_PARAMS: SimParams = {
  seed: 1,
  rate: 2,
  lookaheadMs: 40,
  palette: 'site',
  extra: [],
  ballSpeed: 6,
  paddle: 0.7,
  top: 8,
  width: 0,
  autoplay: true,
  jelly: 'beat',
};

// at: warped seconds since reset (deterministic). epoch: absolute output time in ms.
export interface OutEvent extends RawEvent {
  at: number;
  epoch: number;
}

export interface Snap {
  epoch: number;
  data: Float32Array; // xyz per body
  decor?: Float32Array; // see Scene.decor
}

// A hit the sim expects, at its absolute output time. weight 1 = certain, < 1 = one of several possible futures.
export interface ForecastHit {
  bodyId: number;
  epoch: number;
  weight: number;
}

export type ToWorker =
  | { type: 'reset'; gen: number; params: SimParams }
  | { type: 'params'; params: SimParams }
  | { type: 'input'; input: SceneInput }
  | { type: 'grid'; beatMs: number; originEpoch: number } // the music's beat grid: a downbeat's epoch ms, 4 beats a bar
  | { type: 'pause'; paused: boolean }; // paused: no steps; on resume the sim carries on from where it stopped

export interface FromWorker {
  gen: number;
  events: OutEvent[];
  snaps: Snap[];
  info?: SceneInfo; // sent once after reset
  forecast?: ForecastHit[]; // replaces the previous forecast
}
