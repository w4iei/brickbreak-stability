import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStates } from './states.ts';

test('a hit turns its state on and the previous one off at the same moment; re-hits and clear', () => {
  const log: string[] = [];
  const s = createStates({ on: (id, at) => log.push(`on ${id} @${at}`), off: (id, at) => log.push(`off ${id} @${at}`) });
  assert.equal(s.hit(7, 100, 0.6), true);
  assert.equal(s.hit(7, 200, 1), false); // the second hit on the active brick (its break) keeps it on
  assert.equal(s.hit(1, 300, 0.6), true);
  s.clear(400);
  s.clear(500); // nothing on: no-op
  assert.equal(s.active, undefined);
  assert.deepEqual(log, ['on 7 @100', 'off 7 @300', 'on 1 @300', 'off 1 @400']);
});

test('within the hold after a change, hits change nothing; after it they do', () => {
  const log: string[] = [];
  const s = createStates({ on: (id, at) => log.push(`on ${id} @${at}`), off: (id, at) => log.push(`off ${id} @${at}`) }, () => 1000);
  s.hit(7, 0, 1);
  assert.equal(s.hit(1, 999, 1), false); // too soon: 7 stays on
  assert.equal(s.hit(1, 1000, 1), true);
  assert.equal(s.hit(9, 1500, 1), false); // the hold counts from the latest change
  assert.deepEqual(log, ['on 7 @0', 'off 7 @1000', 'on 1 @1000']);
});

test('a state set directly ignores the hold, and later hits hold from it', () => {
  const log: string[] = [];
  const s = createStates({ on: (id, at) => log.push(`on ${id} @${at}`), off: (id, at) => log.push(`off ${id} @${at}`) }, () => 1000);
  s.hit(7, 0, 1);
  s.set(1, 10);
  s.set(1, 20); // already on: nothing
  assert.equal(s.hit(9, 500, 1), false);
  assert.deepEqual(log, ['on 7 @0', 'off 7 @10', 'on 1 @10']);
});
