// Breakout states: one brick's state is on at a time. A hit turns its brick's state on and the previous one off, at the
// hit's moment; hitting the brick that is already on changes nothing, and so does any hit within `holdMs` of the last
// change (a state stays on long enough to be heard). set() is a state picked directly (the site's Listen tab): no hold.
export interface StateOut {
  on(id: number, epoch: number, force: number): void;
  off(id: number, epoch: number): void;
}

export function createStates(out: StateOut, holdMs: () => number = () => 0) {
  let active: number | undefined;
  let since = -Infinity; // epoch of the last change

  function set(id: number, epoch: number, force = 1) {
    if (id === active) return;
    if (active !== undefined) out.off(active, epoch);
    active = id;
    since = epoch;
    out.on(id, epoch, force);
  }

  return {
    get active() {
      return active;
    },
    hit(id: number, epoch: number, force: number): boolean {
      if (id === active || epoch - since < holdMs()) return false;
      set(id, epoch, force);
      return true;
    },
    set,
    clear(epoch: number) {
      if (active !== undefined) out.off(active, epoch);
      active = undefined;
      since = -Infinity;
    },
  };
}
