import { epochNow } from '../clock.ts';
import type { ForecastHit, FromWorker, OutEvent, SimParams, Snap, ToWorker } from '../protocol.ts';
import { mulberry32 } from '../rng.ts';
import { createEngine } from './engine.ts';
import { breakout } from './scenes/breakout.ts';
import { rapierReady } from './scenes/index.ts';
import type { BeatClock } from './scenes/scene.ts';

const DT = 0.001; // 1 ms substep
const SNAP_EVERY = 16; // steps between render snapshots
const TICK_MS = 5;
const MIN_RATE = 0.05; // stops the ahead-loop spinning forever at rate 0
const START_DELAY_MS = 20;
const FALLBACK_BEAT_MS = 60_000 / 140; // until the page sends the music's grid

const post = (msg: FromWorker, transfer: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer);

let params: SimParams;
let gen = 0;
let engine: ReturnType<typeof createEngine> | undefined;
let anchor = 0; // epoch ms of warped time 0
let steps = 0;
let grid = { beatMs: FALLBACK_BEAT_MS, originEpoch: 0 };
let gridFromPage = false;
let paused = true; // the page opens paused and says so right after its first reset

const outTime = (warped: number) => anchor + warped * 1000;

// The music's beat grid as the scene sees it: epoch ms ↔ sim time through the anchor and the time warp.
const clock: BeatClock = {
  next(simT, every) {
    const e = engine!;
    const r = Math.max(MIN_RATE, params.rate);
    const unit = grid.beatMs * (every === 'bar' ? 4 : 1);
    const n = Math.floor((outTime(e.warped + (simT - e.t) * r) - grid.originEpoch) / unit + 1e-9) + 1;
    return e.t + ((grid.originEpoch + n * unit - anchor) / 1000 - e.warped) / r;
  },
};

function reset(p: SimParams, g: number) {
  params = p;
  gen = g;
  engine?.scene.dispose?.();
  engine = createEngine(breakout(params, mulberry32(params.seed)), DT, () => Math.max(MIN_RATE, params.rate));
  anchor = epochNow() + START_DELAY_MS;
  steps = 0;
  if (!gridFromPage) grid = { beatMs: FALLBACK_BEAT_MS, originEpoch: anchor };
  engine.scene.setClock?.(clock);
  // The starting state as a snapshot too, so a paused scene still shows its ball.
  const first = { epoch: anchor, data: engine.scene.positions(), decor: engine.scene.decor?.() };
  post({ gen, events: [], snaps: [first], info: engine.scene.info() }, first.decor ? [first.data.buffer, first.decor.buffer] : [first.data.buffer]);
}

function tick() {
  if (!engine || paused) return;
  const now = epochNow();
  // Fell behind (worker stalled, or resumed after a pause): slip the anchor rather than burst late notes. Sim stays
  // deterministic.
  if (outTime(engine.warped) < now) anchor = now - engine.warped * 1000;

  const horizon = now + params.lookaheadMs;
  const events: OutEvent[] = [];
  const snaps: Snap[] = [];
  let forecast: ForecastHit[] | undefined;
  const snap = () =>
    snaps.push({ epoch: outTime(engine!.warped), data: engine!.scene.positions(), decor: engine!.scene.decor?.() });
  while (outTime(engine.warped) < horizon) {
    for (const e of engine.step()) events.push({ ...e, epoch: outTime(e.at) });
    const f = engine.scene.forecast?.();
    const rate = Math.max(MIN_RATE, params.rate);
    if (f) forecast = f.map(({ inSec, ...h }) => ({ ...h, epoch: outTime(engine!.warped + inSec * rate) }));
    if (++steps % SNAP_EVERY === 0) snap();
  }
  if (events.length || snaps.length || forecast)
    post({ gen, events, snaps, forecast }, snaps.flatMap((s) => (s.decor ? [s.data.buffer, s.decor.buffer] : [s.data.buffer])));
}

// Messages queue behind Rapier's WASM init; awaiting one resolved promise keeps their order.
self.onmessage = async (e: MessageEvent<ToWorker>) => {
  await rapierReady;
  const msg = e.data;
  if (msg.type === 'reset') reset(msg.params, msg.gen);
  else if (msg.type === 'input') engine?.scene.input?.(msg.input);
  else if (msg.type === 'pause') paused = msg.paused;
  else if (msg.type === 'grid') {
    grid = { beatMs: msg.beatMs, originEpoch: msg.originEpoch };
    gridFromPage = true;
  }
  else {
    params = msg.params;
    engine?.scene.setParams(msg.params);
    if (engine) post({ gen, events: [], snaps: [], info: engine.scene.info() }, []);
  }
};

setInterval(tick, TICK_MS);
