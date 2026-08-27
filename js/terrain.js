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

  // DIE GLAETTUNG, IM FREQUENZBILD.
  //
  // Gemeint ist ein Gaussfilter mit dem Radius `cfg.gelaendeGlaettung`: alles,
  // was feiner ist, verschwindet, alles Groebere bleibt. Auf einem Hoehenfeld
  // hiesse das, an jeder Stelle ein Dutzend Nachbarn abzutasten und zu mitteln
  // - und `heightAt` wird beim Aufbau hunderttausendfach gefragt.
  //
  // Es geht ohne. Das Gelaende IST eine Summe von Wellen bekannter Frequenz,
  // und ein Gaussfilter multipliziert eine Welle der Frequenz f schlicht mit
  // exp(-(2*pi*f*sigma)^2/2). Also bekommt jede Oktave einmalig ihren Faktor,
  // und die Abtastung bleibt so teuer wie vorher.
  const sigma = Math.max(0, cfg.gelaendeGlaettung || 0);
  const gewichte = [];
  for (let o = 0; o < octaves; o++) {
    const f = freq * Math.pow(2, o);
    const k = 2 * Math.PI * f * sigma;
    gewichte.push(Math.exp(-0.5 * k * k));
  }
  const fbm = makeFbm2D(makeNoise2D(rng), octaves, 2.0, 0.5, gewichte);
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
  // DER GANZE RAUSCHBEREICH WIRD GEBRAUCHT.
  //
  // Hier standen zwei Faktoren und ein Vorzeichenvergleich: was ueber der Mitte
  // des Rauschens lag, wurde auf `hoch` gestreckt, was darunter lag, auf
  // `tief`. Das hatte zwei Folgen, und beide waren schlecht.
  //
  // Die erste war eine KANTE quer ueber die ganze Wiese, entlang der Null-Linie:
  // dort sprang die Steigung im Verhaeltnis der beiden Werte, bei 9 m ueber und
  // 1 m unter Null von 13 cm je Meter auf 118. Gemessen lagen alle zweihundert
  // schaerfsten Knicke des Gelaendes innerhalb von 20 cm um die Null. Solange
  // beide Regler gleich standen, hoben die Faktoren sich auf und man sah nichts.
  //
  // Die zweite war eine LEERE. Wer `maxTiefe` klein stellte, bekam nicht etwa
  // flachere Mulden, sondern gar keine: die untere Haelfte des Rauschens - und
  // das ist die halbe Wiese - wurde auf eine Ebene zusammengedrueckt. Uebrig
  // blieb gaehnende Weite und darin ein Berg. Die Form war ja da, sie wurde
  // nur weggeschnitten.
  //
  // Beides erledigt eine einzige Gerade. Der tiefste Rauschwert kommt auf
  // -tief, der hoechste auf +hoch, alles dazwischen liegt dazwischen. Nichts
  // wird gestaucht, nichts abgeschnitten, und einen Knick kann es nicht geben,
  // weil es nur noch eine Abbildung gibt statt zweier. Die Null verschiebt sich
  // dabei: sie liegt nicht mehr in der Mitte des Rauschens, sondern dort, wo
  // das Verhaeltnis der beiden Regler sie hinlegt. Bei `maxTiefe` = 0 heisst
  // das: die Wiese steigt vom tiefsten Punkt an durchgehend an, statt auf
  // halber Flaeche eben zu liegen.
  //
  // Stehen beide Regler gleich, kommt Punkt fuer Punkt dasselbe heraus wie
  // frueher - die Gerade geht dann genau durch die Mitte.
  const spanne = Math.max(1e-6, hi - lo);
  const hub = hoch + tief;

  function heightAt(x, z) {
    const f = falloff(x, z);
    if (f <= 0) return 0;
    const u = (fbm(x * freq + ox, z * freq + oz) - lo) / spanne;
    return (u * hub - tief) * f;
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
 * Horizont: runde Scheibe mit rundem Loch, exakt in der Groesse der Wiese.
 * Kein Ueberlappen -> kein Z-Fighting, keine Naht.
 *
 * DAS LOCH WIRD PUNKT FUER PUNKT GESETZT, nicht als Bogen. `absarc` bekaeme
 * die Segmentzahl der ShapeGeometry, und die ist eine andere als die des
 * Wiesenrandes - beide Vielecke lehnen von innen am selben Kreis, das gröbere
 * laege dann innerhalb des feineren und die Scheibe schoebe sich unter die
 * Wiese. Mit `cfg.randSegmente` fallen die Ecken exakt zusammen.
 *
 * Die Wicklung ist der Aussenkontur entgegengesetzt; die Shape-Ebene wird
 * spaeter um -90 Grad um X gedreht, y wird dabei zu -z.
 */
export function buildHorizon(cfg, material, radius = cfg.horizont) {
  const h = cfg.durchmesser / 2;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);

  const hole = new THREE.Path();          // Wicklung gegenlaeufig zur Aussenkontur
  const n = cfg.randSegmente;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * h, y = -Math.sin(a) * h;
    if (i === 0) hole.moveTo(x, y); else hole.lineTo(x, y);
  }
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
 * Sie deckt alles ab, was ausserhalb des Gartenkreises liegt. Seit die Wiese
 * selbst auf dem Kreis endet, ist das nur noch der Zugang zum Tor, der ein
 * Stueck nach draussen laeuft - frueher waren es auch die vier Ecken der
 * quadratischen Wiese. Der Ausschnitt ist minimal kleiner als der Garten breit
 * ist, damit an der Rundung kein Spalt aufgeht.
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
 * DIE GRAUE UNTERLAGE.
 *
 * Wo zwei Grundflaechen aneinanderstossen - Weg an Wiese, Wiese an Wasser -,
 * bleibt trotz gemeinsamer Punkte hier und da ein Haarriss von einem
 * Bildpunkt: Rundungsfehler in der Rasterung, nicht in der Geometrie. Ganz
 * vermeiden laesst sich das nicht.
 *
 * Was man dabei SIEHT, ist die Himmelskugel: sie wird als Erstes gezeichnet,
 * ohne Tiefe zu schreiben, und liegt damit hinter allem. Unten ist sie fast
 * weiss (#ccddff), und genau das blitzt durch die Risse - hell, und deshalb
 * fallen sie auf.
 *
 * Eine Scheibe unter dem Garten nimmt ihr diesen Platz. Sie liegt tiefer als
 * die tiefste Mulde, ist also nie fuer sich zu sehen; durch einen Riss blickt
 * man aber immer nach unten, und dort steht dann Grau statt Himmel. Ein
 * Zeichenaufruf und ein paar Dutzend Dreiecke, kein Aufwand je Bild - die
 * Beleuchtung braucht sie nicht, sie soll ja nur eine Farbe sein.
 */
export function buildUnterlage(cfg, tiefe) {
  // EIN QUADRAT REICHT. Sie ist keine Flaeche, die man ansieht, sondern eine
  // Farbe hinter den Haarrissen - ihr Umriss spielt keine Rolle, solange sie
  // ueberall dahinterliegt. Vorher war sie ein Faecher aus `randSegmente`
  // Dreiecken um den Mittelpunkt; im Drahtgitter und aus der Vogelperspektive
  // sah man nichts als diese Speichen.
  const R = (cfg.durchmesser / 2) * 1.15;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-R, 0, -R, R, 0, -R, R, 0, R, -R, 0, R], 3));
  // Nach oben blickend - von unten sieht sie ohnehin niemand.
  geo.setIndex([0, 2, 1, 0, 3, 2]);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x666666 }));
  mesh.position.y = -Math.max(0.5, tiefe);
  mesh.name = 'unterlage';
  // In der Karte schaut man von oben in den Garten; dort verdeckt die Wiese
  // sie nicht ueberall, und ein grauer Teller unter dem Gelaende hilft
  // niemandem. Die Haarrisse, gegen die sie gedacht ist, sieht man nur in
  // Augenhoehe.
  mesh.userData.nurAugenhoehe = true;
  return mesh;
}

/**
 * Kasten unter dem Garten: eine senkrechte Wand rings um die Wiesenkante,
 * knapp unter ihr angesetzt und so tief, dass auch das tiefste Tal darueber
 * liegt.
 *
 * Er wird nur in der Karte gebraucht. Dort steht die Kamera bei flacher
 * Neigung fast waagerecht, und bei kraeftigem Relief sieht man dann seitlich
 * unter die Wiese - der Boden ist ein Hoehenfeld ohne Unterseite, man schaut
 * also durch ihn hindurch. Der Kasten macht ihn zu einem geschlossenen Koerper.
 *
 * Er steht auf DENSELBEN Ecken wie Wiesenrand und Horizontscheibe
 * (`cfg.randSegmente`) - vier Waende am Quadrat waeren es einmal, seit die
 * Wiese rund ist, nicht mehr.
 */
export function buildMapBox(cfg, material, tiefe) {
  const h = cfg.durchmesser / 2;
  const oben = -0.01;                       // knapp unter der Kante, kein Z-Fighting
  const unten = oben - Math.max(0.5, tiefe);

  const pos = [];
  const idx = [];
  // Reihum, damit die Aussenseite jeder Wand nach aussen zeigt
  const n = cfg.randSegmente;
  const ecken = [];
  for (let i = 0; i < n; i++) {
    const w = (i / n) * Math.PI * 2;
    ecken.push([Math.cos(w) * h, Math.sin(w) * h]);
  }
  for (let i = 0; i < n; i++) {
    const a = ecken[i], b = ecken[(i + 1) % n];
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
