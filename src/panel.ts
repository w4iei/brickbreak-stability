import { Pane } from 'tweakpane';
import { PALETTES } from './palette.ts';
import type { SimParams } from './protocol.ts';
import type { WebMidiSink } from './sinks/webmidi.ts';

export interface OutputState {
  midiId: string;
  latencyMs: Record<number, number>; // per channel, may be negative
}

export interface Stats {
  headroomMs: number; // worst margin between event arrival and its play time, last second
  late: number; // events that arrived after their play time
  slowFrames: number; // frames drawn more than 50 ms after the one before (visible stutter), since the scene started
}

interface PanelDeps {
  sim: SimParams;
  output: OutputState;
  stats: Stats;
  midi: WebMidiSink | undefined;
  onReset(): void; // structural change: rebuild the board and start the audio again
  onRebuild(): void; // the board only (the paddle's size): what plays carries on
  onParams(): void; // live change
  simple?: boolean; // the public site: the board's own settings only (no palette, time warp, MIDI or timing)
}

const CHANNELS_SHOWN = 4;

// The settings behind the gear. Offline it also holds the palette, the time warp, MIDI out (each brick's state is a
// held note, for a DAW) and the timing monitor.
export function createPanel(el: HTMLElement, d: PanelDeps) {
  const pane = new Pane({ container: el, title: 'Settings' });

  const board = pane.addFolder({ title: 'Board' });
  board.addBinding(d.sim, 'seed', { step: 1 }).on('change', d.onReset);
  const palette = board.addBinding(d.sim, 'palette', { options: Object.fromEntries(Object.entries(PALETTES).map(([k, p]) => [p.name, k])) });
  palette.on('change', d.onReset);
  board.addBinding(d.sim, 'paddle', { min: 0.4, max: 1.6, label: 'paddle (½ width, m)' }).on('change', d.onRebuild);
  const rate = board.addBinding(d.sim, 'rate', { min: 0.5, max: 4, label: 'time warp' }).on('change', d.onParams);
  board.addBinding(d.sim, 'ballSpeed', { min: 2, max: 14, label: 'ball (m/s)' }).on('change', d.onParams);
  board.addBinding(d.sim, 'autoplay', { label: 'autoplay (arrows take over)' }).on('change', d.onParams);
  board.addBinding(d.sim, 'jelly', { options: { off: 'off', 'next beat': 'beat', 'next bar': 'bar' }, label: 'jelly bricks hold' }).on('change', d.onParams);
  board.addButton({ title: 'Reset' }).on('click', d.onReset);

  const out = pane.addFolder({ title: 'MIDI out', expanded: false });
  const addMidiList = () =>
    out.addBinding(d.output, 'midiId', {
      label: 'port',
      index: 0,
      options: Object.fromEntries((d.midi?.outputs() ?? []).map((o) => [o.name, o.id])),
    });
  let midiList = addMidiList();
  midiList.on('change', (e) => d.midi?.select(e.value));
  d.midi?.onChange(() => {
    midiList.dispose();
    midiList = addMidiList();
    midiList.on('change', (e) => d.midi?.select(e.value));
  });
  out.addBinding(d.sim, 'lookaheadMs', { min: 20, max: 500, step: 1, label: 'lookahead (ms)' }).on('change', d.onParams);
  for (let ch = 0; ch < CHANNELS_SHOWN; ch++)
    out.addBinding(d.output.latencyMs, ch, { min: -100, max: 100, step: 0.5, label: `ch${ch + 1} offset (ms)` });

  const mon = pane.addFolder({ title: 'Timing', expanded: false });
  mon.addBinding(d.stats, 'headroomMs', { readonly: true, label: 'min headroom (ms)', format: (v) => v.toFixed(1) });
  mon.addBinding(d.stats, 'late', { readonly: true, label: 'late events', format: (v) => v.toFixed(0) });
  mon.addBinding(d.stats, 'slowFrames', { readonly: true, label: 'slow frames (>50 ms)', format: (v) => v.toFixed(0) });

  if (d.simple) {
    [palette, rate].forEach((b) => (b.hidden = true));
    [out, mon].forEach((f) => (f.hidden = true));
  }
  return pane;
}
