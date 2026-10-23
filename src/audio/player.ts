import { epochNow, toLocal } from '../clock.ts';
import { brickById, type Palette, type PaletteBrick } from '../palette.ts';
import { describeSource, type PromptStyle, renderPrompts, type SourceInfo } from '../prompts.ts';
import type { ForecastHit } from '../protocol.ts';
import { chunkAt, chunkStart, type Grid, holdFilter, plan, quantise } from './chunks.ts';
import { strength } from './dial.ts';

// Track player for breakout. The track runs on a timeline: `zero` is the epoch at which track position 0 is heard, so
// the position is known whether or not anything is audible. Sound is a layer on that timeline:
//   dry: the original, streamed in short chunks (DRY: 8 s every 8 s, 0.5 s overlap) that crossfade into each other
//        exactly (the same audio, gains summing to 1), so nothing waits for the whole song;
//   wet: while a brick state is on, Stable Audio renders of the track (one per 4-bar chunk, prompted by the brick,
//        pushed away from its opposite) over the dry, which ducks under them.
// Renders are fetched ahead of need: the active state's next chunks, then the chunks under forecast hits, so a switch
// usually finds its chunk decoded and crossfades in at the hit (or the next beat / bar).
//
// Where audio comes from: the local server (renders made or read from its disk, the original cut by /api/excerpt), or a
// site build's static files (audio/manifest.json, renders/<slug>/<brick>-<k>.m4a and orig-<k>.m4a), which hold the
// renders for one fixed setting.
//
// States of play: paused (the timeline stops; the audio context is suspended), muted (the timeline runs and nothing is
// fetched or heard; unmuting picks the sound up at the current position), and holding the original (renders and
// ducking bypassed while held). Lifecycle: start() opens a fresh session, stop() closes it; a scene that is off
// fetches, renders and plays nothing.
//
// Browsing (the site's Listen tab): versions are picked by hand and the timeline can jump (seek). A switch keeps the
// old version playing until the new one's chunk is in, then lands on the next beat, instead of dropping to the
// original meanwhile.
//
// Ducking: each render voice feeds -mix × its envelope into the dry gain (AudioParam inputs add to its value of 1), and
// neighbouring envelopes are linear crossfades that sum to 1, so dry = 1 − mix wherever renders cover the track and
// comes back by itself wherever a render wasn't ready.

export interface BreakoutSettings {
  channel: number; // MIDI channel of the state notes, 0-based
  intensity: number; // 0..1 → Stable Audio strength
  push: number; // guidance away from the opposite emotion; 1 = off
  mix: number; // render level while a state is on
  fade: number; // s, crossfade at a state switch
  quantize: string; // 'off' | 'beat' | 'bar'
  style: PromptStyle; // keep the track's sound and change its feeling, or turn it into the brick's genre
  hold: number; // bars a state stays on before another hit can change it
}

export interface AudioStats {
  server: string;
  track: string;
  position: string;
  renders: string; // ready / in flight
  lastMs: number;
  onTime: string; // switches whose render was ready / switches
  prerender: string; // how much of the track is on the server's disk for the current settings
  prerenderAll: string; // the same for every track (a batch the panel starts)
}

interface ServerStatus {
  ready: boolean;
  engine: string;
  error?: string;
  chunkSeconds: number;
}
// A track's analysis, as far as the player uses it.
type Analysis = { beats: number[]; downbeats: number[] } & SourceInfo;
interface Plan {
  name: string;
  duration: number;
  grid: Grid;
  beats: number[];
  bars: number[];
  bar: number; // s
  source: string; // what the track is, for the prompts
}
interface PrerenderView {
  state: string;
  track?: string;
  now?: string; // the track being pre-rendered
  trackNo?: number;
  tracks?: number;
  total?: number;
  done?: number;
  paused?: boolean;
  etaSec?: number | null;
}

export interface TrackInfo {
  name: string;
  set: string; // '' for tracks/ itself, else its subfolder (e.g. Classical)
  duration: number;
  title?: string; // site builds: how to show it
  artist?: string;
  artistUrl?: string; // where to find more of the artist's music
  slug?: string;
}
// A site build's audio: what export.py wrote.
interface SiteTrack {
  name: string;
  slug: string;
  title: string;
  artist: string;
  artistUrl?: string;
  frames: number;
  beats: number[];
  downbeats: number[];
  source: string;
}
export interface SiteManifest {
  settings: { intensity: number; push: number; style: PromptStyle };
  tracks: SiteTrack[];
}
interface Voice {
  brick: number;
  k: number;
  src: AudioBufferSourceNode;
  cs: ConstantSourceNode;
  gains: AudioParam[]; // render envelope, duck envelope
}
interface DryVoice {
  k: number;
  src: AudioBufferSourceNode;
  env: GainNode;
}

const API = '/api';
const CROSSFADE = 1; // s between neighbouring chunks of one state, without an analysis
const CHUNK_BARS = 4; // with an analysis: chunks start on every 4th bar line...
const CHUNK_OVERLAP = 0.5; // ...and run this much past the next one, to crossfade from it
export const DRY = { hop: 8, length: 8.5 }; // s: the original's chunks (its own grid, from 0)
const DEFAULT_BAR = (4 * 60) / 140; // s, without an analysis
const IN_FLIGHT = 2; // renders being fetched at once
const DRY_AHEAD = 2; // original chunks fetched ahead of the one playing
const SCHEDULE_AHEAD = 1.5; // s: the next chunk goes on the audio clock this far ahead
const START_LEAD = 0.05; // s: the soonest anything is scheduled
const ENTER = 0.03; // s: fade when sound starts mid-chunk (unmute, a late chunk)
const ORIGINAL_FADE = 0.03; // s, into and out of holding the original
const TICK_MS = 100;
const SETTLE_MS = 120; // after a resume, before the audio clock's position is trusted
const RETRY_MS = 3000; // a fetch that failed is tried again after this, not every tick
const DRY_WAIT_MS = 2000; // browsing: sound restarting on a version waits this long for it before the original plays
// Pre-render (offline only): the whole track (every brick × every chunk, with the current settings) goes to the
// server, which renders what isn't on its disk yet, so play itself needs no GPU work. Asked again (replacing the last)
// when the track or a setting that changes renders changes; its progress is polled, which also tells the server the
// game is still here. Pre-render all: the same for every track, as a batch the server runs only while no game plays.
const PRERENDER_SETTLE_MS = 1500; // after the last settings change
const PRERENDER_POLL_MS = 2000;

// Intensity → strength (σ): see dial.ts; 0 bypasses rendering.

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Inside a tap: play one silent sample, which is what lets audio start on iPhones (resume() alone sometimes isn't).
function unlock(ctx: AudioContext) {
  const src = ctx.createBufferSource();
  src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  src.connect(ctx.destination);
  src.start();
}

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(API + path, { signal });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export interface PlayerHooks {
  onGrid?(beatMs: number, originEpoch: number): void; // the track's beat grid on the epoch clock, whenever it moves
  site?: { base: string; manifest: SiteManifest }; // a site build's audio folder (its manifest and files), not the server
  onEnd?(): boolean; // the track has reached its end; true if the caller has dealt with it, else the next track starts
  // Audio just decoded: version (a brick id, or 'orig'), the track span it plays alone (s), its buffer. The Listen tab
  // draws the envelopes it has no file for from these.
  onAudio?(version: string, start: number, span: number, buffer: AudioBuffer): void;
}

export function createPlayer(getPalette: () => Palette, settings: BreakoutSettings, stats: AudioStats, hooks: PlayerHooks = {}) {
  const { site, onGrid = () => {}, onEnd = () => false, onAudio } = hooks;
  let session = 0; // bumped by start/stop; async work from an older session drops its result
  let aborter = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ctx: AudioContext | undefined;
  let dry: GainNode; // the original, ducked under renders (renders feed its gain, so it is never set directly)
  let dryOut: GainNode; // after the ducking: off while the original is held
  let wet: GainNode; // the renders
  let orig: GainNode; // the original unducked, while held
  let grid: Grid;
  let base: Grid; // the server's chunk grid, for a track without an analysis
  let tracks: TrackInfo[] = [];
  let ti = 0;
  let track: Plan | undefined;
  let batch = 'idle'; // the all-tracks pre-render's state on the server
  let paused = false; // the timeline stops and the audio context is suspended
  let muted = false; // the timeline runs; nothing is fetched or heard
  let holding = false; // the original instead of the renders
  let browse = false; // versions picked by hand (the Listen tab)
  let zero = 0; // epoch ms at which track position 0 is heard
  let pausedAt = 0;
  let t0 = 0; // audio-clock time of track position 0, while sound runs
  let live = false; // sound is on the audio clock (scheduled from the timeline)
  let dryWait = 0; // epoch ms: browsing, the original holds back until then while the version's chunk is on its way
  // A brick's strength (σ) and push: its own when it has them (made with New emotion), else the settings'.
  const sigmaOf = (b?: PaletteBrick) => b?.strength ?? strength(settings.intensity);
  const pushOf = (b?: PaletteBrick) => b?.push ?? settings.push;

  // What a track's renders depend on: its chunk grid (on its bar lines, from its analysis) and its source description.
  function planOf(name: string, duration: number, analysis?: Analysis): Plan {
    const bars = analysis?.downbeats ?? [];
    const bar = bars.length > 1 ? (bars.at(-1)! - bars[0]) / (bars.length - 1) : DEFAULT_BAR;
    // With an analysis, chunks start on bar lines, so every handover between renders begins on a downbeat.
    const g = bars.length > 1 ? { origin: bars[0], hop: CHUNK_BARS * bar, length: CHUNK_BARS * bar + CHUNK_OVERLAP } : base;
    return { name, duration, grid: g, beats: analysis?.beats ?? [], bars, bar, source: describeSource(analysis) };
  }
  const about = (name: string): Promise<Analysis | undefined> => {
    const s = site?.manifest.tracks.find((t) => t.name === name);
    if (s) return Promise.resolve({ beats: s.beats, downbeats: s.downbeats });
    return json<Analysis>(`/analysis/${encodeURIComponent(name)}`, aborter.signal).catch(() => undefined); // 204: none
  };
  const slug = () => tracks[ti].slug ?? '';

  let active: number | undefined;
  // A switch (track position) whose render isn't on yet; late: browsing, the old version plays on until it is.
  let waiting: { brick: number; at: number; late?: boolean } | undefined;
  let hits: { brick: number; epoch: number; weight: number }[] = [];
  let voices: Voice[] = [];
  let dryVoices: DryVoice[] = [];
  let cache = new Map<string, { k: number; buffer?: AudioBuffer }>();
  let dryCache = new Map<number, { buffer?: AudioBuffer }>();
  let inFlight = 0;
  let switches = 0;
  let onTime = 0;
  let lastHit = -Infinity; // track s of the last state change, for the hold
  const overlap = () => grid.length - grid.hop;
  const holdSec = () => settings.hold * (track?.bar ?? DEFAULT_BAR);
  const switchGrid = () => (!track ? [] : settings.quantize === 'beat' ? track.beats : settings.quantize === 'bar' ? track.bars : []);

  let prerenderTimer: ReturnType<typeof setTimeout> | undefined;
  let prerenderPoll: ReturnType<typeof setInterval> | undefined;
  // A render is its request: the same texts, σ, push, span and seed are the same audio (an edited emotion is new).
  const key = (brick: number, k: number) => (track ? JSON.stringify(requestOf(track, brick, k) ?? [brick, k]) : '');
  const ready = (brick: number, k: number) => cache.get(key(brick, k))?.buffer;

  // The timeline: track position now (frozen while paused), and of an epoch.
  const posAt = (epoch: number) => ((paused ? pausedAt : epoch) - zero) / 1000;
  const pos = () => posAt(epochNow());
  const sounding = () => !!ctx && !!track && live && !paused && !muted;

  // Epoch ms → the audio-clock time heard at that moment.
  // The output timestamp places sound more exactly, but only while it is current: right after the context first runs
  // (iOS) it can still describe a moment from before, which put the track's start far off and the sound never came.
  function audioTime(epoch: number) {
    const c = ctx!;
    const clock = c.currentTime + (toLocal(epoch) - performance.now()) / 1000 - (c.outputLatency || c.baseLatency || 0);
    const ts = c.getOutputTimestamp?.();
    if (ts?.contextTime && ts.performanceTime && Math.abs(performance.now() - ts.performanceTime) < 250) {
      const precise = ts.contextTime + (toLocal(epoch) - ts.performanceTime) / 1000;
      if (Math.abs(precise - clock) < 0.25) return precise;
    }
    return clock;
  }

  // ── sound ────────────────────────────────────────────────────────────────────────────────────────────────────
  function startVoice(brick: number, k: number, from: number, fadeIn: number) {
    const buffer = ready(brick, k)!;
    const start = t0 + chunkStart(grid, k);
    const end = start + buffer.duration;
    if (end - from < fadeIn) return;
    const src = ctx!.createBufferSource();
    src.buffer = buffer;
    const env = ctx!.createGain();
    const duck = ctx!.createGain();
    const cs = ctx!.createConstantSource();
    cs.offset.value = -settings.mix;
    src.connect(env).connect(wet);
    cs.connect(duck).connect(dry.gain);
    const gains = [env.gain, duck.gain];
    for (const g of gains) {
      g.setValueAtTime(0, from);
      g.linearRampToValueAtTime(1, from + fadeIn);
      if (start + grid.hop > from + fadeIn) g.setValueAtTime(1, start + grid.hop); // the next chunk takes over on its bar line
      g.linearRampToValueAtTime(0, end);
    }
    src.start(from, from - start);
    cs.start(from);
    src.stop(end);
    cs.stop(end);
    const v = { brick, k, src, cs, gains };
    src.onended = () => {
      [src, env, duck, cs].forEach((n) => n.disconnect());
      voices = voices.filter((x) => x !== v);
    };
    voices = [...voices, v];
  }

  // Fade every render voice out from `at` (dropping ones that haven't started) — the old state leaving.
  function cut(at: number, fade: number) {
    for (const v of voices) {
      v.gains.forEach((g) => {
        g.cancelAndHoldAtTime(at);
        g.linearRampToValueAtTime(0, at + fade);
      });
      v.src.stop(at + fade);
      v.cs.stop(at + fade);
    }
    voices = [];
  }

  // The original's chunk k: in from `from` (its own start, crossfading from k − 1; or mid-chunk with a short fade),
  // out over the overlap after the next chunk's start, so neighbouring chunks of the same audio sum to it exactly.
  function startDry(k: number, from: number, fadeIn: number) {
    const buffer = dryCache.get(k)?.buffer;
    if (!buffer) return;
    const start = t0 + k * DRY.hop;
    const next = start + DRY.hop;
    const end = Math.min(start + buffer.duration, next + (DRY.length - DRY.hop));
    if (end - from < fadeIn) return;
    const src = ctx!.createBufferSource();
    src.buffer = buffer;
    const env = ctx!.createGain();
    src.connect(env);
    env.connect(dry);
    env.connect(orig);
    const g = env.gain;
    g.setValueAtTime(fadeIn ? 0 : 1, from);
    if (fadeIn) g.linearRampToValueAtTime(1, from + fadeIn);
    if (next > from + fadeIn && next < end) {
      g.setValueAtTime(1, next);
      g.linearRampToValueAtTime(0, end);
    }
    src.start(from, from - start);
    src.stop(end);
    const v = { k, src, env };
    src.onended = () => {
      src.disconnect();
      env.disconnect();
      dryVoices = dryVoices.filter((x) => x !== v);
    };
    dryVoices = [...dryVoices, v];
  }

  // Keep the original playing chunk to chunk, and the active state's renders back to back; land a waiting switch.
  function chain() {
    const now = ctx!.currentTime;
    const p = now + START_LEAD - t0; // the soonest track position anything can start at
    const lastDry = dryVoices.at(-1);
    if (!lastDry) {
      const k = Math.floor(p / DRY.hop);
      // Browsing, a version starts as itself, not as the original turning into it once its audio is in.
      const hold = active !== undefined && !ready(active, chunkAt(grid, p)) && epochNow() < dryWait;
      if (!hold && dryCache.get(k)?.buffer) startDry(k, t0 + Math.max(p, k * DRY.hop), p > k * DRY.hop ? ENTER : 0);
    } else {
      const k = lastDry.k + 1;
      const next = t0 + k * DRY.hop;
      if (next - now < SCHEDULE_AHEAD && dryCache.get(k)?.buffer) {
        if (next >= now + START_LEAD) startDry(k, next, DRY.length - DRY.hop);
        else startDry(k, now + START_LEAD, ENTER); // came late: in where we are
      }
    }

    if (active === undefined) return;
    const last = voices.at(-1);
    if (waiting || !last) {
      let at = Math.max(t0 + (waiting?.at ?? 0), now + START_LEAD);
      if (waiting?.late) at = t0 + quantise(at - t0, switchGrid()); // in only now: on the next beat from here
      const k = chunkAt(grid, at - t0);
      if (!ready(active, k)) return;
      if (waiting?.late) cut(at, settings.fade); // the old version leaves as this one comes in
      startVoice(active, k, at, waiting ? settings.fade : ENTER);
      waiting = undefined;
      return;
    }
    const next = t0 + chunkStart(grid, last.k + 1);
    if (next >= now + START_LEAD && next - now < SCHEDULE_AHEAD && ready(active, last.k + 1)) startVoice(active, last.k + 1, next, overlap());
  }

  // Everything off the audio clock (muting, a new track, before sound restarts from the timeline).
  function silence() {
    if (!ctx) return;
    cut(ctx.currentTime, 0.02);
    for (const v of dryVoices) {
      v.env.gain.cancelAndHoldAtTime(ctx.currentTime);
      v.env.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.02);
      v.src.stop(ctx.currentTime + 0.02);
    }
    dryVoices = [];
    live = false;
  }

  // Put sound back on the timeline: the audio clock's place for track position 0, then chain() picks up the original
  // and the active state where the track is now.
  function relive() {
    if (!ctx || !track || paused || muted || ctx.state !== 'running') return;
    t0 = audioTime(zero);
    live = true;
    if (active !== undefined) waiting = { brick: active, at: pos() };
    dryWait = browse ? epochNow() + DRY_WAIT_MS : 0;
  }

  // ── fetching ─────────────────────────────────────────────────────────────────────────────────────────────────
  // The request for brick's render of chunk k of a track: the same for a render and its pre-render, so both hit one file.
  function requestOf(t: Plan, brick: number, k: number) {
    const b = brickById(getPalette(), brick);
    if (!b) return undefined;
    const { prompt, negative } = renderPrompts(b, brickById(getPalette(), b.opposite), settings.style, t.source);
    return {
      track: t.name,
      start: chunkStart(t.grid, k),
      seconds: t.grid.length,
      prompt,
      negative: pushOf(b) > 1 ? negative : null,
      cfg: pushOf(b),
      strength: sigmaOf(b),
      seed: brick * 1000 + k,
      ...(b.steps ? { steps: b.steps } : {}), // else the server's own (and its renders on disk stay these)
    };
  }
  // Every render a track could need, from chunk `from` to the end and then from the start, each chunk for every brick
  // before the next chunk.
  function itemsOf(t: Plan, from = 0) {
    const chunks = Math.ceil((t.duration - (t.grid.origin ?? 0)) / t.grid.hop);
    const order = Array.from({ length: chunks }, (_, i) => (Math.min(from, chunks - 1) + i) % chunks);
    const bricks = getPalette().bricks.filter((b) => !b.original); // the original is the track as it is: nothing to render
    return order.flatMap((k) => bricks.map((b) => requestOf(t, b.id, k)!));
  }
  const post = (body: object) =>
    fetch(`${API}/prerender`, { method: 'POST', signal: aborter.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function prerender() {
    clearTimeout(prerenderTimer);
    if (site) return; // a site build has its renders already
    if (!track || settings.intensity <= 0) return void fetch(`${API}/prerender`, { method: 'DELETE' }).catch(() => {});
    void post({ track: track.name, items: itemsOf(track, chunkAt(grid, pos())) }).catch(() => {});
  }
  // Every track at the current settings, after the playing one (which its own pre-render covers), in list order.
  async function prerenderAll() {
    if (site || !track || settings.intensity <= 0) return;
    const order = tracks.map((_, i) => tracks[(ti + 1 + i) % tracks.length]);
    const plans = await Promise.all(order.map(async (t) => planOf(t.name, t.duration, await about(t.name))));
    batch = 'running';
    await post({ track: 'all tracks', items: plans.flatMap((p) => itemsOf(p)), batch: true });
    void pollPrerender();
  }

  const minutes = (s: number) => (s >= 5400 ? `~${(s / 3600).toFixed(1)} h` : `~${Math.ceil(s / 60)} min`);
  async function pollPrerender() {
    const p = await json<{ game: PrerenderView; batch: PrerenderView }>('/prerender', aborter.signal).catch(() => undefined);
    if (!p?.game) return;
    const g = p.game;
    // The server lost the job (restarted) or stopped it while we were away (a throttled tab): send it again.
    if (track && settings.intensity > 0 && (g.state === 'idle' || (g.state === 'stopped' && g.track === track.name))) prerender();
    if (g.track === track?.name)
      stats.prerender =
        g.state === 'done'
          ? `all ${g.total} on disk`
          : g.state === 'running'
            ? `${g.done} / ${g.total} (${Math.floor((100 * g.done!) / g.total!)} %)${g.etaSec ? `, ${minutes(g.etaSec)} left` : ''}`
            : `${g.done} / ${g.total} (${g.state})`;
    const b = p.batch;
    batch = b.state;
    const short = (n?: string) => n?.split('/').pop()!.replace(/\.[^.]+$/, '') ?? '';
    stats.prerenderAll =
      b.state === 'running'
        ? `${b.paused ? 'waiting while you play · ' : ''}track ${b.trackNo} / ${b.tracks} (${short(b.now)}), ${b.done} / ${b.total}${b.etaSec ? `, ${minutes(b.etaSec)} left` : ''}`
        : b.state === 'done'
          ? `all ${b.tracks} tracks on disk`
          : b.state === 'idle'
            ? ''
            : `${b.state} at ${b.done} / ${b.total}`;
  }

  async function fetchAudio(url: string, init?: RequestInit) {
    const r = await fetch(url, { ...init, signal: aborter.signal });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return { r, buffer: await ctx!.decodeAudioData(await r.arrayBuffer()) };
  }

  async function render(brick: number, k: number) {
    const id = key(brick, k);
    const body = track && requestOf(track, brick, k);
    if (!body || !track) return;
    const mine = session;
    cache.set(id, { k });
    inFlight++;
    try {
      const { r, buffer } = site
        ? await fetchAudio(`${site.base}renders/${slug()}/${brick}-${k}.m4a`)
        : await fetchAudio(`${API}/transform`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (mine !== session) return;
      stats.lastMs = Number(r.headers.get('x-render-ms') ?? 0);
      if (!cache.has(id)) return; // dropped meanwhile if the track changed
      cache.set(id, { k, buffer });
      onAudio?.(String(brick), chunkStart(grid, k), grid.hop, buffer);
    } catch (err) {
      if (mine !== session) return; // stopped: aborted on purpose
      console.warn('Render failed:', err);
      setTimeout(() => cache.get(id)?.buffer || cache.delete(id), RETRY_MS); // until then it counts as asked for
    } finally {
      if (mine === session) inFlight--;
    }
  }

  async function original(k: number) {
    const mine = session;
    const name = track!.name;
    dryCache.set(k, {});
    try {
      const { buffer } = site
        ? await fetchAudio(`${site.base}renders/${slug()}/orig-${k}.m4a`)
        : await fetchAudio(`${API}/excerpt?${new URLSearchParams({ track: name, start: String(k * DRY.hop), seconds: String(DRY.length) })}`);
      if (mine === session && track?.name === name && dryCache.has(k)) {
        dryCache.set(k, { buffer });
        onAudio?.('orig', k * DRY.hop, DRY.hop, buffer);
      }
    } catch (err) {
      if (mine !== session) return;
      console.warn('Original chunk failed:', err);
      setTimeout(() => dryCache.get(k)?.buffer || dryCache.delete(k), RETRY_MS);
    }
  }

  function tick() {
    if (!ctx || !track) return;
    const p = pos();
    if (p >= track.duration && !paused) {
      if (!onEnd()) void load(ti + 1); // playlist: on to the next track
      return;
    }
    if (!muted) {
      // The original where we are and a little ahead; renders the state and the forecast need.
      const kd = Math.floor(Math.max(0, p) / DRY.hop);
      for (let k = kd; k <= kd + DRY_AHEAD && k * DRY.hop < track.duration; k++) if (!dryCache.has(k)) void original(k);
      dryCache = new Map([...dryCache].filter(([k]) => (k + 1) * DRY.hop + DRY.length > p)); // behind the playhead
      const now = epochNow();
      hits = hits.filter((h) => h.epoch > now);
      const expected = holdFilter(
        hits.map((h) => ({ brick: h.brick, pos: posAt(h.epoch), weight: h.weight })),
        active,
        lastHit,
        holdSec(),
      );
      const needs = settings.intensity > 0 ? plan(grid, p, active, expected, 1, track.duration) : []; // 0 = bypass
      for (const n of needs) {
        if (inFlight >= IN_FLIGHT) break;
        if (brickById(getPalette(), n.brick)?.original) continue; // the track as it is: nothing to render
        if (!cache.has(key(n.brick, n.k))) void render(n.brick, n.k);
      }
      cache = new Map([...cache].filter(([, e]) => chunkStart(grid, e.k) + grid.length > p)); // behind the playhead
    }
    if (sounding()) chain();
    const done = [...cache.values()].filter((e) => e.buffer).length;
    Object.assign(stats, {
      position: `${clock(Math.max(0, p))} / ${clock(track.duration)}${muted ? ' (muted)' : ''}`,
      renders: `${done} ready, ${inFlight} fetching`,
      onTime: `${onTime} / ${switches}`,
    });
  }

  async function load(i: number) {
    if (!ctx) return;
    const mine = session;
    silence();
    waiting = undefined;
    cache = new Map();
    dryCache = new Map();
    ti = (i + tracks.length) % tracks.length;
    const t = tracks[ti];
    track = undefined;
    stats.track = `${t.title ?? t.name} (loading…)`;
    const analysis = await about(t.name);
    if (mine !== session) return;
    track = planOf(t.name, t.duration, analysis);
    grid = track.grid;
    stats.track = analysis ? `${t.title ?? t.name} (beats loaded)` : t.title ?? t.name;
    zero = epochNow() + START_LEAD * 1000; // the track starts now
    if (paused) pausedAt = zero;
    onGrid((track.bar / 4) * 1000, zero + (track.bars[0] ?? 0) * 1000);
    relive();
    prerender();
  }

  return {
    get started() {
      return !!track;
    },
    tracks: () => tracks,
    get bar() {
      return track?.bar ?? DEFAULT_BAR; // s, the playing track's bar
    },
    get trackInfo() {
      return tracks[ti] as TrackInfo | undefined;
    },
    get muted() {
      return muted;
    },
    // Where in the track an epoch falls, and the track's beats (dev checks of the timing).
    trackPos: (epoch: number) => (track ? posAt(epoch) : undefined),
    beats: () => track?.beats ?? [],
    get trackIndex() {
      return ti;
    },
    // From scratch every time: the track from 0:00 on the timeline. The audio context starts suspended without a
    // click; it runs once neither paused nor muted (and a click has let it). False if stopped meanwhile.
    async start(): Promise<boolean> {
      this.stop();
      const mine = session;
      const alive = () => mine === session;
      ctx = new AudioContext({ latencyHint: 'interactive' });
      // Sound follows the context's own state: whenever it comes to run while sound is wanted (a resume, or iOS giving
      // it back after an interruption), the sound is put on the timeline then; an interruption takes it off.
      const c = ctx;
      c.onstatechange = () => {
        if (c !== ctx) return;
        if (c.state !== 'running') {
          if (!paused && !muted) silence(); // interrupted (iOS): sound back from the timeline once it runs again
          return;
        }
        setTimeout(() => c === ctx && !live && relive(), SETTLE_MS);
      };
      // A browser that allows audio without a click starts it running. Not awaited: on iPhones an untouched context's
      // suspend() only settles at its next change to suspended (the first mute), which held the track back until then.
      if (paused || muted) void ctx.suspend().catch(() => {});
      else void ctx.resume();
      dry = ctx.createGain();
      dryOut = ctx.createGain();
      wet = ctx.createGain();
      orig = ctx.createGain();
      wet.gain.value = holding ? 0 : settings.mix;
      dryOut.gain.value = holding ? 0 : 1;
      orig.gain.value = holding ? 1 : 0;
      dry.connect(dryOut);
      [dryOut, wet, orig].forEach((g) => g.connect(ctx!.destination));
      try {
        if (site) {
          stats.server = 'pre-rendered (Stable Audio 3, Stability AI)';
          tracks = site.manifest.tracks.map((t) => ({ name: t.name, set: '', duration: t.frames / 44100, title: t.title, artist: t.artist, artistUrl: t.artistUrl, slug: t.slug }));
        } else {
          const status = await json<ServerStatus>('/status', aborter.signal);
          stats.server = status.ready ? status.engine : `passthrough — ${status.error ?? 'engine loading'}`;
          grid = base = { length: status.chunkSeconds, hop: status.chunkSeconds - CROSSFADE };
          tracks = (await json<TrackInfo[]>('/tracks', aborter.signal)).filter((t) => !t.set); // tracks/ itself, not its subfolders
          prerenderPoll = setInterval(() => void pollPrerender(), PRERENDER_POLL_MS);
        }
        if (!tracks.length) throw new Error('No tracks');
        timer = setInterval(tick, TICK_MS);
        await load(0);
      } catch (err) {
        if (!alive()) return false;
        throw err;
      }
      return alive();
    },
    // Silence, no fetching, nothing held: the scene is off.
    stop() {
      session++;
      aborter.abort();
      aborter = new AbortController();
      clearInterval(timer);
      clearInterval(prerenderPoll);
      clearTimeout(prerenderTimer);
      if (ctx && !site) void fetch(`${API}/prerender`, { method: 'DELETE', keepalive: true }).catch(() => {}); // no compute for a scene that's off
      void ctx?.close(); // stops every source and frees the buffers
      ctx = undefined;
      track = undefined;
      live = false;
      [tracks, voices, dryVoices, hits, cache, dryCache] = [[], [], [], [], new Map(), new Map()];
      [active, waiting, inFlight, switches, onTime, lastHit] = [undefined, undefined, 0, 0, 0, -Infinity];
      Object.assign(stats, { server: 'stopped', track: '', position: '', renders: '', lastMs: 0, onTime: '', prerender: '' }); // the batch's line stays
    },
    // Pause stops the timeline and holds the sound where it is (the suspended audio clock keeps its schedule); resume
    // moves the timeline's zero on by the pause and gives the sim the moved beat grid. Space is a click, so resuming
    // may also be what lets audio start.
    setPaused(p: boolean) {
      if (p === paused) return;
      const now = epochNow();
      if (p) {
        pausedAt = now;
        paused = true;
        hits = []; // the forecast's times are from before the pause
        void ctx?.suspend();
        return;
      }
      zero += now - pausedAt;
      paused = false;
      if (track) onGrid((track.bar / 4) * 1000, zero + (track.bars[0] ?? 0) * 1000);
      if (!ctx || muted) return;
      unlock(ctx);
      const mine = session;
      void ctx.resume().then(() =>
        setTimeout(() => {
          if (mine === session && !live) relive(); // first sound since the start: from the timeline
        }, SETTLE_MS),
      );
    },
    // Muted, the timeline runs on and nothing is fetched or heard; unmuting starts the sound where the track is (a
    // click, so it may be what lets audio start at all).
    setMuted(m: boolean) {
      if (m === muted) return;
      muted = m;
      if (!ctx) return;
      if (m) {
        silence();
        void ctx.suspend();
        return;
      }
      if (paused) return;
      unlock(ctx);
      const mine = session;
      void ctx.resume().then(() =>
        setTimeout(() => {
          if (mine === session && !live) relive();
        }, SETTLE_MS),
      );
    },
    // Held, the original plays as it is: renders and ducking are bypassed (they keep their place underneath).
    setOriginal(on: boolean) {
      holding = on;
      if (!ctx) return;
      const t = ctx.currentTime;
      const to = (g: GainNode, v: number) => {
        g.gain.cancelAndHoldAtTime(t);
        g.gain.linearRampToValueAtTime(v, t + ORIGINAL_FADE);
      };
      to(orig, on ? 1 : 0);
      to(dryOut, on ? 0 : 1);
      to(wet, on ? 0 : settings.mix);
    },
    // A setting that changes renders (intensity, push, prompts) moved: pre-render again once it settles.
    settingsChanged() {
      clearTimeout(prerenderTimer);
      if (track) prerenderTimer = setTimeout(prerender, PRERENDER_SETTLE_MS);
    },
    prerenderAll,
    stopPrerenderAll: () => fetch(`${API}/prerender?batch=true`, { method: 'DELETE' }).then(() => void (batch = 'stopped')),
    get batchRunning() {
      return batch === 'running';
    },
    select: (i: number) => load(i),
    next: () => load(ti + 1),
    setMix() {
      if (!ctx || holding) return;
      wet.gain.value = settings.mix;
      voices.forEach((v) => (v.cs.offset.value = -settings.mix));
    },
    // A state switch heard at `epoch` (undefined = all off): quantised, then the old renders fade out as the new fade in.
    switchTo(brick: number | undefined, epoch: number) {
      active = brick;
      if (!track) return;
      // A hit that already falls on a beat (a jelly brick's release) stays on it.
      const hit = posAt(epoch);
      const at = quantise(Math.max(hit, pos() + START_LEAD) - 0.005, switchGrid());
      const inYet = brick === undefined || !!ready(brick, chunkAt(grid, at));
      // Sound on the audio clock (paused too: the suspended clock keeps its schedule) leaves at the switch, or, while
      // browsing, once the new version is in.
      const late = browse && !inYet && voices.length > 0;
      if (ctx && live && !late) cut(t0 + at, settings.fade);
      waiting = undefined;
      if (brick === undefined) return;
      lastHit = hit;
      switches++;
      if (inYet) onTime++;
      waiting = { brick, at, late };
      if (sounding()) chain();
    },
    // Browsing: versions are picked by hand (switches wait for their audio, see above).
    setBrowse(on: boolean) {
      browse = on;
      if (on) hits = [];
    },
    // A switch whose audio is still on its way.
    get pending() {
      return !!waiting && !!track && !muted;
    },
    // Fetch brick's chunk at the playhead now (a version the pointer is over is likely next).
    prefetch(brick: number) {
      if (!ctx || !track || muted || settings.intensity <= 0 || brickById(getPalette(), brick)?.original) return;
      const k = chunkAt(grid, pos() + START_LEAD);
      if (!cache.has(key(brick, k))) void render(brick, k);
    },
    // The timeline jumps to track position `to` (s); sound picks up there (once playing and unmuted). Only audio near
    // the new place is kept.
    seek(to: number) {
      if (!ctx || !track) return;
      const p = Math.min(Math.max(0, to), track.duration);
      silence();
      zero = (paused ? pausedAt : epochNow()) - p * 1000;
      [waiting, hits, lastHit] = [undefined, [], -Infinity];
      const near = (start: number, length: number) => start + length > p && start < p + 3 * grid.hop;
      cache = new Map([...cache].filter(([, e]) => near(chunkStart(grid, e.k), grid.length)));
      dryCache = new Map([...dryCache].filter(([k]) => near(k * DRY.hop, DRY.length)));
      onGrid((track.bar / 4) * 1000, zero + (track.bars[0] ?? 0) * 1000);
      relive();
      tick();
    },
    get duration() {
      return track?.duration;
    },
    get source() {
      return track?.source ?? ''; // what the track is, as every prompt begins
    },
    // The texts a version's renders of this track are made with (offline: shown under the Listen lanes).
    promptsOf(brick: number) {
      const r = track && requestOf(track, brick, 0);
      return r && { prompt: r.prompt, negative: r.negative ?? '', strength: r.strength, push: r.cfg };
    },
    // What a brick without its own strength and push renders with (the settings).
    get defaults() {
      return { strength: strength(settings.intensity), push: settings.push };
    },
    // Every chunk of every version of this track, as the server renders it (offline: the Listen tab's envelopes, from
    // the renders on its disk).
    versionChunks() {
      if (site || !track || settings.intensity <= 0) return undefined;
      const t = track;
      const n = Math.ceil((t.duration - (t.grid.origin ?? 0)) / t.grid.hop);
      const bricks = getPalette().bricks.filter((b) => !b.original);
      const chunks = bricks.flatMap((b) =>
        Array.from({ length: n }, (_, k) => ({ version: String(b.id), start: chunkStart(t.grid, k), span: t.grid.hop, request: requestOf(t, b.id, k)! })),
      );
      return { track: t.name, duration: t.duration, chunks };
    },
    forecast(f: ForecastHit[]) {
      hits = f.map((h) => ({ brick: h.bodyId, epoch: h.epoch, weight: h.weight }));
    },
  };
}
