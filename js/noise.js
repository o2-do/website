// Gradient-Noise (2D) fuer die Wiese, Value-Noise (3D) fuer die Felsbrocken.
// Beide bekommen ihre Permutationstabelle aus einem seedbaren RNG.

function permutation(rng) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

export function makeNoise2D(rng) {
  const perm = permutation(rng);
  return function noise2D(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const X = xi & 255, Y = yi & 255;
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const g = (gx, gy, dx, dy) => {
      const h = perm[(perm[gx] + gy) & 511] & 7;
      return GRAD2[h][0] * dx + GRAD2[h][1] * dy;
    };
    const n0 = lerp(g(X, Y, xf, yf), g(X + 1, Y, xf - 1, yf), u);
    const n1 = lerp(g(X, Y + 1, xf, yf - 1), g(X + 1, Y + 1, xf - 1, yf - 1), u);
    return lerp(n0, n1, v) * 1.4; // grob auf [-1,1] normiert
  };
}

export function makeNoise3D(rng) {
  const perm = permutation(rng);
  const val = (i, j, k) =>
    perm[(perm[(perm[i & 255] + j) & 255] + k) & 255] / 127.5 - 1;
  return function noise3D(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const c000 = val(xi, yi, zi), c100 = val(xi + 1, yi, zi);
    const c010 = val(xi, yi + 1, zi), c110 = val(xi + 1, yi + 1, zi);
    const c001 = val(xi, yi, zi + 1), c101 = val(xi + 1, yi, zi + 1);
    const c011 = val(xi, yi + 1, zi + 1), c111 = val(xi + 1, yi + 1, zi + 1);
    const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
    const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  };
}

/**
 * Fraktale Summe. Normiert auf die Amplitudensumme, Ergebnis bleibt in [-1,1].
 *
 * `gewichte` daempft einzelne Oktaven - das ist die GLAETTUNG, und sie kostet
 * nichts. Eine Flaeche mit einem Gaussfilter zu verwischen heisst im
 * Frequenzbild: jede Welle mit exp(-(2*pi*f*sigma)^2/2) multiplizieren. Eine
 * fraktale Summe besteht aber schon aus Wellen bekannter Frequenz, und statt
 * das Ergebnis an vielen Stellen abzutasten und zu mitteln, wird hier einfach
 * jeder Summand einmal mit seinem Faktor versehen.
 *
 * Ohne `gewichte` verhaelt sich alles wie zuvor.
 */
export function makeFbm2D(noise2D, octaves, lacunarity = 2.0, gain = 0.5, gewichte = null) {
  return function fbm(x, y) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const g = gewichte ? gewichte[o] : 1;
      sum += amp * g * noise2D(x * freq, y * freq);
      norm += amp * g;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 1e-9 ? sum / norm : 0;
  };
}
