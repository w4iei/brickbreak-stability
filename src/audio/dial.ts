// The intensity dial: 0..1 → Stable Audio strength (σ), how much of the original is replaced by noise and rebuilt
// toward the words. Measured on the KUNAKBAEVA masters: below ~0.6 every prompt sounds like the original, above ~0.9
// the rhythm is gone; 0.5 → 0.75 is what the public site's renders use.
export const strength = (intensity: number) => 0.62 + 0.26 * intensity;
