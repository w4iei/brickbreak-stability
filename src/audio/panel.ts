import type { BindingApi } from '@tweakpane/core';
import type { ButtonApi, Pane } from 'tweakpane';
import type { AudioStats, BreakoutSettings, createPlayer } from './player.ts';

type Player = ReturnType<typeof createPlayer>;

// Audio folder: state MIDI channel, the Stable Audio controls, the track list and how the look-ahead is doing.
// start() / stop() follow the scene: entering (or resetting) it starts audio from scratch, leaving it stops everything.
// Start audio stays as the fallback for when the browser wants a click first or the server was down.
// simple (the site): its renders are fixed, so no intensity, push, prompts, MIDI or pre-rendering.
export function addBreakoutPanel(pane: Pane, player: Player, s: BreakoutSettings, stats: AudioStats, simple = false) {
  const f = pane.addFolder({ title: 'Audio', index: 1 });
  const offline = [f.addBinding(s, 'channel', { min: 0, max: 15, step: 1, label: 'state MIDI ch', format: (v) => String(v + 1) })];
  const rerender = () => player.settingsChanged();
  offline.push(
    f.addBinding(s, 'intensity', { min: 0, max: 1, label: 'intensity' }).on('change', rerender),
    f.addBinding(s, 'push', { min: 1, max: 3, label: 'push from opposite' }).on('change', rerender),
    f.addBinding(s, 'style', { options: { 'emotion only (keep sound)': 'source', 'full recipe (genre)': 'recipe' }, label: 'prompts' }).on('change', rerender),
  );
  f.addBinding(s, 'mix', { min: 0, max: 1, label: 'render mix' }).on('change', () => player.setMix());
  f.addBinding(s, 'fade', { min: 0.02, max: 2, label: 'switch fade (s)' });
  f.addBinding(s, 'quantize', { options: { off: 'off', beat: 'beat', bar: 'bar' }, label: 'switch on' });
  f.addBinding(s, 'hold', { min: 0, max: 8, step: 1, label: 'min state (bars)' });

  const startButton = f.addButton({ title: 'Start audio', hidden: simple });
  const pick = { track: 0 };
  let trackList: BindingApi<unknown, number> | undefined;
  let next: ButtonApi | undefined;
  function clearTracks() {
    trackList?.dispose();
    next?.dispose();
    trackList = next = undefined;
  }

  async function start() {
    clearTracks();
    startButton.hidden = false;
    startButton.disabled = true;
    try {
      if (!(await player.start())) return; // stopped meanwhile
      startButton.hidden = true;
      // (the site's track list is its own, in the page)
      pick.track = player.trackIndex;
      trackList = f.addBinding(pick, 'track', {
        index: 7,
        options: Object.fromEntries(player.tracks().map((t, i) => [t.name.replace(/\.[^.]+$/, ''), i])),
      });
      trackList.on('change', (e) => void player.select(e.value));
      trackList.hidden = simple;
      next = f.addButton({ title: 'Next track', index: 8, hidden: simple });
      next.on('click', () => void player.next().then(() => (pick.track = player.trackIndex)));
    } catch (err) {
      stats.server = `not started — ${(err as Error).message}`;
    } finally {
      startButton.disabled = false;
    }
  }
  startButton.on('click', () => void start());

  const ro = { readonly: true, interval: 250 } as const;
  offline.push(f.addBinding(stats, 'server', { ...ro, label: 'engine' }));
  f.addBinding(stats, 'track', ro);
  f.addBinding(stats, 'position', ro);
  f.addBinding(stats, 'renders', ro);
  offline.push(f.addBinding(stats, 'lastMs', { ...ro, label: 'last render (ms)', format: (v) => v.toFixed(0) }));
  f.addBinding(stats, 'onTime', { ...ro, label: 'switches ready' });
  offline.push(f.addBinding(stats, 'prerender', { ...ro, label: 'pre-rendered' }));
  // Every track at the current settings; the server works on it only while no game is playing.
  const all = f.addButton({ title: 'Pre-render all tracks', hidden: simple });
  const allTitle = () => (all.title = player.batchRunning ? 'Stop pre-rendering all tracks' : 'Pre-render all tracks');
  all.on('click', () => void (player.batchRunning ? player.stopPrerenderAll() : player.prerenderAll()).then(allTitle));
  setInterval(allTitle, 1000);
  offline.push(f.addBinding(stats, 'prerenderAll', { ...ro, label: 'all tracks' }));
  if (simple) offline.forEach((b) => (b.hidden = true)); // the site's renders are fixed

  return {
    folder: f,
    start,
    stop() {
      player.stop();
      clearTracks();
      startButton.hidden = false;
    },
  };
}
