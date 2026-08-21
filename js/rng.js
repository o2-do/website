// Seedbare Zufallszahlen. Pro Gewerk ein eigener Stream (siehe PLAN.md, L2),
// damit z.B. eine geaenderte Felsanzahl die Wiesenverformung nicht verschiebt.

export function hashSeed(input) {
  const str = String(input);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stream(masterSeed, name) {
  return makeRng((masterSeed ^ hashSeed(name)) >>> 0);
}

export const rand = (rng, min, max) => min + (max - min) * rng();
export const randInt = (rng, min, max) => Math.floor(min + (max - min + 1) * rng());
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
