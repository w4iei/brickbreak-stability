import palettes from './palettes.json' with { type: 'json' };

// A palette says what each breakout brick id means: its label, MIDI note, colour and the Stable Audio prompt it
// steers the track towards. Each brick names its opposite, which the audio pushes away from.
export interface PaletteBrick {
  id: number;
  label: string;
  pole: string; // 'dark' | 'light'
  opposite: number; // brick id
  note: number; // MIDI note held while this brick's state is active
  color: string;
  prompt: string; // a full render recipe (genre, instruments, mood): changes the track's sound
  feel: string; // emotion words only, added to a description of the source: changes its feeling, keeps its sound
  listen: string[]; // emotion-only phrasings the analysis scores music against (averaged)
  original?: boolean; // not an emotion: hitting it brings the track back as it is
  // Made with New emotion: `prompt` and `negative` are the whole texts, as typed, with {track} standing for what the
  // track already is (its sound tags and tempo); `negative` '' pushes away from nothing.
  template?: boolean;
  negative?: string;
}

export interface Palette {
  name: string;
  version: number; // bumped when the listening texts change: analyses made before are stale
  layout?: 'pairs' | 'listed'; // breakout row: each brick beside its opposite (default), or in the listed order
  bricks: PaletteBrick[];
}

export const PALETTES = palettes as Record<string, Palette>;

export const palette = (name: string): Palette => PALETTES[name] ?? PALETTES.emotions;

export const brickById = (p: Palette, id: number | undefined) => p.bricks.find((b) => b.id === id);

// The palette a game plays: its own bricks, then any made on this computer (New emotion), at the end of the row. One
// made here that the palette has since taken in (the same id or name) is the palette's.
export const paletteOf = (p: { palette: string; extra?: PaletteBrick[] }): Palette => {
  const base = palette(p.palette);
  const extra = (p.extra ?? []).filter((x) => !base.bricks.some((b) => b.id === x.id || b.label === x.label));
  return extra.length ? { ...base, bricks: [...base.bricks, ...extra] } : base; // a paired row puts each alone at the end
};
