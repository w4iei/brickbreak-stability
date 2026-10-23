import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createWebMidiSink } from './webmidi.ts';

test('a retrigger ends the old note at the new note-on, so the old note-off never cuts the new note short', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  mock.method(performance, 'now', () => now);
  const sent: [number[], number | undefined][] = [];
  const port = { id: 'p', name: 'fake', send: (data: number[], at?: number) => sent.push([data, at]) };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => ({ outputs: new Map([['p', port]]) }) });

  const sink = await createWebMidiSink();
  const c = { channel: 0, note: 60, velocity: 100, duration: 5000, time: 0 };
  sink.send(c, 100);
  sink.send(c, 2100); // C again while the first is still ringing
  now = 7000;
  mock.timers.tick(10);
  assert.equal(sent.length, 3, 'note-off sent before it was close to due');
  now = 7090;
  mock.timers.tick(10);
  assert.deepEqual(sent, [
    [[0x90, 60, 100], 100],
    [[0x80, 60, 0], 2100], // old note ends at the retrigger
    [[0x90, 60, 100], 2100],
    [[0x80, 60, 0], 7100], // the new note gets its full length
  ]);
  mock.timers.reset();
});

test('a held note (duration Infinity) sounds until released, and a port switch ends it now', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  mock.method(performance, 'now', () => now);
  const sent: [number[], number | undefined][] = [];
  const port = { id: 'p', name: 'fake', send: (data: number[], at?: number) => sent.push([data, at]) };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => ({ outputs: new Map([['p', port]]) }) });

  const sink = await createWebMidiSink();
  sink.send({ channel: 0, note: 48, velocity: 100, duration: Infinity, time: 0 }, 100);
  now = 60_000;
  mock.timers.tick(10);
  assert.equal(sent.length, 1, 'held note ended on its own');
  sink.release(0, 48, 60_100);
  sink.release(0, 48, 60_200); // already off: nothing
  sink.send({ channel: 0, note: 60, velocity: 90, duration: Infinity, time: 0 }, 60_100);
  sink.select('p');
  assert.deepEqual(sent, [
    [[0x90, 48, 100], 100],
    [[0x80, 48, 0], 60_100],
    [[0x90, 60, 90], 60_100],
    [[0x80, 60, 0], 60_000], // flushed at the switch, timestamped now rather than Infinity
  ]);
  mock.timers.reset();
});
