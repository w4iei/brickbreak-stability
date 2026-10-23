import * as THREE from 'three';
import type { SceneInfo } from './worker/scenes/scene.ts';

const FLASH_DECAY = 0.88; // per frame
const PULSE_ATTACK = 0.35; // per frame, a brick's pulse easing up to its hit (no one-frame jump)
const MAX_PIXELS = 2.5e6; // drawing-buffer budget: full-screen Retina at 2× is ~8 M, and the GPU is shared with the
// audio renders; a flat board looks the same at a lower ratio (antialiasing smooths the edges)
const WALL_COLOUR = 0x3d5a73;
const PADDLE_COLOUR = 0xf0f4f8;
const PADDLE_GLOW = 0.18; // m, the paddle's halo
const BRICK_PULSE = 0.12; // brick grows by this on a hit, then settles
const BRICK_TEX_W = 512; // px
const BOARD_BG = '#0b0d10';
const NEON_TILE = 0.16; // an unlit brick's fill: its colour this far over the board
const NEON_GLOW = 0.32; // m, how far the lit brick's glow reaches
const BALL_HALO = 5.2; // × the ball's radius, the halo's width
const TRAIL = 12; // dots behind the ball
const TRAIL_DT = 24; // ms between them (by time, so as long at 120 Hz as at 60)
const WOBBLE = 0.08; // a jelly brick holding the ball squashes and wobbles by this much

// sRGB hex mix, a → b by t.
function mixHex(a: string, b: string, t: number) {
  const [pa, pb] = [parseInt(a.slice(1), 16), parseInt(b.slice(1), 16)];
  const ch = (s: number) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}
// A colour bright enough to glow on the dark board: the dark ones (GRIEF, DREAD) lifted towards white.
export function neon(hex: string) {
  const c = new THREE.Color(hex); // linear
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return mixHex(hex, '#ffffff', (Math.max(0, 0.2 - lum) / 0.2) * 0.5);
}
// A rounded rectangle, centred.
function roundRect(hx: number, hy: number, r: number) {
  const s = new THREE.Shape();
  s.moveTo(-hx + r, -hy);
  s.lineTo(hx - r, -hy);
  s.absarc(hx - r, -hy + r, r, -Math.PI / 2, 0);
  s.lineTo(hx, hy - r);
  s.absarc(hx - r, hy - r, r, 0, Math.PI / 2);
  s.lineTo(-hx + r, hy);
  s.absarc(-hx + r, hy - r, r, Math.PI / 2, Math.PI);
  s.lineTo(-hx, -hy + r);
  s.absarc(-hx + r, -hy + r, r, Math.PI, 1.5 * Math.PI);
  return s;
}
// A soft white glow round a w × h (m) rounded rectangle, reaching `reach` m beyond it; its material tints it.
function glowTexture(w: number, h: number, reach: number, round: number) {
  const ppm = 96; // px per m
  const c = document.createElement('canvas');
  c.width = Math.round((w + 2 * reach) * ppm);
  c.height = Math.round((h + 2 * reach) * ppm);
  const g = c.getContext('2d')!;
  const off = c.width + 100; // the shape itself is drawn off the canvas: only its blurred shadow lands on it
  g.shadowColor = '#fff';
  g.shadowBlur = reach * ppm * 0.8;
  g.shadowOffsetX = off;
  g.beginPath();
  g.roundRect(reach * ppm - off, reach * ppm, w * ppm, h * ppm, round * ppm);
  g.fill();
  return new THREE.CanvasTexture(c);
}
// A round soft dot: the ball's halo and its trail.
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// The breakout board, face-on (orthographic, the xy plane), its foot at the bottom of the canvas (spare height above).
export function createRenderer(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d10);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.5));

  const flatCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  flatCamera.position.set(0, 0, 10);
  let flat: SceneInfo['flat'];
  let board = new THREE.Group();
  scene.add(board);
  let boardKey = '';
  let sides: THREE.LineSegments | undefined; // the board's upright walls
  let sideWalls = true;
  // Bricks in decor order.
  let bricks: SceneInfo['bricks'];
  let brickMeshes: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  let brickTex: THREE.Texture[] = []; // unlit faces
  let brickLit: THREE.Texture[] = []; // lit faces (the brick's state on)
  let brickFlash: number[] = []; // each brick's pulse, easing towards its kick
  let brickKick: number[] = []; // each brick's hit, decaying
  let paddle: THREE.Mesh | undefined;
  let brickGlow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | undefined; // behind the lit brick
  let active: number | undefined; // brick id whose state is on

  // The ball: a halo and a trail in the colour of the state that is on.
  const dot = dotTexture();
  const additive = (opacity: number) =>
    new THREE.SpriteMaterial({ map: dot, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Sprite(additive(0.9));
  const trailDots = Array.from({ length: TRAIL }, () => new THREE.Sprite(additive(0)));
  [halo, ...trailDots].forEach((s) => {
    s.visible = false;
    s.position.z = -0.05; // behind the ball
    scene.add(s);
  });
  let trail: { t: number; x: number; y: number }[] = [];
  const tint = () => {
    const i = bricks?.id.indexOf(active ?? -1) ?? -1;
    return neon(i >= 0 ? bricks!.color[i] : '#c9d4df');
  };

  function dispose(group: THREE.Object3D) {
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh || o instanceof THREE.Line)) return;
      o.geometry.dispose();
      const m = o.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    });
  }

  // Brick labels: one size for all, the largest at which the longest fits, running up the brick when it is much
  // taller than wide.
  function labelFit(labels: string[], aspect: number) {
    const g = document.createElement('canvas').getContext('2d')!;
    const [w, h] = [BRICK_TEX_W, Math.round(BRICK_TEX_W / aspect)];
    const up = h > 1.5 * w;
    const [along, across] = up ? [h, w] : [w, h];
    g.letterSpacing = `${Math.round(0.012 * Math.max(w, h))}px`;
    let size = across * 0.42;
    const fits = () => {
      g.font = `700 ${size}px system-ui, sans-serif`;
      return labels.every((l) => g.measureText(l).width <= along * 0.82);
    };
    while (!fits() && size > 12) size -= 2;
    return { size, up };
  }

  // A brick face, neon: unlit, a dark tile with its outline and label in its colour; lit, filled with the colour.
  function brickTexture(label: string, colour: string, aspect: number, lit: boolean, { size, up }: ReturnType<typeof labelFit>) {
    const c = document.createElement('canvas');
    c.width = BRICK_TEX_W;
    c.height = Math.round(BRICK_TEX_W / aspect);
    const g = c.getContext('2d')!;
    const [w, h] = [c.width, c.height];
    const line = 0.05 * Math.min(w, h);
    const vivid = neon(colour);
    g.beginPath();
    g.roundRect(line / 2, line / 2, w - line, h - line, 0.18 * Math.min(w, h));
    g.fillStyle = lit ? colour : mixHex(BOARD_BG, colour, NEON_TILE);
    g.fill();
    g.lineWidth = line;
    g.strokeStyle = vivid; // lit, the same as the fill, except on a dark brick, which keeps its bright edge
    g.stroke();
    const rgb = new THREE.Color(colour);
    const light = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b > 0.45; // linear luminance
    g.fillStyle = lit ? (light ? '#121417' : '#ffffff') : vivid;
    g.letterSpacing = `${Math.round(0.012 * Math.max(w, h))}px`;
    g.font = `700 ${size}px system-ui, sans-serif`;
    g.translate(w / 2, h / 2);
    if (up) g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 0, size * 0.05);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // Rebuilt only when the geometry changes, not on every live param edit.
  function setBoard(info: SceneInfo) {
    const key = JSON.stringify([info.walls, info.bricks?.label, info.bricks?.color]);
    if (key === boardKey) return;
    boardKey = key;
    brickGlow?.removeFromParent();
    if (brickGlow) dispose(brickGlow);
    dispose(board);
    [...brickTex, ...brickLit].forEach((t) => t.dispose());
    scene.remove(board);
    board = new THREE.Group();
    scene.add(board);
    sides = undefined;
    if (info.walls) {
      const w = info.walls;
      const pts = Array.from({ length: w.length / 2 }, (_, k) => new THREE.Vector3(w[k * 2], w[k * 2 + 1], 0));
      const segs = Array.from({ length: pts.length / 2 }, (_, k) => [pts[k * 2], pts[k * 2 + 1]]);
      const material = new THREE.LineBasicMaterial({ color: WALL_COLOUR });
      const lines = (s: THREE.Vector3[][]) => {
        const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(s.flat()), material);
        l.position.z = 0.2; // in front of the ball
        board.add(l);
        return l;
      };
      lines(segs.filter(([a, b]) => a.x !== b.x));
      sides = lines(segs.filter(([a, b]) => a.x === b.x)); // the upright ones, which an upright phone hides
      sides.visible = sideWalls;
    }
    bricks = info.bricks;
    const k = info.bricks;
    const [hx, hy] = k?.half ?? [0, 0];
    const fit = labelFit(k?.label ?? [], hx / hy);
    brickTex = (k?.label ?? []).map((l, i) => brickTexture(l, k!.color[i], hx / hy, false, fit));
    brickLit = (k?.label ?? []).map((l, i) => brickTexture(l, k!.color[i], hx / hy, true, fit));
    brickFlash = brickTex.map(() => 0);
    brickKick = brickTex.map(() => 0);
    brickMeshes = brickTex.map((face, i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * hx, 2 * hy), new THREE.MeshBasicMaterial({ map: face, transparent: true }));
      m.position.set(k!.at[i * 2], k!.at[i * 2 + 1], 0);
      board.add(m);
      return m;
    });
    // The lit brick's glow: a child of the brick, so it pulses and wobbles with it.
    brickGlow = k
      ? new THREE.Mesh(
          new THREE.PlaneGeometry(2 * (hx + NEON_GLOW), 2 * (hy + NEON_GLOW)),
          new THREE.MeshBasicMaterial({
            map: glowTexture(2 * hx, 2 * hy, NEON_GLOW, 0.18 * 2 * Math.min(hx, hy)),
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        )
      : undefined;
    // The paddle: a rounded bar with a faint halo.
    paddle = undefined;
    if (info.paddle) {
      const [px, py] = info.paddle.half;
      paddle = new THREE.Mesh(new THREE.ShapeGeometry(roundRect(px, py, py), 8), new THREE.MeshBasicMaterial({ color: PADDLE_COLOUR }));
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(2 * (px + PADDLE_GLOW), 2 * (py + PADDLE_GLOW)),
        new THREE.MeshBasicMaterial({
          map: glowTexture(2 * px, 2 * py, PADDLE_GLOW, py),
          color: 0xdce8f5,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      glow.position.z = -0.01;
      paddle.add(glow);
      paddle.position.y = info.paddle.y;
      board.add(paddle);
    }
    trail = [];
    showActive();
  }

  function showActive() {
    const i = bricks?.id.indexOf(active ?? -1) ?? -1;
    brickMeshes.forEach((m, j) => (m.material.map = (j === i ? brickLit : brickTex)[j]));
    if (!brickGlow) return;
    brickGlow.removeFromParent();
    if (i < 0) return;
    brickGlow.material.color.set(neon(bricks!.color[i]));
    brickMeshes[i].add(brickGlow);
    brickGlow.position.set(0, 0, -0.01);
  }

  // Fit the board's rectangle in view, centred across and standing on the canvas's foot.
  function fitFlat(w: number, h: number) {
    if (!flat) return;
    const scale = Math.min(w / flat.size[0], h / flat.size[1]); // px per m
    const left = flat.center[0] - w / 2 / scale;
    const bottom = flat.center[1] - flat.size[1] / 2;
    Object.assign(flatCamera, { left, right: left + w / scale, top: bottom + h / scale, bottom });
    flatCamera.updateProjectionMatrix();
  }

  const geometry = new THREE.SphereGeometry(1, 24, 16); // scaled per body
  let meshes: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>[] = [];
  let radii: number[] = [];

  function ensure(n: number) {
    while (meshes.length < n) {
      const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff }));
      scene.add(m);
      meshes = [...meshes, m];
    }
    while (meshes.length > n) {
      const m = meshes[meshes.length - 1];
      scene.remove(m);
      m.material.dispose();
      meshes = meshes.slice(0, -1);
    }
  }

  // The ball's halo and trail: where the ball was TRAIL_DT, 2·TRAIL_DT, … ms ago, from the positions it was drawn
  // at (a jump, the ball served again, starts the trail afresh).
  function drawTrail(ball: [number, number] | undefined, now: number) {
    [halo, ...trailDots].forEach((s) => (s.visible = !!ball));
    if (!ball) return;
    const [x, y] = ball;
    const last = trail.at(-1);
    if (last && (now < last.t || Math.hypot(x - last.x, y - last.y) > 1)) trail = [];
    trail.push({ t: now, x, y });
    trail = trail.filter((p) => p.t >= now - (TRAIL + 1) * TRAIL_DT);
    const colour = tint();
    const r = radii[0] ?? 0.15;
    halo.position.set(x, y, -0.05);
    halo.scale.setScalar(r * BALL_HALO);
    halo.material.color.set(colour);
    trailDots.forEach((s, k) => {
      const at = now - (k + 1) * TRAIL_DT;
      const j = trail.findIndex((p) => p.t >= at);
      if (j <= 0) return void (s.visible = false); // older than the trail
      const [a, b] = [trail[j - 1], trail[j]];
      const f = (at - a.t) / (b.t - a.t || 1);
      const fade = 1 - (k + 1) / (TRAIL + 1);
      s.position.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, -0.05);
      s.scale.setScalar(r * 2.6 * (0.3 + 0.7 * fade));
      s.material.opacity = 0.8 * fade ** 1.2;
      s.material.color.set(colour);
    });
  }

  let sized = ''; // canvas size the cameras were fitted to; cleared when the scene's framing changes
  function resize() {
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    if (sized === `${w}x${h}`) return;
    sized = `${w}x${h}`;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2, Math.sqrt(MAX_PIXELS / Math.max(1, w * h))));
    renderer.setSize(w, h, false);
    fitFlat(w, h);
  }

  return {
    // The board's x under a page x (a finger on the board).
    toWorldX(clientX: number) {
      const r = canvas.getBoundingClientRect();
      return flatCamera.left + ((clientX - r.left) / r.width) * (flatCamera.right - flatCamera.left);
    },
    setInfo(info: SceneInfo) {
      radii = info.radii;
      flat = info.flat;
      setBoard(info);
      sized = '';
    },
    // The side walls drawn or not (an upright phone's board runs edge to edge: the screen's edges are the walls).
    setSideWalls(on: boolean) {
      sideWalls = on;
      if (sides) sides.visible = on;
    },
    // The brick whose state is on.
    setActive(id: number | undefined) {
      active = id;
      showActive();
    },
    // A brick was hit: it pulses.
    flash(bodyId: number, force: number) {
      const brick = bricks?.id.indexOf(bodyId) ?? -1;
      if (brick >= 0) brickKick[brick] = force;
    },
    draw(snap: { data: Float32Array; decor?: Float32Array } | undefined, now = performance.now()) {
      resize();
      if (snap?.decor && bricks) {
        // decor = paddle x, then whether each brick holds the ball (interpolated, so the wobble eases in).
        if (paddle) paddle.position.x = snap.decor[0];
        const wob = Math.sin(now / 45);
        brickMeshes.forEach((m, i) => {
          const held = snap.decor![1 + i] ?? 0;
          const pulse = 1 + BRICK_PULSE * brickFlash[i];
          m.scale.set(pulse * (1 + WOBBLE * held * (0.5 + 0.5 * wob)), pulse * (1 - WOBBLE * held * (1 + 0.5 * wob)), 1);
        });
        brickFlash = brickFlash.map((f, i) => f + (brickKick[i] - f) * PULSE_ATTACK);
        brickKick = brickKick.map((k) => k * FLASH_DECAY);
        if (brickGlow) brickGlow.material.opacity = 0.75 + 0.25 * Math.sin(now / 120);
      }
      const positions = snap?.data;
      if (positions) {
        ensure(positions.length / 3);
        meshes.forEach((m, i) => {
          m.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
          m.scale.setScalar(radii[i] ?? 0.15);
        });
      }
      drawTrail(bricks && positions?.length ? [positions[0], positions[1]] : undefined, now);
      renderer.render(scene, flatCamera);
    },
  };
}
