import * as THREE from 'three';
import { bandPunkt } from './paths.js';

/**
 * Der Zaun um den Garten: ein Kreis, ein halbes Meter innerhalb der Kante.
 *
 * WARUM EINWAERTS. Der Garten ist ein Quadrat, das die Kartenmaske in der
 * Vogelperspektive auf einen Kreis beschneidet. Stuende der Zaun genau auf
 * dieser Kante, verschwaende er dort halb unter der Maske und liefe an den
 * Ecken ins Weisse. Ein halber Meter weiter innen steht er in der Karte als
 * geschlossener Ring knapp innerhalb des Randes - sichtbar, aber ohne Rahmen
 * zu wirken.
 *
 * ZWEI NETZE JE SEKTOR: alle Pfosten sind ein InstancedMesh, alle Querhoelzer
 * ein zweites. Ein Zaun um einen 100-m-Garten hat rund 160 Pfosten und 320
 * Querhoelzer - einzeln waeren das fast 500 Objekte.
 */

// Masse in Metern. Sie stehen hier und nicht im Formular: ein Gartenzaun ist
// ein Gartenzaun, und wer die Proportionen aendert, aendert nicht eine
// Einstellung, sondern das Bauteil.
const PFOSTEN_D = 0.10;          // Durchmesser Pfosten wie Querholz
const PFOSTEN_H = 1.00;          // Hoehe ueber Grund
const QUER_LAENGE = 2.00;        // Sollabstand zweier Pfosten
const QUER_HOEHEN = [0.45, 0.95];
// Wie tief jeder Pfosten unter den Boden reicht. Er steht auf einer Flaeche,
// die zwischen zwei Stuetzstellen gerade laeuft, das Gelaende aber nicht - und
// am Gelaender kommt hinzu, dass er auf WEGHOEHE gesetzt wird, waehrend es
// neben ihm steil abfaellt. Ohne den Fuss stuende er dort in der Luft.
const PFOSTEN_EIN = 0.20;
const SEITEN = 10;               // Umfangssegmente der Zylinder
// Kantenlaenge einer Texturkachel auf dem Holz. Die UVs werden beim Bauen
// darauf umgerechnet, damit Pfosten und Querholz dieselbe Maserung zeigen -
// eine Instanz kann ihre UVs nicht selbst skalieren.
//
// Zwei Meter und nicht ein halber: die Rindentextur ist feiner geworden, und
// bei 0,5 m lag die Maserung so dicht, dass ein Pfosten aus der Entfernung
// grau flimmerte statt hoelzern auszusehen.
const KACHEL = 2.0;
// Wie weit der Zaun innerhalb der Gartenkante steht.
export const ZAUN_EINRUECKUNG = 0.5;

/** Der Halbmesser, auf dem die Pfosten stehen. */
export function zaunRadius(cfg) {
  return Math.max(1, cfg.durchmesser / 2 - ZAUN_EINRUECKUNG);
}

/**
 * Die Pfostenstellen als geschlossener Ring, gegen den Uhrzeigersinn.
 *
 * Die Feldweite wird so aufgeteilt, dass eine ganze Zahl Felder auf den Umfang
 * geht - sonst saesse der Rest als Stummel irgendwo im Kreis. Die Querhoelzer
 * sind Sehnen und nicht Boegen; bei 2 m Feldweite auf 50 m Halbmesser weicht
 * eine Sehne einen Zentimeter von der Rundung ab, was niemand sieht.
 */
export function planZaun(cfg) {
  const r = zaunRadius(cfg);
  const felder = Math.max(8, Math.round((2 * Math.PI * r) / QUER_LAENGE));
  const punkte = [];
  for (let i = 0; i < felder; i++) {
    const a = (i / felder) * Math.PI * 2;
    punkte.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return punkte;
}

/* ---------------- Das Tor ---------------- */

// Masse des Tors, in Metern.
const TOR_SAEULE_H = 3.40;       // Hoehe der Saeulen
const TOR_SAEULE_D = 0.20;       // Schluesselweite der Sechskantsaeulen
const TOR_BRETT_H  = 0.80;       // Hoehe des Schilderbretts
const TOR_BRETT_D  = 0.05;       // Dicke
const TOR_BRETT_Y  = 2.50;       // Unterkante ueber Grund
const TOR_LUECKE   = 2;          // wie viele Zaunfelder das Tor ersetzt
// Wie viel steiler als die flachste Stelle eine noch sein darf, um bei der
// Parallelitaet mitzureden. Groesser heisst: Parallelitaet zaehlt mehr.
const TOR_FLACH_TOLERANZ = 0.20;
const TOR_SCHRIFT  = '#aa8833';

/**
 * Wo das Tor steht.
 *
 * ZWEI KRITERIEN, IN DIESER REIHENFOLGE. Erst die Flachheit: der Weg vom Tor
 * zum naechsten Weg soll ohne Steigung auskommen, sonst muesste der
 * Verbindungsweg eine Boeschung hinauf. Unter den flachsten Stellen dann die
 * parallelste - ein Tor, dessen Weg schraeg auf den Rundweg trifft, sieht aus
 * wie ein Versehen.
 *
 * Bewertet wird jede moegliche Luecke, also jedes Paar von Pfosten im Abstand
 * `TOR_LUECKE`. Zurueck kommt der Index des ERSTEN Pfostens der Luecke; die
 * Saeulen stehen auf ihm und auf dem `TOR_LUECKE` Felder weiteren, die Pfosten
 * und Querhoelzer dazwischen fallen weg.
 */
export function planTor(cfg, hf, paths) {
  if (!cfg.zaun || !paths || !paths.length) return null;
  const punkte = planZaun(cfg);
  const n = punkte.length;
  if (n < TOR_LUECKE + 3) return null;

  const kandidaten = [];
  for (let i = 0; i < n; i++) {
    const a = punkte[i], b = punkte[(i + TOR_LUECKE) % n];
    const mitte = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const weg = naechsterWegpunkt(paths, mitte);
    if (!weg) continue;

    // Flachheit: der groesste Hoehensprung je Meter auf der Strecke vom Tor
    // zum Weg. Nicht der Gesamtunterschied - eine Stufe mittendrin waere
    // schlimmer als ein gleichmaessiges Gefaelle, und genau die faellt hier auf.
    const schritte = Math.max(2, Math.round(weg.d / 0.5));
    let steilste = 0, vorher = hf.heightAt(mitte.x, mitte.z);
    for (let k = 1; k <= schritte; k++) {
      const f = k / schritte;
      const y = hf.heightAt(mitte.x + (weg.x - mitte.x) * f,
                            mitte.z + (weg.z - mitte.z) * f);
      steilste = Math.max(steilste, Math.abs(y - vorher) / (weg.d / schritte));
      vorher = y;
    }

    // Parallelitaet: die Sehne der Luecke gegen die Wegrichtung. 1 = parallel.
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const par = Math.abs(((b.x - a.x) / l) * weg.tx + ((b.z - a.z) / l) * weg.tz);

    kandidaten.push({ i, a, b, mitte, weg, steilste, par });
  }
  if (!kandidaten.length) return null;

  // Erst die flachsten heraussuchen, dann darunter die parallelste.
  //
  // `TOR_FLACH_TOLERANZ` entscheidet, wie viel Gewicht die Parallelitaet
  // bekommt: je weiter der Kreis der „noch flachen" Stellen gezogen ist, desto
  // eher gewinnt eine, die zwar etwas huegeliger liegt, an der der Weg aber
  // sauber am Zaun entlanglaeuft. Bei 0,05 gewann fast immer die flachste
  // Stelle, und das Tor sass schief zum Weg.
  const flachste = Math.min(...kandidaten.map((k) => k.steilste));
  const eng = kandidaten.filter((k) => k.steilste <= flachste + TOR_FLACH_TOLERANZ);
  eng.sort((p, q) => q.par - p.par);
  const w = eng[0];

  return {
    i: w.i, luecke: TOR_LUECKE,
    a: w.a, b: w.b, mitte: w.mitte,
    weg: w.weg,                       // naechster Punkt auf dem Rundweg
    steilste: w.steilste, parallel: w.par,
  };
}

/** Der naechste Punkt auf irgendeinem Weg, samt Richtung und Abstand. */
function naechsterWegpunkt(paths, p) {
  let best = null, bestD = Infinity;
  for (const weg of paths) {
    for (const s of weg.samples) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  return best ? { x: best.x, z: best.z, tx: best.tx, tz: best.tz, d: bestD } : null;
}

/**
 * Ein Zylinder mit Achse +Y und Texturkacheln in Metern.
 *
 * `unten` sagt, wie weit er unter den Ansatzpunkt reicht - der Fuss liegt dann
 * bei y = -unten, die Oberkante bei y = laenge - unten. Damit bleibt der
 * Ansatzpunkt die BODENHOEHE und nicht die Unterkante: wer den Pfosten setzt,
 * rechnet in sichtbarer Hoehe weiter, gleichgueltig wie tief er steckt.
 */
function pfostenGeometrie(laenge, unten = 0) {
  const g = new THREE.CylinderGeometry(PFOSTEN_D / 2, PFOSTEN_D / 2, laenge, SEITEN, 1);
  g.translate(0, laenge / 2 - unten, 0);
  kachle(g, Math.PI * PFOSTEN_D, laenge);
  return g;
}

/** Derselbe Zylinder, aber mit Achse +X und Laenge 1 - die Instanz streckt ihn. */
function querGeometrie() {
  const g = new THREE.CylinderGeometry(PFOSTEN_D / 2, PFOSTEN_D / 2, 1, SEITEN, 1);
  g.rotateZ(-Math.PI / 2);
  kachle(g, Math.PI * PFOSTEN_D, QUER_LAENGE);
  return g;
}

/**
 * Die UVs eines Zylinders auf Meter umrechnen: u laeuft einmal um den Umfang,
 * v ueber die Laenge. Ohne das zoege sich dieselbe Textur ueber einen 10 cm
 * dicken Pfosten wie ueber ein 2 m langes Querholz.
 */
function kachle(geo, umfang, laenge) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (umfang / KACHEL), uv.getY(i) * (laenge / KACHEL));
  }
  uv.needsUpdate = true;
}

const _pos = new THREE.Vector3();
const _skal = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _achse = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();

/**
 * Den Zaun bauen. Zurueck kommen die Netze - je Sektor eines fuer die Pfosten
 * und eines fuer die Querhoelzer (siehe `sektoren.js`); die Stats stehen in
 * `meshes.stats`.
 *
 * Der Ring ist geschlossen: jeder Pfosten traegt die Querhoelzer zum naechsten,
 * der letzte zum ersten zurueck.
 */
export function buildZaun(cfg, hf, textur, sektoren, tor) {
  const ecken = planZaun(cfg);
  if (!cfg.zaun || ecken.length < 3) return [];

  const n = ecken.length;
  // Die Luecke fuers Tor: die Pfosten INNERHALB der Luecke fallen weg, die
  // beiden an ihren Enden bleiben - dort stehen die Saeulen, und ohne sie
  // haenge das letzte Querholz an nichts. Genauso fallen die Querhoelzer
  // ueber die Luecke weg. Sonst laeuft der Zaun rings um den Garten.
  const wegPfosten = new Set();
  const wegQuer = new Set();
  if (tor) {
    for (let k = 1; k < tor.luecke; k++) wegPfosten.add((tor.i + k) % n);
    for (let k = 0; k < tor.luecke; k++) wegQuer.add((tor.i + k) % n);
  }

  const alle = ecken.map((p) => ({ x: p.x, y: hf.heightAt(p.x, p.z), z: p.z }));
  const pfosten = alle.filter((_, i) => !wegPfosten.has(i));
  const quer = alle
    .map((a, i) => ({ a, b: alle[(i + 1) % n], i }))
    .filter((q) => !wegQuer.has(q.i));

  const material = new THREE.MeshStandardMaterial({
    map: textur, roughness: 0.9, metalness: 0,
    wireframe: cfg.drahtgitter,
  });
  const pGeo = pfostenGeometrie(PFOSTEN_H + PFOSTEN_EIN, PFOSTEN_EIN);
  const qGeo = querGeometrie();

  const meshes = [];
  const setze = (netz, i, ort, quatern, skal) => {
    netz.setMatrixAt(i, _m.compose(ort, quatern, skal));
  };

  for (const [feld, teil] of sektoren.teile(pfosten)) {
    const netz = new THREE.InstancedMesh(pGeo, material, teil.length);
    netz.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    _quat.identity();
    _skal.set(1, 1, 1);
    teil.forEach((p, i) => setze(netz, i, _pos.set(p.x, p.y, p.z), _quat, _skal));
    netz.instanceMatrix.needsUpdate = true;
    netz.computeBoundingSphere();
    netz.castShadow = true;
    netz.receiveShadow = true;
    netz.name = `zaunpfosten_${feld}`;
    meshes.push(netz);
  }

  // Die Querhoelzer werden nach der MITTE des Feldes einsortiert - sonst
  // fiele ein Holz in einen anderen Sektor als die Pfosten, zwischen denen es
  // haengt, und an der Sektorgrenze klaffte im Bild eine Luecke.
  const querMitten = quer.map((q) => ({
    x: (q.a.x + q.b.x) / 2, z: (q.a.z + q.b.z) / 2, q,
  }));
  for (const [feld, teil] of sektoren.teile(querMitten)) {
    const netz = new THREE.InstancedMesh(qGeo, material, teil.length * QUER_HOEHEN.length);
    netz.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    let i = 0;
    for (const e of teil) {
      for (const hoehe of QUER_HOEHEN) {
        const ax = e.q.a.x, ay = e.q.a.y + hoehe, az = e.q.a.z;
        const bx = e.q.b.x, by = e.q.b.y + hoehe, bz = e.q.b.z;
        _dir.set(bx - ax, by - ay, bz - az);
        const l = _dir.length();
        _quat.setFromUnitVectors(_achse, _dir.divideScalar(l || 1));
        setze(netz, i++, _pos.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2),
              _quat, _skal.set(l, 1, 1));
      }
    }
    netz.instanceMatrix.needsUpdate = true;
    netz.computeBoundingSphere();
    netz.castShadow = true;
    netz.receiveShadow = true;
    netz.name = `zaunquer_${feld}`;
    meshes.push(netz);
  }

  meshes.stats = {
    pfosten: pfosten.length,
    quer: quer.length * QUER_HOEHEN.length,
    umfang: Math.round(quer.reduce(
      (a, q) => a + Math.hypot(q.b.x - q.a.x, q.b.z - q.a.z), 0)),
    radius: +zaunRadius(cfg).toFixed(1),
  };
  return meshes;
}

/* ---------------- Gelaender an steilen Wegen ---------------- */

// Wie weit die Pfostenmitte neben der Wegkante steht.
const GELAENDER_AB_KANTE = 0.05;
// Wo das Gefaelle gemessen wird, gerechnet ab der Wegkante. Zwei Abstaende,
// und der steilere gewinnt: dicht an der Kante hat die Boeschung den Absatz
// schon abgefangen (siehe `boeschung` in `wegnetz.js`), erst dahinter zeigt
// sich, ob es wirklich hinuntergeht.
const GELAENDER_PROBEN = [1.2, 2.4];
// Ein einzelner steiler Punkt ist noch keine Absturzkante. Erst so viele
// Stuetzstellen hintereinander ergeben ein Gelaender - bei einem halben Meter
// Abtastschritt sind das gut zwei Meter.
const GELAENDER_MIN = 5;

/**
 * WO ES NEBEN DEM WEG HINUNTERGEHT.
 *
 * Der Zaun am Gartenrand ist eine Grenze; hier ist derselbe Zaun ein Gelaender,
 * und das ist etwas anderes: es steht nicht dort, wo das Grundstueck aufhoert,
 * sondern dort, wo man fallen koennte. Solche Stellen liegen fast immer am
 * Rand des Gartens - dort laeuft das Gelaende zur Horizontscheibe hin aus, und
 * neben einem Weg, der nah daran vorbeifuehrt, bleibt kein Platz mehr fuer eine
 * Boeschung.
 *
 * Gesucht wird je Stuetzstelle und Seite, gemessen wird das Gefaelle vom
 * Wegrand nach aussen. Was zusammenhaengt, wird zu einem Lauf gebuendelt -
 * einzelne steile Punkte ergeben kein Gelaender, sondern Zaunstummel.
 *
 * Zurueck kommen Laeufe von Pfostenplaetzen; jeder Platz traegt die Hoehe der
 * WEGKANTE und nicht die des Bodens neben ihm. Ein Gelaender folgt dem Weg,
 * nicht dem Abhang.
 */
export function planeGelaender(paths, hf, cfg) {
  if (!cfg.gelaender) return [];
  const grenze = Math.tan((cfg.gelaenderAb * Math.PI) / 180);
  const laeufe = [];

  for (const p of paths) {
    const sm = p.samples;
    const halb = p.width / 2;
    for (const sgn of [-1, 1]) {
      let lauf = [];
      const schliesse = () => {
        if (lauf.length >= GELAENDER_MIN) laeufe.push(lauf);
        lauf = [];
      };
      for (let k = 0; k < sm.length; k++) {
        const c = sm[k];
        // Die Wegkante liegt auf der Hoehe der Mittellinie - der Querschnitt
        // ist waagerecht, das ist das Prinzip des ganzen Netzes.
        const yKante = hf.heightAt(c.x, c.z);
        let gefaelle = 0;
        for (const d of GELAENDER_PROBEN) {
          const px = c.x + c.nx * sgn * (halb + d);
          const pz = c.z + c.nz * sgn * (halb + d);
          gefaelle = Math.max(gefaelle, (yKante - hf.heightAt(px, pz)) / d);
        }
        if (gefaelle < grenze) { schliesse(); continue; }
        const a = bandPunkt(p, k, sgn, halb + GELAENDER_AB_KANTE, 0);
        lauf.push({ x: a.x, y: yKante, z: a.z });
      }
      schliesse();
    }
  }
  return laeufe;
}

/**
 * Die Laeufe zu Pfosten und Querhoelzern machen.
 *
 * Die Stuetzstellen stehen einen halben Meter auseinander, ein Zaunfeld ist
 * zwei Meter - es wird also jede vierte genommen, und das letzte Feld darf
 * kuerzer ausfallen. Ein Gelaender endet dort, wo der Abhang endet, und nicht
 * dort, wo das Raster gerade passt.
 *
 * OHNE RUECKSICHT AUF DAS UEBRIGE. Es steht, wo es hingehoert; ob dort schon
 * ein Grasbueschel oder ein Fels steht, ist ihm gleich. Ein Gelaender, das an
 * einer Absturzkante aussetzt, weil zufaellig ein Stein im Weg lag, waere die
 * schlechtere Loesung.
 */
export function buildGelaender(laeufe, cfg, textur, sektoren) {
  if (!laeufe.length) return [];
  const material = new THREE.MeshStandardMaterial({
    map: textur, roughness: 0.9, metalness: 0,
    wireframe: cfg.drahtgitter,
  });
  const pGeo = pfostenGeometrie(PFOSTEN_H + PFOSTEN_EIN, PFOSTEN_EIN);
  const qGeo = querGeometrie();

  const pfosten = [];
  const quer = [];
  for (const lauf of laeufe) {
    // Jede vierte Stuetzstelle, das Ende immer.
    const stellen = [];
    for (let k = 0; k < lauf.length; k += 4) stellen.push(lauf[k]);
    const letzt = lauf[lauf.length - 1];
    const vorher = stellen[stellen.length - 1];
    if (Math.hypot(letzt.x - vorher.x, letzt.z - vorher.z) > 0.6) stellen.push(letzt);
    else stellen[stellen.length - 1] = letzt;
    if (stellen.length < 2) continue;
    pfosten.push(...stellen);
    for (let k = 0; k + 1 < stellen.length; k++) {
      const a = stellen[k], b = stellen[k + 1];
      quer.push({ a, b, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
    }
  }
  if (!pfosten.length) return [];

  const meshes = [];
  for (const [feld, teil] of sektoren.teile(pfosten)) {
    const netz = new THREE.InstancedMesh(pGeo, material, teil.length);
    netz.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    _quat.identity();
    _skal.set(1, 1, 1);
    teil.forEach((p, i) => netz.setMatrixAt(i, _m.compose(_pos.set(p.x, p.y, p.z), _quat, _skal)));
    netz.instanceMatrix.needsUpdate = true;
    netz.computeBoundingSphere();
    netz.castShadow = true;
    netz.receiveShadow = true;
    netz.name = `gelaenderpfosten_${feld}`;
    meshes.push(netz);
  }
  for (const [feld, teil] of sektoren.teile(quer)) {
    const netz = new THREE.InstancedMesh(qGeo, material, teil.length * QUER_HOEHEN.length);
    netz.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    let i = 0;
    for (const e of teil) {
      for (const hoehe of QUER_HOEHEN) {
        const ax = e.a.x, ay = e.a.y + hoehe, az = e.a.z;
        const bx = e.b.x, by = e.b.y + hoehe, bz = e.b.z;
        _dir.set(bx - ax, by - ay, bz - az);
        const l = _dir.length();
        _quat.setFromUnitVectors(_achse, _dir.divideScalar(l || 1));
        netz.setMatrixAt(i++, _m.compose(
          _pos.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _quat, _skal.set(l, 1, 1)));
      }
    }
    netz.instanceMatrix.needsUpdate = true;
    netz.computeBoundingSphere();
    netz.castShadow = true;
    netz.receiveShadow = true;
    netz.name = `gelaenderquer_${feld}`;
    meshes.push(netz);
  }
  meshes.stats = {
    laeufe: laeufe.length, pfosten: pfosten.length,
    quer: quer.length * QUER_HOEHEN.length,
    laenge: Math.round(quer.reduce((a, q) => a + Math.hypot(q.b.x - q.a.x, q.b.z - q.a.z), 0)),
  };
  return meshes;
}

/* ---------------- Die Schwelle im Tor ---------------- */

// Masse in Metern.
const BORD_H = 0.02;              // was ueber dem Boden steht
const BORD_B = 0.15;              // Breite quer zum Durchgang
// Wie tief die Wangen unter den Boden reichen. Zwischen den beiden Saeulen
// liegt die Schwelle gerade, das Gelaende nicht; ohne den Fuss klaffte auf
// einer Woelbung ein Spalt darunter.
const BORD_FUSS = 0.15;
// Kantenlaenge einer Texturkachel auf dem Stein, in Metern.
const BORD_KACHEL = 1.5;

/**
 * DIE SCHWELLE ZWISCHEN DEN TORSAEULEN.
 *
 * Die Schwelle läuft quer zum Weg und reicht von einer Tor-säule zur anderen,
 * um die Stoßkante zwischen dem Weg außerhalb des Gartens und innerhalb des
 * Gartens zu verdecken. (Entfernt)
 */
export function buildBordstein(cfg, hf, textur, sektoren, tor) {
  
}

/* ---------------- Das Tor bauen ---------------- */

/**
 * Zwei Sechskantsaeulen mit einem Schilderbrett dazwischen.
 *
 * Die Saeulen stehen dort, wo sonst die beiden Zaunpfosten am Rand der Luecke
 * staenden - das Tor setzt den Zaun also fort, statt daneben zu stehen. Das
 * Brett reicht von Saeulenmitte zu Saeulenmitte; seine Enden verschwinden
 * dadurch im Holz und muessen nicht sauber anschliessen.
 *
 * DIE SCHRIFT STEHT AUF EINER LEINWAND, nicht in der Geometrie. Der Untergrund
 * ist dieselbe Maserung wie ringsum, darueber der Zug in einer Farbe - das
 * liest sich wie gemalt und kostet eine Textur je Seite. Welche Seite welchen
 * Text traegt, entscheidet die Blickrichtung zur Gartenmitte: von aussen liest
 * man „Eingang", von innen „Ausgang".
 */
export function buildTor(cfg, hf, textur, tor) {
  if (!tor) return [];
  const A = { x: tor.a.x, z: tor.a.z, y: hf.heightAt(tor.a.x, tor.a.z) };
  const B = { x: tor.b.x, z: tor.b.z, y: hf.heightAt(tor.b.x, tor.b.z) };
  const laenge = Math.hypot(B.x - A.x, B.z - A.z);
  if (laenge < 0.5) return [];

  const gruppe = new THREE.Group();
  gruppe.name = 'tor';

  // --- Saeulen ---------------------------------------------------------
  // Sechskant heisst: ein Zylinder mit sechs Umfangssegmenten. Der Radius
  // eines regelmaessigen Sechsecks ist seine Schluesselweite geteilt durch
  // die Wurzel aus drei - so misst die Saeule ueber die Flaechen wirklich
  // TOR_SAEULE_D.
  const rSechs = TOR_SAEULE_D / Math.sqrt(3);
  const saeuleGeo = new THREE.CylinderGeometry(rSechs, rSechs, TOR_SAEULE_H, 6, 1, false);
  saeuleGeo.translate(0, TOR_SAEULE_H / 2, 0);
  // Rings um die Saeule reicht die Kachel ein halbes Mal; senkrecht so oft,
  // dass die Maserung nicht gestaucht wird.
  const umfang = 6 * rSechs;
  kachleFrei(saeuleGeo, 0.5, TOR_SAEULE_H / (umfang / 0.5));

  const holzMat = new THREE.MeshStandardMaterial({
    map: textur, roughness: 0.9, metalness: 0, wireframe: cfg.drahtgitter,
  });
  for (const p of [A, B]) {
    const m = new THREE.Mesh(saeuleGeo, holzMat);
    m.position.set(p.x, p.y, p.z);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'torsaeule';
    gruppe.add(m);
  }

  // --- Brett -----------------------------------------------------------
  const brettGeo = new THREE.BoxGeometry(laenge, TOR_BRETT_H, TOR_BRETT_D);
  // Die schmale Ober- und Unterseite bekommt dieselbe Maserung, aber um 90
  // Grad gedreht und einmal ueber die Brettbreite - laengs sieht sie sonst
  // aus, als waere das Brett quer aus dem Stamm geschnitten.
  const schmalTex = textur.clone();
  schmalTex.needsUpdate = true;
  schmalTex.wrapS = schmalTex.wrapT = THREE.RepeatWrapping;
  schmalTex.center.set(0.5, 0.5);
  schmalTex.rotation = Math.PI / 2;
  schmalTex.repeat.set(1 / TOR_BRETT_H, 1 / TOR_BRETT_H);
  const schmalMat = new THREE.MeshStandardMaterial({
    map: schmalTex, roughness: 0.9, metalness: 0, wireframe: cfg.drahtgitter,
  });

  // Das Brett liegt in seiner eigenen x-Achse, +z ist die Vorderseite. Eine
  // Drehung um die Hochachse bildet lokales +x auf (cos, 0, -sin) ab und
  // lokales +z auf (sin, 0, cos) - der Winkel ist deshalb `atan2(-dz, dx)`
  // und nicht `atan2(dx, dz)`. Mit dem falschen stand das Brett quer zwischen
  // den Saeulen und war von vorn nur ein Strich.
  const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
  const gier = Math.atan2(-(B.z - A.z), B.x - A.x);
  // Welche Seite nach draussen zeigt: die, deren Normale von der Gartenmitte
  // wegweist.
  const vz = { x: Math.sin(gier), z: Math.cos(gier) };
  const nachAussen = vz.x * mx + vz.z * mz > 0;

  const vorne = schildMaterial(textur, nachAussen ? 'Eingang' : 'Ausgang',
                               laenge, cfg.drahtgitter);
  const hinten = schildMaterial(textur, nachAussen ? 'Ausgang' : 'Eingang',
                                laenge, cfg.drahtgitter);
  //                px         nx         py         ny         pz      nz
  const brett = new THREE.Mesh(brettGeo,
    [holzMat, holzMat, schmalMat, schmalMat, vorne, hinten]);
  brett.position.set(mx, Math.max(A.y, B.y) + TOR_BRETT_Y + TOR_BRETT_H / 2, mz);
  brett.rotation.y = gier;
  brett.castShadow = true;
  brett.receiveShadow = true;
  brett.name = 'torbrett';
  gruppe.add(brett);

  gruppe.userData.stats = {
    laenge: +laenge.toFixed(2),
    steilste: +tor.steilste.toFixed(3),
    parallel: +tor.parallel.toFixed(2),
  };
  return [gruppe];
}

/**
 * UVs eines Zylinders frei skalieren - `kachle` rechnet in Metern, hier sind
 * die Vielfachen direkt gemeint.
 */
function kachleFrei(geo, u, v) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  uv.needsUpdate = true;
}

/**
 * Eine Brettseite mit Aufschrift: die Maserung als Untergrund, darueber der
 * Zug. Die Leinwand hat das Seitenverhaeltnis des Bretts, damit die Schrift
 * nicht gestaucht wird.
 */
function schildMaterial(textur, text, laenge, drahtgitter) {
  const PX = 256;                               // Bildpunkte je Meter
  const w = Math.max(64, Math.round(laenge * PX));
  const h = Math.max(32, Math.round(TOR_BRETT_H * PX));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');

  // Untergrund: dieselbe Maserung wie das uebrige Holz, in derselben
  // Kachelgroesse wie am Zaun. Fehlt das Bild noch, bleibt es beim Braun.
  ctx.fillStyle = '#6b5334';
  ctx.fillRect(0, 0, w, h);
  const bild = textur && textur.image;
  if (bild && bild.width) {
    // Jede Kachel um 90 Grad gedreht: die Maserung laeuft dadurch quer zum
    // Brett statt laengs, wie bei einem Schild, das aus dem Stamm geschnitten
    // wurde. Gedreht wird je Kachel und nicht die ganze Leinwand - die Kacheln
    // sind quadratisch, sie liegen danach also genauso buendig wie vorher.
    const kachel = KACHEL * PX;
    for (let y = 0; y < h; y += kachel) {
      for (let x = 0; x < w; x += kachel) {
        ctx.save();
        ctx.translate(x + kachel / 2, y + kachel / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(bild, -kachel / 2, -kachel / 2, kachel, kachel);
        ctx.restore();
      }
    }
  }

  ctx.font = `600 ${Math.round(h * 0.55)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = TOR_SCHRIFT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.9, metalness: 0, wireframe: drahtgitter,
  });
}
