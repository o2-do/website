import * as THREE from 'three';
import { stream } from './rng.js';
import { makeNoise2D, makeFbm2D } from './noise.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Die einzige Hoehenquelle der Szene (PLAN.md L1).
 * Analytisch, damit Felsen, Gras, Wege und Kamera dieselbe Referenz nutzen
 * koennen, ohne im Mesh nachschlagen zu muessen.
 */
export function createHeightField(cfg) {
  const rng = stream(cfg._seed, 'terrain');
  const R = cfg.durchmesser / 2;
  // Erhebung und Senke werden getrennt eingestellt, nicht als eine Spanne.
  // Die Null ist keine willkuerliche Mitte: auf ihr liegt der Rand des Gartens,
  // dort schliesst die Horizontscheibe an, und dort steht der Zaun. Wer eine
  // huegelige Wiese ohne Mulden will, setzt `maxTiefe` auf 0 und bekommt genau
  // das - mit einer gemeinsamen Spanne ginge das nicht.
  const hoch = cfg.maxHoehe / 100;                 // cm -> m, ueber Null
  const tief = cfg.maxTiefe / 100;                 // cm -> m, unter Null
  const s = cfg.staerke;                            // 0..1
  const freq = 0.008 + 0.042 * s;                   // 1/m, grosse Wellen -> feine Wellen
  const octaves = Math.round(2 + 2 * s);
  const fbm = makeFbm2D(makeNoise2D(rng), octaves);
  const ox = rng() * 1000, oz = rng() * 1000;
  const edge = cfg.randAuslauf;                     // 0..1, Anteil von R fuer den Auslauf

  function falloff(x, z) {
    const r = Math.hypot(x, z);
    return 1 - smoothstep(R * (1 - edge), R, r);    // ab r >= R exakt 0
  }

  // fBm schoepft seinen Wertebereich [-1,1] nie aus. Deshalb einmalig abtasten
  // und so normieren, dass die beiden Einstellungen wirklich der hoechste und
  // der tiefste Punkt der Wiese sind.
  let lo = Infinity, hi = -Infinity;
  const inner = R * (1 - edge);
  const S = 64;
  for (let i = 0; i <= S; i++) {
    for (let j = 0; j <= S; j++) {
      const x = -inner + (2 * inner * i) / S;
      const z = -inner + (2 * inner * j) / S;
      if (Math.hypot(x, z) > inner) continue;
      const v = fbm(x * freq + ox, z * freq + oz);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  // Zwei Faktoren statt eines: die Haelfte des Rauschens ueber der Mitte wird
  // auf `hoch` gestreckt, die darunter auf `tief`. Bei gleichen Werten kommt
  // dasselbe heraus wie mit einer Spanne, nur eben getrennt einstellbar.
  const mid = (hi + lo) / 2;
  const kHoch = hoch / Math.max(1e-6, hi - mid);
  const kTief = tief / Math.max(1e-6, mid - lo);

  function heightAt(x, z) {
    const f = falloff(x, z);
    if (f <= 0) return 0;
    const v = fbm(x * freq + ox, z * freq + oz) - mid;
    return v * (v >= 0 ? kHoch : kTief) * f;
  }

  // Finite Differenzen; wird spaeter fuer Ausrichtung von Objekten gebraucht.
  function normalAt(x, z, eps = 0.5) {
    const hx = heightAt(x + eps, z) - heightAt(x - eps, z);
    const hz = heightAt(x, z + eps) - heightAt(x, z - eps);
    return new THREE.Vector3(-hx, 2 * eps, -hz).normalize();
  }

  // Hangneigung in Grad, aus zentralen Differenzen. Eigene Funktion statt
  // `normalAt(...).y` durch den Arkuskosinus: die Platzierung von Baeumen und
  // Beeten fragt das einige hundert Mal je Aufbau, und ein Vector3 je Abfrage
  // nur, um am Ende eine Zahl zu bekommen, ist Verschwendung.
  function neigung(x, z, eps = 0.4) {
    const gx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps);
    const gz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps);
    return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
  }

  // `amplitude` ist der Gesamthub - sie sagt, wie tief der Kartenkasten unter
  // den Garten reichen muss, damit auch die tiefste Mulde darueber liegt.
  return { heightAt, normalAt, neigung, falloff, radius: R,
           amplitude: hoch + tief, hoch, tief, freq, octaves };
}

/**
 * Horizont: runde Scheibe mit quadratischem Loch, exakt in der Groesse des
 * Bodengitters. Kein Ueberlappen -> kein Z-Fighting, keine Naht.
 */
export function buildHorizon(cfg, material, radius = cfg.horizont) {
  const h = cfg.durchmesser / 2;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);

  const hole = new THREE.Path();          // Wicklung gegenlaeufig zur Aussenkontur
  hole.moveTo(-h, -h);
  hole.lineTo(-h, h);
  hole.lineTo(h, h);
  hole.lineTo(h, -h);
  hole.closePath();
  shape.holes.push(hole);

  const geo = new THREE.ShapeGeometry(shape, 96);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const tile = cfg.kachelWiese;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / tile, pos.getZ(i) / tile);
  }
  uv.needsUpdate = true;
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'horizont';
  return mesh;
}

/**
 * Kartenmaske: ein weisses Quadrat mit rundem Ausschnitt, flach ueber den
 * Garten gelegt. Nur in der Vogelperspektive sichtbar.
 *
 * Sie beschneidet den quadratischen Garten optisch auf einen runden: was
 * ausserhalb des Kreises liegt - die vier Ecken der Wiese - verschwindet unter
 * dem Weiss. Der Ausschnitt ist minimal kleiner als der Garten breit ist, damit
 * an der Rundung kein Spalt aufgeht.
 *
 * DAS QUADRAT IST WEIT GROESSER ALS DER GARTEN, und das ist keine Vorsicht,
 * sondern Notwendigkeit. Die Karte ist eine Parallelprojektion aus 35 Grad:
 * was tief liegt, erscheint darin nach vorn verschoben, und zwar um seine
 * Tiefe mal Kosinus der Neigung. Bei kraeftigem Relief rutschen die
 * Ausgleichswaelle am Rand deshalb aus dem Umriss der Maske heraus und stehen
 * als graue Schollen im Weiss. Ein Viertel Zuschlag reichte dafuer nicht; vier
 * Gartenbreiten reichen immer, und es sind zwei Dreiecke.
 *
 * Weiss und ohne Licht: ein Basismaterial nimmt keinen Schatten an, die
 * Schatten des Gartens enden also an der Kante des Ausschnitts.
 *
 * Die Hoehe ist unkritisch: der Falloff des Hoehenfelds drueckt die Wiese zum
 * Rand hin auf y = 0, unter der Maske liegt also flaches Gelaende.
 */
export function buildMapMask(cfg, material) {
  const a = cfg.durchmesser * 2;                // halbe Kantenlaenge, 4x Garten
  const r = cfg.durchmesser / 2 * 0.995;        // Ausschnitt, minimal kleiner

  const shape = new THREE.Shape();              // gegen den Uhrzeigersinn
  shape.moveTo(-a, -a);
  shape.lineTo(a, -a);
  shape.lineTo(a, a);
  shape.lineTo(-a, a);
  shape.closePath();

  const hole = new THREE.Path();                // Wicklung gegenlaeufig
  hole.absarc(0, 0, r, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geo = new THREE.ShapeGeometry(shape, 128);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.05, 0);                    // knapp ueber der flachen Wiese
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'kartenmaske';
  return mesh;
}

/**
 * Kasten unter dem Garten: vier senkrechte Rechtecke an den Quadratseiten,
 * knapp unter der Kante angesetzt und so tief, dass auch das tiefste Tal
 * darueber liegt.
 *
 * Er wird nur in der Karte gebraucht. Dort steht die Kamera bei flacher
 * Neigung fast waagerecht, und bei kraeftigem Relief sieht man dann seitlich
 * unter die Wiese - der Boden ist ein Hoehenfeld ohne Unterseite, man schaut
 * also durch ihn hindurch. Der Kasten macht ihn zu einem geschlossenen Koerper.
 */
export function buildMapBox(cfg, material, tiefe) {
  const h = cfg.durchmesser / 2;
  const oben = -0.01;                       // knapp unter der Kante, kein Z-Fighting
  const unten = oben - Math.max(0.5, tiefe);

  const pos = [];
  const idx = [];
  // Reihum, damit die Aussenseite jeder Wand nach aussen zeigt
  const ecken = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (let i = 0; i < 4; i++) {
    const a = ecken[i], b = ecken[(i + 1) % 4];
    const o = pos.length / 3;
    pos.push(a[0], oben, a[1], b[0], oben, b[1], b[0], unten, b[1], a[0], unten, a[1]);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'kartenkasten';
  return mesh;
}
