import type { PaletteBrick } from './palette.ts';
import { neon } from './render.ts';

// The site's Listen tab: every version of the track (the original and each emotion) as a lane with its loudness
// envelope, on one time line with one playhead. Tap a version's name and the track carries on in that version from
// where it is (on the next beat, once its audio is in); tap or drag on a version's envelope and it plays from there
// (the time line moves the playhead alone; with a mouse, a faint line shows where a click lands). Below: back to the
// start, play / pause, next track. The lanes are the game's bricks in the game's order, drawn the same way
// (unlit: a dark tile, label and envelope outlined in its colour; on: filled). Envelopes: the site build's
// audio/envelopes/<slug>.json (site/envelopes.py); offline, the original's from the server and each version's filled in
// from its audio as it arrives (fill).

export interface ListenDeps {
  onChoose(id: number): void; // a version: its brick (the original is a brick too)
  onSeek(pos: number, id?: number): void; // s; id: the version whose envelope was tapped, which plays from there
  onPlay(): void; // play / pause
  onNext(): void;
  onPrefetch(id: number): void; // the pointer is over a version
  onAdd?(): void; // offline: the New emotion card (a row under the lanes)
}

export interface ListenView {
  show(on: boolean): void;
  setBricks(bricks: PaletteBrick[]): void; // the lanes, again (a new emotion added or removed)
  setTrack(id: string, duration: number): void; // id: what loadEnvelope is asked for
  fill(version: string, start: number, span: number, buffer: AudioBuffer): void; // audio of a version: its envelope there
  merge(f: EnvelopeFile): void; // versions' envelopes as far as they are rendered (a 0 byte: not yet)
  update(pos: number, active: number | undefined, pending: boolean, paused: boolean): void;
}

export interface EnvelopeFile {
  rate: number; // bins per s
  versions: Record<string, { peak: string; rms: string; have?: number; total?: number }>; // one byte per bin: (dBFS + 60) × 4
}
type Levels = { rate: number; versions: Record<string, { peak: Float32Array; rms: Float32Array }> };

const DRAG_PX = 8; // sideways this far, and a press on a lane moves the playhead instead of switching
const PEAK_DB = [-24, 0]; // dBFS shown from nothing to full lane height
const RMS_DB = [-32, -6];
const TICK_MIN_PX = 44; // time line labels at least this far apart
const FILL_RATE = 10; // bins per s for envelopes made from audio (as site/envelopes.py)

const CSS = `
.site-listen { position: fixed; left: env(safe-area-inset-left); right: env(safe-area-inset-right); top: var(--top, 64px); bottom: 0; z-index: 2; background: var(--bg); display: flex; flex-direction: column; gap: 10px; padding: 8px 12px calc(12px + env(safe-area-inset-bottom)); }
.site-listen[hidden] { display: none; }
.ls-stage { --lw: 92px; position: relative; flex: 1; min-height: 0; width: 100%; max-width: 1280px; margin-inline: auto; display: flex; flex-direction: column; gap: 6px; touch-action: none; }
@media (min-width: 700px) { .ls-stage { --lw: 124px; } }
.ls-ruler { position: relative; flex: none; height: 16px; margin-left: calc(var(--lw) + 8px); font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; cursor: pointer; }
.ls-ruler span { position: absolute; top: 1px; transform: translateX(-50%); white-space: nowrap; }
.ls-ruler span:first-child { transform: none; }
.ls-lanes { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.site button.ls-lane { flex: 1 1 0; min-height: 0; max-height: 92px; display: grid; grid-template-columns: var(--lw) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 8px; padding: 0; border: 0; border-radius: 12px; background: none; }
.ls-name { display: grid; place-items: center; min-height: 0; overflow: hidden; border-radius: 11px; border: 2px solid var(--v); background: color-mix(in srgb, var(--c) 16%, var(--bg)); color: var(--v); font-weight: 700; font-size: 12.5px; letter-spacing: 0.07em; transition: background 0.2s, color 0.2s, box-shadow 0.2s; }
.ls-env { display: block; width: 100%; height: 100%; min-height: 0; border-radius: 11px; background: color-mix(in srgb, var(--c) 9%, var(--bg)); opacity: 0.8; transition: opacity 0.2s; }
.ls-lane.on .ls-name { background: var(--c); color: var(--ink); box-shadow: 0 0 18px color-mix(in srgb, var(--v) 55%, transparent); }
.ls-lane.on .ls-env { opacity: 1; background: color-mix(in srgb, var(--c) 16%, var(--bg)); box-shadow: 0 0 16px color-mix(in srgb, var(--v) 28%, transparent); }
.ls-lane.pending .ls-name { animation: ls-pulse 0.7s ease-in-out infinite; }
@keyframes ls-pulse { 50% { opacity: 0.5; } }
@media (hover: hover) { .ls-lane:hover .ls-env { opacity: 1; } }
.ls-head { position: absolute; top: 0; bottom: 0; left: 0; width: 2px; margin-left: -1px; background: var(--fg); box-shadow: 0 0 8px rgba(238, 242, 246, 0.55); pointer-events: none; will-change: transform; }
.ls-head::before { content: ''; position: absolute; top: 3px; left: 50%; width: 10px; height: 10px; border-radius: 50%; background: var(--fg); transform: translateX(-50%); }
.ls-tip { position: absolute; top: 0; left: 9px; padding: 0 6px; border-radius: 6px; background: var(--fg); color: var(--bg); font-size: 11px; font-weight: 700; line-height: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ls-tip[hidden] { display: none; }
.ls-head.right .ls-tip, .ls-ghost.right .ls-tip { left: auto; right: 9px; }
.ls-ghost { position: absolute; top: 0; bottom: 0; left: 0; width: 1px; background: rgba(238, 242, 246, 0.45); pointer-events: none; }
.ls-ghost[hidden] { display: none; }
.ls-ghost .ls-tip { background: var(--panel); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line); }
.site button.ls-add { flex: none; width: 100%; max-width: 1280px; margin-inline: auto; padding: 8px 14px; border-radius: 12px; border: 1px dashed var(--line); background: none; color: var(--muted); font-weight: 600; text-align: left; }
.site button.ls-add:hover { color: var(--fg); border-color: var(--muted); }
.site button.ls-add-icon { display: none; font-size: 20px; }
.ls-foot { flex: none; display: grid; justify-items: center; gap: 10px; }
.ls-how { margin: 0; font-size: 12.5px; color: var(--muted); text-align: center; }
.ls-transport { display: flex; align-items: center; gap: 24px; }
.site button.ls-play { width: 64px; height: 64px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center; background: var(--fg); color: var(--bg); box-shadow: 0 0 0 8px rgba(238, 242, 246, 0.12); }
.ls-play svg { width: 26px; height: 26px; }
@media (max-height: 500px) {
  .site-listen { flex-direction: row; align-items: stretch; padding-top: 6px; padding-bottom: calc(8px + env(safe-area-inset-bottom)); }
  .ls-stage, .ls-lanes { gap: 4px; }
  .ls-foot { align-content: center; }
  .ls-how { display: none; }
  .site button.ls-add { display: none; }
  .site button.ls-add-icon { display: grid; }
  .ls-transport { flex-direction: column; gap: 10px; }
  .site button.ls-play { width: 52px; height: 52px; box-shadow: none; }
}
`;

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>',
  start: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="2.5" height="14" rx="1"/><path d="M19 6.3v11.4a1 1 0 0 1-1.53.85l-8.6-5.7a1 1 0 0 1 0-1.7l8.6-5.7A1 1 0 0 1 19 6.3z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.5 6.3v11.4a1 1 0 0 0 1.53.85L12 13.9v3.8a1 1 0 0 0 1.53.85l7.6-5.7a1 1 0 0 0 0-1.7l-7.6-5.7A1 1 0 0 0 12 6.3v3.8L5.03 5.45A1 1 0 0 0 3.5 6.3z"/></svg>',
};

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lit = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255) ** 2.2);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.45; // as the bricks' labels (render.ts)
};
const dB = (b64: string) => Float32Array.from(atob(b64), (ch) => ch.charCodeAt(0) / 4 - 60);
const bytes = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

export function createListenView(bricks: PaletteBrick[], loadEnvelope: (id: string) => Promise<EnvelopeFile | undefined>, d: ListenDeps): ListenView {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.className = 'site-listen site';
  root.hidden = true;
  root.innerHTML = `
    <div class="ls-stage" data-k="stage">
      <div class="ls-ruler" data-k="ruler"></div>
      <div class="ls-lanes" data-k="lanes"></div>
      <div class="ls-ghost" data-k="ghost" hidden><span class="ls-tip" data-k="ghostTip"></span></div>
      <div class="ls-head" data-k="head"><span class="ls-tip" data-k="tip" hidden></span></div>
    </div>
    <button class="ls-add" data-k="add" hidden>+ New emotion</button>
    <div class="ls-foot">
      <p class="ls-how">Tap a name to switch version. Tap or drag on a version to jump there.</p>
      <div class="ls-transport">
        <button class="icon" data-k="start" aria-label="Back to the start">${ICON.start}</button>
        <button class="ls-play" data-k="play" aria-label="Play">${ICON.play}</button>
        <button class="icon" data-k="next" aria-label="Next track">${ICON.next}</button>
        <button class="icon ls-add-icon" data-k="addIcon" aria-label="New emotion" hidden>+</button>
      </div>
    </div>`;
  document.body.append(root);
  const $ = <T extends HTMLElement>(k: string) => root.querySelector<T>(`[data-k="${k}"]`)!;
  const [stage, ruler, head, tip, ghost, ghostTip, play] = ['stage', 'ruler', 'head', 'tip', 'ghost', 'ghostTip', 'play'].map((k) => $(k));

  type Lane = { id: number; key: string; el: HTMLButtonElement; canvas: HTMLCanvasElement; vivid: string };
  const makeLane = (b: PaletteBrick): Lane => {
    const el = document.createElement('button');
    el.className = 'ls-lane';
    el.dataset.id = String(b.id);
    el.setAttribute('aria-pressed', 'false');
    el.setAttribute('aria-label', b.original ? 'The original track' : b.label);
    el.style.setProperty('--c', b.color);
    el.style.setProperty('--v', neon(b.color));
    el.style.setProperty('--ink', lit(b.color) ? '#121417' : '#ffffff');
    el.innerHTML = `<span class="ls-name">${b.label}</span><canvas class="ls-env"></canvas>`;
    $('lanes').append(el);
    // Keyboard (Enter): pointer presses are handled on the stage, where a drag can turn into moving the playhead.
    el.addEventListener('click', (e) => e.detail === 0 && d.onChoose(b.id));
    el.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && d.onPrefetch(b.id));
    return { id: b.id, key: b.original ? 'orig' : String(b.id), el, canvas: el.querySelector('canvas')!, vivid: neon(b.color) };
  };
  let lanes = bricks.map(makeLane);

  let track = '';
  let duration = 0;
  let levels: Levels = { rate: FILL_RATE, versions: {} };
  let fromFile = new Set<string>(); // versions whose whole envelope came from a file (not filled from audio)
  const loaded = new Map<string, Promise<Levels | undefined>>();
  const load = (id: string) => {
    if (!loaded.has(id))
      loaded.set(
        id,
        loadEnvelope(id)
          .then((f) =>
            f && {
              rate: f.rate,
              versions: Object.fromEntries(Object.entries(f.versions).map(([k, v]) => [k, { peak: dB(v.peak), rms: dB(v.rms) }])),
            },
          )
          .catch((err) => {
            console.warn('Envelopes unavailable:', err);
            loaded.delete(id); // asked again with the next track change
            return undefined;
          }),
      );
    return loaded.get(id)!;
  };

  // Where the lanes' envelopes run, in stage px (the playhead and drags map time onto it).
  let x0 = 0;
  let width = 1;
  function measure() {
    const s = stage.getBoundingClientRect();
    const c = lanes[0].canvas.getBoundingClientRect();
    x0 = c.left - s.left;
    width = Math.max(1, c.width);
  }

  function drawRuler() {
    if (!duration) return void (ruler.innerHTML = '');
    const step = [15, 30, 60, 120].find((s) => (s / duration) * width >= TICK_MIN_PX) ?? 120;
    const marks = [];
    for (let t = 0; t <= duration - step / 3; t += step) marks.push(`<span style="left:${(100 * t) / duration}%">${clock(t)}</span>`);
    ruler.innerHTML = marks.join('');
  }

  // A lane's envelope, mirrored about the middle, one column per device pixel: unlit, its RMS outlined in its colour
  // over a faint fill; on, the RMS filled and the peaks round it.
  function draw(l: (typeof lanes)[number]) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const [w, h] = [Math.round(l.canvas.clientWidth * dpr), Math.round(l.canvas.clientHeight * dpr)];
    if (!w || !h) return;
    [l.canvas.width, l.canvas.height] = [w, h];
    const g = l.canvas.getContext('2d')!;
    const on = l.el.classList.contains('on');
    g.fillStyle = g.strokeStyle = l.vivid;
    const v = levels.versions[l.key];
    const mid = h / 2;
    if (!v || !duration) {
      g.globalAlpha = 0.5;
      g.fillRect(0, mid - dpr / 2, w, dpr);
      return;
    }
    const perPx = (duration * levels.rate) / w;
    const column = (a: Float32Array, [lo, hi]: number[]) =>
      Array.from({ length: w }, (_, x) => {
        const [b0, b1] = [Math.floor(x * perPx), Math.max(Math.floor(x * perPx) + 1, Math.floor((x + 1) * perPx))];
        let m = -Infinity;
        for (let b = b0; b < Math.min(b1, a.length); b++) m = Math.max(m, a[b]);
        return Math.max(dpr / 2, clamp01((m - lo) / (hi - lo)) * (mid - 2 * dpr));
      });
    const shape = (ys: number[]) => {
      g.beginPath();
      g.moveTo(0, mid - ys[0]);
      ys.forEach((y, x) => g.lineTo(x + 0.5, mid - y));
      for (let x = w - 1; x >= 0; x--) g.lineTo(x + 0.5, mid + ys[x]);
      g.closePath();
    };
    const rms = column(v.rms, RMS_DB);
    if (on) {
      shape(column(v.peak, PEAK_DB));
      g.globalAlpha = 0.3;
      g.fill();
    }
    shape(rms);
    g.globalAlpha = on ? 1 : 0.16;
    g.fill();
    if (on) return;
    g.globalAlpha = 0.85;
    g.lineWidth = 1.25 * dpr;
    g.lineJoin = 'round';
    g.stroke();
  }

  // Straight away: a resize is reported as layout is done, and the playhead must not be drawn against the old size.
  const relayout = () => {
    if (root.hidden) return;
    measure();
    drawRuler();
    lanes.forEach(draw);
  };
  new ResizeObserver(relayout).observe(stage);
  // Lanes whose envelope grew, drawn once per frame however many chunks arrived.
  const dirty = new Set<string>();
  let queued = false;
  const redraw = () => {
    if (queued || root.hidden) return; // hidden: drawn whole when shown
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      lanes.filter((l) => dirty.has(l.key)).forEach(draw);
      dirty.clear();
    });
  };

  // A press on an envelope (or the time line) takes the playhead there and follows a drag, heard on release, in that
  // envelope's version; a tap on a name switches version where the track is (a sideways drag from one moves the
  // playhead alone).
  let drag: { id: number; x: number; y: number; name?: number; pick?: number; scrub: boolean } | undefined;
  let preview: number | undefined; // s: where a drag has the playhead
  const toPos = (clientX: number) => clamp01((clientX - stage.getBoundingClientRect().left - x0) / width) * duration;
  const laneOf = (el: Element | null) => {
    const lane = el?.closest<HTMLElement>('.ls-lane');
    return lane ? Number(lane.dataset.id) : undefined;
  };
  function scrub(e: PointerEvent) {
    drag!.scrub = true;
    preview = toPos(e.clientX);
    ghost.hidden = true;
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks */
    }
  }
  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !duration) return;
    const at = e.target as Element;
    const env = at.closest('.ls-env');
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, name: env ? undefined : laneOf(at), pick: env ? laneOf(at) : undefined, scrub: false };
    if (env || at.closest('.ls-ruler')) scrub(e);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) {
      // A mouse over the envelopes or the time line: where a click would take the playhead.
      const over = e.pointerType === 'mouse' && !!duration && !!(e.target as Element).closest('.ls-env, .ls-ruler');
      ghost.hidden = !over;
      if (over) {
        const f = toPos(e.clientX) / duration;
        ghost.style.transform = `translateX(${x0 + f * width}px)`;
        ghost.classList.toggle('right', f > 0.85);
        ghostTip.textContent = clock(f * duration);
      }
      return;
    }
    if (e.pointerId !== drag.id) return;
    const [dx, dy] = [Math.abs(e.clientX - drag.x), Math.abs(e.clientY - drag.y)];
    if (!drag.scrub && dx > DRAG_PX && dx > dy) scrub(e);
    if (drag.scrub) preview = toPos(e.clientX);
  });
  stage.addEventListener('pointerleave', () => (ghost.hidden = true));
  stage.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.scrub && preview !== undefined) d.onSeek(preview, drag.pick);
    else if (drag.name !== undefined) d.onChoose(drag.name);
    drag = preview = undefined;
  });
  stage.addEventListener('pointercancel', () => (drag = preview = undefined));

  $('play').addEventListener('click', () => d.onPlay());
  $('start').addEventListener('click', () => d.onSeek(0));
  $('next').addEventListener('click', () => d.onNext());
  for (const k of ['add', 'addIcon'])
    if (d.onAdd) {
      $(k).hidden = false;
      $(k).addEventListener('click', () => d.onAdd!());
    } else $(k).remove();

  let shown: { active?: number; pending?: boolean; paused?: boolean } = {};
  return {
    show(on) {
      root.hidden = !on;
      if (on) relayout();
    },
    setBricks(next) {
      lanes.forEach((l) => l.el.remove());
      lanes = next.map(makeLane);
      shown = {}; // the next update marks the version that is on
      relayout();
    },
    setTrack(id, dur) {
      [track, duration, levels, fromFile] = [id, dur, { rate: FILL_RATE, versions: {} }, new Set()];
      relayout();
      void load(id).then((l) => {
        if (id !== track || !l) return;
        // A file's versions replace whatever audio has filled in meanwhile (offline, the original only).
        if (l.rate !== levels.rate) levels = { rate: l.rate, versions: {} };
        Object.assign(levels.versions, l.versions);
        fromFile = new Set(Object.keys(l.versions));
        relayout();
      });
    },
    fill(version, start, span, buffer) {
      if (!duration || fromFile.has(version)) return;
      const n = Math.ceil(duration * levels.rate);
      const v = (levels.versions[version] ??= { peak: new Float32Array(n).fill(-Infinity), rms: new Float32Array(n).fill(-Infinity) });
      const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      const sr = buffer.sampleRate;
      for (let b = Math.max(0, Math.ceil(start * levels.rate)); b < Math.min(n, Math.floor((start + span) * levels.rate)); b++) {
        const i0 = Math.round((b / levels.rate - start) * sr);
        const i1 = Math.min(chans[0].length, Math.round(((b + 1) / levels.rate - start) * sr));
        if (i1 <= i0) continue;
        let [peak, sum] = [0, 0];
        for (const ch of chans)
          for (let i = i0; i < i1; i++) {
            const a = Math.abs(ch[i]);
            if (a > peak) peak = a;
            sum += ch[i] * ch[i];
          }
        v.peak[b] = 20 * Math.log10(Math.max(peak, 1e-9));
        v.rms[b] = 10 * Math.log10(Math.max(sum / ((i1 - i0) * chans.length), 1e-18));
      }
      dirty.add(version);
      redraw();
    },
    merge(f) {
      if (!duration || f.rate !== levels.rate) return;
      const n = Math.ceil(duration * levels.rate);
      for (const [k, e] of Object.entries(f.versions)) {
        if (fromFile.has(k)) continue;
        const v = (levels.versions[k] ??= { peak: new Float32Array(n).fill(-Infinity), rms: new Float32Array(n).fill(-Infinity) });
        const [p, r] = [bytes(e.peak), bytes(e.rms)];
        for (let b = 0; b < Math.min(n, p.length); b++)
          if (p[b]) [v.peak[b], v.rms[b]] = [p[b] / 4 - 60, r[b] / 4 - 60];
        dirty.add(k);
      }
      redraw();
    },
    update(pos, active, pending, paused) {
      const t = preview ?? pos;
      const f = duration ? clamp01(t / duration) : 0;
      head.style.transform = `translateX(${x0 + f * width}px)`;
      tip.hidden = preview === undefined;
      if (preview !== undefined) {
        tip.textContent = clock(preview);
        head.classList.toggle('right', f > 0.85);
      }
      if (active !== shown.active || pending !== shown.pending)
        for (const l of lanes) {
          const was = l.el.classList.contains('on');
          l.el.classList.toggle('on', l.id === active);
          l.el.classList.toggle('pending', l.id === active && pending);
          l.el.setAttribute('aria-pressed', String(l.id === active));
          if (was !== (l.id === active) && !root.hidden) draw(l);
        }
      if (paused !== shown.paused) {
        play.innerHTML = paused ? ICON.play : ICON.pause;
        play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
      }
      shown = { active, pending, paused };
    },
  };
}
