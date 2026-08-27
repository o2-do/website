import * as THREE from 'three';
import { stempleRiss } from './schattenriss.js';
import { sonnenVersatz } from './baumloader.js';
import { stream, rand, randInt } from './rng.js';
import { makeNoise3D } from './noise.js';

/**
 * n unterschiedliche Brocken. Ikosaeder, radial verrauscht, danach
 * nichtuniform gestaucht -> unrund. Die Geometrie ist non-indexed
 * (PolyhedronGeometry), deshalb funktioniert flatShading und die
 * facettenweise UV-Zuweisung ohne Umbau.
 */
export function createRockGeometries(rng, count, detail = 2) {
  const noise = makeNoise3D(rng);
  const geos = [];
  for (let g = 0; g < count; g++) {
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const pos = geo.attributes.position;
    const ox = rng() * 100, oy = rng() * 100, oz = rng() * 100;
    const lumpy = rand(rng, 0.22, 0.38);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const d = v.clone().normalize();
      const r =
        1 +
        lumpy * noise(d.x * 1.7 + ox, d.y * 1.7 + oy, d.z * 1.7 + oz) +
        0.5 * lumpy * noise(d.x * 3.9 + ox, d.y * 3.9 + oy, d.z * 3.9 + oz);
      pos.setXYZ(i, d.x * r, d.y * r, d.z * r);
    }
    // nichtuniforme Stauchung fest in die Geometrie backen
    geo.scale(rand(rng, 0.7, 1.25), rand(rng, 0.55, 1.0), rand(rng, 0.7, 1.25));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    // auf max. Kantenlaenge 1 normieren, damit "Groesse" in Metern steuerbar ist
    const s = geo.boundingBox.getSize(new THREE.Vector3());
    geo.scale(1 / Math.max(s.x, s.y, s.z), 1 / Math.max(s.x, s.y, s.z), 1 / Math.max(s.x, s.y, s.z));
    geo.computeBoundingBox();
    geos.push(geo);
  }
  return geos;
}

/**
 * Box-Mapping pro Dreieck: dominante Achse der Flaechennormalen bestimmen,
 * UV aus den beiden anderen Achsen. Vermeidet die Polnaht der Kugel-UVs
 * ohne Custom-Shader.
 */
export function planarUV(geo, scale = 1) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.copy(ab.subVectors(b, a)).cross(ac.subVectors(c, a)).normalize();
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u, v;
      if (ax >= ay && ax >= az) { u = p.z; v = p.y; }
      else if (ay >= ax && ay >= az) { u = p.x; v = p.z; }
      else { u = p.x; v = p.y; }
      uv[(i + k) * 2] = u / scale;
      uv[(i + k) * 2 + 1] = v / scale;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function randomQuaternion(rng, q) {
  const u1 = rng(), u2 = rng() * Math.PI * 2, u3 = rng() * Math.PI * 2;
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
  return q.set(s1 * Math.sin(u2), s1 * Math.cos(u2), s2 * Math.sin(u3), s2 * Math.cos(u3));
}

// Vertikale Ausdehnung der skalierten und rotierten Geometrie, exakt ueber die
// Vertices (nicht ueber die Bounding-Box - die wuerde bei Rotation ueberschaetzen).
const _v = new THREE.Vector3();
function extents(array, quat, scale) {
  let min = Infinity, max = -Infinity, rad = 0;
  for (let i = 0; i < array.length; i += 3) {
    _v.set(array[i] * scale.x, array[i + 1] * scale.y, array[i + 2] * scale.z)
      .applyQuaternion(quat);
    if (_v.y < min) min = _v.y;
    if (_v.y > max) max = _v.y;
    const r2 = _v.x * _v.x + _v.z * _v.z;
    if (r2 > rad) rad = r2;
  }
  return { min, max, radXZ: Math.sqrt(rad) };
}

/**
 * Haufenweise Platzierung auf freier Grasflaeche (Wege werden freigehalten).
 * Jeder Brocken bekommt eine eigene Rotation und eine eigene, nichtuniforme
 * Skalierung; er sinkt um `felsEinsinken` seiner Hoehe in den Boden ein.
 */
export function planRocks(hf, cfg, geometries, pathIndex, occ) {
  const rng = stream(cfg._seed, 'rocks');
  const R = hf.radius;
  const haufen = Math.max(0, Math.round(cfg.felsMenge));
  const placements = [];

  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const frei = (x, z) => (pathIndex ? pathIndex.surfaceDistance(x, z) : Infinity);

  for (let h = 0; h < haufen; h++) {
    // Haufenzentrum gleichverteilt auf der Kreisflaeche, abseits der Wege
    let cx = 0, cz = 0, ok = false;
    for (let tries = 0; tries < 30 && !ok; tries++) {
      const rr = 0.9 * R * Math.sqrt(rng());
      const aa = rng() * Math.PI * 2;
      cx = Math.cos(aa) * rr; cz = Math.sin(aa) * rr;
      ok = frei(cx, cz) > cfg.felsAbstandWegMin + 1.5;
    }
    if (!ok) continue;

    const spread = rand(rng, 1.0, 2.5);
    const n = randInt(rng, cfg.felsProHaufen[0], cfg.felsProHaufen[1]);

    for (let i = 0; i < n; i++) {
      const da = rng() * Math.PI * 2;
      const dr = spread * Math.sqrt(rng());
      const x = cx + Math.cos(da) * dr;
      const z = cz + Math.sin(da) * dr;
      if (Math.hypot(x, z) > 0.95 * R) continue;

      const typeIndex = randInt(rng, 0, geometries.length - 1);
      const size = rand(rng, cfg.felsMin, cfg.felsMax);
      const w = cfg.felsVerzerrung / 100;
      sc.set(
        size * rand(rng, 1 - w, 1 + w),
        size * rand(rng, 1 - w, 1 + w),
        size * rand(rng, 1 - w, 1 + w),
      );
      randomQuaternion(rng, q);

      // JEDER BROCKEN WUERFELT SEINEN EIGENEN ABSTAND. Ein fester Wert reihte
      // sie alle in gleichem Abstand am Weg auf, als waeren sie gesetzt; mit
      // einer Spanne liegt einer auf dem Belag, der naechste einen Meter
      // daneben, und dazwischen ist alles moeglich.
      const abstand = rand(rng, cfg.felsAbstandWegMin, cfg.felsAbstandWegMax);

      const arr = geometries[typeIndex].attributes.position.array;
      const ext = extents(arr, q, sc);
      // Exakter Umriss des gedrehten Brockens gegen die befestigte Flaeche.
      // Ist der gewuerfelte Abstand negativ, darf der Brocken so weit in den
      // Belag hineinragen - ein Findling, um den herum der Weg gebaut wurde.
      if (frei(x, z) < ext.radXZ + abstand) continue;
      // ... und gegen alles bereits Platzierte - Baumstaemme, Zypressen.
      //
      // Die WEGE werden dabei uebergangen, sobald ein negativer Abstand
      // eingestellt ist: sonst haette das Belegungsraster gerade das
      // verhindert, was die exakte Abfrage eine Zeile darueber schon erlaubt
      // hat. Es sperrt in Zellen von einigen Zentimetern und kennt keine
      // Bruchteile davon - fuer „ein bisschen auf dem Belag" ist es das
      // falsche Werkzeug.
      if (occ && !occ.free(x, z, ext.radXZ, abstand < 0)) continue;

      const hoehe = ext.max - ext.min;
      // Unterkante auf den Boden, dann um den eingestellten Anteil versenken
      const y = hf.heightAt(x, z) - ext.min - hoehe * cfg.felsEinsinken;

      p.set(x, y, z);
      m.compose(p, q, sc);
      placements.push({ typeIndex, matrix: m.clone(), x, z, radXZ: ext.radXZ,
                        hoehe: hoehe * (1 - cfg.felsEinsinken) });
    }
  }
  // Erst am Ende sperren: Felsen duerfen sich untereinander ueberschneiden
  // (das gehoert zum Haufen), spaetere Objekte sollen ihnen aber ausweichen.
  if (occ) for (const pl of placements) occ.block(pl.x, pl.z, pl.radXZ);
  return placements;
}

/**
 * Je Brockenform und Sektor ein InstancedMesh (siehe `sektoren.js`).
 *
 * Felsen liegen in Haufen und damit ohnehin geklumpt - das Aufteilen kostet
 * hier fast keine zusaetzlichen Zeichenaufrufe und nimmt einem Netz mit
 * 47 m Huellkugel die Unverwerfbarkeit.
 */
export function buildRockMeshes(geometries, placements, material, sektoren) {
  const gruppen = new Map();
  for (const pl of placements) {
    const k = `${pl.typeIndex}|${sektoren.index(pl.x, pl.z)}`;
    let a = gruppen.get(k);
    if (!a) { a = { typ: pl.typeIndex, feld: sektoren.index(pl.x, pl.z), mats: [] }; gruppen.set(k, a); }
    a.mats.push(pl.matrix);
  }

  const meshes = [];
  for (const g of gruppen.values()) {
    const im = new THREE.InstancedMesh(geometries[g.typ], material, g.mats.length);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    g.mats.forEach((m, k) => im.setMatrixAt(k, m));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
    im.name = `felsen_${g.typ}_${g.feld}`;
    meshes.push(im);
  }
  return meshes;
}

/* ---------------- Der echte Schatten in die Bodenkarte ---------------- */

/**
 * Fuer jeden Brocken sein wirklicher Umriss, laengs der Sonne auf den Boden
 * geworfen (siehe `schattenriss.js`).
 *
 * Hier stand einmal eine Ellipse - eine Naeherung, die bei neun Bildpunkten
 * Breite keine war. Bei zwei Metern Brockengroesse und 4096er Karte ist sie
 * eine: ein Findling ist kantig, und ein glatter Ovalfleck darunter sieht aus
 * wie aufgeklebt. Die Huelle kostet je Brocken ein paar Dutzend Punkte.
 */
export function stempelFelsschatten(bodenkarte, placements, geometries, hf) {
  if (!bodenkarte) return 0;
  let n = 0;
  for (const pl of placements) {
    const geo = geometries && geometries[pl.typeIndex];
    if (geo && stempleRiss(bodenkarte, geo, pl.matrix, hf ? hf.heightAt(pl.x, pl.z) : 0)) { n++; continue; }
    // Ohne Geometrie bleibt die alte Naeherung.
    const v = sonnenVersatz(pl.hoehe);
    const laenge = Math.hypot(v.x, v.z);
    bodenkarte.setzeEllipse(pl.x + v.x / 2, pl.z + v.z / 2,
                            pl.radXZ + laenge / 2, pl.radXZ, Math.atan2(v.z, v.x));
    n++;
  }
  return n;
}
