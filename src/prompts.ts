import type { PaletteBrick } from './palette.ts';

// The text a Stable Audio render is steered toward, and the text it is pushed away from (the opposite brick's).
//   'source' (default): what the track already is, from its analysis (strongest genre / instrument / ensemble / voice
//     tags and its tempo), plus the brick's emotion words. Both texts share the source part, so the push away from the
//     opposite works on the feeling alone: the render keeps the track's sound and changes how it feels.
//   'recipe': the brick's full recipe (genre, instruments, mood), which turns the track into that genre.
export type PromptStyle = 'source' | 'recipe';

export interface SourceInfo {
  tempo?: number;
  tagMatrix?: { tags: string[]; cats: string[]; p: number[][] }; // p: [window][tag]
}

// Not moods (they would fight the brick's). A tag goes in only when the analysis is fairly sure: single instruments are
// the tags it mishears most (the Larghetto's clarinet came out as trombone and pipe organ), so they need more.
const MIN_P: Record<string, number> = { genre: 0.1, ensemble: 0.1, vocals: 0.1, instrument: 0.25 };
const SOURCE_TAGS = 3;

export function describeSource(a: SourceInfo | undefined): string {
  const m = a?.tagMatrix;
  const parts: string[] = [];
  if (m?.p.length) {
    const mean = m.tags.map((_, j) => m.p.reduce((s, row) => s + row[j], 0) / m.p.length);
    parts.push(
      ...m.tags
        .map((tag, j) => ({ tag, v: mean[j], cat: m.cats[j] }))
        .filter((t) => t.cat in MIN_P && t.v >= MIN_P[t.cat])
        .sort((x, y) => y.v - x.v)
        .slice(0, SOURCE_TAGS)
        .map((t) => t.tag),
    );
  }
  if (a?.tempo) parts.push(`${Math.round(a.tempo)} BPM`);
  return parts.join(', ');
}

// A typed text with {track} in it, for this track (and tidy where the track has no description).
export const fillTrack = (text: string, source: string) =>
  text
    .replaceAll('{track}', source)
    .replace(/(\s*,\s*)+/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '');

export function renderPrompts(b: PaletteBrick, opposite: PaletteBrick | undefined, style: PromptStyle, source: string) {
  if (b.template) return { prompt: fillTrack(b.prompt, source), negative: fillTrack(b.negative ?? '', source) };
  if (style === 'recipe') return { prompt: b.prompt, negative: opposite?.prompt ?? '' };
  const on = (feel: string) => (source ? `${source}, ${feel}` : feel);
  return { prompt: on(b.feel), negative: opposite ? on(opposite.feel) : '' };
}
