// A MIDI note: a brick's state while it is on (duration Infinity = held until released).
export interface NoteEvent {
  channel: number;
  note: number;
  velocity: number;
  duration: number; // ms
  time: number; // epoch ms
}

// Web MIDI (and, later, serial to a microcontroller) behind one interface.
export interface OutputSink {
  send(note: NoteEvent, localMs: number): void; // localMs: this thread's performance.now() base; duration Infinity = hold
  release(channel: number, note: number, localMs: number): void; // ends a held note
  panic(): void;
}
