import * as THREE from 'three';

/**
 * Die eingebrannte Bodenkarte: Baumschatten als Stempel auf einer Leinwand,
 * die ueber den ganzen Garten gespannt und in den Untergrund multipliziert
 * wird.
 *
 * WOHER DIE STEMPEL KOMMEN. Jede Baumdatei bringt unter `paket.schatten` einen
 * fertig gerechneten Grundriss ihrer Krone mit - ein graues PNG samt Massen in
 * Metern. Er entsteht beim Export, nicht zur Laufzeit; hier wird er nur noch an
 * seinen Platz gezeichnet.
 *
 * WAS SIE KOSTET. Einmal Zeichnen beim Aufbau des Gartens und eine Textur.
 * Danach nichts: kein Schattendurchgang, keine Lichtquelle, keine
 * Aufloesungssorgen im Nahbereich. Der Preis ist, dass der Stempel starr ist -
 * er legt sich zwar ueber jedes Gelaende, aber er weiss nichts davon. An einem
 * steilen Hang laege der Schatten in Wahrheit gestreckt; wer das braucht,
 * nimmt die Schattenkarten (siehe `baumloader.js`, `baueWerfer`).
 *
 * WIE SIE ABGETASTET WIRD. Nicht ueber die UVs der Netze, sondern ueber die
 * Weltkoordinaten x und z. Genau das macht sie unabhaengig von der Form der
 * Landschaft: Wiese, Weg, Boeschung und Grasbueschel schlagen alle in derselben
 * Karte nach, ohne dass eines von ihnen etwas ueber die anderen wissen muesste.
 *
 * WIE STEMPEL SICH UEBERLAGERN: der DUNKLERE gewinnt, es wird nicht
 * multipliziert. Das ist der Grund, weshalb die Stempel als undurchsichtiges
 * Grau vorliegen und nicht als Schwarz mit Deckkraft. Mit Deckkraft laege ueber
 * zwei einander deckenden Kronen (je 60 % Schatten) am Ende 84 % - und wo
 * Baumschatten und Pflanzenschatten zusammenfallen, saeuft der Boden ab. Mit
 * `globalCompositeOperation = 'darken'` bleibt es bei 60 %: ein Schatten ist
 * fehlendes Sonnenlicht, und fehlen kann es nur einmal.
 *
 * DESHALB IST DIE KARTE SELBST VOLL AUSGESTEUERT: jeder Stempel geht bis
 * Schwarz - der gerechnete Riss des Baumgenerators ebenso wie die Kreise fuer
 * Pflanzen und Felsen. Was in der Karte steht, ist die reine Deckung, nicht
 * schon die Wirkung. Abgeschwaecht wird erst bei der Anwendung, mit
 * `SCHATTEN_STAERKE`.
 *
 * Der Umweg lohnt sich zweifach: „der dunklere gewinnt" vergleicht nur dann
 * Vergleichbares, wenn alle Stempel denselben Massstab haben; und die Staerke
 * laesst sich aendern, ohne eine einzige Leinwand neu zu zeichnen - sie ist
 * ein Uniform.
 */

/**
 * Wie stark ein voll gedeckter Stempel den Boden verdunkelt. 0 heisst kein
 * Schatten, 1 heisst schwarz.
 *
 * 0,30 ist keine physikalische Groesse, sondern die Antwort auf die Frage,
 * wie viel Himmelslicht in den Schatten faellt. Bei bedecktem Himmel waere es
 * weniger, bei tiefer Sonne mehr. Wer daran dreht: hoehere Werte lassen den
 * Garten schnell fleckig wirken, weil der Stempel flach auf dem Boden liegt
 * und keine Halbschatten kennt.
 */
export const SCHATTEN_STAERKE = 0.60;

// Weiss = volles Licht. Damit wird die Karte neutral gestellt, ohne dass die
// Shader neu uebersetzt werden muessten.
let _weiss = null;
function weisseTextur() {
  if (!_weiss) {
    _weiss = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    _weiss.needsUpdate = true;
  }
  return _weiss;
}

/**
 * Der Schattenriss aus dem Paket als Maske: undurchsichtiges Grau, in dem die
 * Deckung des Bildes zur Helligkeit geworden ist. Gezeichnet wird er spaeter
 * mit `darken`, deshalb gerade nicht mit Deckkraft.
 *
 * Das Bild ist eine Datenadresse und aendert sich nie - deshalb je Baumsorte
 * nur einmal.
 */
const maskenCache = new Map();

export function ladeMaske(schatten) {
  if (!schatten || !schatten.bild) return Promise.resolve(null);
  let p = maskenCache.get(schatten.bild);
  if (!p) { p = baueMaske(schatten); maskenCache.set(schatten.bild, p); }
  return p;
}

async function baueMaske(schatten) {
  const px = schatten.px || 512;
  const im = new Image();
  im.src = schatten.bild;
  await im.decode();
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0, px, px);
  const d = x.getImageData(0, 0, px, px);
  for (let i = 0; i < px * px; i++) {
    // Deckung wird Helligkeit: 255 heisst freier Boden, 0 voller Schatten.
    // Undurchsichtig, damit `darken` greifen kann - siehe Kopf der Datei.
    const v = 255 - d.data[i * 4];
    d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v;
    d.data[i * 4 + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  return c;
}

/**
 * Eine Bodenkarte fuer einen Garten.
 *
 * `weite` ist die Kantenlaenge in Metern, die sie abdeckt - etwas mehr als der
 * Garten breit ist, damit ringsum weisser Rand steht. Ausserhalb liefert die
 * Textur ihren Randpixel (ClampToEdge), und der soll volles Licht sein, sonst
 * zoege sich der Schatten des aeussersten Baums als Streifen bis zum Horizont.
 */
export function createBodenkarte(cfg) {
  const weite = cfg.durchmesser + 12;
  const px = Math.round(cfg.bodenkartePx);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);

  const textur = new THREE.CanvasTexture(canvas);
  textur.colorSpace = THREE.NoColorSpace;          // eine Maske, kein Bild
  textur.wrapS = textur.wrapT = THREE.ClampToEdgeWrapping;
  // Ohne das steht die Karte in z auf dem Kopf. three dreht eine Textur beim
  // Hochladen um (flipY), damit Bilddateien in der ueblichen UV-Leserichtung
  // liegen - eine Leinwand, die hier als Karte ueber x/z gezeichnet wurde, will
  // aber genau nicht gedreht werden: Zeile 0 ist z = -weite/2 und soll v = 0
  // bleiben. Gedreht wandert jeder Schatten an die gespiegelte Stelle.
  textur.flipY = false;

  const stempel = [];
  const kreise = [];
  const ellipsen = [];
  let an = true;

  // Das Uniform-Objekt steht ausserhalb und wird nur hineingereicht. Es innen
  // anzulegen waere eine Falle: sobald sich am Material etwas aendert, was ein
  // neues Programm noetig macht - etwa das Ein- und Ausschalten des
  // Schattenwurfs -, laeuft onBeforeCompile erneut, legt ein zweites
  // Uniform-Objekt an, und ein von aussen gehaltener Zeiger auf das erste geht
  // ins Leere.
  const uKarte = { value: textur };
  const uWeite = { value: weite };
  const uStaerke = { value: SCHATTEN_STAERKE };

  return {
    weite, px, canvas, textur,

    /**
     * Einen Baum vormerken. `maske` ist die Leinwand aus `ladeMaske`,
     * `schatten` der Eintrag aus dem Paket - er traegt die Massstaebe.
     */
    setze(maske, schatten, x, z, dreh, groesse) {
      if (maske && schatten) stempel.push({ maske, schatten, x, z, dreh, groesse });
    },

    /**
     * Ein Pseudoschatten fuer alles, was keinen gerechneten Riss mitbringt:
     * ein weicher Kreis. `durchmesser` in Metern; um den Versatz gegen die
     * Sonne hat der Aufrufer sich schon gekuemmert.
     *
     * `deckung` ist voreingestellt 1 und soll das auch bleiben - genau wie der
     * Riss eines Baums geht der Kreis bis Schwarz. Wie viel davon am Ende zu
     * sehen ist, entscheidet `SCHATTEN_STAERKE` fuer alle gleich. Wer hier
     * abschwaechte, machte den Vergleich „der dunklere gewinnt" schief.
     *
     * Fuer eine Pflanze ist der Kreis kein Notbehelf, sondern das richtige
     * Mass: bei der Aufloesung der Karte (rund 18 px/m) ist ein Grasbueschel
     * sechzehn Bildpunkte breit. Ein gerechneter Riss braechte dort nichts.
     */
    setzeKreis(x, z, durchmesser, deckung = 1) {
      if (durchmesser > 0) kreise.push({ x, z, r: durchmesser / 2, deckung });
    },

    /**
     * EIN SCHATTEN MIT RICHTUNG UND LAENGE.
     *
     * Ein Kreis ist fuer ein Grasbueschel das richtige Mass, fuer einen
     * Felsblock oder eine Zypresse aber nicht: die stehen aufrecht in der
     * Landschaft, und ihr Schatten liegt nicht um sie herum, sondern LAENGS von
     * ihnen weg. Bei einer sechs Meter hohen Zypresse und der Sonne auf ihrer
     * Bahn sind das mehrere Meter - ein Kreis von einem Meter Durchmesser
     * darunter sah aus wie ein Fleck, nicht wie ein Schatten.
     *
     * Was ein aufrechter Koerper wirft, ist der Umriss seines Grundrisses,
     * verschoben um Hoehe mal Kotangens des Sonnenstandes - also eine Kapsel:
     * der Grundriss am Fuss, derselbe noch einmal am Ende des Versatzes, und
     * dazwischen ausgezogen. Eine Ellipse mit denselben Halbachsen trifft das
     * gut genug und laesst sich in einem Zug zeichnen.
     *
     *   laengs  halbe Laenge, in Richtung `winkel`
     *   quer    halbe Breite
     *   winkel  Richtung in der x/z-Ebene, im Bogenmass
     */
    setzeEllipse(x, z, laengs, quer, winkel, deckung = 1) {
      if (laengs > 0 && quer > 0) ellipsen.push({ x, z, laengs, quer, winkel, deckung });
    },

    /** Die ganze Karte auf einmal zeichnen. */
    zeichne() {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#fff';                        // weiss = volles Licht
      ctx.fillRect(0, 0, px, px);
      // Ab hier gewinnt der dunklere Bildpunkt. Ausserhalb eines Stempels wird
      // gar nichts gezeichnet, dort bleibt der Untergrund also unberuehrt.
      ctx.globalCompositeOperation = 'darken';
      const proMeter = px / weite;

      // Erst die Ellipsen, dann die Kreise - die Reihenfolge ist gleichgueltig,
      // weil ohnehin der dunklere Bildpunkt gewinnt.
      for (const e of ellipsen) {
        const a = Math.max(1, e.laengs * proMeter);
        const b = Math.max(1, e.quer * proMeter);
        const cx = (e.x + weite / 2) * proMeter;
        const cz = (e.z + weite / 2) * proMeter;
        const v = Math.round(255 * (1 - Math.min(1, Math.max(0, e.deckung))));
        const halb = Math.round(v + (255 - v) * 0.45);
        // Gezeichnet wird als KREIS in einem gestauchten Koordinatensystem -
        // ein Farbverlauf laesst sich nicht elliptisch anlegen, eine Leinwand
        // aber verzerren. Sonst muesste der Verlauf Punkt fuer Punkt von Hand
        // gerechnet werden.
        ctx.save();
        ctx.translate(cx, cz);
        ctx.rotate(e.winkel);
        ctx.scale(1, b / a);
        const g = ctx.createRadialGradient(0, 0, a * 0.25, 0, 0, a);
        g.addColorStop(0, `rgb(${v},${v},${v})`);
        g.addColorStop(0.65, `rgb(${halb},${halb},${halb})`);
        g.addColorStop(1, 'rgb(255,255,255)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, a, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      for (const k of kreise) {
        const r = Math.max(1, k.r * proMeter);
        const cx = (k.x + weite / 2) * proMeter;
        const cz = (k.z + weite / 2) * proMeter;
        // Weich auslaufend: innen der volle Wert, nach aussen auf Weiss. Ein
        // harter Kreis sieht aus wie ein Deckel, kein Schatten.
        const v = Math.round(255 * (1 - Math.min(1, Math.max(0, k.deckung))));
        const g = ctx.createRadialGradient(cx, cz, r * 0.25, cx, cz, r);
        g.addColorStop(0, `rgb(${v},${v},${v})`);
        g.addColorStop(0.65, `rgb(${Math.round(v + (255 - v) * 0.45)},`
                           + `${Math.round(v + (255 - v) * 0.45)},`
                           + `${Math.round(v + (255 - v) * 0.45)})`);
        g.addColorStop(1, 'rgb(255,255,255)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cz, r, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const s of stempel) {
        const g = s.groesse;
        const sch = s.schatten;
        // Zwei Verschiebungen, und ihre Reihenfolge ist der ganze Witz:
        //
        //   versatzX/Z  kommt von der Sonne. Er steht in Weltkoordinaten und
        //               darf nicht mitdrehen - die Sonne dreht sich nicht mit
        //               dem Baum.
        //   mitteX/Z    ist der Mittelpunkt des Risses im Koordinatensystem des
        //               Baums und dreht deshalb mit.
        //
        // Erst also im Weltmass versetzen, dann drehen, dann das Bild
        // ausrichten. In Bildkoordinaten zeigt z nach unten, deshalb dreht die
        // Leinwand andersherum.
        const k = sch.breite * proMeter * g;
        ctx.save();
        ctx.translate((s.x + sch.versatzX * g + weite / 2) * proMeter,
                      (s.z + sch.versatzZ * g + weite / 2) * proMeter);
        ctx.rotate(-s.dreh);
        ctx.translate(sch.mitteX * proMeter * g, sch.mitteZ * proMeter * g);
        ctx.drawImage(s.maske, -k / 2, -k / 2, k, k);
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
      textur.needsUpdate = true;
    },

    /** Ein- und ausschalten, ohne die Shader anzufassen. */
    setzeAktiv(wert) {
      an = !!wert;
      uKarte.value = an ? textur : weisseTextur();
    },
    get aktiv() { return an; },

    /**
     * Die Schattenstaerke zur Laufzeit. Sie ist ein Uniform - die Leinwand
     * bleibt unberuehrt, es wird nichts neu gezeichnet und nichts neu
     * uebersetzt. Praktisch zum Einstellen von Hand:
     * `__sim.garden.bodenkarte.setzeStaerke(0.5)`.
     */
    setzeStaerke(wert) { uStaerke.value = Math.min(1, Math.max(0, wert)); },
    get staerke() { return uStaerke.value; },

    /**
     * Ein Material die Karte lesen lassen. Der Griff sitzt hinter
     * `map_fragment`, damit die Bodentextur schon steht und nur noch
     * abgedunkelt wird.
     */
    bindeMaterial(mat) {
      const vorher = mat.onBeforeCompile;
      mat.onBeforeCompile = (sh, r) => {
        if (vorher) vorher(sh, r);
        sh.uniforms.uKarte = uKarte;
        sh.uniforms.uWeite = uWeite;
        sh.uniforms.uStaerke = uStaerke;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWelt;')
          .replace('#include <project_vertex>',
                   'vWelt = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>',
                   '#include <common>\nvarying vec3 vWelt;\nuniform sampler2D uKarte;\n'
                 + 'uniform float uWeite;\nuniform float uStaerke;')
          // In der Karte steht die volle Deckung; hier wird sie abgeschwaecht.
          // mix(1, karte, staerke): bei staerke = 0 bleibt der Boden, wie er
          // ist, bei 1 gilt die Karte unveraendert.
          .replace('#include <map_fragment>',
                   '#include <map_fragment>\n{\n  vec2 su = vWelt.xz / uWeite + 0.5;\n'
                 + '  vec3 k = texture2D(uKarte, su).rgb;\n'
                 + '  diffuseColor.rgb *= mix(vec3(1.0), k, uStaerke);\n}');
      };
      // Zwei Fassungen desselben Materials brauchen zwei Schluessel, sonst
      // haelt three das eine fuer das andere.
      const alt = mat.customProgramCacheKey;
      mat.customProgramCacheKey = () => 'bodenkarte|' + (alt ? alt.call(mat) : '');
      return mat;
    },

    dispose() { textur.dispose(); stempel.length = 0; kreise.length = 0; },
  };
}
