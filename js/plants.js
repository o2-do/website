import * as THREE from 'three';
import { frisch } from './frisch.js';
import { stream, rand } from './rng.js';
import { atArcLength } from './paths.js';
import { makeTranslucent } from './translucency.js';
import { sonnenVersatz } from './baumloader.js';

/**
 * Bruecke zum Pflanzenkonfigurator (`plantloader/`) und zum Beetkonfigurator.
 *
 * MASSE: `gartenloader.js` liefert bereits Meter, y nach oben, Ursprung am Fuss
 * auf der Grasnarbe, und der Fuss laeuft unter y = 0 weiter bis zu einem
 * gemeinsamen Wurzelpunkt (mindestens 10 cm, auf 20 Grad Hang ausgelegt). Damit
 * passt er ohne Umrechnung in den Garten - dieselbe Abmachung wie bei den
 * Baeumen, nur dass die Pflanze ihre Eintauchtiefe selbst mitbringt.
 *
 * FARBRAUM: die Vertexfarben des Generators liegen im linearen Arbeitsfarbraum.
 * Der Garten rendert mit three r169 und damit mit eingeschaltetem
 * ColorManagement (`renderer.outputColorSpace = SRGBColorSpace`) - genau der
 * Fall, fuer den nichts einzustellen ist. `geometry.js` bleibt unangetastet.
 *
 * MENGE: eine Pflanze hat rund 900 Dreiecke - drei Zehnerpotenzen weniger als
 * ein Baum frueher. Sie kommen dafuer zu Hunderten.
 *
 * DAS BEET IST JETZT EIN GEGENSTAND, keine blosse Liste mehr. Der
 * Beetkonfigurator gibt seine Masse in Metern an und legt eine Bodentextur
 * dazu; im Garten wird daraus eine Flaeche, die dem Gelaende folgt, mit den
 * Pflanzen darauf.
 */

const Pflanze = () => {
  if (!window.Pflanze) throw new Error('plantloader/gartenloader.js ist nicht geladen.');
  return window.Pflanze;
};

/* ---------------- Modelle ---------------- */

// Wie bei den Baeumen: einmal bauen, ueber Neuaufbauten hinweg behalten.
// Pflanzen sind zwar billig (wenige Millisekunden), aber die Geometrien
// werden geteilt und duerfen deshalb nicht mit dem Garten weggeraeumt werden.
const cache = new Map();

export async function loadPlantModel(datei) {
  if (cache.has(datei)) return cache.get(datei);

  const P = Pflanze();
  const url = /^[a-z][a-z0-9+.-]*:/i.test(datei) || datei.includes('/')
    ? datei : `json/${/\.json$/i.test(datei) ? datei : `${datei}.json`}`;
  // Mit Zeitstempel wie jede andere zur Laufzeit geladene Datei - sonst haelt
  // der Browser die Pflanzendatei fest und eine Aenderung daran wirkt nicht.
  const cfg = await P.loadConfig(frisch(url));
  const { geometry, stats } = P.buildPlant({ config: cfg });
  // Das Material des Konfigurators passt unveraendert (Vertexfarben, beidseitig,
  // Rauheit aus `glanz`); der Garten haengt nur das Gegenlicht ein.
  const material = makeTranslucent(P.buildMaterial({ config: cfg }));

  const model = {
    datei, name: cfg.name || datei.replace(/\.json$/i, ''),
    geometry, material,
    hoehe: stats.height,
    breite: stats.footprint,          // Grundrissdurchmesser inkl. Blattueberhang
    fussRadius: stats.footRadius,
    minY: stats.minY,
    dreiecke: stats.triangles,
  };
  cache.set(datei, model);
  return model;
}

export function clearPlantCache() {
  for (const m of cache.values()) { m.geometry.dispose(); m.material.dispose(); }
  cache.clear();
  for (const t of texturCache.values()) t.dispose();
  texturCache.clear();
}

/* ---------------- Beete ---------------- */

/**
 * Eine Beetdatei des Beetkonfigurators (Fassung 2).
 *
 * Was sich gegenueber der ersten Fassung geaendert hat, und warum es zaehlt:
 *
 *   `art` ist der DATEINAME der Pflanze, nicht mehr eine laufende Nummer im
 *   Beet. Frueher wuerfelte der Garten aus, welche Pflanze hinter Art 1 steckt;
 *   jetzt hat der Beetkonfigurator die Bepflanzung wirklich entworfen, und
 *   daran ist nichts mehr zu wuerfeln. `pickPlants` und der Regler „Verwendete
 *   Arten" sind damit ersatzlos entfallen - geladen wird, was die Beete nennen.
 *
 *   `breite` und `hoehe` stehen in der Datei. Frueher folgten die Masse aus dem
 *   Inhalt, weil eine mitgespeicherte Groesse eine zweite Wahrheit gewesen
 *   waere; jetzt ist die Beetgroesse eine eigene Entscheidung im Konfigurator
 *   (Pflanzen duerfen ueberstehen oder Platz lassen) und damit die erste.
 *
 *   `textur` ist der Boden des Beetes - Kies, Rindenmulch, Erde. Ohne sie waere
 *   das Beet im Garten unsichtbar und nur an seinen Pflanzen zu erkennen.
 *
 *   `durchmesser` je Pflanze ist ihr Aufsichtsdurchmesser MAL ihrer Skalierung,
 *   in Metern. Damit kann die Bodenkarte ihren Schatten stempeln, ohne eine
 *   einzige Pflanzendatei zu oeffnen.
 *
 * `x` zaehlt von der Beetmitte nach rechts (Weltachse X), `y` nach hinten
 * (Weltachse Z).
 */
export async function loadBed(datei) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(datei) || datei.includes('/')
    ? datei : `json/${datei}`;
  const r = await fetch(frisch(url), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`„${url}“ liess sich nicht laden (${r.status}).`);
  const d = await r.json();

  const roh = d.pflanzen || [];
  if (roh.some((p) => typeof p.art === 'number')) {
    throw new Error(`„${url}“ ist ein Beet der ersten Fassung („art“ als Nummer). `
      + 'Der Beetkonfigurator schreibt seit Fassung 2 den Dateinamen der Pflanze '
      + 'hinein; ein neuer Export bringt das Beet auf den Stand.');
  }

  const pflanzen = roh
    .map((p) => ({
      art: String(p.art ?? '').trim(),
      x: +p.x || 0,
      y: +p.y || 0,
      // Fehlt scale, gilt das Originalmass der Pflanzendatei.
      scale: Math.min(10, Math.max(0.02, p.scale == null ? 1 : +p.scale || 1)),
      // Schon mit der Skalierung verrechnet, in Metern.
      durchmesser: Math.max(0, +p.durchmesser || 0),
    }))
    .filter((p) => p.art && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pflanzen.length) throw new Error(`„${url}“ enthaelt keine Pflanzen.`);

  const breite = Math.max(0.2, +d.breite || 1);
  const hoehe = Math.max(0.2, +d.hoehe || 1);

  return {
    datei,
    name: d.name || datei.replace(/\.json$/i, ''),
    pflanzen,
    arten: [...new Set(pflanzen.map((p) => p.art))],
    breite, hoehe,                       // X und Y (= Z) in Metern
    textur: typeof d.textur === 'string' && d.textur ? d.textur : null,
    kacheln: !!d.kacheln,
    kachelgroesse: Math.max(0.05, +d.kachelgroesse || 0.5),
  };
}

/** Welche Pflanzendateien die geladenen Beete zusammen brauchen. */
export function pflanzenAusBeeten(beete) {
  const noetig = new Set();
  for (const b of beete) for (const a of b.arten) noetig.add(`${a}.json`);
  return [...noetig];
}

/**
 * Beete am Weg. Ein Beet steht wie im Park laengs zum Weg: die lange Seite
 * parallel zur Wegrichtung, der Abstand zwischen `beetAbstandMin` und
 * `beetAbstandMax` von der Wegkante gemessen - und zwar bis zur **Vorderkante**
 * des Beetes, nicht bis zur Mitte. Sonst haengt der sichtbare Abstand von der
 * zufaelligen Beettiefe ab.
 *
 * Steht die Vorlage hochkant (`hoehe > breite`), wird sie um 90 Grad gedreht
 * statt abgelehnt. Zusaetzlich darf sie gespiegelt werden - bei nur einer
 * Vorlage im Vorrat stuenden sonst zwei Dutzend identische Beete im Garten.
 *
 * Ergebnis:
 *   stellen  Map Pflanzendatei -> [{ x, y, z, yaw, scale, durchmesser }]
 *   plaetze  je gesetztem Beet { beet, cx, cz, yaw, halbX, halbZ } - daraus
 *            baut `buildBedFloors` die Bodenflaechen
 */
export function planBeds(beete, paths, pathIndex, hf, occ, cfg) {
  const stellen = new Map();
  const plaetze = [];
  if (!beete.length || !paths.length) return { stellen, plaetze, beete: 0 };

  const rng = stream(cfg._seed, 'beete');
  const R = hf.radius;
  const anzahl = Math.round(cfg.anzahlBeete);
  const aMin = Math.min(cfg.beetAbstandMin, cfg.beetAbstandMax);
  const aMax = Math.max(cfg.beetAbstandMin, cfg.beetAbstandMax);
  const gesamt = paths.reduce((a, p) => a + p.total, 0);
  const pickPath = () => {
    let r = rng() * gesamt;
    for (const p of paths) { r -= p.total; if (r <= 0) return p; }
    return paths[paths.length - 1];
  };

  let gesetzt = 0;
  for (let b = 0; b < anzahl * 8 && gesetzt < anzahl; b++) {
    const beet = beete[Math.floor(rng() * beete.length)];

    // Die lange Seite kommt an den Weg. `quer` heisst: die Vorlage steht
    // hochkant und wird beim Setzen um 90 Grad gedreht.
    const quer = beet.hoehe > beet.breite;
    const halbL = (quer ? beet.hoehe : beet.breite) / 2;   // laengs zum Weg
    const halbT = (quer ? beet.breite : beet.hoehe) / 2;   // quer dazu
    // Spiegeln kostet nichts und macht aus einer Vorlage vier Bilder.
    const spL = rng() < 0.5 ? -1 : 1;
    const spT = rng() < 0.5 ? -1 : 1;

    const path = pickPath();
    const s = rand(rng, 0, path.total);
    const side = rng() < 0.5 ? -1 : 1;
    const c = atArcLength(path, s);
    // Aussenrichtung und Wegrichtung. n zeigt vom Weg weg, t laeuft laengs.
    const nx = c.nx * side, nz = c.nz * side;
    const tx = c.nz * side, tz = -c.nx * side;

    // Vorderkante auf den gewuenschten Abstand, daraus die Mitte
    const vorne = path.width / 2 + rand(rng, aMin, aMax);
    const cx = c.x + nx * (vorne + halbT);
    const cz = c.z + nz * (vorne + halbT);

    // Alle vier Ecken muessen im Garten liegen und duerfen keinen Weg beruehren
    let frei = true;
    for (const sl of [-1, 1]) {
      for (const st of [-1, 1]) {
        const ex = cx + tx * halbL * sl + nx * halbT * st;
        const ez = cz + tz * halbL * sl + nz * halbT * st;
        if (Math.hypot(ex, ez) > 0.95 * R || pathIndex.surfaceDistance(ex, ez) < 0.1) {
          frei = false; break;
        }
      }
      if (!frei) break;
    }
    // Belegung: das Rechteck als Kapsel entlang der langen Achse pruefen
    if (frei && occ) {
      frei = occ.free(cx - tx * (halbL - halbT), cz - tz * (halbL - halbT), halbT)
          && occ.free(cx, cz, halbT)
          && occ.free(cx + tx * (halbL - halbT), cz + tz * (halbL - halbT), halbT);
    }
    if (!frei) continue;

    for (const p of beet.pflanzen) {
      // Erst in das Beetsystem laengs/quer umrechnen (Drehung bei hochkanter
      // Vorlage, dann Spiegelung), danach in die Welt.
      const pl = (quer ? p.y : p.x) * spL;
      const pt = (quer ? -p.x : p.y) * spT;
      const x = cx + tx * pl + nx * pt;
      const z = cz + tz * pl + nz * pt;
      const datei = `${p.art}.json`;
      if (!stellen.has(datei)) stellen.set(datei, []);
      stellen.get(datei).push({
        x, y: hf.heightAt(x, z), z,
        yaw: rng() * Math.PI * 2,
        // Die Vorgabe des Beetkonfigurators gilt genau: er hat die Pflanzen
        // gegeneinander abgewogen, eine Streuung darueber machte das zunichte.
        scale: p.scale,
        durchmesser: p.durchmesser,
      });
    }

    plaetze.push({ beet, cx, cz, tx, tz, nx, nz, halbL, halbT });
    if (occ) {
      occ.blockSegment(cx - tx * (halbL - halbT), cz - tz * (halbL - halbT),
                       cx + tx * (halbL - halbT), cz + tz * (halbL - halbT), halbT);
    }
    gesetzt++;
  }
  return { stellen, plaetze, beete: gesetzt };
}

/* ---------------- Der Boden des Beetes ---------------- */

// Die Bodentextur steht als Datenadresse in der Beetdatei und aendert sich nie.
const texturCache = new Map();

function bodenTextur(beet) {
  if (!beet.textur) return null;
  let t = texturCache.get(beet.textur);
  if (!t) {
    t = new THREE.TextureLoader().load(beet.textur);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texturCache.set(beet.textur, t);
  }
  // Gekachelt wiederholt sich das Bild alle `kachelgroesse` Meter, ungekachelt
  // wird es auf die vollen Beetmasse gezogen. Beides steckt in der Wiederholung
  // der Textur, die UVs bleiben in beiden Faellen 0…1 ueber das Beet.
  t.wrapS = t.wrapT = beet.kacheln ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.repeat.set(
    beet.kacheln ? beet.breite / beet.kachelgroesse : 1,
    beet.kacheln ? beet.hoehe / beet.kachelgroesse : 1);
  return t;
}

// Schrittweite des Bodengitters. Ein Beet ist wenige Meter gross, und das
// Gelaende unter ihm ist planiert - feiner als das braucht es nicht.
const BEET_SCHRITT = 0.4;

/**
 * Die Bodenflaechen aller gesetzten Beete, je Vorlage in EIN Netz verschmolzen.
 *
 * Eine ebene Platte ginge nicht: das Beet liegt neben dem Weg auf der
 * Boeschung, und eine Platte stuende dort mit einer Ecke in der Luft. Deshalb
 * ein kleines Gitter, dessen Punkte auf `hf.heightAt` sitzen - dieselbe
 * Hoehenquelle wie fuer alles andere.
 *
 * `imGrund` haengt die Bodenkarte ein (siehe `garden.js`), damit auch der
 * Beetboden die eingebrannten Schatten bekommt.
 */
export function buildBedFloors(plaetze, hf, cfg, imGrund, sektoren) {
  // Je Vorlage UND Sektor ein Netz. Die Vorlage, weil jede ihre eigene
  // Bodentextur hat; der Sektor aus demselben Grund wie ueberall sonst.
  const jeBeet = new Map();
  for (const p of plaetze) {
    const k = `${p.beet.datei}|${sektoren.index(p.cx, p.cz)}`;
    let a = jeBeet.get(k);
    if (!a) { a = []; jeBeet.set(k, a); }
    a.push(p);
  }

  const meshes = [];
  const materialien = new Map();      // je Vorlage eines, ueber alle Sektoren
  for (const [k, liste] of jeBeet) {
    const beet = liste[0].beet;
    const tex = bodenTextur(beet);
    const nl = Math.max(1, Math.round(liste[0].halbL * 2 / BEET_SCHRITT));
    const nt = Math.max(1, Math.round(liste[0].halbT * 2 / BEET_SCHRITT));

    const pos = [], uv = [], idx = [];
    for (const p of liste) {
      const basis = pos.length / 3;
      for (let j = 0; j <= nt; j++) {
        for (let i = 0; i <= nl; i++) {
          const u = i / nl, v = j / nt;
          const l = (u - 0.5) * p.halbL * 2;
          const t = (v - 0.5) * p.halbT * 2;
          const x = p.cx + p.tx * l + p.nx * t;
          const z = p.cz + p.tz * l + p.nz * t;
          // Wie der Weg: knapp ueber dem Gelaende, den Rest macht der
          // polygonOffset des Materials.
          pos.push(x, hf.heightAt(x, z) + cfg.wegHoehe, z);
          uv.push(u, v);
        }
      }
      for (let j = 0; j < nt; j++) {
        for (let i = 0; i < nl; i++) {
          const a = basis + j * (nl + 1) + i;
          const b = a + 1, c = a + nl + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    let mat = materialien.get(beet.datei);
    if (!mat) {
      mat = imGrund(new THREE.MeshStandardMaterial({
        map: tex, color: tex ? 0xffffff : 0x6b5a44,
        roughness: 1, metalness: 0,
        wireframe: cfg.drahtgitter,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      }));
      materialien.set(beet.datei, mat);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `beetboden_${beet.name}_${k.split('|')[1]}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    meshes.push(mesh);
  }
  return meshes;
}

/* ---------------- Pseudoschatten in die Bodenkarte ---------------- */

/**
 * Fuer jede Pflanze ein weicher Kreis in der gemeinsamen Bodenkarte - leicht
 * gegen die Sonne versetzt, damit er zu den Baumschatten daneben passt.
 *
 * Der Versatz ist derselbe, den der Baumgenerator in seinen Riss rechnet:
 * Hoehe des Schwerpunkts mal Tangens der Sonnenneigung, in Weltkoordinaten.
 * Genommen wird die halbe Pflanzenhoehe - die Masse des Blattwerks sitzt
 * darum herum.
 */
export function stempelPflanzenschatten(bodenkarte, stellen, modelle) {
  if (!bodenkarte) return 0;
  let n = 0;
  for (const [datei, liste] of stellen) {
    const model = modelle.get(datei);
    if (!model) continue;
    for (const s of liste) {
      // `durchmesser` aus der Beetdatei ist schon skaliert; fehlt er (alte
      // Datei), tut es der Grundriss aus der Pflanzendatei.
      const d = s.durchmesser > 0 ? s.durchmesser : model.breite * s.scale;
      const v = sonnenVersatz(model.hoehe * s.scale * 0.5);
      // Voll ausgesteuert wie jeder andere Stempel auch; abgeschwaecht wird
      // erst bei der Anwendung (`SCHATTEN_STAERKE` in `bodenkarte.js`).
      bodenkarte.setzeKreis(s.x + v.x, s.z + v.z, d);
      n++;
    }
  }
  return n;
}

/* ---------------- In den Garten setzen ---------------- */

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Eine Pflanzenart im Garten - je Sektor ein InstancedMesh.
 *
 * Die Aufteilung ist der ganze Punkt: ein einziges Netz ueber alle Beete haette
 * eine gartenweite Huellkugel, und das Sichtvolumen koennte es nie aussortieren
 * (siehe `sektoren.js`).
 */
export function buildPlantMeshes(model, stellen, sektoren) {
  const meshes = [];
  if (!stellen || !stellen.length) return meshes;

  for (const [feld, teil] of sektoren.teile(stellen)) {
    const mesh = new THREE.InstancedMesh(model.geometry, model.material, teil.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    teil.forEach((s, i) => {
      _q.setFromAxisAngle(_up, s.yaw);
      _p.set(s.x, s.y, s.z);
      _s.setScalar(s.scale);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Pflanzen werfen Schatten wie Felsen und Schilder auch - aber nur im
    // Modus „detailliert". Sie sind mit Abstand der groesste Posten im
    // Schattendurchgang; „simpel" stempelt sie stattdessen in die Bodenkarte.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `pflanzen_${model.name}_${feld}`;
    mesh.userData.geteilt = true;         // Geometrie und Material sind im Cache
    meshes.push(mesh);
  }
  return meshes;
}
