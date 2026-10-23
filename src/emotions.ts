import type { PaletteBrick } from './palette.ts';
import { fillTrack } from './prompts.ts';

// Offline only: emotions made on this computer. Each is a brick like the palette's own, added at the end of the row,
// but its texts are typed in whole: what Stable Audio is steered toward and what it is pushed away from, with {track}
// standing for what the track already is (so a new one can ask for a saxophone as much as for a feeling). They are kept by the local
// server (server/emotions.json), so every browser on this computer has the same ones, and in this browser as a
// fallback. Their renders are made by the local server as they play, like any other brick's.

const KEY = 'brickbreak.emotions';
const FIRST_ID = 100; // above every palette's ids
const MAX_LABEL = 12; // characters: it has to fit on a brick
// Colours for new bricks, clear of the palette's own (taken in order, skipping any already on the board).
const COLOURS = ['#ffb347', '#8be04e', '#5b8cff', '#ffd84d', '#4dd0a1', '#c792ea', '#ff7a59', '#4fc3f7'];

const valid = (v: unknown): PaletteBrick[] =>
  Array.isArray(v) ? v.filter((b) => b && typeof b.id === 'number' && b.label && b.feel) : [];

function loadLocal(): PaletteBrick[] {
  try {
    return valid(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return []; // storage blocked or unreadable
  }
}

function keepLocal(list: PaletteBrick[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage blocked */
  }
}

// The server's list; this browser's own when the server has none yet (and then the server gets them).
export async function loadEmotions(): Promise<PaletteBrick[]> {
  const local = loadLocal();
  try {
    const r = await fetch('/api/emotions');
    const mine = r.ok ? valid(await r.json()) : [];
    if (mine.length || !local.length) return keepLocal(mine), mine;
    let list = local;
    for (const b of local) list = (await saveEmotion(b)) ?? list;
    return list;
  } catch {
    return local; // no server: what this browser kept
  }
}

// Add or change one on the server; the server's whole list back (undefined: no server, kept in this browser only).
async function saveEmotion(b: PaletteBrick, rename = false): Promise<PaletteBrick[] | undefined> {
  try {
    const r = await fetch('/api/emotions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...b, rename }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = valid((await r.json()).emotions);
    keepLocal(list);
    return list;
  } catch (err) {
    console.warn('Emotion not saved on the server:', err);
    return undefined;
  }
}

async function removeEmotion(id: number): Promise<PaletteBrick[] | undefined> {
  try {
    const r = await fetch(`/api/emotions/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = valid((await r.json()).emotions);
    keepLocal(list);
    return list;
  } catch (err) {
    console.warn('Emotion not removed on the server:', err);
    return undefined;
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

// A brick from the card: its whole texts as typed (see PaletteBrick.template). opposite: the brick its push text came
// from, if any (named in the bar's pill).
export function makeFromTexts(
  label: string,
  prompt: string,
  negative: string,
  opposite: number | undefined,
  board: PaletteBrick[],
  color?: string,
  id = Math.max(FIRST_ID - 1, ...board.map((b) => b.id)) + 1,
  dial: { strength?: number; push?: number; steps?: number } = {}, // its own σ, push and steps (else the settings')
): PaletteBrick {
  const words = fillTrack(prompt, '');
  return {
    id,
    label: label.trim().toUpperCase().slice(0, MAX_LABEL),
    pole: 'light',
    opposite: opposite ?? id,
    note: 72 + ((id - FIRST_ID) % 24),
    color: color ?? nextColour(board),
    template: true,
    prompt: prompt.trim(),
    negative: negative.trim(),
    feel: words,
    listen: [words],
    ...(dial.strength !== undefined ? { strength: dial.strength } : {}),
    ...(dial.push !== undefined ? { push: dial.push } : {}),
    ...(dial.steps && dial.steps !== DEFAULT_STEPS ? { steps: dial.steps } : {}),
  };
}

const CSS = `
.site-form { display: grid; gap: 10px; }
.site-form label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; color: var(--muted); }
.site-form input, .site-form select, .site-form textarea { font: inherit; font-size: 15px; color: var(--fg); background: #1a2129; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; -webkit-user-select: text; user-select: text; }
.site-form textarea { resize: vertical; min-height: 64px; line-height: 1.35; }
.site-form input:focus-visible, .site-form select:focus-visible, .site-form textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.site-form .pair { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
.site-form input[type="color"] { width: 54px; height: 42px; padding: 4px; cursor: pointer; }
.site-form .hint { margin: -2px 0 0; font-size: 12.5px; color: var(--muted); }
.site-form .dials { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.site-form input[type="range"] { padding: 0; accent-color: var(--accent); }
.site-form .dials output { color: var(--fg); font-variant-numeric: tabular-nums; }
.site-form .hint code { color: var(--fg); }
.site-form .err { margin: 0; min-height: 1.2em; font-size: 13px; color: #ff8a7a; }
.site-mine { display: grid; gap: 6px; }
.site-mine:empty { display: none; }
.site-mine div { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; border-radius: 12px; background: #1a2129; border: 1px solid var(--line); }
.site-mine b { flex: none; font-size: 13px; letter-spacing: 0.06em; }
.site-mine span { flex: 1; min-width: 0; font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.site-mine button { flex: none; padding: 5px 11px; font-size: 13px; }
`;

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const DEFAULT_STEPS = 8; // the server's
const TRACK = '{track}, ';
const OWN = 'own'; // the push text is the user's own, not an emotion's
const ITSELF = 'track'; // pushed away from the track as it is: the push then leans on exactly the words added

export interface EmotionCard {
  open(): void;
}

// The card: add one (a name, the prompt, what it is pushed away from, a colour), or edit or remove one made before.
// Both texts are shown whole, as Stable Audio gets them for the playing track.
export function createEmotionCard(d: {
  board(): PaletteBrick[]; // every brick on the board now
  mine(): PaletteBrick[]; // the ones made here
  source(): string; // what the playing track is (its sound tags and tempo): what {track} stands for
  defaults(): { strength: number; push: number }; // the settings' σ and push, for one without its own
  onChange(list: PaletteBrick[]): void; // the new list of the ones made here
}): EmotionCard {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const sheet = document.createElement('div');
  sheet.className = 'site-sheet site';
  sheet.hidden = true;
  sheet.innerHTML = `<div class="site-card" role="dialog" aria-label="New emotion">
    <h1 data-k="title">New emotion</h1>
    <p>Name it and write what the track should become: a feeling, an instrument, a sound. Stable Audio reshapes it toward that, here on this computer, as it plays.</p>
    <form class="site-form" data-k="form">
      <label>Name<input data-k="name" maxlength="${MAX_LABEL}" placeholder="LONGING" autocomplete="off" required /></label>
      <label>Prompt<textarea data-k="prompt" rows="3" placeholder="{track}, longing, aching, saxophone solo" required></textarea></label>
      <div class="pair"><label>Away from<select data-k="opposite"></select></label><label>Colour<input type="color" data-k="colour" /></label></div>
      <textarea data-k="negative" rows="2" aria-label="Away from, in words" placeholder="Nothing: no push"></textarea>
      <p class="hint"><code>{track}</code> is what the track already is: <i data-k="source"></i>. Keep it to keep the track's sound.</p>
      <div class="dials">
        <label>Strength <output data-k="sOut"></output><input type="range" data-k="strength" min="0.5" max="1" step="0.01" /></label>
        <label>Push <output data-k="pOut"></output><input type="range" data-k="push" min="1" max="6" step="0.1" /></label>
        <label>Steps <output data-k="nOut"></output><input type="range" data-k="steps" min="8" max="32" step="4" /></label>
      </div>
      <p class="hint">Strength is how much of the original is replaced: about 0.75 changes the mood and keeps the track; an instrument it doesn't have needs 0.85 or more. Push is how hard it leans away from the second text; away from <i>the track as it is</i>, it leans on exactly the words you added. More steps rebuild new parts more finely, and take longer.</p>
      <p class="site-prompt" data-k="preview"></p>
      <p class="err" data-k="err"></p>
      <div class="go"><button class="big" type="submit" data-k="save">Add</button><button type="button" data-k="close">Close</button></div>
    </form>
    <div class="site-mine" data-k="mine"></div>
  </div>`;
  document.body.append(sheet);
  const $ = <T extends HTMLElement>(k: string) => sheet.querySelector<T>(`[data-k="${k}"]`)!;
  const name = $<HTMLInputElement>('name');
  const prompt = $<HTMLTextAreaElement>('prompt');
  const opposite = $<HTMLSelectElement>('opposite');
  const negative = $<HTMLTextAreaElement>('negative');
  const colour = $<HTMLInputElement>('colour');
  const strength = $<HTMLInputElement>('strength');
  const push = $<HTMLInputElement>('push');
  const steps = $<HTMLInputElement>('steps');
  const err = $('err');
  let editing: PaletteBrick | undefined; // the one being changed, else a new one
  sheet.addEventListener('click', (e) => e.target === sheet && (sheet.hidden = true));
  $('close').addEventListener('click', () => (sheet.hidden = true));

  const emotion = (id: string) => d.board().find((b) => String(b.id) === id && !b.original);
  const pushFrom = (b: PaletteBrick | undefined) => (b ? TRACK + b.feel : '');
  const choiceText = (v: string) => (v === ITSELF ? '{track}' : pushFrom(emotion(v)));
  // The texts as Stable Audio will get them for the playing track.
  function preview() {
    const src = d.source();
    $('source').textContent = src || 'nothing yet (no analysis)';
    const [p, n] = [fillTrack(prompt.value, src), fillTrack(negative.value, src)];
    $('sOut').textContent = Number(strength.value).toFixed(2);
    $('pOut').textContent = Number(push.value).toFixed(1);
    $('nOut').textContent = steps.value;
    $('preview').innerHTML =
      `<b>Prompt:</b> “${esc(p || '…')}”<br><b>Away from:</b> ${n ? `“${esc(n)}”` : 'nothing'}` +
      `<br><b>Strength</b> ${Number(strength.value).toFixed(2)} · <b>push</b> ${n ? Number(push.value).toFixed(1) : 'none'} · <b>steps</b> ${steps.value}`;
  }
  [prompt, strength, push, steps].forEach((el) => el.addEventListener('input', preview));
  negative.addEventListener('input', () => {
    const t = negative.value.trim();
    opposite.value = !t ? '' : t === '{track}' ? ITSELF : negative.value === choiceText(opposite.value) ? opposite.value : OWN;
    preview();
  });
  opposite.addEventListener('change', () => {
    if (opposite.value !== OWN) negative.value = choiceText(opposite.value);
    preview();
  });

  // The form for a new one, or filled with one made before (as its texts would be typed).
  function fill(b?: PaletteBrick) {
    editing = b;
    $('title').textContent = b ? `Edit ${b.label}` : 'New emotion';
    $('save').textContent = b ? 'Save' : 'Add';
    const feelings = d.board().filter((x) => !x.original && x.id !== b?.id);
    opposite.innerHTML = [
      ...feelings.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`),
      `<option value="${ITSELF}">The track as it is</option>`,
      '<option value="">Nothing</option>',
      `<option value="${OWN}">My own words</option>`,
    ].join('');
    const opp = b && b.opposite !== b.id ? emotion(String(b.opposite)) : undefined; // a new one: pushed from nothing
    name.value = b?.label ?? '';
    prompt.value = b ? (b.template ? b.prompt : TRACK + b.feel) : TRACK;
    negative.value = b ? (b.template ? (b.negative ?? '') : pushFrom(opp)) : pushFrom(opp);
    const t = negative.value.trim();
    opposite.value = !t ? '' : t === '{track}' ? ITSELF : negative.value === pushFrom(opp) && opp ? String(opp.id) : OWN;
    colour.value = b?.color ?? nextColour(d.board());
    const def = d.defaults();
    strength.value = String(b?.strength ?? def.strength);
    push.value = String(b?.push ?? def.push);
    steps.value = String(b?.steps ?? DEFAULT_STEPS);
    err.textContent = '';
    $('mine').innerHTML = d
      .mine()
      .map(
        (x) =>
          `<div><b style="color:${x.color}">${esc(x.label)}</b><span>${esc(fillTrack(x.template ? x.prompt : x.feel, ''))}</span>` +
          `<button type="button" data-edit="${x.id}">Edit</button><button type="button" data-remove="${x.id}">Remove</button></div>`,
      )
      .join('');
    preview();
  }
  $('mine').addEventListener('click', async (e) => {
    const t = (e.target as HTMLElement).dataset;
    if (t.edit) return fill(d.mine().find((b) => b.id === Number(t.edit)));
    if (!t.remove) return;
    const id = Number(t.remove);
    const fromServer = await removeEmotion(id);
    const list = fromServer ?? d.mine().filter((b) => b.id !== id);
    if (!fromServer) keepLocal(list); // no server: this browser keeps the change
    d.onChange(list);
    fill(editing && editing.id !== id ? editing : undefined);
  });
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = name.value.trim().toUpperCase();
    if (!label || !fillTrack(prompt.value, '')) return void (err.textContent = 'Give it a name and a prompt.');
    if (d.board().some((b) => b.label === label && b.id !== editing?.id)) return void (err.textContent = `${label} is already on the board.`);
    const opp = emotion(opposite.value);
    const b = makeFromTexts(label, prompt.value, negative.value, opp?.id, d.board(), colour.value, editing?.id, {
      strength: Number(strength.value),
      push: Number(push.value),
      steps: Number(steps.value),
    });
    const here = editing ? d.mine().map((x) => (x.id === editing!.id ? b : x)) : [...d.mine(), b];
    sheet.hidden = true;
    const list = await saveEmotion(b, !!editing);
    if (!list) keepLocal(here); // no server: this browser keeps it
    d.onChange(list ?? here);
  });

  return {
    async open() {
      fill();
      sheet.hidden = false;
      name.focus();
      // Another page on this computer may have added some since this one loaded.
      d.onChange(await loadEmotions()); // the same list: nothing happens
      if (!editing) fill();
    },
  };
}
