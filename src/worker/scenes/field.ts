// The breakout field's size: shared by the scene and by the page that fits it to a screen.
export const CELL = 10 / 18; // m: the field holds 18 bricks in 10 m...
export const MIN_HALF_W = 3.5; // ...and is never narrower than 7 m, so a short row gets wider, readable bricks
export const TOP = 8; // m, its usual height (the top wall)
export const LOST_Y = -0.6; // below the paddle: the ball is gone
export const MARGIN = 0.15; // m round the board, in its framing

export const halfWidth = (bricks: number) => Math.max(MIN_HALF_W, (CELL * bricks) / 2);
// The height at which the framed board has this height ÷ width (a phone held upright gets a taller field)...
export const topFor = (aspect: number, bricks: number) => aspect * (2 * halfWidth(bricks) + 2 * MARGIN) + LOST_Y - 2 * MARGIN;
// ...or the half width at which it does, for a given height (a phone on its side gets a wider one).
export const widthFor = (aspect: number, top: number) => ((top - LOST_Y + 2 * MARGIN) / aspect - 2 * MARGIN) / 2;
