import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEmotion } from './emotions.ts';
import { palette, paletteOf } from './palette.ts';
import { renderPrompts } from './prompts.ts';

test('a new emotion gets a fresh id and a colour not on the board, and joins the end of the row', () => {
  const site = palette('site').bricks;
  const a = makeEmotion(' nostalgia ', 'nostalgic, wistful, warm, hazy', 9, site);
  assert.equal(a.label, 'NOSTALGIA');
  assert.ok(a.id >= 100 && !site.some((b) => b.id === a.id));
  assert.ok(!site.some((b) => b.color === a.color));
  const b = makeEmotion('swagger', 'confident, strutting', undefined, [...site, a]);
  assert.equal(b.id, a.id + 1);
  assert.notEqual(b.color, a.color);
  const row = paletteOf({ palette: 'site', extra: [a, b] }).bricks;
  assert.deepEqual(row.slice(-2), [a, b]);
  assert.equal(paletteOf({ palette: 'site', extra: [] }), palette('site')); // nothing made: the palette as it is
});

test("a new emotion's renders keep the track's sound and push away from its opposite, or from nothing", () => {
  const site = palette('site').bricks;
  const rage = site.find((x) => x.label === 'RAGE')!;
  const a = makeEmotion('nostalgia', 'nostalgic, wistful', rage.id, site);
  const pushed = renderPrompts(a, rage, 'source', 'techno, 140 BPM');
  assert.equal(pushed.prompt, 'techno, 140 BPM, nostalgic, wistful');
  assert.equal(pushed.negative, `techno, 140 BPM, ${rage.feel}`);
  const free = makeEmotion('calm', 'calm', undefined, site);
  assert.equal(free.opposite, free.id);
  assert.equal(renderPrompts(free, site.find((x) => x.id === free.opposite), 'source', 'techno').negative, '');
});
