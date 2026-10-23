// Worker and main thread have different performance.timeOrigin, so cross-thread times are epoch ms.
export const epochNow = (): number => performance.timeOrigin + performance.now();

// Epoch ms → this thread's performance.now() base (what MIDIOutput.send expects).
export const toLocal = (epochMs: number): number => epochMs - performance.timeOrigin;
