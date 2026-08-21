import { stream, rand } from './rng.js';
import { atArcLength } from './paths.js';

/**
 * Baumplaetze entlang der Wege: seitlicher Versatz von der Wegkante,
 * Mindestabstand untereinander, und Abstand zu ALLEN Wegen - sonst stuende ein
 * Baum mitten auf dem kreuzenden Weg.
 *
 * Was auf dem Platz waechst, entscheidet garden.js: die ersten Plaetze bekommen
 * die benannten Baeume aus der Namensliste, alle uebrigen den Standardbaum.
 * Geliefert wird Trunk = { x, y, z, pathIdx, s, side, nx, nz } - Grundlage fuer
 * Schilder (gleiche Bogenlaenge) und Grasbueschel Typ 3.
 *
 * `stammR` ist der tatsaechliche Stammradius des groessten Baummodells, nicht
 * mehr eine Formulargroesse: die Baeume kommen aus dem Konfigurator und bringen
 * ihr Mass selbst mit.
 */
export function planTrunks(paths, pathIndex, hf, cfg, occ, stammR, want) {
  const rng = stream(cfg._seed, 'trees');
  const trunks = [];
  if (paths.length === 0 || want === 0) return trunks;

  const R = hf.radius;
  // Der Abstand gilt zur Kante DES WEGES, an dem der Baum steht - und die
  // Abkuerzung ist schmaler als der Rundweg.
  const minDist = cfg.stammAbstand;
  const maxTries = want * 40;

  // Der Weg wird nach Laenge gewichtet gezogen, nicht gleichverteilt: sonst
  // saessen an einem 8 m langen Stichweg genauso viele Baeume wie am
  // mehrere hundert Meter langen Rundweg.
  const gesamt = paths.reduce((a, p) => a + p.total, 0);
  const pickPath = () => {
    let r = rng() * gesamt;
    for (const p of paths) { r -= p.total; if (r <= 0) return p; }
    return paths[paths.length - 1];
  };

  for (let t = 0; t < maxTries && trunks.length < want; t++) {
    const path = pickPath();
    const s = rand(rng, 0, path.total);
    const side = rng() < 0.5 ? -1 : 1;
    const c = atArcLength(path, s);
    const offset = path.width / 2 + cfg.stammAbstandWeg;
    const x = c.x + c.nx * offset * side;
    const z = c.z + c.nz * offset * side;

    if (Math.hypot(x, z) > 0.95 * R) continue;
    // nicht auf einem (anderen) Weg stehen
    if (pathIndex.surfaceDistance(x, z) < stammR) continue;

    // Mindestabstand untereinander ist eine Gestaltungsregel, keine Kollision -
    // deshalb weiterhin ein direkter Vergleich und nicht das Belegungsraster.
    let ok = true;
    for (const o of trunks) {
      if ((o.x - x) ** 2 + (o.z - z) ** 2 < minDist * minDist) { ok = false; break; }
    }
    if (!ok) continue;
    if (occ && !occ.free(x, z, stammR + 0.05)) continue;

    trunks.push({ x, z, y: hf.heightAt(x, z), pathIdx: path.index, s, side, nx: c.nx, nz: c.nz });
    if (occ) occ.block(x, z, stammR);
  }
  return trunks;
}
