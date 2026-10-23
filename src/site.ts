// The public page round the breakout board (klavecimbel.com/brickbreak), laid out like a phone game: a slim bar on top
// (what the music is now, hear the original, sound, pause, the menu), a line with the Game / Listen tabs and where the
// track is, and below it the board to the edges (Listen: every version of the track, listen.ts), its paddle near the bottom of the screen, steered by dragging anywhere on it. Everything else
// is in the menu: next track, a new emotion (offline only), how it works, technical details, settings, about the maker,
// links, and a share card (QR code and address). A short intro comes first (Go); the
// game then plays muted (phones need a tap before audio) with a big sound button in the middle until it is tapped;
// after that, while the demo steers, a hint above the paddle says how to take over.

export interface SiteUI {
  setActive(b: { label: string; color: string; opposite?: string } | undefined): void;
  setTrack(title: string, artist: string): void;
  setPaused(paused: boolean): void;
  setMuted(muted: boolean): void;
  setProgress(pos: number, duration: number): void; // s
  setDemo(on: boolean): void; // the demo steers the paddle
  setListen(on: boolean): void; // the Listen tab instead of the game
}

export interface SiteDeps {
  onSound(on: boolean): void;
  onPause(): void; // toggle
  onHold(on: boolean): void;
  onNextTrack(): void;
  onSettings(open: boolean): void;
  onListen(on: boolean): void; // a tab picked
  onNewEmotion?(): void; // offline (renders made on this computer): the New emotion card
}

const STABILITY = 'https://stability.ai';
const ARTIST = 'https://soundcloud.com/kunakbaeva';
const MAKER = 'https://noahjaffe.org';
const SITE_URL = 'https://klavecimbel.com/brickbreak/'; // what the share card's QR code (site/qr.py) opens

const CSS = `
:root { --bg: #0b0d10; --fg: #eef2f6; --muted: #8a98a6; --line: #232b34; --panel: #141a20; --accent: #7fb2e5; }
html, body { overscroll-behavior: none; }
.site, .site * { box-sizing: border-box; }
body.site { position: fixed; inset: 0; font: 15px/1.4 -apple-system, system-ui, sans-serif; color: var(--fg); -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
/* A canvas is sized by its own pixels unless told: give it everything below the bar outright. */
body.site #view { position: fixed; left: env(safe-area-inset-left); right: env(safe-area-inset-right); top: var(--top, 64px); bottom: env(safe-area-inset-bottom); height: calc(100vh - var(--top, 64px) - env(safe-area-inset-bottom)); height: calc(100dvh - var(--top, 64px) - env(safe-area-inset-bottom)); touch-action: none; }
body.site #panel { display: none; top: calc(var(--top, 64px) + 8px); right: 8px; z-index: 7; }
body.site.settings #panel { display: block; }
.site button { font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px; cursor: pointer; touch-action: manipulation; }
.site button:focus-visible, .site a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.site a { color: inherit; text-decoration: underline; text-decoration-color: rgba(138, 152, 166, 0.5); text-underline-offset: 2px; }
.site-top { position: fixed; top: 0; left: 0; right: 0; z-index: 4; background: var(--bg); padding: max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 6px max(12px, env(safe-area-inset-left)); display: grid; gap: 6px; }
.site-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.site-sp { flex: 1; min-width: 4px; }
.site .icon { width: 38px; height: 38px; padding: 0; display: grid; place-items: center; font-size: 16px; flex: none; }
.site-pill { border-radius: 999px; padding: 5px 12px; font-weight: 800; font-size: 14px; letter-spacing: 0.04em; white-space: nowrap; transition: background 0.25s, color 0.25s; }
.site-hear { white-space: nowrap; flex: none; }
.site-hear.held { background: var(--fg); color: var(--bg); }
.site-line { display: flex; align-items: center; gap: 8px; }
.site-tabs { display: flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.site .site-tabs button { border: 0; background: none; padding: 3px 11px; font-size: 12.5px; font-weight: 700; color: var(--muted); }
.site .site-tabs button[aria-selected="true"] { background: var(--fg); color: var(--bg); }
body.site.listen .site-unmute, body.site.listen .site-hint { display: none; }
.site-line .bar { flex: 1; min-width: 24px; height: 3px; background: #1d242c; border-radius: 2px; overflow: hidden; }
.site-line .fill { height: 100%; width: 0; background: #6f7d8a; }
.site-line .time { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.site-line .song { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
/* A phone upright: the tabs, the song and the time; the line of where the track is would be a stub. */
@media (max-width: 480px) { .site-line .bar { display: none; } .site-line .song { flex: 1; max-width: none; } }
/* Narrow phones: the top row fits a long mood name (ORIGINAL, EUPHORIA) and the menu button. */
@media (max-width: 400px) { .site-row { gap: 6px; } .site-sp { min-width: 0; } .site .icon { width: 36px; height: 36px; } .site-pill { padding: 5px 10px; } }
.site-sheet { position: fixed; inset: 0; z-index: 6; display: grid; place-items: center; background: rgba(5, 7, 9, 0.78); padding: 16px; overflow-y: auto; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.site-sheet[hidden] { display: none; }
.site-card { width: min(100%, 440px); margin-block: auto; /* centred, and a tall card scrolls from its top */ display: grid; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 20px; padding: 22px 20px; }
.site-card h1 { margin: 0; font-size: 21px; letter-spacing: 0.02em; }
.site-card h1 small { display: block; font-size: 13px; font-weight: 500; color: var(--muted); letter-spacing: 0; margin-top: 4px; }
.site-card p, .site-card li { margin: 0; color: #c6cfd8; font-size: 14.5px; }
.site-card ol { margin: 0; padding-left: 20px; display: grid; gap: 7px; }
.site-card b { color: var(--fg); }
.site-card .go { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 2px; }
.site-card .go > * { flex: 1; text-align: center; padding: 14px 20px; }
.site-card .big, .site-card a.big { font-size: 18px; font-weight: 700; background: var(--fg); color: var(--bg); border: 0; border-radius: 999px; text-decoration: none; }
/* In the open middle of the board (it sits at the foot of the space below the bar), between the bricks and the paddle. */
.site button.site-unmute { position: fixed; left: 50%; top: calc(var(--top, 64px) + (100dvh - var(--top, 64px)) * 0.64); transform: translate(-50%, -50%); z-index: 5; width: 104px; height: 104px; padding: 0; border-radius: 50%; border: 0; font-size: 46px; line-height: 1; background: var(--fg); color: var(--bg); box-shadow: 0 0 0 10px rgba(238, 242, 246, 0.14); }
.site .icon svg { width: 22px; height: 22px; }
/* While the demo steers: how to take over, just above the paddle (a finger sliding, a soft pulse; touches pass through). */
.site-hint { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom) + 14%); transform: translateX(-50%); z-index: 3; display: flex; align-items: center; gap: 8px; padding: 8px 15px 8px 11px; border-radius: 999px; background: rgba(20, 26, 32, 0.85); border: 1px solid var(--line); font-size: 14px; font-weight: 600; white-space: nowrap; pointer-events: none; animation: site-hint-pulse 1.6s ease-in-out infinite; }
.site-hint[hidden] { display: none; }
.site-hint .finger { display: inline-block; font-size: 19px; animation: site-hint-slide 1.6s ease-in-out infinite; }
.site-hint .keys { display: none; color: var(--muted); font-weight: 500; }
@media (hover: hover) and (pointer: fine) { .site-hint .keys { display: inline; } }
@keyframes site-hint-pulse { 50% { border-color: var(--accent); box-shadow: 0 0 0 6px rgba(127, 178, 229, 0.22); } }
@keyframes site-hint-slide { 0%, 100% { transform: translateX(-7px); } 50% { transform: translateX(7px); } }
@media (prefers-reduced-motion: reduce) { .site-hint, .site-hint .finger { animation: none; } }
/* A phone on its side: one slim bar, so the board keeps the height. */
@media (max-height: 500px) {
  .site-top { grid-template-columns: auto 1fr; align-items: center; column-gap: 12px; padding-top: max(4px, env(safe-area-inset-top)); padding-bottom: 4px; }
  .site-top .site-row { grid-column: 2; grid-row: 1; }
  .site-top .site-line { grid-column: 1; grid-row: 1; min-width: 270px; }
  .site-line .song { display: none; }
  .site .icon { width: 34px; height: 34px; }
  .site button.site-unmute { width: 76px; height: 76px; font-size: 34px; top: calc(var(--top, 48px) + (100dvh - var(--top, 48px)) / 2); }
}
.site-menu { display: grid; gap: 8px; }
.site-menu button, .site-menu a { display: block; width: 100%; text-align: left; padding: 13px 16px; border-radius: 14px; background: #1a2129; border: 1px solid var(--line); color: var(--fg); text-decoration: none; font-weight: 600; }
.site-card img.site-qr { width: min(100%, 230px); aspect-ratio: 1; justify-self: center; background: #fff; border-radius: 14px; padding: 8px; }
.site-card p.site-url { text-align: center; font-size: 17px; font-weight: 700; color: var(--fg); -webkit-user-select: text; user-select: text; }
.site-card p.site-prompt { font-size: 13.5px; background: #1a2129; border: 1px solid var(--line); border-radius: 10px; padding: 8px 11px; }
.site-menu small { display: block; font-weight: 400; color: var(--muted); font-size: 12.5px; }
`;

const light = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255) ** 2.2);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.3;
};

export function createSiteUI(d: SiteDeps): SiteUI {
  document.body.classList.add('site');
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  // A game, not a page: no pinch zoom, full screen when saved to the home screen.
  document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  for (const [name, content] of [['apple-mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-status-bar-style', 'black-translucent'], ['mobile-web-app-capable', 'yes']]) {
    const m = document.createElement('meta');
    m.name = name;
    m.content = content;
    document.head.append(m);
  }

  const top = document.createElement('div');
  top.className = 'site-top site';
  top.innerHTML = `
    <div class="site-row">
      <span class="site-pill" data-k="pill">ORIGINAL</span>
      <div class="site-sp"></div>
      <button class="site-hear" data-k="hear" aria-label="Hold to hear the original track">Hear original</button>
      <button class="icon" data-k="sound" aria-label="Sound on">🔇</button>
      <button class="icon" data-k="pause" aria-label="Pause">❚❚</button>
      <button class="icon" data-k="menu" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 4.3c.4-1.8 3-1.8 3.4 0a1.7 1.7 0 0 0 2.6 1.1c1.5-.9 3.3.8 2.3 2.3a1.7 1.7 0 0 0 1.1 2.6c1.8.4 1.8 3 0 3.4a1.7 1.7 0 0 0-1.1 2.6c.9 1.5-.8 3.3-2.3 2.3a1.7 1.7 0 0 0-2.6 1.1c-.4 1.8-3 1.8-3.4 0a1.7 1.7 0 0 0-2.6-1.1c-1.5.9-3.3-.8-2.3-2.3a1.7 1.7 0 0 0-1.1-2.6c-1.8-.4-1.8-3 0-3.4a1.7 1.7 0 0 0 1.1-2.6c-.9-1.5.8-3.3 2.3-2.3a1.7 1.7 0 0 0 2.6-1.1z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div>
    <div class="site-line"><div class="site-tabs" role="tablist" aria-label="Mode"><button role="tab" aria-selected="true" data-k="game">Game</button><button role="tab" aria-selected="false" data-k="listen">Listen</button></div><span class="song" data-k="song"></span><div class="bar"><div class="fill" data-k="fill"></div></div><span class="time" data-k="time"></span></div>`;

  // A card over the board; a tap beside it closes it, unless it waits for its own button.
  const sheet = (html: string, modal = false) => {
    const el = document.createElement('div');
    el.className = 'site-sheet site';
    el.hidden = true;
    el.innerHTML = `<div class="site-card" role="dialog">${html}</div>`;
    if (!modal) el.addEventListener('click', (e) => e.target === el && (el.hidden = true));
    return el;
  };
  const intro = sheet(`
    <h1>BRICK BREAKER × STABLE AUDIO</h1>
    <p>Music by <a href="${ARTIST}" target="_blank" rel="noopener"><b>Yana Kunakbaeva</b></a><br>Demo by <a href="${MAKER}" target="_blank" rel="noopener"><b>Noah Jaffe</b></a></p>
    <p>When the ball hits a brick, the song turns into that emotion, re-rendered by <a href="${STABILITY}" target="_blank" rel="noopener">Stability AI</a>’s Stable Audio.</p>
    <p><b>For DJs:</b> steer the mood of a track live, on the beat.</p>
    <div class="go"><button class="big" data-k="go">Go</button></div>`,
    true,
  );
  intro.hidden = false;
  const about = sheet(`
    <h1>About the maker</h1>
    <p>Noah Jaffe is a PhD researcher and engineer in Amsterdam, building PHOTON, an optical sensing platform for historical keyboard instruments.</p>
    <div class="go"><a class="big" href="${MAKER}" target="_blank" rel="noopener">noahjaffe.org ↗</a><button data-k="close">Close</button></div>`);
  const menu = sheet(`
    <div class="site-menu">
      <button data-k="next">Next track</button>
      ${d.onNewEmotion ? '<button data-k="emotion">New emotion<small>Your own words, rendered on this computer</small></button>' : ''}
      <button data-k="how">How it works</button>
      <button data-k="tech">Technical details</button>
      <button data-k="settings">Settings</button>
      <button data-k="about">About the maker: Noah Jaffe</button>
      <a href="${ARTIST}" target="_blank" rel="noopener">Yana Kunakbaeva on SoundCloud ↗</a>
      <a href="${STABILITY}" target="_blank" rel="noopener">Stability AI ↗</a>
      <button data-k="share">Share</button>
    </div>`);
  const tech = sheet(`
    <h1>Technical details</h1>
    <p>A typical laptop renders 7 seconds of music in about 1 second.</p>
    <p><b>From the original to the new audio</b> (4 bars at a time)</p>
    <ol>
      <li><b>Encode:</b> the audio is compressed into the model’s latent space, a compact version of the sound that the model edits.</li>
      <li><b>Add noise:</b> part of that latent is replaced with random noise.</li>
      <li><b>Denoise:</b> Stable Audio 3 removes the noise in 3 steps, filling it back in to match the text.</li>
      <li><b>Decode:</b> the latent becomes audio again and fades in on the beat.</li>
    </ol>
    <p><b>Strength 0.75:</b> how much of the original is replaced. 0 is the original, 1 is all new.</p>
    <p><b>Push 2.5:</b> how hard it leans toward the brick’s words, away from the opposite brick’s.</p>
    <p>Each brick’s label is its prompt. For example:</p>
    <p class="site-prompt"><b>RAGE:</b> “trance, techno, 140 BPM, furious, violent, aggressive, relentless, harsh”, pushed away from SERENITY</p>
    <p class="site-prompt"><b>SERENITY:</b> “trance, techno, 140 BPM, serene, calm, peaceful, still, weightless”, pushed away from RAGE</p>
    <div class="go"><button data-k="close">Close</button></div>`);
  const share = sheet(`
    <h1>Share</h1>
    <img class="site-qr" src="${import.meta.env.BASE_URL}qr.svg" alt="QR code for ${SITE_URL}" />
    <p class="site-url">${SITE_URL.replace(/^https:\/\/|\/$/g, '')}</p>
    <div class="go"><button class="big" data-k="send">Share link</button><button data-k="close">Close</button></div>`);
  // Sound on: one big button in the middle of the board, gone for good once sound is on.
  let unmute: HTMLButtonElement | undefined = document.createElement('button');
  unmute.className = 'site-unmute site';
  unmute.setAttribute('aria-label', 'Sound on');
  unmute.textContent = '🔇';
  unmute.addEventListener('click', () => d.onSound(true));
  // Then, one thing at a time: how to take over from the demo (back whenever the demo is).
  const hint = document.createElement('div');
  hint.className = 'site-hint site';
  hint.hidden = true;
  hint.innerHTML = `<span class="finger" aria-hidden="true">👇</span>Drag to take over<span class="keys">· or ← →</span>`;
  let demo = true;
  const showHint = () => (hint.hidden = !demo || !!unmute);
  document.body.append(top, unmute, hint, intro, about, tech, menu, share);
  const $ = <T extends HTMLElement>(root: HTMLElement, k: string) => root.querySelector<T>(`[data-k="${k}"]`)!;

  // The board starts where the bar ends, whatever its height on this screen.
  const fit = () => document.body.style.setProperty('--top', `${top.offsetHeight}px`);
  new ResizeObserver(fit).observe(top);
  fit();

  let muted = true;
  $(intro, 'go').addEventListener('click', () => (intro.hidden = true));
  $(top, 'sound').addEventListener('click', () => d.onSound(muted));
  $(top, 'pause').addEventListener('click', () => d.onPause());
  $(top, 'game').addEventListener('click', () => d.onListen(false));
  $(top, 'listen').addEventListener('click', () => d.onListen(true));
  $(top, 'menu').addEventListener('click', () => {
    if (document.body.classList.contains('settings')) {
      document.body.classList.remove('settings');
      d.onSettings(false);
    } else menu.hidden = false;
  });
  $(menu, 'next').addEventListener('click', () => {
    menu.hidden = true;
    d.onNextTrack();
  });
  if (d.onNewEmotion)
    $(menu, 'emotion').addEventListener('click', () => {
      menu.hidden = true;
      d.onNewEmotion!();
    });
  $(menu, 'how').addEventListener('click', () => {
    menu.hidden = true;
    intro.hidden = false;
  });
  $(menu, 'tech').addEventListener('click', () => {
    menu.hidden = true;
    tech.hidden = false;
  });
  $(tech, 'close').addEventListener('click', () => (tech.hidden = true));
  $(menu, 'settings').addEventListener('click', () => {
    menu.hidden = true;
    document.body.classList.add('settings'); // the menu button closes it again
    d.onSettings(true);
  });
  $(menu, 'about').addEventListener('click', () => {
    menu.hidden = true;
    about.hidden = false;
  });
  $(about, 'close').addEventListener('click', () => (about.hidden = true));
  $(menu, 'share').addEventListener('click', () => {
    menu.hidden = true;
    share.hidden = false;
  });
  // The phone's own share sheet where there is one; otherwise the address to the clipboard.
  $(share, 'send').addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    try {
      if (navigator.share) await navigator.share({ title: document.title, url: SITE_URL });
      else {
        await navigator.clipboard.writeText(SITE_URL);
        b.textContent = 'Link copied';
      }
    } catch {
      /* dismissed */
    }
  });
  $(share, 'close').addEventListener('click', () => (share.hidden = true));

  // Hear the original: press and hold (mouse, finger, or the O key in main.ts).
  const hear = $(top, 'hear');
  const held = (on: boolean) => {
    hear.classList.toggle('held', on);
    d.onHold(on);
  };
  hear.addEventListener('pointerdown', (e) => {
    held(true);
    hear.setPointerCapture?.(e.pointerId);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) hear.addEventListener(ev, () => held(false));
  hear.addEventListener('contextmenu', (e) => e.preventDefault()); // a long press on phones

  const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  return {
    setActive(b) {
      const pill = $(top, 'pill');
      pill.textContent = b?.label ?? 'ORIGINAL';
      pill.style.background = b?.color ?? '#c9d4df';
      pill.style.color = b && !light(b.color) ? '#f2f4f6' : '#121417';
      pill.title = b?.opposite ? `${b.label}, away from ${b.opposite}` : 'The track as it is';
    },
    setTrack(title, artist) {
      $(top, 'song').textContent = [title, artist].filter(Boolean).join(' · ');
    },
    setPaused(paused) {
      const b = $(top, 'pause');
      b.textContent = paused ? '▶' : '❚❚';
      b.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    },
    setMuted(m) {
      muted = m;
      if (!m) {
        unmute?.remove();
        unmute = undefined;
        showHint();
      }
      const b = $(top, 'sound');
      b.textContent = m ? '🔇' : '🔊';
      b.setAttribute('aria-label', m ? 'Sound on' : 'Mute');
    },
    setProgress(pos, duration) {
      $(top, 'fill').style.width = `${Math.min(100, (100 * Math.max(0, pos)) / duration)}%`;
      $(top, 'time').textContent = `${clock(Math.max(0, pos))} / ${clock(duration)}`;
    },
    setDemo(on) {
      if (on === demo) return;
      demo = on;
      showHint();
    },
    setListen(on) {
      document.body.classList.toggle('listen', on);
      $(top, 'game').setAttribute('aria-selected', String(!on));
      $(top, 'listen').setAttribute('aria-selected', String(on));
    },
  };
}
