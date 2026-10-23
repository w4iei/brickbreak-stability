import { epochNow, toLocal } from './clock.ts';
import { createPanel, type OutputState, type Stats } from './panel.ts';
import { DEFAULT_PARAMS, type FromWorker, type OutEvent, type SimParams, type ToWorker } from './protocol.ts';
import { createRenderer } from './render.ts';
import type { OutputSink } from './sinks/sink.ts';
import { createWebMidiSink, type WebMidiSink } from './sinks/webmidi.ts';
import { createSnapshotBuffer } from './snapshots.ts';
import { addBreakoutPanel } from './audio/panel.ts';
import { type AudioStats, type BreakoutSettings, createPlayer, type SiteManifest } from './audio/player.ts';
import { createEmotionCard, loadEmotions } from './emotions.ts';
import { brickById, paletteOf } from './palette.ts';
import { createListenView, type EnvelopeFile } from './listen.ts';
import { createSiteUI } from './site.ts';
import { createStates } from './states.ts';
import { halfWidth, TOP, topFor, widthFor } from './worker/scenes/field.ts';

// Two ways to run, one page. The site build (vite --mode site: klavecimbel.com/brickbreak) plays pre-rendered audio
// from its own files: no server, no model. Offline (npm run dev with the local server, server/server.py) renders on
// this computer as it plays, so the settings can change the renders, MIDI goes out, and new emotions can be added.
const STATIC = import.meta.env.MODE === 'site';
const manifest: SiteManifest | undefined = STATIC ? await (await fetch(`${import.meta.env.BASE_URL}audio/manifest.json`)).json() : undefined;
const IDLE_DEMO_MS = 20_000; // no steering for this long, and the paddle plays itself again

const STATS_WINDOW_MS = 1000;
const DEBUG_LOG_SIZE = 500;

const PADDLE = 1.0; // m, half width: wide enough for thumbs (and wider still on a wider field)
const sim: SimParams = { ...DEFAULT_PARAMS, paddle: PADDLE, extra: STATIC ? [] : loadEmotions() };
const board = () => paletteOf(sim);
const output: OutputState = { midiId: '', latencyMs: Object.fromEntries(Array.from({ length: 16 }, (_, ch) => [ch, 0])) };
const stats: Stats = { headroomMs: 0, late: 0, slowFrames: 0 };
const SLOW_FRAME_MS = 50;
let lastFrame = 0;
// push 2.5: preferred 6 of 8 in a blind A/B on the KUNAKBAEVA tracks over 1.5, stronger σ, latent blend and FlowEdit.
const breakout: BreakoutSettings = { channel: 0, intensity: 0.5, push: 2.5, mix: 1, fade: 0.15, quantize: 'beat', hold: 2, style: 'source' };
if (manifest) Object.assign(breakout, manifest.settings); // the settings its renders were made with
const audioStats: AudioStats = { server: 'not started', track: '', position: '', renders: '', lastMs: 0, onTime: '', prerender: '', prerenderAll: '' };

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const renderer = createRenderer(canvas);
const snaps = createSnapshotBuffer();
const midi: WebMidiSink | undefined = STATIC
  ? undefined // no MIDI permission prompts on a public page
  : await createWebMidiSink().catch((err) => {
      console.warn('MIDI unavailable:', err);
      return undefined;
    });
output.midiId = midi?.outputs()[0]?.id ?? '';
const sinks: OutputSink[] = midi ? [midi] : [];

const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
const send = (msg: ToWorker) => worker.postMessage(msg);
let gen = 0;
let flashes: OutEvent[] = [];
let windowStart = epochNow();
let windowMin = Infinity;
let debugLog: OutEvent[] = [];
let flips: { id: number | undefined; epoch: number }[] = []; // state changes the renderer shows when they happen
// The track's beat grid goes to the sim, so jelly bricks let go on the music's beats.
const player = createPlayer(board, breakout, audioStats, {
  onGrid: (beatMs, originEpoch) => send({ type: 'grid', beatMs, originEpoch }),
  site: manifest && { base: `${import.meta.env.BASE_URL}audio/`, manifest },
  onEnd: () => listening && (endListen(), true), // Listen: a track plays to its end and stops there
  onAudio: (version, start, span, buffer) => listen.fill(version, start, span, buffer),
});

// A brick hit turns its state on (held MIDI note, renders over the track) and the previous one off.
const stateNote = (id: number) => brickById(board(), id)?.note ?? 60;
const states = createStates({
  on(id, epoch, force) {
    const note = { channel: breakout.channel, note: stateNote(id), velocity: Math.round(80 + 47 * force), duration: Infinity, time: epoch };
    sinks.forEach((sink) => sink.send(note, toLocal(epoch + output.latencyMs[breakout.channel])));
    player.switchTo(brickById(board(), id)?.original ? undefined : id, epoch); // ORIGINAL: the track as it is
    flips = [...flips, { id, epoch }];
  },
  off(id, epoch) {
    sinks.forEach((sink) => sink.release(breakout.channel, stateNote(id), toLocal(epoch + output.latencyMs[breakout.channel])));
  },
}, () => breakout.hold * player.bar * 1000);
function clearState() {
  const now = epochNow();
  states.clear(now);
  player.switchTo(undefined, now);
  flips = [...flips, { id: undefined, epoch: now }];
}
// Listen tab: a version picked directly (no hold; the original is a brick too).
function choose(id: number) {
  states.set(id, epochNow());
}
if (import.meta.env.DEV) Object.assign(window, { __sim: { params: sim, events: () => debugLog, player: () => player } });

// The page opens playing, muted, as a demo. Space plays and pauses. Holding the original (the button, or O) freezes
// the ball while the track plays on as it is.
let paused = false;
let holding = false;
let listening = false; // the Listen tab: the ball holds and the track is played by hand
const simHeld = () => paused || holding || listening;
function setPaused(p: boolean) {
  paused = p;
  send({ type: 'pause', paused: simHeld() });
  player.setPaused(paused);
  if (paused) sinks.forEach((s) => s.panic());
  site.setPaused(paused);
}
function setHold(on: boolean) {
  if (on === holding) return;
  holding = on;
  send({ type: 'pause', paused: simHeld() });
  player.setOriginal(on);
}
// iOS: play through the ringer switch, like a music app (Safari 17+). Set before any sound, not during the tap that
// starts it (changing it then can interrupt the audio that tap just started).
const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
if (audioSession) audioSession.type = 'playback';
function setSound(on: boolean) {
  player.setMuted(!on);
  site.setMuted(!on);
  if (on && paused) setPaused(false);
}

// The sim from scratch (its own state only: the track plays on). keepState: the version playing stays on (a resize, a
// new emotion; the renderer keeps its brick lit on the new board).
function rebuild(keepState = false) {
  gen++;
  snaps.clear();
  flashes = [];
  if (!keepState) clearState();
  send({ type: 'reset', gen, params: { ...sim } });
  send({ type: 'pause', paused: simHeld() });
}
// The board and the audio from scratch (a new seed or palette).
function reset() {
  stats.slowFrames = 0;
  breakoutPanel.stop();
  void breakoutPanel.start();
  sinks.forEach((s) => s.panic());
  fitField();
  rebuild();
  listen.setBricks(board().bricks);
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const { gen: g, events, snaps: s } = e.data;
  if (g !== gen) return; // stale, from before a reset
  if (e.data.info) renderer.setInfo(e.data.info);
  snaps.push(s);
  const now = epochNow();
  if (e.data.forecast) player.forecast(e.data.forecast); // pre-renders the audio of the bricks ahead
  for (const ev of events) {
    const headroom = ev.epoch - now;
    windowMin = Math.min(windowMin, headroom);
    if (headroom < 0) stats.late++;
    states.hit(ev.bodyId, ev.epoch, ev.force);
  }
  flashes = flashes.concat(events);
  if (import.meta.env.DEV) debugLog = debugLog.concat(events).slice(-DEBUG_LOG_SIZE);
};

worker.onerror = (e) => console.error('Sim worker error:', e.message);

// Leaving the tab pauses (and a hidden tab draws nothing: not a stutter).
addEventListener('visibilitychange', () => {
  lastFrame = 0;
  if (document.hidden && !paused) setPaused(true);
});
let shownTrack = '';
function frame() {
  const now = epochNow();
  if (lastFrame && now - lastFrame > SLOW_FRAME_MS && !document.hidden) stats.slowFrames++;
  lastFrame = now;
  const due = flashes.filter((f) => f.epoch <= now);
  flashes = flashes.filter((f) => f.epoch > now);
  due.forEach((f) => renderer.flash(f.bodyId, f.force));
  flips.filter((f) => f.epoch <= now).forEach((f) => {
    renderer.setActive(f.id);
    const b = brickById(board(), f.id);
    site.setActive(b && !b.original ? { label: b.label, color: b.color, opposite: brickById(board(), b.opposite)?.label } : undefined);
  });
  flips = flips.filter((f) => f.epoch > now);
  if (!listening) renderer.draw(snaps.sample(now)); // under the Listen tab, the board isn't seen
  const t = player.trackInfo;
  if (t) {
    if (t.name !== shownTrack) {
      site.setTrack(t.title ?? t.name.replace(/\.[^.]+$/, ''), t.artist ?? '');
      listen.setTrack(STATIC ? t.slug ?? '' : t.name, t.duration);
    }
    shownTrack = t.name;
    site.setProgress(player.trackPos(now) ?? 0, t.duration);
  }
  site.setDemo(sim.autoplay);
  if (listening) listen.update(player.trackPos(now) ?? 0, states.active ?? originalId(), player.pending, paused);
  if (now - windowStart > STATS_WINDOW_MS) {
    stats.headroomMs = Number.isFinite(windowMin) ? windowMin : 0;
    windowMin = Infinity;
    windowStart = now;
  }
  requestAnimationFrame(frame);
}

const pane = createPanel(document.querySelector<HTMLElement>('#panel')!, {
  sim,
  output,
  stats,
  midi,
  simple: STATIC,
  onReset: reset,
  onRebuild: () => rebuild(listening), // the paddle's size (also set by fitField on a resize)
  onParams: () => send({ type: 'params', params: { ...sim } }),
});
const breakoutPanel = addBreakoutPanel(pane, player, breakout, audioStats, STATIC);
player.setMuted(true);

// The page round the board, and steering by dragging on it (which takes over from autoplay until idle).
let lastSteer = 0;
function steer(x: number, launch = false) {
  lastSteer = Date.now();
  if (sim.autoplay) {
    sim.autoplay = false;
    pane.refresh();
    send({ type: 'params', params: { ...sim } });
  }
  send({ type: 'input', input: { dir: 0, launch, target: x } });
}
// Offline: new emotions, as bricks after the palette's own (and a lane each in Listen).
const emotions = STATIC
  ? undefined
  : createEmotionCard({
      board: () => board().bricks,
      mine: () => sim.extra,
      onChange(list) {
        sim.extra = list;
        if (states.active !== undefined && !brickById(board(), states.active)) clearState(); // the one playing went
        fitField();
        rebuild(true);
        listen.setBricks(board().bricks);
        player.settingsChanged(); // the server pre-renders the new one too
      },
    });
const site = createSiteUI({
  onSound: setSound,
  onPause: () => setPaused(!paused),
  onHold: setHold,
  onNextTrack: () => void player.next(),
  onSettings: () => pane.refresh(),
  onListen: setListen,
  onNewEmotion: emotions && (() => emotions.open()),
});

// The Listen tab: every version of the track, one playhead; tap a name to switch, tap or drag an envelope to jump. The
// game holds while it is open. Entering it muted pauses the silent demo (a player starts on ▶) and leaving it muted
// resumes it; with sound on, the music plays on across tabs. #listen in the address opens it.
const originalId = () => board().bricks.find((b) => b.original)?.id;
const loadEnvelope = async (id: string): Promise<EnvelopeFile | undefined> => {
  const url = STATIC ? `${import.meta.env.BASE_URL}audio/envelopes/${id}.json` : `/api/envelope/${encodeURIComponent(id)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};
const listen = createListenView(board().bricks, loadEnvelope, {
  onChoose: choose,
  onSeek: (pos, id) => {
    if (id !== undefined) choose(id); // first, so the version starts as itself at the new place
    seekTo(pos);
  },
  onPlay: playListen,
  onNext: () => void player.next(),
  onPrefetch: (id) => player.prefetch(id),
});
function setListen(on: boolean) {
  if (on === listening) return;
  listening = on;
  site.setListen(on);
  listen.show(on);
  player.setBrowse(on);
  send({ type: 'pause', paused: simHeld() });
  if (player.muted) setPaused(on);
  try {
    history.replaceState(null, '', on ? '#listen' : location.pathname + location.search);
  } catch {
    /* not allowed here */
  }
}
function playListen() {
  if (player.muted) setSound(true); // a player that plays is heard
  else setPaused(!paused);
}
// To the nearest beat, so the music picks up on one.
function seekTo(pos: number) {
  const beats = player.beats();
  const near = beats.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a), beats[0] ?? pos);
  player.seek(beats.length && Math.abs(near - pos) < 0.5 ? near : pos);
}
function endListen() {
  setPaused(true);
  player.seek(0);
}
// The field shaped like the screen, edge to edge. Upright, taller (bricks under the bar, the paddle at the foot; the
// ball faster by as much, so hits come as often); on its side, wider. A turned phone rebuilds the field; the track
// plays on.
function fitField() {
  const aspect = canvas.clientHeight / canvas.clientWidth;
  const n = board().bricks.length;
  const tall = topFor(aspect, n);
  const top = tall >= TOP ? Math.min(18, tall) : TOP;
  const width = tall >= TOP ? 0 : widthFor(aspect, TOP);
  renderer.setSideWalls(tall < TOP); // upright, the screen's edges are the walls
  if (Math.abs(top - sim.top) < 0.3 && Math.abs(width - sim.width) < 0.3) return false;
  const wide = Math.max(1, width / halfWidth(n)); // how much wider than its bricks need
  Object.assign(sim, { top, width, ballSpeed: (DEFAULT_PARAMS.ballSpeed * top) / TOP, paddle: PADDLE * Math.sqrt(wide) });
  pane.refresh();
  return true;
}
let refit: ReturnType<typeof setTimeout> | undefined;
addEventListener('resize', () => {
  clearTimeout(refit);
  refit = setTimeout(() => fitField() && rebuild(listening), 250);
});
site.setPaused(paused);
site.setMuted(true);
site.setActive(undefined);
let dragging: number | undefined; // the pointer steering the paddle
canvas.addEventListener('pointerdown', (e) => {
  dragging = e.pointerId;
  steer(renderer.toWorldX(e.clientX), true); // a tap also serves a waiting ball
  try {
    canvas.setPointerCapture(e.pointerId); // keep the drag when the finger leaves the board
  } catch {
    /* a pointer the browser no longer tracks */
  }
});
canvas.addEventListener('pointermove', (e) => e.pointerId === dragging && steer(renderer.toWorldX(e.clientX)));
for (const ev of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(ev, () => (dragging = undefined));
setInterval(() => {
  if (sim.autoplay || Date.now() - lastSteer < IDLE_DEMO_MS) return;
  sim.autoplay = true; // back to the demo
  pane.refresh();
  send({ type: 'params', params: { ...sim } });
}, 1000);

// Space plays / pauses. ←/→ move the paddle (and take over from autoplay), ↑ serves, Esc turns the state off.
const held = { left: false, right: false };
const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
function sendInput(launch = false) {
  send({ type: 'input', input: { dir: held.left === held.right ? 0 : held.left ? -1 : 1, launch } });
}
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.key === 'o' || e.key === 'O') {
    if (!e.repeat) setHold(true);
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur(); // or the focused panel button would take the key too
    if (!e.repeat) (listening ? playListen : () => setPaused(!paused))();
    return;
  }
  // Listen: ↑/↓ or 1–9 pick a version, ←/→ move 4 bars, Home back to the start, Esc the original.
  if (listening) {
    const order = board().bricks;
    const i = order.findIndex((b) => b.id === (states.active ?? originalId()));
    const p = player.trackPos(epochNow()) ?? 0;
    const orig = originalId();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') choose(order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowUp' ? -1 : 1)))].id);
    else if (/^[1-9]$/.test(e.key) && order[Number(e.key) - 1]) choose(order[Number(e.key) - 1].id);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') seekTo(p + (e.key === 'ArrowLeft' ? -4 : 4) * player.bar);
    else if (e.key === 'Home') seekTo(0);
    else if (e.key === 'Escape' && orig !== undefined) choose(orig);
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    held[e.key === 'ArrowLeft' ? 'left' : 'right'] = true;
    if (sim.autoplay) {
      sim.autoplay = false;
      pane.refresh();
      send({ type: 'params', params: { ...sim } });
    }
    sendInput();
  } else if (e.key === 'ArrowUp') sendInput(true);
  else if (e.key === 'Escape') clearState();
  else return;
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (e.key === 'o' || e.key === 'O') setHold(false);
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  held[e.key === 'ArrowLeft' ? 'left' : 'right'] = false;
  sendInput();
});

reset();
if (location.hash === '#listen') setListen(true);
requestAnimationFrame(frame);
