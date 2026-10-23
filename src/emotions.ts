import type { PaletteBrick } from './palette.ts';

// Offline only: emotions made on this computer. Each is a brick like the palette's own (a name, the words Stable
// Audio is steered toward, an opposite it is pushed away from), added at the end of the row, kept in this browser.
// Its renders are made by the local server as it plays, like any other brick's.

const KEY = 'brickbreak.emotions';
const FIRST_ID = 100; // above every palette's ids
const MAX_LABEL = 12; // characters: it has to fit on a brick
// Colours for new bricks, clear of the palette's own (taken in order, skipping any already on the board).
const COLOURS = ['#ffb347', '#8be04e', '#5b8cff', '#ffd84d', '#4dd0a1', '#c792ea', '#ff7a59', '#4fc3f7'];

export function loadEmotions(): PaletteBrick[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as PaletteBrick[];
    return Array.isArray(v) ? v.filter((b) => b && typeof b.id === 'number' && b.label && b.feel) : [];
  } catch {
    return []; // storage blocked or unreadable: start empty
  }
}

function saveEmotions(list: PaletteBrick[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: they last until the page is closed */
  }
}

// The colour a new brick gets unless one is picked: the first of COLOURS not already on the board.
export const nextColour = (board: PaletteBrick[]) => {
  const used = new Set(board.map((b) => b.color.toLowerCase()));
  return COLOURS.find((c) => !used.has(c)) ?? COLOURS[board.length % COLOURS.length];
};

// words: what the music should feel like, comma-separated ("nostalgic, wistful, warm, hazy").
export function makeEmotion(label: string, words: string, opposite: number | undefined, board: PaletteBrick[], color?: string): PaletteBrick {
  const id = Math.max(FIRST_ID - 1, ...board.map((b) => b.id)) + 1;
  return {
    id,
    label: label.trim().toUpperCase().slice(0, MAX_LABEL),
    pole: 'light',
    opposite: opposite ?? id, // its own id: no push (renderPrompts finds no opposite)
    note: 72 + ((id - FIRST_ID) % 24),
    color: color ?? nextColour(board),
    prompt: words.trim(),
    feel: words.trim(),
    listen: [words.trim()],
  };
}

const CSS = `
.site-form { display: grid; gap: 10px; }
.site-form label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; color: var(--muted); }
.site-form input, .site-form select { font: inherit; font-size: 15px; color: var(--fg); background: #1a2129; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; -webkit-user-select: text; user-select: text; }
.site-form input:focus-visible, .site-form select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.site-form .pair { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
.site-form input[type="color"] { width: 54px; height: 42px; padding: 4px; cursor: pointer; }
.site-form .err { margin: 0; min-height: 1.2em; font-size: 13px; color: #ff8a7a; }
.site-mine { display: grid; gap: 6px; }
.site-mine:empty { display: none; }
.site-mine div { display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 12px; border-radius: 12px; background: #1a2129; border: 1px solid var(--line); }
.site-mine b { flex: none; font-size: 13px; letter-spacing: 0.06em; }
.site-mine span { flex: 1; min-width: 0; font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.site-mine button { flex: none; padding: 5px 11px; font-size: 13px; }
`;

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface EmotionCard {
  open(): void;
}

// The card: add one (name, words, what it moves away from), or remove one made before.
export function createEmotionCard(d: {
  board(): PaletteBrick[]; // every brick on the board now
  mine(): PaletteBrick[]; // the ones made here
  onChange(list: PaletteBrick[]): void; // the new list of the ones made here
}): EmotionCard {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const sheet = document.createElement('div');
  sheet.className = 'site-sheet site';
  sheet.hidden = true;
  sheet.innerHTML = `<div class="site-card" role="dialog" aria-label="New emotion">
    <h1>New emotion</h1>
    <p>Name a feeling and describe it in a few words. Stable Audio reshapes the track toward them, here on this computer, as it plays.</p>
    <form class="site-form" data-k="form">
      <label>Name<input data-k="name" maxlength="${MAX_LABEL}" placeholder="NOSTALGIA" autocomplete="off" required /></label>
      <label>Words<input data-k="words" placeholder="nostalgic, wistful, warm, hazy" autocomplete="off" required /></label>
      <div class="pair"><label>Away from<select data-k="opposite"></select></label><label>Colour<input type="color" data-k="colour" /></label></div>
      <p class="err" data-k="err"></p>
      <div class="go"><button class="big" type="submit">Add</button><button type="button" data-k="close">Close</button></div>
    </form>
    <div class="site-mine" data-k="mine"></div>
  </div>`;
  document.body.append(sheet);
  const $ = <T extends HTMLElement>(k: string) => sheet.querySelector<T>(`[data-k="${k}"]`)!;
  const [name, words, opposite, colour, err] = [$<HTMLInputElement>('name'), $<HTMLInputElement>('words'), $<HTMLSelectElement>('opposite'), $<HTMLInputElement>('colour'), $('err')];
  sheet.addEventListener('click', (e) => e.target === sheet && (sheet.hidden = true));
  $('close').addEventListener('click', () => (sheet.hidden = true));

  function show() {
    colour.value = nextColour(d.board());
    const feelings = d.board().filter((b) => !b.original);
    opposite.innerHTML = [...feelings.map((b) => `<option value="${b.id}">${esc(b.label)}</option>`), '<option value="">Nothing</option>'].join('');
    $('mine').innerHTML = d
      .mine()
      .map((b) => `<div><b style="color:${b.color}">${esc(b.label)}</b><span>${esc(b.feel)}</span><button type="button" data-remove="${b.id}">Remove</button></div>`)
      .join('');
  }
  $('mine').addEventListener('click', (e) => {
    const id = Number((e.target as HTMLElement).dataset.remove);
    if (!id) return;
    const list = d.mine().filter((b) => b.id !== id);
    saveEmotions(list);
    d.onChange(list);
    show();
  });
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const label = name.value.trim().toUpperCase();
    if (!label || !words.value.trim()) return void (err.textContent = 'Give it a name and a few words.');
    if (d.board().some((b) => b.label === label)) return void (err.textContent = `${label} is already on the board.`);
    const b = makeEmotion(label, words.value, opposite.value ? Number(opposite.value) : undefined, d.board(), colour.value);
    const list = [...d.mine(), b];
    saveEmotions(list);
    d.onChange(list);
    [name.value, words.value, err.textContent] = ['', '', ''];
    sheet.hidden = true;
  });

  return {
    open() {
      show();
      err.textContent = '';
      sheet.hidden = false;
      name.focus();
    },
  };
}
