import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { paletteOf, type PaletteBrick } from '../../palette.ts';
import type { BeatClock, Forecast, RawEvent, SceneFactory } from './scene.ts';
import { halfWidth, LOST_Y, MARGIN } from './field.ts';
import { boxToi } from './toi.ts';

// Breakout in the xy plane (Rapier 3D locked to 2D). The whole palette is one row of permanent bricks
// across the top, each beside its opposite; a brick is a palette entry with an id and a label, a hit is the event
// (type 'brick', bodyId = brick id), and the main thread turns hits into held states. The row spans the field, so every
// climb ends in exactly one brick, picked by where the paddle sends the ball. The ball keeps a constant speed; where
// it meets the paddle sets its angle.
//
// Hits ahead are forecast on a fork of the world (takeSnapshot / restoreSnapshot) so their audio can be rendered before
// the ball gets there. Until the ball is back at the paddle the future is fixed: those hits are certain. After that it
// depends on where the paddle meets the ball, so the fork branches: autoplay has already chosen (one branch), a player
// hasn't (three branches sharing the weight).
//
// Jelly bricks (params.jelly = 'beat' | 'bar'): a brick holds the ball where it touched and lets go on the music's next
// beat or bar line (BeatClock, from the worker), throwing it back out at a fraction of its speed, which ramps up to
// normal. The hit event is the release, so states and their MIDI notes change on the beat. Forks hold the same way.
// Physics keeps a held ball at the contact point; it is drawn sinking into the jelly and springing back out (sunk).

const WALL = 0.5;
const DEPTH = 0.2; // z half-extent; the ball never leaves z = 0
const BALL_R = 0.1;
const PADDLE_Y = 0.5;
const PADDLE_HH = 0.08;
const PADDLE_SPEED = 12; // m/s, by keys and autoplay
const DRAG_SPEED = 60; // m/s, after a finger: it stays under it
const CATCH_Y = PADDLE_Y + PADDLE_HH + BALL_R; // ball centre when it meets the paddle
const REST_Y = CATCH_Y + 0.02; // resting on the paddle, just clear of contact
const MAX_ANGLE = Math.PI / 3; // off the vertical, at the paddle's edge
const MIN_VY = 0.25; // × speed, so the ball never skims sideways for long
const SERVE_SPREAD = 0.8; // rad
const AIM_SPREAD = 0.7; // autoplay catches between ±0.7 of the paddle half-width
const AUTO_SERVE = 0.6; // s on the paddle before autoplay serves
const BRICK_GAP = 0.08; // narrower than the ball, which can't slip between bricks
const BRICK_H = 1.6;
const PREDICTION = 0.002; // Rapier reports contacts this close ahead (its 2 cm default is ~20 ms early at 1 m/s); hits are timed by boxToi
const MAX_EARLY = 0.05; // s
const FORECAST_DT = 0.004;
const FORECAST_SEC = 6; // per segment
const BRANCHES = [-0.6, 0, 0.6]; // paddle offsets tried when a player will decide
const AUTOPLAY_WEIGHT = 0.9; // the autoplayer usually, not always, catches where it aimed
const RELEASE_SPEED = 0.3; // × speed as a jelly brick lets go
const RAMP = 0.35; // s from release back to full speed
const SINK = 0.12; // s a held ball takes to sink into the jelly and settle, and to come back out
const FALLBACK_BEAT = 60 / 140; // s, a grid of our own until the worker hands over the music's

type V3 = { x: number; y: number; z: number };
type Brick = { id: number; x: number; y: number; handle: number };
type Hold = { brick: Brick; at: V3; since: number; vin: { x: number; y: number }; release: number; dir: { x: number; y: number } };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Where a ball at x drifting dx sideways ends up between the side walls, bouncing.
function fold(x: number, halfW: number) {
  const lo = -halfW + BALL_R;
  const w = 2 * (halfW - BALL_R);
  const u = (((x - lo) % (2 * w)) + 2 * w) % (2 * w);
  return lo + (u > w ? 2 * w - u : u);
}

// The palette in row order: each brick, then its opposite, the light one of the pair first.
function rowOrder(bricks: PaletteBrick[]) {
  const out: PaletteBrick[] = [];
  for (const b of bricks) {
    if (out.includes(b)) continue;
    const o = bricks.find((x) => x.id === b.opposite && !out.includes(x));
    out.push(...(!o ? [b] : b.pole === 'light' ? [b, o] : [o, b]));
  }
  return out;
}

export const breakout: SceneFactory = (initial, rng) => {
  let p = initial;
  const pal = paletteOf(initial);
  const PADDLE_HW = initial.paddle; // fixed for the scene's life (a new value rebuilds it)
  const row = pal.layout === 'listed' ? pal.bricks : rowOrder(pal.bricks);
  const halfW = Math.max(halfWidth(row.length), initial.width); // wider when a screen asks for it
  const TOP = initial.top; // the field's height (a tall screen can ask for more); fixed for the scene's life
  const ROW_Y = TOP - 0.25 - BRICK_H / 2; // the row's centre, just under the top wall
  const cell = (2 * halfW) / row.length;
  const half: [number, number] = [(cell - BRICK_GAP) / 2, BRICK_H / 2];
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.integrationParameters.normalizedPredictionDistance = PREDICTION;
  const queue = new RAPIER.EventQueue(true);

  const solid = (desc: RAPIER.ColliderDesc, body?: RAPIER.RigidBody) =>
    world.createCollider(desc.setRestitution(1).setFriction(0), body);
  solid(RAPIER.ColliderDesc.cuboid(WALL, TOP / 2 + WALL, DEPTH).setTranslation(-halfW - WALL, TOP / 2, 0));
  solid(RAPIER.ColliderDesc.cuboid(WALL, TOP / 2 + WALL, DEPTH).setTranslation(halfW + WALL, TOP / 2, 0));
  solid(RAPIER.ColliderDesc.cuboid(halfW + 2 * WALL, WALL, DEPTH).setTranslation(0, TOP + WALL, 0));

  const paddle = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PADDLE_Y, 0));
  const paddleCol = solid(RAPIER.ColliderDesc.cuboid(PADDLE_HW, PADDLE_HH, DEPTH), paddle);
  const ball = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, REST_Y, 0).enabledTranslations(true, true, false).lockRotations().setCcdEnabled(true),
  );
  const ballCol = solid(
    RAPIER.ColliderDesc.ball(BALL_R)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    ball,
  );

  const bricks: Brick[] = row.map((b, i) => {
    const x = -halfW + cell * (i + 0.5);
    return { id: b.id, x, y: ROW_Y, handle: solid(RAPIER.ColliderDesc.cuboid(half[0], half[1], DEPTH).setTranslation(x, ROW_Y, 0)).handle };
  });
  const brickOf = new Map(bricks.map((b) => [b.handle, b])); // collider handle → brick (forks keep the handles)

  let paddleX = 0;
  let dir: -1 | 0 | 1 = 0;
  let target: number | undefined; // x the paddle heads for, at its speed (touch)
  let stuck = true;
  let stuckFor = 0;
  let serveQueued = false;
  let aim = 0; // autoplay: where on the paddle (−1..1) it means to catch the ball next
  let pending: Forecast[] | undefined;
  let held: Hold | undefined; // in a jelly brick, until its release
  let releasedAt = -Infinity; // sim time the last jelly release happened
  let now = 0; // sim time at the end of the last step
  let clock: BeatClock = {
    next: (t, every) => {
      const unit = FALLBACK_BEAT * (every === 'bar' ? 4 : 1);
      return (Math.floor(t / unit + 1e-9) + 1) * unit;
    },
  };
  const jelly = () => (p.jelly === 'beat' || p.jelly === 'bar' ? p.jelly : undefined);
  // Full speed, or on the way back up to it after a jelly release.
  const speedAt = (t: number, since: number) => p.ballSpeed * Math.min(1, RELEASE_SPEED + ((1 - RELEASE_SPEED) * Math.max(0, t - since)) / RAMP);

  const send = (body: RAPIER.RigidBody, angle: number) =>
    body.setLinvel({ x: p.ballSpeed * Math.sin(angle), y: p.ballSpeed * Math.cos(angle), z: 0 }, true);

  // Back to the target speed, and never too flat.
  function regulate(body: RAPIER.RigidBody, s = p.ballSpeed) {
    const v = body.linvel();
    const n = Math.hypot(v.x, v.y) || 1;
    let [x, y] = [(v.x / n) * s, (v.y / n) * s];
    if (Math.abs(y) < MIN_VY * s) {
      y = Math.sign(y || 1) * MIN_VY * s;
      x = Math.sign(x || 1) * Math.sqrt(s * s - y * y);
    }
    body.setLinvel({ x, y, z: 0 }, true);
  }

  function movePaddle(dt: number) {
    let move = dir * PADDLE_SPEED * dt;
    if (p.autoplay) {
      const at = ball.translation();
      const v = ball.linvel();
      // Meet the falling ball so it lands `aim` along the paddle.
      const meet = stuck || v.y >= 0 ? paddleX : fold(at.x + (v.x * (at.y - CATCH_Y)) / -v.y, halfW) - aim * PADDLE_HW;
      move = clamp(meet - paddleX, -PADDLE_SPEED * dt, PADDLE_SPEED * dt);
    } else if (target !== undefined) move = clamp(target - paddleX, -DRAG_SPEED * dt, DRAG_SPEED * dt);
    paddleX = clamp(paddleX + move, -(halfW - PADDLE_HW), halfW - PADDLE_HW);
    paddle.setNextKinematicTranslation({ x: paddleX, y: PADDLE_Y, z: 0 });
  }

  // Where a ball moving at v from `at` leaves a brick: mirrored off the face it came through.
  function bounce(at: V3, v: V3, k: Brick) {
    const side = Math.abs(at.x - k.x) - half[0] > Math.abs(at.y - k.y) - half[1];
    const n = Math.hypot(v.x, v.y) || 1;
    return side ? { x: -v.x / n, y: v.y / n } : { x: v.x / n, y: -v.y / n };
  }

  // Where and when a ball touching brick k (pre-step state s, step from t) is held, and when it is let go.
  function hold(k: Brick, s: { at: V3; v: V3 }, t: number, dt: number, every: 'beat' | 'bar'): Hold {
    const tau = clamp(boxToi(s.at, s.v, k, half, BALL_R) ?? 0, 0, dt);
    return {
      brick: k,
      at: { x: s.at.x + s.v.x * tau, y: s.at.y + s.v.y * tau, z: 0 },
      since: t + tau,
      vin: { x: s.v.x, y: s.v.y },
      release: clock.next(t + tau, every),
      dir: bounce(s.at, s.v, k),
    };
  }

  // Where a held ball is drawn at time t: it arrives at its speed, sinks in and settles, and leaves on the release at
  // the release velocity. Position and velocity stay continuous (cubic Hermite pieces), so even a hold of a frame or
  // two reads as a soft bounce, not a freeze. A short hold is one curve in and out.
  function sunk(h: Hold, t: number) {
    const out = { x: h.dir.x * p.ballSpeed * RELEASE_SPEED, y: h.dir.y * p.ballSpeed * RELEASE_SPEED };
    const T = h.release - h.since;
    const u = clamp(t - h.since, 0, T);
    // From offset a with velocity va to offset b with velocity vb over `len` seconds, at s in 0..1.
    const curve = (s: number, len: number, a: number, va: number, b: number, vb: number) =>
      (2 * s ** 3 - 3 * s ** 2 + 1) * a + (s ** 3 - 2 * s ** 2 + s) * len * va + (3 * s ** 2 - 2 * s ** 3) * b + (s ** 3 - s ** 2) * len * vb;
    const off = (k: 'x' | 'y') => {
      const deep = (h.vin[k] * SINK) / 2; // where it settles: stopping evenly from its speed over SINK
      if (T <= 2 * SINK) return curve(u / T, T, 0, h.vin[k], 0, out[k]);
      if (u < SINK) return curve(u / SINK, SINK, 0, h.vin[k], deep, 0);
      if (u < T - SINK) return deep;
      return curve((u - T + SINK) / SINK, SINK, deep, 0, 0, out[k]);
    };
    return { x: h.at.x + off('x'), y: h.at.y + off('y') };
  }

  const throwOut = (body: RAPIER.RigidBody, h: Hold) =>
    body.setLinvel({ x: h.dir.x * p.ballSpeed * RELEASE_SPEED, y: h.dir.y * p.ballSpeed * RELEASE_SPEED, z: 0 }, true);

  // Fly a fork (from absolute sim time t; hits timed from `from`) until the ball is back down at the paddle line,
  // collecting brick hits. Returns when it got there.
  function fly(w: RAPIER.World, q: RAPIER.EventQueue, t: number, from: number, since: number, weight: number, out: Forecast[]) {
    const b = w.getRigidBody(ball.handle);
    const limit = t + FORECAST_SEC;
    const every = jelly();
    w.timestep = FORECAST_DT;
    for (; t < limit; t += FORECAST_DT) {
      if (b.linvel().y < 0 && b.translation().y <= CATCH_Y) return { at: t, since };
      const s = { at: b.translation(), v: b.linvel() };
      w.step(q);
      let h: Hold | undefined;
      q.drainCollisionEvents((h1, h2, started) => {
        const k = brickOf.get(h1 === ballCol.handle ? h2 : h1);
        if (!started || !k || h) return;
        if (every) h = hold(k, s, t, FORECAST_DT, every);
        else out.push({ bodyId: k.id, inSec: t + FORECAST_DT - from, weight });
      });
      if (h) {
        // Nothing else moves in a fork, so skip straight to the release.
        out.push({ bodyId: h.brick.id, inSec: h.release - from, weight });
        b.setTranslation(h.at, true);
        throwOut(b, h);
        since = h.release;
        t = h.release - FORECAST_DT;
      }
      regulate(b, speedAt(t + FORECAST_DT, since));
    }
    return undefined;
  }

  function forecast(from: number): Forecast[] {
    const out: Forecast[] = [];
    const q = new RAPIER.EventQueue(true);
    const fork = RAPIER.World.restoreSnapshot(world.takeSnapshot());
    fork.integrationParameters.normalizedPredictionDistance = PREDICTION;
    fork.removeRigidBody(fork.getRigidBody(paddle.handle)); // the ball won't meet it before the paddle line
    const back = fly(fork, q, from, from, releasedAt, 1, out);
    if (back !== undefined) {
      const atPaddle = fork.takeSnapshot();
      const offsets = p.autoplay ? [aim] : BRANCHES;
      for (const o of offsets) {
        const branch = RAPIER.World.restoreSnapshot(atPaddle);
        branch.integrationParameters.normalizedPredictionDistance = PREDICTION;
        send(branch.getRigidBody(ball.handle), o * MAX_ANGLE);
        fly(branch, q, back.at, from, -Infinity, p.autoplay ? AUTOPLAY_WEIGHT : 1 / offsets.length, out);
        branch.free();
      }
    }
    fork.free();
    q.free();
    return out;
  }

  return {
    step(t, dt) {
      now = t + dt;
      world.timestep = dt;
      movePaddle(dt);
      let served = false;
      if (stuck) {
        ball.setTranslation({ x: paddleX, y: REST_Y, z: 0 }, true);
        ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
        stuckFor += dt;
        if (serveQueued || (p.autoplay && stuckFor >= AUTO_SERVE)) {
          stuck = false;
          served = true;
          send(ball, (rng() - 0.5) * SERVE_SPREAD);
          aim = (rng() * 2 - 1) * AIM_SPREAD;
        }
      }
      serveQueued = false;
      const events: RawEvent[] = [];
      const hit = (b: Brick, at: number) => events.push({ type: 'brick', bodyId: b.id, simTime: at, force: 1, position: [b.x, b.y, 0] });
      if (held) {
        ball.setTranslation(held.at, true);
        ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
        if (t + dt >= held.release) {
          hit(held.brick, held.release); // the hit is the release: on the beat
          throwOut(ball, held);
          releasedAt = held.release;
          held = undefined;
        }
      }
      const s: { at: V3; v: V3 } = { at: ball.translation(), v: ball.linvel() };
      world.step(queue);

      let bounced = false;
      queue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;
        const other = h1 === ballCol.handle ? h2 : h1;
        if (other === paddleCol.handle) {
          if (stuck || s.v.y >= 0) return; // only a falling ball is caught
          send(ball, clamp((ball.translation().x - paddleX) / PADDLE_HW, -1, 1) * MAX_ANGLE);
          aim = (rng() * 2 - 1) * AIM_SPREAD;
          bounced = true;
          return;
        }
        const b = brickOf.get(other);
        if (!b || held) return;
        const every = jelly();
        if (every) {
          held = hold(b, s, t, dt, every);
          ball.setTranslation(held.at, true);
          ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
        } else hit(b, t + clamp(boxToi(s.at, s.v, b, half, BALL_R) ?? 0, -dt, MAX_EARLY));
      });
      if (!stuck && !bounced && !held) regulate(ball, speedAt(t + dt, releasedAt));

      if (!stuck && ball.translation().y < LOST_Y) {
        stuck = true;
        stuckFor = 0;
        pending = []; // the old forecast's future won't happen
      } else if (served || bounced) {
        pending = forecast(t + dt);
      }
      return events;
    },
    positions() {
      const { x, y } = held ? sunk(held, now) : ball.translation();
      return new Float32Array([x, y, 0]);
    },
    decor: () => new Float32Array([paddleX, ...bricks.map((b) => (held?.brick === b ? 1 : 0))]),
    energy: () => 0.5 * p.ballSpeed ** 2,
    info: () => ({
      radii: [BALL_R],
      flat: { center: [0, (TOP + LOST_Y) / 2], size: [2 * halfW + 2 * MARGIN, TOP - LOST_Y + 2 * MARGIN] },
      walls: [-halfW, 0, -halfW, TOP, -halfW, TOP, halfW, TOP, halfW, TOP, halfW, 0],
      bricks: {
        at: bricks.flatMap((b) => [b.x, b.y]),
        half,
        id: row.map((b) => b.id),
        label: row.map((b) => b.label),
        color: row.map((b) => b.color),
      },
      paddle: { y: PADDLE_Y, half: [PADDLE_HW, PADDLE_HH] },
    }),
    setClock(c) {
      clock = c;
    },
    input(i) {
      dir = i.dir;
      if (i.target !== undefined) target = i.target;
      else if (i.dir) target = undefined;
      if (i.launch && stuck) serveQueued = true;
    },
    forecast() {
      const f = pending;
      pending = undefined;
      return f;
    },
    setParams(next) {
      p = next;
    },
    dispose() {
      queue.free();
      world.free();
    },
  };
};
