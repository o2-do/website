import * as THREE from 'three';
import { frisch } from './frisch.js';
import {
  normiere, baueSkelett, baueHolz, baueBillboards, ladeBillboardSatz, holzMaterial,
  ansichtTafeln, leereBillboardCache, leereHolzCache, laubtoene,
  SONNE_AZIMUT, SONNE_NEIGUNG,
} from '../baumloader/baum-import.js';

export { laubtoene };

/**
 * Bruecke zum neuen Baumgenerator (`baumloader/baum-import.js`).
 *
 * WAS EIN BAUM JETZT IST. Zwei Netze und sonst nichts: ein Holznetz (Roehren
 * mit Rindentextur) und ein Laubnetz aus Rechtecken, die der Vertexshader zur
 * Kamera dreht. Zusammen ein paar tausend Dreiecke statt der zig tausend
 * Einzelblaetter von frueher - deshalb sind alle Detailstufen, Puschel,
 * Impostoren und Stellvertreter ersatzlos entfallen. Der Baum wird gezeichnet,
 * wie er ist.
 *
 * WAS DIE BAUMDATEI MITBRINGT. Sie ist vollstaendig: Rinde und Blattbilder
 * stecken als Datenadressen darin, dazu drei fertig gerechnete Bilder unter
 * `paket`:
 *
 *   schatten        Grundriss der Krone, zum Brennen in die Bodenkarte
 *                   (siehe `bodenkarte.js`)
 *   schattenkarte   Silhouette zur Sonne, als unsichtbare Flaeche aufgehaengt -
 *                   sie wirft echten Schatten fuer den ganzen Baum, kostet im
 *                   Schattendurchgang aber nur zwei Dreiecke
 *   ansicht         Seitenansicht als Tafel fuer die Ferne
 *
 * Ein `img/`-Ordner wird also nicht gebraucht; `basis` ist nur der Notweg fuer
 * Dateien, die vor dieser Erweiterung geschrieben wurden.
 *
 * MASSE: der Generator rechnet in Metern, y nach oben, Grasnarbe bei y = 0; der
 * Stamm laeuft von dort noch 10 cm nach unten (STAMM_UNTER_NULL) und deckt
 * damit die Neigung des Gelaendes ab. Der Garten rechnet genauso - ein Baum
 * wird schlicht nach (x, hf.heightAt(x,z), z) verschoben. Frei sind Drehung um
 * die Hochachse und gleichmaessige Groesse.
 *
 * SONNE: die drei Bilder im Paket sind fuer einen festen Sonnenstand gerechnet
 * (Suedost, 20 Grad aus der Senkrechten). Wer sie benutzt, muss die Sonne der
 * Szene dorthin stellen - `sonnenRichtung()` liefert sie.
 */

/* ---------------- Sonnenstand ---------------- */

/**
 * Die Richtung ZUR Sonne, wie sie die Bilder im Paket voraussetzen. In three
 * ist +x Osten und +z Sueden; der Azimut zaehlt von Norden ueber Osten.
 *
 * Das ist keine Geschmacksfrage: der Schattenversatz im Grundriss und die
 * Neigung der Schattenkarte stehen fertig in der Datei. Steht die Sonne der
 * Szene woanders, faellt der gebrannte Schatten in die eine und der geworfene
 * in die andere Richtung.
 */
export function sonnenRichtung() {
  const az = SONNE_AZIMUT * Math.PI / 180;
  const t = Math.tan(SONNE_NEIGUNG * Math.PI / 180);
  return new THREE.Vector3(Math.sin(az) * t, 1, -Math.cos(az) * t).normalize();
}

/**
 * Der Versatz eines Schattens gegenueber dem Ding, das ihn wirft - fuer eine
 * Sache in `hoehe` Metern ueber dem Boden, in Weltkoordinaten.
 *
 * Dieselbe Rechnung, die der Baumgenerator in seinen Grundriss legt
 * (`versatzX`/`versatzZ`): Hoehe mal Tangens der Sonnenneigung, in die
 * Gegenrichtung der Sonne. Wer einen Pseudoschatten in die Bodenkarte stempelt
 * - eine Pflanze etwa -, bekommt ihn damit an dieselbe Stelle, an der der
 * gerechnete Riss eines Baums daneben liegt.
 */
export function sonnenVersatz(hoehe) {
  const az = SONNE_AZIMUT * Math.PI / 180;
  const d = -Math.max(0, hoehe) * Math.tan(SONNE_NEIGUNG * Math.PI / 180);
  return { x: d * Math.sin(az), z: -d * Math.cos(az) };
}

/* ---------------- Namensliste ---------------- */

/**
 * Liste aus Namen und Baumdateien. Erlaubt sind
 *   { baeume: [ { name, baum }, … ], standard: "baum.json" }
 *   { baeume: […], standard: ["baum.json", "baum_gross.json"] }
 * und die blosse Liste [ { name, baum }, … ].
 *
 * `standard` darf mehrere Dateien nennen; die namenlosen Plaetze werden dann
 * zufaellig - aber ueber den Startwert reproduzierbar - daraus besetzt.
 *
 * Ein Eintrag darf zusaetzlich `ton` tragen: die Tönung seiner Blätter, als
 * `#rrggbb` oder als [r, g, b] um 1.0 herum. Damit steht ein benannter Baum
 * auch farblich fuer sich, ohne dass es eine zweite Baumdatei braucht.
 */
export function parseTreeList(data) {
  const roh = Array.isArray(data) ? data : (data && data.baeume) || [];
  const baeume = roh
    .map((e) => ({
      name: String(e.name ?? '').trim(),
      baum: String(e.baum ?? '').trim(),
      ton: leseTon(e.ton),
    }))
    .filter((e) => e.name && e.baum);

  const s = (!Array.isArray(data) && data && data.standard) || 'baum.json';
  const standard = (Array.isArray(s) ? s : [s])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);

  // Der ganze Pflanzenvorrat und die Beetvorlagen. Wie viele Arten davon
  // gebaut werden, entscheidet das Formular - hier steht nur, was zur
  // Verfuegung steht.
  const liste = (feld) => {
    const v = (!Array.isArray(data) && data && data[feld]) || [];
    return (Array.isArray(v) ? v : [v]).map((x) => String(x ?? '').trim()).filter(Boolean);
  };

  return {
    baeume,
    standard: standard.length ? standard : ['baum.json'],
    pflanzen: liste('pflanzen'),
    beete: liste('beete'),
  };
}

/** `#rrggbb`, `[r,g,b]` oder nichts. Zurueck kommt ein THREE.Color oder null. */
function leseTon(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length === 3) return new THREE.Color().setRGB(+v[0], +v[1], +v[2]);
  if (typeof v === 'string') { try { return new THREE.Color(v); } catch { return null; } }
  return null;
}

export async function fetchTreeList(url) {
  const r = await fetch(frisch(url), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`„${url}“ liess sich nicht laden (${r.status}).`);
  return parseTreeList(await r.json());
}

/* ---------------- Bauplaene ---------------- */

/**
 * Ein Bauplan ist alles, was an einer Baumsorte EINMAL gerechnet wird:
 * Skelett, Holzgeometrie, Laubgeometrie, die beiden Materialien und das Paket.
 * Wie viele Baeume daraus werden, steht darin nicht - das entscheidet erst
 * `baueWald()`.
 *
 * Der Schnitt liegt genau hier, weil das Skelett der teure Teil ist (einige
 * hundert Millisekunden) und die Instanzen der billige. Ein Neuaufbau des
 * Gartens mit anderer Baumzahl kostet deshalb nichts mehr.
 */
const plaene = new Map();

export async function ladeBauplan(datei) {
  if (plaene.has(datei)) return plaene.get(datei);
  const p = baueBauplan(datei);
  plaene.set(datei, p);          // das Versprechen cachen, nicht das Ergebnis:
  return p;                      // zwei Anfragen zugleich sollen einen Baum bauen
}

async function baueBauplan(datei) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(datei) || datei.includes('/')
    ? datei : `json/${/\.json$/i.test(datei) ? datei : `${datei}.json`}`;
  const antwort = await fetch(frisch(url), { cache: 'no-cache' });
  if (!antwort.ok) throw new Error(`Baum „${datei}“ liess sich nicht laden (${antwort.status}).`);
  const cfg = normiere(await antwort.json());

  // Der Notweg fuer Dateien ohne Paket: img/ liegt eine Ebene ueber json/.
  const teile = url.split('?')[0].split('/');
  teile.pop();
  if (teile[teile.length - 1] === 'json') teile.pop();
  const basis = teile.length ? `${teile.join('/')}/` : './';

  const skel = baueSkelett(cfg);
  const holzGeo = baueHolz(skel);
  const holzMat = holzMaterial(cfg, basis);

  const satz = await ladeBillboardSatz(cfg, basis);
  let laubGeo = null, laubMat = null;
  if (satz) {
    const netz = baueBillboards(skel, cfg, satz);
    laubGeo = netz.geometry;
    laubMat = satz.materialInstanz;
  }

  const paket = cfg.paket || {};
  const fehlt = ['schatten', 'schattenkarte', 'ansicht'].filter((k) => !paket[k]);
  if (fehlt.length) {
    console.warn(`Baum „${datei}“: im Paket fehlt ${fehlt.join(', ')}. `
      + 'Die Datei ist vor dieser Erweiterung geschrieben worden; ein neuer '
      + 'Export aus dem Baumgenerator bringt die Bilder mit.');
  }

  return {
    datei, name: cfg.name || datei.replace(/\.json$/i, ''),
    cfg, skel, holzGeo, holzMat, laubGeo, laubMat, paket,
    stammRadius: skel.stats.stammD / 2,
    hoehe: skel.stats.hoehe,
    kroneR: skel.stats.kronenR,
    billboards: skel.stats.billboards,
    dreiecke: holzGeo.index.count / 3 + (laubGeo ? laubGeo.index.count / 3 : 0),
  };
}

/**
 * Alles freigeben. Noetig, bevor eine geaenderte Baumdatei neu gelesen wird -
 * sonst liefert der Cache den alten Baum.
 */
export function clearTreeCache() {
  for (const p of plaene.values()) {
    p.then((b) => {
      b.holzGeo.dispose();
      if (b.laubGeo) b.laubGeo.dispose();
    }).catch(() => {});
  }
  plaene.clear();
  leereBillboardCache();
  leereHolzCache();
  for (const t of werferCache.values()) { t.geo.dispose(); t.mat.dispose(); t.tex.dispose(); }
  werferCache.clear();
  for (const p of tafelCache.values()) {
    p.then((x) => {
      if (!x) return;
      x.geometry.dispose();
      if (x.material.map) x.material.map.dispose();
      x.material.dispose();
    }).catch(() => {});
  }
  tafelCache.clear();
}

/* ---------------- Aus einem Bauplan viele Baeume ---------------- */

/**
 * Eine Baumsorte an `anzahl` Stellen, als zwei InstancedMesh. Zwei
 * Zeichenaufrufe fuer den ganzen Bestand einer Sorte, gleichgueltig wie viele
 * Baeume darin stehen.
 *
 * Gesetzt wird ueber `setze(i, matrix)`, getoent ueber `faerbe(i, farbe)`, und
 * `fertig()` einmal am Ende. Der Stamm bleibt ungetoent: das Blattwerk soll
 * sich von Baum zu Baum unterscheiden, die Rinde nicht.
 *
 * Schatten wirft hier nichts. Er kommt entweder aus der Schattenkarte
 * (`baueWerfer`) oder aus der Bodenkarte - beides kostet ein Vielfaches
 * weniger als Krone und Geaest im Schattendurchgang.
 */
export function baueWald(plan, anzahl) {
  const n = Math.max(1, Math.round(anzahl));
  const grp = new THREE.Group();
  grp.name = `baeume_${plan.name}`;

  const holz = new THREE.InstancedMesh(plan.holzGeo, plan.holzMat, n);
  holz.name = 'holz';
  holz.castShadow = false;
  holz.receiveShadow = true;
  // Geometrie und Material gehoeren dem Bauplan und ueberdauern den Garten;
  // nur die Instanzpuffer sind seine. `disposeGarden` liest das so: dispose()
  // auf dem Netz, Finger weg von Geometrie und Material.
  holz.userData.geteilt = true;
  grp.add(holz);

  let laub = null;
  if (plan.laubGeo) {
    laub = new THREE.InstancedMesh(plan.laubGeo, plan.laubMat, n);
    laub.name = 'laub';
    laub.castShadow = false;
    laub.receiveShadow = false;
    laub.userData.geteilt = true;
    grp.add(laub);
  }

  // Jede Instanz bekommt von vornherein eine Toenung. Ohne das gaebe es das
  // Attribut instanceColor gar nicht, und der Shader laese Nullen - die Krone
  // bliebe schwarz, bis der Aufrufer zufaellig faerbe() benutzt.
  const weiss = new THREE.Color(1, 1, 1);
  const leer = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    holz.setMatrixAt(i, leer);
    if (laub) { laub.setMatrixAt(i, leer); laub.setColorAt(i, weiss); }
  }

  grp.setze = (i, m) => { holz.setMatrixAt(i, m); if (laub) laub.setMatrixAt(i, m); };
  grp.faerbe = (i, farbe) => { if (laub) laub.setColorAt(i, farbe); };
  grp.fertig = () => {
    holz.instanceMatrix.needsUpdate = true;
    holz.computeBoundingSphere();
    if (laub) {
      laub.instanceMatrix.needsUpdate = true;
      if (laub.instanceColor) laub.instanceColor.needsUpdate = true;
      // Die Huellkugel muss ueber die Instanzen gehen, nicht ueber die
      // Geometrie: die liegt im Baumkoordinatensystem, also um den Ursprung
      // des Gartens. Wer sie unbesehen uebernimmt, laesst das Sichtvolumen
      // jede Krone wegschneiden, die nicht zufaellig in der Gartenmitte steht -
      // und man sieht zwoelf kahle Geruste.
      //
      // Was die Rechtecke im Shader an Ausdehnung zulegen, steckt in
      // `geometry.boundingSphere` schon drin; computeBoundingSphere setzt
      // genau die je Instanz um.
      laub.computeBoundingSphere();
    }
  };
  grp.fertig();
  return grp;
}

/* ---------------- Der unsichtbare Schattenwerfer ---------------- */

/**
 * Eine Leinwand je Baum, senkrecht auf dem Sonnenstrahl, in der Kronenmitte
 * aufgehaengt. Fuer die Kamera unsichtbar, fuer das Licht nicht - und sie
 * dreht sich NICHT mit dem Baum mit, denn die Sonne tut es auch nicht.
 *
 * Alle zusammen sind ein InstancedMesh: ein Zeichenaufruf im Schattendurchgang
 * fuer den ganzen Bestand einer Sorte, statt Holz und Laub jedes Baums.
 *
 * `setze(i, x, y, z, groesse)` haengt die Karte ueber den Baumfuss; die
 * Drehung des Baums geht dabei nicht ein.
 */
const werferCache = new Map();

export function baueWerfer(plan, anzahl) {
  const k = plan.paket.schattenkarte;
  if (!k || !k.bild) return null;
  const n = Math.max(1, Math.round(anzahl));

  let teile = werferCache.get(plan.datei);
  if (!teile) {
    const tex = new THREE.TextureLoader().load(k.bild);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    teile = {
      geo: new THREE.PlaneGeometry(k.breite, k.breite),
      mat: new THREE.MeshBasicMaterial({
        // Der Riss steht als Deckung im Bild: hell heisst Schatten. Genau das
        // braucht der Alphatest, um die Loecher im Laub durchzustanzen.
        alphaMap: tex, alphaTest: 0.35, transparent: false,
        side: THREE.DoubleSide,              // einseitig wirft sie nichts
        colorWrite: false, depthWrite: false,
      }),
      tex,
    };
    werferCache.set(plan.datei, teile);
  }
  const netz = new THREE.InstancedMesh(teile.geo, teile.mat, n);
  netz.name = `schattenkarten_${plan.name}`;
  netz.userData.geteilt = true;
  netz.castShadow = true;
  netz.receiveShadow = false;
  netz.frustumCulled = false;

  // Die Ebene liegt in xy und schaut nach +z; sie muss zur Sonne zeigen.
  const nach = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(k.normale.x, k.normale.y, k.normale.z));
  const ort = new THREE.Vector3();
  const gr = new THREE.Vector3();
  const m = new THREE.Matrix4();

  netz.setze = (i, x, y, z, groesse) => {
    ort.set(x + k.mitte.x * groesse, y + k.mitte.y * groesse, z + k.mitte.z * groesse);
    gr.setScalar(groesse);
    netz.setMatrixAt(i, m.compose(ort, nach, gr));
  };
  netz.fertig = () => { netz.instanceMatrix.needsUpdate = true; };
  return netz;
}

/* ---------------- Die Tafel fuer die Ferne ---------------- */

// Das Bild wird einmal je Baumsorte zur Textur gemacht; jeder weitere Bestand
// derselben Sorte bekommt dieselbe.
const tafelCache = new Map();

/**
 * Die Seitenansicht als Tafelfeld. Ein Zeichenaufruf und zwei Dreiecke je Baum;
 * aufgespannt wird das Rechteck im Blickraum, es steht also immer zur Kamera.
 *
 * `setze(i, x, y, z, groesse)` setzt sie ueber den Baumfuss. Wer eine Tafel
 * verschwinden lassen will, gibt ihr keine Ausdehnung - ein InstancedMesh
 * kennt keine einzeln sichtbaren Instanzen, aber die Grafikkarte verwirft eine
 * auf null skalierte, ehe ein Bildpunkt entsteht.
 */
export async function baueTafeln(plan, anzahl) {
  const a = plan.paket.ansicht;
  if (!a || !a.bild) return null;
  const n = Math.max(1, Math.round(anzahl));

  let p = tafelCache.get(plan.datei);
  if (!p) { p = ansichtTafeln(a, 1); tafelCache.set(plan.datei, p); }
  const vorlage = await p;
  if (!vorlage) return null;

  const netz = new THREE.InstancedMesh(vorlage.geometry, vorlage.material, n);
  netz.name = `tafeln_${plan.name}`;
  netz.frustumCulled = false;          // die Tafel entsteht erst im Shader
  netz.castShadow = netz.receiveShadow = false;
  netz.userData.geteilt = true;

  const ort = new THREE.Vector3();
  const gr = new THREE.Vector3();
  const dreh = new THREE.Quaternion();   // ohne Wirkung, die Tafel dreht sich selbst
  const m = new THREE.Matrix4();

  netz.setze = (i, x, y, z, groesse) => {
    ort.set(x, y + a.mitteY * groesse, z);
    gr.setScalar(groesse);
    netz.setMatrixAt(i, m.compose(ort, dreh, gr));
  };
  // Dieselbe Toenung wie die Krone. Ohne sie spraenge die Farbe eines Baums
  // beim Wechsel - der Stamm bekommt sie hier mit ab, was auf zwanzig Meter
  // niemand sieht.
  netz.faerbe = (i, farbe) => netz.setColorAt(i, farbe);
  netz.fertig = () => {
    netz.instanceMatrix.needsUpdate = true;
    if (netz.instanceColor) netz.instanceColor.needsUpdate = true;
  };
  return netz;
}
