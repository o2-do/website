import * as THREE from 'three';

/**
 * Sammelplaketten: kleine Marken, die im Konfigurator von Hand gesetzt und im
 * Spiel eingesammelt werden.
 *
 * WARUM NICHT „DIESES DREIECK". Naheliegend waere, eine Plakette an ein
 * Dreieck der Wiese zu haengen. Sie ueberlebte aber keine Aenderung: das Netz
 * wird bei jedem Aufbau neu trianguliert, und schon eine andere Gitterweite
 * verschiebt jeden Index. Gespeichert wird deshalb der ORT und die NORMALE der
 * Flaeche, auf der sie sitzt - beides in Weltkoordinaten. Damit haengt sie an
 * der Landschaft und nicht an ihrer Zerlegung, liegt in der Schraeglage der
 * Stelle und findet sich auch dann wieder, wenn dort statt eines Dreiecks
 * zwoelf liegen.
 *
 * DIE NUMMER IST DIE IDENTITAET. Sie wird beim Setzen vergeben, laufend und
 * ohne Wiederverwendung; das Spiel meldet mit ihr, was eingesammelt wurde
 * (`addPlakette(nr)`). Wer eine Plakette loescht und eine neue setzt, bekommt
 * eine neue Nummer - eine eingesammelte soll nicht durch eine andere an
 * derselben Stelle wieder auftauchen.
 */

export const BREITE = 0.15;      // Kantenlaenge der Marke
export const DICKE = 0.015;
export const FASE = 0.0075;      // abgeschraegte Ecken
// Wie weit sie von der Flaeche abgehoben steht. Ohne das steckte sie zur
// Haelfte im Fels oder im Ast, auf dem sie sitzt.
const ABHEBEN = DICKE / 2 + 0.002;

/**
 * Das Achteck, ausgezogen zur Marke.
 *
 * Zwei Gruppen, damit zwei Materialien darauf passen: die Vorderseite traegt
 * das Bild, alles Uebrige die Grundfarbe. Ein einziges Netz mit zwei Gruppen
 * ist billiger als zwei Netze - die Instanzen bleiben dieselben.
 *
 * Die Marke liegt in der x/y-Ebene und blickt nach +z; gestellt wird sie
 * spaeter mit einem Quaternion aus der Flaechennormalen.
 */
export function plaketteGeometrie() {
  const h = BREITE / 2, f = FASE, d = DICKE / 2;
  // Achteck gegen den Uhrzeigersinn, beginnend rechts unten.
  const rand = [
    [h - f, -h], [h, -h + f], [h, h - f], [h - f, h],
    [-h + f, h], [-h, h - f], [-h, -h + f], [-h + f, -h],
  ];
  const pos = [], nor = [], uv = [], idx = [];
  const punkt = (x, y, z, nx, ny, nz) => {
    pos.push(x, y, z); nor.push(nx, ny, nz);
    // Die Kachelung des Bildes: der Umriss auf 0…1 abgebildet.
    uv.push((x + h) / BREITE, (y + h) / BREITE);
    return pos.length / 3 - 1;
  };

  // Vorderseite - eigene Gruppe, damit das Bild nur hierhin kommt.
  const vorn = [];
  for (const [x, y] of rand) vorn.push(punkt(x, y, d, 0, 0, 1));
  for (let i = 1; i + 1 < vorn.length; i++) idx.push(vorn[0], vorn[i], vorn[i + 1]);
  const grenzeVorn = idx.length;

  // Rueckseite, Wicklung umgekehrt.
  const hinten = [];
  for (const [x, y] of rand) hinten.push(punkt(x, y, -d, 0, 0, -1));
  for (let i = 1; i + 1 < hinten.length; i++) idx.push(hinten[0], hinten[i + 1], hinten[i]);

  // Die acht Seitenflaechen. Eigene Eckpunkte, damit die Kante scharf bleibt.
  for (let i = 0; i < rand.length; i++) {
    const [ax, ay] = rand[i], [bx, by] = rand[(i + 1) % rand.length];
    let nx = by - ay, ny = -(bx - ax);
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const a = punkt(ax, ay, d, nx, ny, 0);
    const b = punkt(bx, by, d, nx, ny, 0);
    const c = punkt(bx, by, -d, nx, ny, 0);
    const e = punkt(ax, ay, -d, nx, ny, 0);
    idx.push(a, c, b, a, e, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.addGroup(0, grenzeVorn, 0);                      // Vorderseite
  geo.addGroup(grenzeVorn, idx.length - grenzeVorn, 1); // Rueckseite und Kanten
  geo.computeBoundingSphere();
  return geo;
}

const _n = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Die Matrix einer Plakette: Ort plus Ausrichtung nach ihrer Normalen. */
export function plakettenMatrix(pl, ziel = new THREE.Matrix4()) {
  _n.set(pl.nx, pl.ny, pl.nz);
  if (_n.lengthSq() < 1e-9) _n.set(0, 1, 0);
  _n.normalize();
  _q.setFromUnitVectors(_z, _n);
  _p.set(pl.x + _n.x * ABHEBEN, pl.y + _n.y * ABHEBEN, pl.z + _n.z * ABHEBEN);
  return ziel.compose(_p, _q, _s);
}

/**
 * Alle Plaketten eines Gartens als EIN Netz.
 *
 * `bild` ist die Textur der Vorderseite. Zurueck kommt ein InstancedMesh mit
 * `userData.plaketten` - der Liste in derselben Reihenfolge, damit sich eine
 * eingesammelte Marke ueber ihren Platz wiederfinden laesst.
 */
export function bauePlaketten(liste, bild) {
  if (!liste || !liste.length) return null;
  const geo = plaketteGeometrie();
  const vorne = new THREE.MeshStandardMaterial({
    map: bild || null, color: 0xffffff, roughness: 0.45, metalness: 0.15,
  });
  const seiten = new THREE.MeshStandardMaterial({
    color: 0xeecc00, roughness: 0.45, metalness: 0.15,
  });
  const netz = new THREE.InstancedMesh(geo, [vorne, seiten], liste.length);
  netz.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  netz.name = 'plaketten';
  netz.castShadow = false;
  netz.receiveShadow = true;
  const m = new THREE.Matrix4();
  liste.forEach((pl, i) => netz.setMatrixAt(i, plakettenMatrix(pl, m)));
  netz.instanceMatrix.needsUpdate = true;
  netz.computeBoundingSphere();
  netz.userData.plaketten = liste;
  return netz;
}

// Eine eingesammelte Marke verschwindet, indem ihre Instanz auf null schrumpft
// - dieselbe Loesung wie bei den Baeumen (siehe `baumbestand.js`). Ein
// InstancedMesh kennt keine einzeln sichtbaren Instanzen.
const NIRGENDS = new THREE.Matrix4().makeScale(0, 0, 0);

export function nimmPlakette(netz, i) {
  if (!netz || i < 0 || i >= netz.count) return false;
  netz.setMatrixAt(i, NIRGENDS);
  netz.instanceMatrix.needsUpdate = true;
  const pl = netz.userData.plaketten[i];
  if (pl) pl.weg = true;
  return true;
}

/**
 * Den ganzen Stand auf einmal setzen: welche Marken eingesammelt sind und
 * welche noch stehen. Gebraucht beim Laden eines Spielstands - dort koennen
 * auch welche WIEDERKOMMEN, die in dieser Sitzung schon weg waren.
 */
export function setzePlakettenStand(netz, gesammelt) {
  if (!netz) return 0;
  const weg = new Set(gesammelt || []);
  const m = new THREE.Matrix4();
  const liste = netz.userData.plaketten;
  let offen = 0;
  liste.forEach((pl, i) => {
    pl.weg = weg.has(pl.nr);
    netz.setMatrixAt(i, pl.weg ? NIRGENDS : plakettenMatrix(pl, m));
    if (!pl.weg) offen++;
  });
  netz.instanceMatrix.needsUpdate = true;
  return offen;
}

// Wie weit die Reichweite in die Hoehe geht. GETRENNT VON DER WEITE, und das
// ist der Kern der Sache: eine Marke in den Zweigen sitzt zwei, drei Meter
// ueber dem Boden. Wuerde die Hoehe wie bisher in EINEN Abstand eingerechnet,
// waere sie schon allein durch ihre Hoehe ausser Reichweite - man stuende
// unmittelbar darunter und kaeme trotzdem nicht heran, weil der Weg nach oben
// die zweieinhalb Meter bereits aufgebraucht hat. Und naeher heran geht es
// nicht: unter dem Baum steht der Stamm, das Hindernisraster haelt einen einen
// knappen Meter davon entfernt.
//
// Nach oben grosszuegiger als nach unten - Verstecke liegen in Zweigen, nicht
// in Loechern.
const REICH_HOCH = 4.0;
const REICH_TIEF = 2.5;
// Innerhalb dieses Halbmessers gilt kein Blickkegel mehr. Wer fast senkrecht
// unter einer Marke steht, hat keine sinnvolle Richtung zu ihr: ein halber
// Schritt zur Seite drehte die waagerechte Richtung um neunzig Grad, und die
// Marke ginge an und aus, ohne dass sich der Blick geaendert haette.
const REICH_NAH = 1.2;

/**
 * WELCHE PLAKETTE IST IN REICHWEITE?
 *
 * In Reichweite heisst: waagerecht naeher als `reichweite` (2,5 m), senkrecht
 * innerhalb von `REICH_HOCH` darueber und `REICH_TIEF` darunter, und im
 * Blickfeld. Waagerecht gilt ein Kegel von `grad` zu jeder Seite, senkrecht
 * gar keine Schranke - wer eine Marke vor den Fuessen oder ueber dem Kopf hat,
 * soll sie auch dann greifen koennen, wenn er geradeaus schaut.
 *
 * WEITE UND HOEHE WERDEN GETRENNT GEMESSEN, nicht zu einem Abstand verrechnet
 * (siehe `REICH_HOCH`). Ausgewaehlt wird danach die naechste im Raum - stehen
 * eine im Gras und eine im Baum zugleich bereit, gilt die, vor der man
 * wirklich steht.
 *
 * GEMESSEN WIRD VOM STANDPUNKT, NICHT VOM AUGE. Das Auge sitzt anderthalb Meter
 * ueber dem Boden; eine Marke, die einen Meter vor den Fuessen im Gras liegt,
 * waere von dort schon 1,8 m entfernt und mit zwei Metern Reichweite kaum je zu
 * erreichen. Wer davorsteht, steht davor - deshalb zaehlt der Boden unter der
 * Kamera als Bezugspunkt. Die BLICKRICHTUNG kommt weiterhin von der Kamera.
 *
 * Zurueck kommt der Platz im Netz oder -1. Der waagerechte Kegel wird auf der
 * Grundrissebene gerechnet: die Blickrichtung der Kamera taugt dafuer nicht
 * unmittelbar, weil sie beim Hinunterschauen kippt.
 */
export function plaketteInReichweite(liste, kamera, fussY, reichweite = 2.5, grad = 60) {
  if (!liste || !liste.length) return -1;
  const p = kamera.getWorldPosition(_p);
  const y = Number.isFinite(fussY) ? fussY : p.y;
  kamera.getWorldDirection(_n);
  // Schaut jemand fast senkrecht nach oben oder unten, bleibt von der
  // Blickrichtung waagerecht nichts uebrig, was eine Richtung waere. Dann
  // entscheidet allein der Abstand.
  const bl = Math.hypot(_n.x, _n.z);
  const kegel = bl > 0.05;
  const bx = kegel ? _n.x / bl : 0, bz = kegel ? _n.z / bl : 0;
  const grenze = Math.cos((grad * Math.PI) / 180);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < liste.length; i++) {
    const pl = liste[i];
    if (pl.weg) continue;
    const dx = pl.x - p.x, dy = pl.y - y, dz = pl.z - p.z;
    if (dy > REICH_HOCH || dy < -REICH_TIEF) continue;
    const l = Math.hypot(dx, dz);
    if (l > reichweite) continue;
    const d = Math.hypot(l, dy);
    if (d >= bestD) continue;
    // Steht man so gut wie darueber oder darunter, gibt es keine brauchbare
    // waagerechte Richtung mehr - dann ist sie in Reichweite, gleich wohin
    // man schaut.
    if (kegel && l > REICH_NAH && (dx / l) * bx + (dz / l) * bz < grenze) continue;
    best = i; bestD = d;
  }
  return best;
}
