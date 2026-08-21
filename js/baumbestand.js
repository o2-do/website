import * as THREE from 'three';
import { stream } from './rng.js';
import { ladeBauplan, baueWald, baueWerfer, baueTafeln, laubtoene } from './baumloader.js';
import { ladeMaske } from './bodenkarte.js';

/**
 * Der Baumbestand eines Gartens: alle Baeume aller Sorten, ihre Schatten und
 * ihre Fernansicht.
 *
 * DREI DINGE JE SORTE, und alle drei sind ein einziges InstancedMesh:
 *
 *   Wald      Holz und Laub - der Baum, wie er ist. Zwei Zeichenaufrufe.
 *   Werfer    Unsichtbare Flaechen quer zum Sonnenstrahl. Sie werfen den
 *             echten Schatten des ganzen Baums und kosten im
 *             Schattendurchgang zwei Dreiecke statt der ganzen Krone.
 *   Tafeln    Die gebackene Seitenansicht. Sie tritt in der Ferne an die
 *             Stelle des Baums; ein Rechteck statt zweier Netze.
 *
 * DIE FERNE IST EINE SACHE DER ANSICHT, NICHT DES BAUMS. Die Tafel ist fuer
 * die Laufperspektive gerechnet, in der zwanzig Meter weit sind. Aus der
 * Vogelperspektive schaut man ihr von oben auf die flache Seite - dort stehen
 * deshalb immer die echten Baeume.
 *
 * SCHATTEN FOLGT DER EINSTELLUNG DER SZENE, und die kennt drei Stufen:
 *
 *   'detailliert'  Der Werfer ist sichtbar und wirft echt - er folgt damit dem
 *                  Gelaende und dem Weg. Braucht den Schattendurchgang.
 *   'simpel'       Der Grundriss der Krone steht in der Bodenkarte
 *                  (`bodenkarte.js`), der Werfer ist aus. Kostet nach dem
 *                  Aufbau nichts; dafuer ist der Stempel flach und starr.
 *   'aus'          Weder noch.
 */

/** Alle Baumdateien der Liste einmal bauen. Der Bauplan-Cache traegt sie. */
export async function ladeBauplaene(liste, onProgress = () => {}) {
  const plaene = new Map();
  const dateien = new Set([...liste.standard, ...liste.baeume.map((e) => e.baum)]);
  for (const datei of dateien) {
    onProgress(datei);
    plaene.set(datei, await ladeBauplan(datei));
  }
  return plaene;
}

/**
 * Die Baumplaetze besetzen und den ganzen Bestand bauen.
 *
 * `trunks` sind die geplanten Standorte (siehe `trees.js`), `plaene` die
 * geladenen Bauplaene. Die ersten Plaetze bekommen die benannten Baeume aus der
 * Namensliste, alle uebrigen einen Standardbaum.
 *
 * Drehung, Groesse, Sorte und Toenung werden je Platz in fester Reihenfolge
 * gezogen - nicht erst beim Gruppieren nach Sorte. Sonst haenge die Zufallsfolge
 * davon ab, wie viele Baeume welcher Sorte zufaellig herauskamen, und derselbe
 * Startwert lieferte je nach Liste einen anderen Garten.
 */
export async function baueBestand(cfg, liste, plaene, trunks, bodenkarte) {
  const rng = stream(cfg._seed, 'baum-verteilung');
  // Die Grenze zur Tafel steht hier und nicht in `cfg`: sie wirkt sofort, und
  // das Formular reicht bei jeder Aenderung ein frisch gelesenes cfg herein -
  // ein hier festgehaltenes waere von der ersten Sekunde an veraltet.
  const ferne = { ab: cfg.tafelAb, band: cfg.tafelBand };
  const streuung = cfg.baumStreuung / 100;
  const blattTon = cfg.blattTon / 100;
  const blattStreuung = cfg.blattStreuung / 100;

  // DIE FARBVARIANTEN KOMMEN AUS DER BAUMDATEI. `laubtoene` liefert sechs
  // gleich wahrscheinliche Toene: den ungefaerbten (1,1,1) und die fuenf
  // Varianten, die im Baumkonfigurator eingetragen sind. Gewuerfelt wird hier
  // und nicht dort - eine Landschaft, die bei gleichem Startwert gleich
  // aussehen soll, braucht ihren eigenen Zufall.
  //
  // Die beiden Regler bleiben darueber liegen: `blattTon` haelt oder daempft
  // die Helligkeit im Ganzen, `blattStreuung` gibt jedem Baum noch eine
  // Kleinigkeit mit, damit zwei Baeume derselben Variante nicht wie gestempelt
  // nebeneinanderstehen.
  const toeneJeDatei = new Map();
  for (const [datei, plan] of plaene) toeneJeDatei.set(datei, laubtoene(plan.cfg));

  // Je Baumdatei eine Liste von Baeumen.
  const jeDatei = new Map();
  const benannt = [];

  trunks.forEach((t, i) => {
    const dreh = rng() * Math.PI * 2;
    const groesse = 1 + (rng() * 2 - 1) * streuung;
    const sorte = liste.standard[Math.floor(rng() * liste.standard.length)];
    const e = liste.baeume[i];
    const datei = e ? e.baum : sorte;

    // Eine der sechs Varianten aus der Baumdatei, darauf nur noch Helligkeit.
    // Ein benannter Baum darf stattdessen seine eigene Farbe aus der Liste
    // tragen - wer einen Namen bekommt, soll auch wiederzuerkennen sein.
    //
    // DIE STREUUNG VERSCHIEBT DIE FARBE NICHT MEHR, sie hellt nur auf und ab.
    // Solange die Toene hier gerechnet wurden, drehte sie zusaetzlich an der
    // Waerme - rot hoch, blau herunter -, denn ohne das waeren alle Baeume
    // gleich gewesen. Seit die Varianten aus der Baumdatei kommen, ist das
    // falsch: bei 25 % Streuung verschob sie den Farbton um ein Sechstel und
    // machte aus einem neutralen Baum einen warm-orangen. Neben dem einen
    // wirklich roten Ton sah der Garten dadurch nach viel mehr Rot aus, als
    // gewuerfelt war. Was der Konfigurator einstellt, bleibt jetzt stehen.
    const toene = toeneJeDatei.get(datei) || [WEISS];
    const basis = toene[(rng() * toene.length) | 0];
    const h = blattTon * (1 + (rng() * 2 - 1) * blattStreuung);
    const ton = (e && e.ton) ? e.ton.clone()
      : new THREE.Color().setRGB(basis.r * h, basis.g * h, basis.b * h);

    if (!jeDatei.has(datei)) jeDatei.set(datei, []);
    jeDatei.get(datei).push({ x: t.x, y: t.y, z: t.z, dreh, groesse, ton, fern: false });
    if (e) benannt.push({ trunk: t, name: e.name, datei: e.baum });
  });

  const group = new THREE.Group();
  group.name = 'baeume';
  const sorten = [];
  const stats = { baeume: trunks.length, benannt: benannt.length,
                  sorten: liste.standard.length, billboards: 0, dreiecke: 0 };

  const q = new THREE.Quaternion();
  const achse = new THREE.Vector3(0, 1, 0);
  const skal = new THREE.Vector3();
  const ort = new THREE.Vector3();

  for (const [datei, baeume] of jeDatei) {
    const plan = plaene.get(datei);
    const n = baeume.length;

    const wald = baueWald(plan, n);
    // Das Holz bleibt auch in der Karte stehen. Es war kurz ausgeblendet - aus
    // 35 Grad ueber dem Horizont sieht man den Stamm ja kaum -, aber dann
    // schwebte die Krone ueber ihrem eigenen Schatten: der Stamm ist das
    // Einzige, was sie sichtbar mit dem Boden verbindet.
    const werfer = baueWerfer(plan, n);
    const tafeln = await baueTafeln(plan, n);

    // Die Matrizen werden aufgehoben, nicht nur gesetzt: die Entfernung
    // schaltet weiter unten zwischen Netz und Tafel um, und dann muss beides
    // jederzeit wieder an seinen Platz geschrieben werden koennen.
    const matrizen = [];
    const maske = await ladeMaske(plan.paket.schatten);

    baeume.forEach((b, i) => {
      q.setFromAxisAngle(achse, b.dreh);
      skal.setScalar(b.groesse);
      ort.set(b.x, b.y, b.z);
      matrizen[i] = new THREE.Matrix4().compose(ort, q, skal);
      wald.setze(i, matrizen[i]);
      wald.faerbe(i, b.ton);
      if (werfer) werfer.setze(i, b.x, b.y, b.z, b.groesse);
      if (tafeln) { tafeln.setMatrixAt(i, NIRGENDS); tafeln.faerbe(i, b.ton); }
      if (bodenkarte) bodenkarte.setze(maske, plan.paket.schatten, b.x, b.z, b.dreh, b.groesse);
    });
    wald.fertig();
    group.add(wald);
    if (werfer) { werfer.fertig(); group.add(werfer); }
    if (tafeln) { tafeln.fertig(); group.add(tafeln); }

    sorten.push({ plan, baeume, matrizen, wald, werfer, tafeln });
    // Wie viele UNTERSCHIEDLICHE Toene die Sorte mitbringt. Gezaehlt wird ueber
    // die Rohwerte, nicht ueber getHex(): die Varianten duerfen ueber eins
    // liegen (1,8 faerbt kraeftiger, als das Bild ist), und getHex kappt dort.
    stats.laubvarianten = Math.max(stats.laubvarianten || 0,
      new Set((toeneJeDatei.get(datei) || []).map((c) => `${c.r},${c.g},${c.b}`)).size);
    stats.billboards += plan.billboards * n;
    stats.dreiecke += plan.dreiecke * n;
  }

  // Gezeichnet wird die Bodenkarte NICHT hier: Felsen und Pflanzen stempeln
  // spaeter in dieselbe Leinwand, und `garden.js` zeichnet sie einmal am Ende.

  const bestand = {
    group, benannt, stats, sorten,

    /**
     * Nah und fern. Gemessen wird vom Auge zum Baumfuss; der Rueckweg liegt
     * naeher als der Hinweg, sonst flackerte ein Baum genau auf der Grenze.
     *
     * Der Schatten bleibt davon unberuehrt - weder der Werfer noch der Stempel
     * in der Bodenkarte haengen daran, wie der Baum gerade gezeichnet wird. Ein
     * Baum, der zur Tafel wird, behaelt also seinen Schatten, und es gibt
     * nichts neu zu zeichnen.
     */
    aktualisiere(kamera, istVogel) {
      // In der Karte schaut man den Tafeln von oben auf die flache Seite. Dort
      // stehen deshalb immer die echten Baeume.
      const ab = (istVogel || !(ferne.ab > 0)) ? Infinity : ferne.ab;
      const band = ferne.band;
      const p = kamera.getWorldPosition(_p);

      for (const s of sorten) {
        let anders = false;
        s.baeume.forEach((b, i) => {
          const d = Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z);
          const fern = b.fern ? d > ab - band : d > ab;
          if (fern === b.fern) return;
          b.fern = fern;
          anders = true;
          s.wald.setze(i, fern ? NIRGENDS : s.matrizen[i]);
          if (s.tafeln) s.tafeln.setMatrixAt(i, fern ? _tafel(s.plan, b) : NIRGENDS);
        });
        if (anders) {
          s.wald.fertig();
          if (s.tafeln) s.tafeln.fertig();
        }
      }
    },

    /** Ab wo die Tafel uebernimmt, und wie breit der Uebergang ist. */
    setzeFerne(ab, band) {
      ferne.ab = ab;
      ferne.band = band;
    },

    /**
     * 'aus', 'simpel' oder 'detailliert'. Umgeschaltet wird eine Sichtbarkeit
     * und ein Uniform - es gibt nichts neu zu bauen und nichts neu zu
     * uebersetzen.
     */
    setzeSchatten(art) {
      for (const s of sorten) if (s.werfer) s.werfer.visible = art === 'detailliert';
      if (bodenkarte) bodenkarte.setzeAktiv(art === 'simpel');
    },
  };

  bestand.setzeSchatten(cfg.schatten);
  return bestand;
}

// Ein InstancedMesh kennt keine einzeln sichtbaren Instanzen. Wer eine
// verschwinden lassen will, gibt ihr keine Ausdehnung - die Grafikkarte
// verwirft sie dann, ehe ein Bildpunkt entsteht.
const NIRGENDS = new THREE.Matrix4().makeScale(0, 0, 0);
const WEISS = new THREE.Color(1, 1, 1);
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _ort = new THREE.Vector3();
const _dreh = new THREE.Quaternion();
const _skal = new THREE.Vector3();

// Die Tafel steht ueber dem Baumfuss, um die halbe Tafelhoehe angehoben -
// dieselbe Rechnung wie beim Schattenwerfer, nur senkrecht. Ihre Drehung bleibt
// ohne Wirkung, sie richtet sich im Shader selbst zur Kamera aus.
function _tafel(plan, b) {
  const a = plan.paket.ansicht;
  _ort.set(b.x, b.y + a.mitteY * b.groesse, b.z);
  _skal.setScalar(b.groesse);
  return _m.compose(_ort, _dreh, _skal);
}
