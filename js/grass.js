import * as THREE from 'three';
import { stream, rand } from './rng.js';
import { atArcLength } from './paths.js';

/**
 * Very-low-poly Halm in der XY-Ebene: Breite 1, Hoehe 1, 5 Vertices,
 * 3 Dreiecke. Die Normalen zeigen nach oben (nicht nach vorn), damit die
 * Halme wie der Boden beleuchtet werden und beim Drehen nicht dunkel kippen.
 * Die Vertexfarbe verlaeuft dunkel (Basis) nach hell (Spitze) und wird mit
 * der Instanzfarbe multipliziert.
 */
export function createBladeGeometry() {
  const pos = new Float32Array([
    -0.5, 0.0, 0,   0.5, 0.0, 0,  -0.25, 0.55, 0,
     0.5, 0.0, 0,   0.25, 0.55, 0, -0.25, 0.55, 0,
    -0.25, 0.55, 0, 0.25, 0.55, 0,  0.0, 1.0, 0,
  ]);
  const col = [];
  const shade = (y) => 0.55 + 0.55 * y;
  for (let i = 0; i < pos.length; i += 3) {
    const c = shade(pos[i + 1]);
    col.push(c, c, c);
  }
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { nrm[i] = 0; nrm[i + 1] = 1; nrm[i + 2] = 0; }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/* --- Dichteverteilungen ---------------------------------------------------
 * "Halme nehmen gleichmaessig ab" heisst: die Flaechendichte faellt linear.
 * Das ist nicht dasselbe wie gleichverteiltes Ziehen, die CDF muss invertiert
 * werden.
 *   lateral: rho(d) ~ (1-d)          -> d = 1 - sqrt(1-u)
 *   radial:  rho(r) ~ (1-r/R), Ring ~ r  -> CDF = 3r^2 - 2r^3 = smoothstep(r)
 *            -> exakte Umkehrung der Smoothstep-Funktion
 */
export const lateralDecay = (u) => 1 - Math.sqrt(1 - u);
export const radialDecay = (u) => 0.5 - Math.sin(Math.asin(1 - 2 * u) / 3);

/**
 * Am Stamm wachsen die Halme doppelt so hoch wie sonst - dort maeht niemand,
 * und der Uebergang vom Boden zum Stamm braucht etwas, das ihn verdeckt.
 * Die Breite bleibt gleich: hoehere UND breitere Halme saehen aus wie eine
 * andere Pflanze, nicht wie dasselbe Gras an einer ruhigeren Stelle.
 */
const STAMM_HOEHE = 2;

function bladeMatrix(m, p, q, sc, rng, cfg, x, y, z, hoehenFaktor = 1) {
  const yaw = rng() * Math.PI * 2;
  const tilt = rng() * (cfg.halmNeigung * Math.PI / 180);
  const tiltDir = rng() * Math.PI * 2;
  q.setFromAxisAngle(_axis.set(Math.cos(tiltDir), 0, Math.sin(tiltDir)), tilt)
    .multiply(_qy.setFromAxisAngle(_up, yaw));
  sc.set(
    cfg.halmBreite * rand(rng, 0.7, 1.3),
    rand(rng, cfg.halmHoeheMin, cfg.halmHoeheMax) * hoehenFaktor,
    1,
  );
  p.set(x, y, z);
  m.compose(p, q, sc);
}
const _axis = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _qy = new THREE.Quaternion();

/**
 * Wachsender Float32-Puffer fuer Instanzmatrizen. Ein `Matrix4.clone()` je
 * Halm kostet bei ueber hunderttausend Halmen spuerbar Zeit und erzeugt
 * entsprechend viel Muell fuer den GC.
 */
function matrixBuffer(estimate) {
  let arr = new Float32Array(Math.max(16, Math.ceil(estimate) * 16));
  let n = 0;
  return {
    push(m) {
      if ((n + 1) * 16 > arr.length) {
        const bigger = new Float32Array(arr.length * 2);
        bigger.set(arr);
        arr = bigger;
      }
      arr.set(m.elements, n * 16);
      n++;
    },
    get count() { return n; },
    get array() { return arr; },
  };
}

/** Typ 1: durchgehend links und rechts der Wege, je Wegsegment ein Bueschel. */
export function planEdgeGrass(paths, hf, pathIndex, cfg) {
  const rng = stream(cfg._seed, 'grass-edge');
  const total0 = paths.reduce((a, p) => a + p.total, 0);
  const out = matrixBuffer((total0 / cfg.wegSegment) * 2 * cfg.halmeTyp1);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(),
        q = new THREE.Quaternion(), sc = new THREE.Vector3();

  for (const path of paths) {
    const edge = path.width / 2;
    const total = path.total;
    const segs = Math.max(1, Math.round(total / cfg.wegSegment));
    const segLen = total / segs;
    // Radius, in dem alle Halme eines Segments liegen
    const rad = segLen / 2 + cfg.grasBreiteWeg / 2 + 0.3;

    for (let k = 0; k < segs; k++) {
      for (let side = -1; side <= 1; side += 2) {
        // An Kreuzungen liegt der Rand des einen Weges auf der Flaeche des
        // anderen - dort waechst kein Gras. Der Test kostet pro Segment
        // dasselbe wie pro Halm, deshalb einmal fuer das ganze Segment
        // vorpruefen und nur im Zweifel jeden Halm einzeln testen.
        const mid = atArcLength(path, (k + 0.5) * segLen);
        const mx = mid.x + mid.nx * (edge + cfg.grasBreiteWeg / 2) * side;
        const mz = mid.z + mid.nz * (edge + cfg.grasBreiteWeg / 2) * side;
        const frei = pathIndex.farFrom(mx, mz, rad, path.index);

        for (let i = 0; i < cfg.halmeTyp1; i++) {
          const s = (k + rng()) * segLen;
          const d = lateralDecay(rng()) * cfg.grasBreiteWeg;
          const c = atArcLength(path, s);
          const x = c.x + c.nx * (edge + d) * side;
          const z = c.z + c.nz * (edge + d) * side;
          if (!frei && pathIndex.onSurface(x, z, path.index)) continue;
          bladeMatrix(m, p, q, sc, rng, cfg, x, hf.heightAt(x, z), z);
          out.push(m);
        }
      }
    }
  }
  return out;
}

/** Typ 2: runde Bueschel, unregelmaessig auf der freien Wiese. */
export function planPatchGrass(hf, pathIndex, occ, cfg) {
  const rng = stream(cfg._seed, 'grass-patch');
  const out = matrixBuffer(cfg.anzahlBueschel2 * cfg.halmeTyp2);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(),
        q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const R = hf.radius;
  const radius = cfg.bueschelD2 / 2;

  for (let b = 0; b < Math.round(cfg.anzahlBueschel2); b++) {
    let cx = 0, cz = 0, ok = false;
    for (let t = 0; t < 20 && !ok; t++) {
      const rr = 0.95 * R * Math.sqrt(rng());
      const aa = rng() * Math.PI * 2;
      cx = Math.cos(aa) * rr; cz = Math.sin(aa) * rr;
      ok = pathIndex.surfaceDistance(cx, cz) > 0.2 + radius
        && (!occ || occ.free(cx, cz, radius));
    }
    if (!ok) continue;
    if (occ) occ.block(cx, cz, radius * 0.8);

    for (let i = 0; i < cfg.halmeTyp2; i++) {
      const r = radialDecay(rng()) * radius;
      const a = rng() * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      bladeMatrix(m, p, q, sc, rng, cfg, x, hf.heightAt(x, z), z);
      out.push(m);
    }
  }
  return out;
}

/** Typ 3: um jeden Stamm, bewusst ohne Aussparung in der Mitte. */
export function planTrunkGrass(trunks, hf, pathIndex, cfg) {
  const rng = stream(cfg._seed, 'grass-trunk');
  const out = matrixBuffer(trunks.length * cfg.halmeTyp3);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(),
        q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const radius = cfg.bueschelD3 / 2;

  for (const t of trunks) {
    const frei = pathIndex.farFrom(t.x, t.z, radius);
    for (let i = 0; i < cfg.halmeTyp3; i++) {
      const r = radialDecay(rng()) * radius;
      const a = rng() * Math.PI * 2;
      const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
      if (!frei && pathIndex.onSurface(x, z)) continue;
      bladeMatrix(m, p, q, sc, rng, cfg, x, hf.heightAt(x, z), z, STAMM_HOEHE);
      out.push(m);
    }
  }
  return out;
}

/**
 * Die Halme einer Sorte, je Sektor ein InstancedMesh (siehe `sektoren.js`).
 *
 * Das Aufteilen ist hier am wichtigsten: der Wegrand allein hat 90 000 Halme,
 * und als ein Netz ueber den ganzen Garten liegt seine Huellkugel bei 62 m
 * Halbmesser - das Sichtvolumen kann davon nie etwas verwerfen.
 */
/**
 * Halme jenseits der Sichtweite ausblenden - je Sektor, nicht je Halm.
 *
 * DAS SICHTVOLUMEN ALLEIN REICHT NICHT. Es sortiert nach Richtung aus, nicht
 * nach Abstand: wer vom Rand quer durch den Garten schaut, hat jeden Sektor
 * vor sich, und dann werden alle Halme gezeichnet. Nachgemessen waren das
 * 112 677 Halme bis in 93 m Entfernung, davon 70 Prozent jenseits von 40 m -
 * dort ist ein Halm zwei Bildpunkte hoch.
 *
 * GERECHNET WIRD JE NETZ, NICHT JE INSTANZ. Das ist der Unterschied zu den
 * frueheren, langsameren Anlaeufen: es sind rund siebzig Abstandsvergleiche je
 * Bild, und kein einziger Instanzpuffer wird angefasst. Gemessen wird zur
 * naechsten Ecke des Sektors (Mittelpunkt minus Huellkugelradius), damit ein
 * Sektor auftaucht, sobald sein erster Halm in Reichweite kommt.
 *
 * Das Band verhindert das Flackern an der Grenze: ein Sektor kommt bei
 * `weite` und geht erst bei `weite + BAND` wieder - sonst schaltete ein ganzes
 * 17-Meter-Feld beim Hin- und Hergehen im Takt der Schritte um.
 */
const SICHT_BAND = 4;

export function aktualisiereGrasSicht(netze, kamera, weite, istVogel) {
  // In der Karte ist das Gras ohnehin aus (siehe `applyView`); dort hier
  // hineinzuregieren hiesse, sich mit ihr um dieselbe Eigenschaft zu streiten.
  if (istVogel || !netze || !netze.length) return 0;
  kamera.getWorldPosition(_kam);
  const ohneGrenze = !(weite > 0);
  let sichtbar = 0;
  for (const m of netze) {
    if (ohneGrenze) { m.visible = true; sichtbar++; continue; }
    const bs = m.boundingSphere;
    const d = bs
      ? Math.hypot(_kam.x - bs.center.x, _kam.z - bs.center.z) - bs.radius
      : 0;
    const an = m.visible ? d < weite + SICHT_BAND : d < weite;
    m.visible = an;
    if (an) sichtbar++;
  }
  return sichtbar;
}
const _kam = new THREE.Vector3();

export function buildGrassMeshes(buffer, geometry, material, name, cfg, seedName, sektoren) {
  const n = buffer.count;
  if (!n) return [];

  // Farbstreuung aus einer kleinen Palette - optisch nicht von einer Farbe je
  // Halm zu unterscheiden, aber ohne 100 000 HSL-Umrechnungen.
  //
  // Gezogen wird ueber ALLE Halme in ihrer urspruenglichen Reihenfolge, nicht
  // je Sektor: sonst haenge die Farbfolge davon ab, wie das Raster gerade
  // steht, und das Umstellen der Sektorweite faerbte die Wiese um.
  const rng = stream(cfg._seed, seedName + '-color');
  const PAL = 64;
  const pal = new Float32Array(PAL * 3);
  const c = new THREE.Color();
  for (let i = 0; i < PAL; i++) {
    c.setHSL(rand(rng, 0.22, 0.30), rand(rng, 0.35, 0.6), rand(rng, 0.28, 0.45));
    pal[i * 3] = c.r; pal[i * 3 + 1] = c.g; pal[i * 3 + 2] = c.b;
  }
  const alleFarben = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = (Math.floor(rng() * PAL) % PAL) * 3;
    alleFarben[i * 3] = pal[k];
    alleFarben[i * 3 + 1] = pal[k + 1];
    alleFarben[i * 3 + 2] = pal[k + 2];
  }

  // Je Halm sein Feld, damit die Farben beim Aufteilen mitwandern.
  const feld = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    feld[i] = sektoren.index(buffer.array[i * 16 + 12], buffer.array[i * 16 + 14]);
  }

  const meshes = [];
  for (const [k, matrizen] of sektoren.teileMatrizen(buffer.array, n)) {
    const m = matrizen.length / 16;
    const mesh = new THREE.InstancedMesh(geometry, material, m);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceMatrix.array.set(matrizen);
    mesh.instanceMatrix.needsUpdate = true;

    const farben = new Float32Array(m * 3);
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (feld[i] !== k) continue;
      farben[j * 3] = alleFarben[i * 3];
      farben[j * 3 + 1] = alleFarben[i * 3 + 1];
      farben[j * 3 + 2] = alleFarben[i * 3 + 2];
      j++;
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(farben, 3);
    mesh.instanceColor.needsUpdate = true;

    mesh.computeBoundingSphere();
    // Halme werfen bewusst keinen Schatten: 100k Instanzen im Shadow-Pass
    // kosten die Haelfte der Framerate und ergeben nur Rauschen.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = `${name}_${k}`;
    meshes.push(mesh);
  }
  return meshes;
}
