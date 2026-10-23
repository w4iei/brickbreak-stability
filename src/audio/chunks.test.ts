import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkAt, chunkStart, holdFilter, plan, quantise } from './chunks.ts';

const g = { length: 6, hop: 5 };

test('a hit maps to the chunk it lands in; chunks overlap by length − hop', () => {
  assert.equal(chunkAt(g, 0), 0);
  assert.equal(chunkAt(g, 4.99), 0);
  assert.equal(chunkAt(g, 5), 1); // 5..6 is covered by chunks 0 and 1; the newer one takes over
  assert.equal(chunkAt(g, -1), 0);
});

test('plan: each state gets only the chunks it will play before the next sure hit; maybes last', () => {
  const needs = plan(g, 12, 7, [
    { brick: 3, pos: 13, weight: 1 }, // takes over from 7 before 7's next chunk (15) is needed
    { brick: 8, pos: 14, weight: 1 / 3 },
    { brick: 3, pos: 13.5, weight: 1 }, // hits the brick that is already on: 3 carries on, into chunk 3
    { brick: 9, pos: 11, weight: 1 }, // already past
    { brick: 4, pos: 16, weight: 0.9 }, // the last sure state: its chunk and one more
  ]);
  assert.deepEqual(
    needs.map((n) => `${n.brick}:${n.k}@${n.due}`),
    ['7:2@12', '3:2@13', '3:3@15', '4:3@16', '4:4@20', '8:2@14'],
  );
});

test('plan: a state that would play a new chunk only briefly before the next hit skips it', () => {
  // 5 is on from 4 to 10.2: chunk 2 starts at 10, only 0.2 s before 6 takes over.
  const needs = plan(g, 4, 5, [{ brick: 6, pos: 10.2, weight: 1 }]);
  assert.deepEqual(needs.map((n) => `${n.brick}:${n.k}`), ['5:0', '5:1', '6:2', '6:3']);
});

test('plan skips chunks that start after the track ends', () => {
  assert.deepEqual(plan(g, 9, 1, [], 1, 10).map((n) => n.k), [1]);
});

test('a bar-aligned grid starts every chunk on a downbeat', () => {
  const bars = { length: 7.36, hop: 4 * (60 / 140) * 4, origin: 0.006 };
  assert.equal(chunkAt(bars, 0), 0);
  assert.ok(Math.abs(chunkStart(bars, 3) - (0.006 + 3 * 6.857142857)) < 1e-6);
  assert.equal(chunkAt(bars, chunkStart(bars, 2) + 0.001), 2);
});

test('holdFilter keeps only the hits that will change the state', () => {
  const kept = holdFilter(
    [
      { brick: 3, pos: 10.5, weight: 1 }, // within the hold of the last change (at 10)
      { brick: 7, pos: 12.2, weight: 1 }, // the brick that is already on
      { brick: 4, pos: 13, weight: 1 }, // changes: 7 → 4
      { brick: 5, pos: 14, weight: 1 }, // within the hold of 4
      { brick: 6, pos: 16.5, weight: 1 / 3 },
    ],
    7,
    10,
    3,
  );
  assert.deepEqual(kept.map((h) => h.brick), [4, 6]);
});

test('quantise moves a switch to the next beat', () => {
  assert.equal(quantise(1.1, [0, 0.5, 1, 1.5]), 1.5);
  assert.equal(quantise(1, [0, 0.5, 1, 1.5]), 1);
  assert.equal(quantise(2, [0, 0.5]), 2);
});
