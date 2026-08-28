import * as THREE from 'three';
import { stream } from './rng.js';
import { ladeBauplan, baueWald, baueWerfer, baueTafeln, laubtoene } from './baumloader.js';
import { ladeMaske } from './bodenkarte.js';

/**
 * Der Baumbestand eines Gartens: alle Baeume aller Sorten, ihre Schatten und
 * ihre Fernansicht.
 *
 * DREI DINGE JE SORTE UND SEKTOR, und alle drei sind ein InstancedMesh:
 *
 *   Wald      Holz und Laub - der Baum, wie er ist. Zwei Zeichenaufrufe.
 *   Werfer    Unsichtbare Flaechen quer zum Sonnenstrahl. Sie werfen den
 *             echten Schatten des ganzen Baums und kosten im
 *             Schattendurchgang zwei Dreiecke statt der ganzen Krone.
 *   Tafeln    Die gebackene Seitenansicht. Sie tritt in der Ferne an die
 *             Stelle des Baums; ein Rechteck statt zweier Netze.
 *
 * AUFGETEILT WIRD NACH SEKTOREN, wie beim Gras (siehe `sektoren.js`). Ein Netz
 * ueber den ganzen Garten hat eine Huellkugel vom Gartenradius; man steht immer
 * darin, und das Sichtvolumen kann es nie verwerfen. Bei hundert Baeumen sind
 * das eine halbe Million Dreiecke Holz, die auch dann gezeichnet werden, wenn
 * man in die andere Richtung schaut.
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
export async function baueBestand(cfg, liste, plaene, trunks, bodenkarte, sektoren) {
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
  // EIN EINTRAG JE SORTE UND SEKTOR - nicht je Sorte. Was hier `gruppen` heisst,
  // ist ein Haeufchen Baeume derselben Datei in demselben Rasterfeld, mit
  // eigenem Netz und eigener Huellkugel.
  const gruppen = [];
  // GEZAEHLT WIRD, WAS UNTERSCHIEDLICH IST. Dieselbe Datei darf in `standard`
  // mehrfach stehen - so stellt man die Verteilung ein, ohne einen zweiten
  // Regler dafuer zu brauchen -, sie ergibt aber nur EINEN Bauplan und EIN
  // Netz. Die Laenge der Liste waere hier also die Zahl der Lose, nicht die
  // der Sorten.
  const stats = { baeume: trunks.length, benannt: benannt.length,
                  sorten: new Set(liste.standard).size, billboards: 0, dreiecke: 0 };

  const q = new THREE.Quaternion();
  const achse = new THREE.Vector3(0, 1, 0);
  const skal = new THREE.Vector3();
  const ort = new THREE.Vector3();

  for (const [datei, baeume] of jeDatei) {
    const plan = plaene.get(datei);
    const maske = await ladeMaske(plan.paket.schatten);

    // JE SORTE UND SEKTOR EIN NETZ, nicht je Sorte eines.
    //
    // Der Grund ist derselbe wie beim Gras (siehe `sektoren.js`), nur faellt er
    // hier am schwersten ins Gewicht: das Holz von hundert Baeumen sind eine
    // halbe Million Dreiecke, und in EINEM Netz ueber den ganzen Garten hat es
    // eine Huellkugel vom Gartenradius. Man steht immer darin - das
    // Sichtvolumen kann es nie verwerfen, und die Baeume hinter dem Ruecken
    // werden mitgezeichnet. Aufgeteilt faellt weg, was nicht im Bild ist.
    const teile = sektoren ? sektoren.teile(baeume) : new Map([[0, baeume]]);
    for (const [feld, meine] of teile) {
      const n = meine.length;
      const wald = baueWald(plan, n);
      // Das Holz bleibt auch in der Karte stehen. Es war kurz ausgeblendet -
      // aus 35 Grad ueber dem Horizont sieht man den Stamm ja kaum -, aber dann
      // schwebte die Krone ueber ihrem eigenen Schatten: der Stamm ist das
      // Einzige, was sie sichtbar mit dem Boden verbindet.
      const werfer = baueWerfer(plan, n);
      const tafeln = await baueTafeln(plan, n);
      wald.name = `${wald.name}_${feld}`;

      // Die Matrizen werden aufgehoben, nicht nur gesetzt: die Entfernung
      // schaltet weiter unten zwischen Netz und Tafel um, und dann muss beides
      // jederzeit wieder an seinen Platz geschrieben werden koennen.
      const matrizen = [];
      meine.forEach((b, i) => {
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
      // Am Anfang steht ueberall der echte Baum; die Tafeln liegen alle auf
      // NIRGENDS und brauchen gar nicht erst eingereicht zu werden.
      if (tafeln) tafeln.visible = false;

      // Die Mitte des Feldes und sein Halbmesser: damit kann `aktualisiere`
      // ganze Sektoren ueberspringen, statt jeden Baum einzeln zu messen.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const b of meine) {
        if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
        if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
      }
      const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
      const rr = Math.hypot(maxX - mx, maxZ - mz);

      gruppen.push({ plan, baeume: meine, matrizen, wald, werfer, tafeln,
                     mx, mz, rr, alleFern: false, alleNah: true });
    }

    const n = baeume.length;
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
    group, benannt, stats, gruppen,

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

      for (const s of gruppen) {
        // GANZE SEKTOREN UEBERSPRINGEN. Liegt das Feld mitsamt seinem
        // Halbmesser diesseits der Grenze, sind alle seine Baeume nah; liegt es
        // ganz jenseits, sind alle fern. Nur die Felder, durch die die Grenze
        // laeuft, muessen Baum fuer Baum gemessen werden - und selbst die nur,
        // solange sich etwas aendern kann.
        const dm = Math.hypot(p.x - s.mx, p.z - s.mz);
        const ruhig = (dm + s.rr < ab - band && s.alleNah)
                   || (dm - s.rr > ab && s.alleFern);
        if (!ruhig) {
          let anders = false;
          let nah = 0;
          s.baeume.forEach((b, i) => {
            const d = Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z);
            const fern = b.fern ? d > ab - band : d > ab;
            if (!fern) nah++;
            if (fern === b.fern) return;
            b.fern = fern;
            anders = true;
            s.wald.setze(i, fern ? NIRGENDS : s.matrizen[i]);
            if (s.tafeln) s.tafeln.setMatrixAt(i, fern ? _tafel(s.plan, b) : NIRGENDS);
          });
          s.alleNah = nah === s.baeume.length;
          s.alleFern = nah === 0;
          if (anders) {
            s.wald.fertig();
            if (s.tafeln) s.tafeln.fertig();
          }
        }

        // GANZ AUS STATT AUF NULL GESCHRUMPFT. Eine Instanz mit Groesse null
        // erzeugt keinen Bildpunkt - der Scheitelpunkt-Shader laeuft aber
        // trotzdem ueber sie. Ein Sektor, in dem alle Baeume fern sind, hat
        // hundert solcher Instanzen; sichtbar bleibt dann nur die Tafel.
        // Nebenbei behebt das eine Merkwuerdigkeit der Huellkugel: ueber lauter
        // Nullmatrizen gerechnet, schrumpft sie auf den Ursprung des Gartens -
        // und das Netz gilt als sichtbar, sobald man zur Gartenmitte schaut.
        //
        // GESETZT WIRD IMMER, AUCH WENN NICHTS GEMESSEN WURDE. Zwei Zuweisungen
        // kosten nichts, und sie duerfen nicht veralten: greift jemand von
        // aussen in die Sichtbarkeit - der Shader-Vorlauf schaltet zum
        // Uebersetzen die ganze Szene an und danach wieder aus (siehe
        // `waermeShader` in `scene.js`) -, dann stand hier ein Sektor auf
        // „alles fern" und wurde uebersprungen, waehrend seine Tafeln
        // ausgeschaltet blieben. Die fernen Baeume fehlten und kamen erst
        // zurueck, wenn man ihnen nahe genug kam.
        s.wald.visible = !s.alleFern;
        if (s.tafeln) s.tafeln.visible = !s.alleNah;
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
      for (const s of gruppen) if (s.werfer) s.werfer.visible = art === 'detailliert';
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
  // JEDE ZWEITE TAFEL STEHT SEITENVERKEHRT. Eine negative Breite in der
  // Instanzmatrix heisst dem Shader, das Bild zu spiegeln (siehe `spiegelbar`
  // in `baumloader.js`) - hundert Baeume aus einem Bild sehen damit nach zweien
  // aus, ohne einen einzigen Zeichenaufruf mehr.
  //
  // ENTSCHIEDEN WIRD ES AN DER DREHUNG, nicht an einem neuen Wurf. Die Drehung
  // eines Baums ist bereits ausgewuerfelt und gleichverteilt, und auf die Tafel
  // wirkt sie nicht - sie richtet sich ohnehin zur Kamera. Ein zusaetzlicher
  // Wurf haette dagegen die ganze Zufallsfolge verschoben, und derselbe
  // Startwert haette einen anderen Garten ergeben.
  const w = b.groesse * (b.dreh > Math.PI ? -1 : 1);
  _skal.set(w, b.groesse, b.groesse);
  return _m.compose(_ort, _dreh, _skal);
}
