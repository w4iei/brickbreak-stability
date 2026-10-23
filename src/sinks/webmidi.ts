import type { OutputSink } from './sink.ts';

export interface WebMidiSink extends OutputSink {
  outputs(): { id: string; name: string }[];
  select(id: string): void;
  onChange(cb: () => void): void;
}

const OFF_LEAD_MS = 25; // note-offs are sent this close to due, so a retrigger can still replace them
const OFF_TICK_MS = 10;

export async function createWebMidiSink(): Promise<WebMidiSink> {
  if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not supported in this browser');
  const access = await navigator.requestMIDIAccess();
  const list = () => [...access.outputs.values()];
  let port: MIDIOutput | undefined = list()[0];
  // Pending note-offs, (channel << 7 | note) → local ms. Long notes retrigger before they end; scheduling the old
  // note-off up front would then cut the new note short, so the retrigger ends the old note itself and takes over.
  let offs = new Map<number, number>();

  // Send the note-offs due by `until`. Held notes (due at Infinity) only go when everything is flushed, and then now.
  function flush(until: number) {
    for (const [key, at] of offs)
      if (at <= until) port?.send([0x80 | (key >> 7), key & 0x7f, 0], Number.isFinite(at) ? at : performance.now());
    offs = new Map([...offs].filter(([, at]) => at > until));
  }
  setInterval(() => flush(performance.now() + OFF_LEAD_MS), OFF_TICK_MS);

  return {
    outputs: () => list().map((o) => ({ id: o.id, name: o.name ?? o.id })),
    select(id) {
      flush(Infinity); // to the old port, so nothing hangs there
      port = access.outputs.get(id);
    },
    onChange(cb) {
      access.onstatechange = cb;
    },
    send(n, at) {
      if (!port) return;
      const ch = n.channel & 0x0f;
      const key = (ch << 7) | n.note;
      const pending = offs.get(key);
      if (pending !== undefined) port.send([0x80 | ch, n.note, 0], Math.min(pending, at)); // end the old note first
      port.send([0x90 | ch, n.note, n.velocity], at);
      offs = new Map(offs).set(key, at + n.duration);
    },
    release(channel, note, at) {
      const key = ((channel & 0x0f) << 7) | note;
      if (!offs.has(key)) return;
      port?.send([0x80 | (channel & 0x0f), note, 0], at);
      offs = new Map([...offs].filter(([k]) => k !== key));
    },
    panic() {
      offs = new Map();
      for (let ch = 0; ch < 16; ch++) port?.send([0xb0 | ch, 123, 0]);
    },
  };
}
