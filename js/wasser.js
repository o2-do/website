import * as THREE from 'three';
import { stream } from './rng.js';

/**
 * Der Tuempel - eine Mulde in der Wiese und eine Scheibe darin.
 *
 * DIE MULDE ENTSTEHT WIE DIE BOESCHUNG: nicht als eigene Geometrie, sondern als
 * senkrechte Verschiebung vorhandener Wiesenpunkte. Innerhalb des Beckens
 * kommen sie alle auf eine feste Hoehe, nach aussen laufen sie ueber die
 * Uferbreite zurueck aufs Gelaende. Das Netz ist dasselbe wie vorher, es haengt
 * nur anders durch.
 *
 * DIE WASSERSCHEIBE REICHT WEITER ALS DAS BECKEN, und das ist der Trick an der
 * Uferlinie. Wo genau das Wasser aufhoert, soll nicht die Kante der Scheibe
 * entscheiden - eine kreisrunde Kante sieht man sofort. Also wird die Scheibe
 * bis in das ansteigende Ufer hineingelegt: dort liegt das Gelaende ueber dem
 * Spiegel und verdeckt sie. Sichtbar bleibt genau die Linie, an der der Hang
 * die Wasserebene schneidet - unregelmaessig, so wie ein Ufer aussieht, und
 * ohne dass zwei Flaechen um dieselben Bildpunkte streiten.
 */

// WIE TIEF DER SPIEGEL UNTER DEM UMGEBENDEN GELAENDE LIEGT.
//
// Hier standen sechs Zentimeter, und daran lag die unschoene Uferkontur. Die
// sichtbare Linie ist ja nicht die Kante der Scheibe, sondern die Stelle, an
// der der Hang die Wasserebene schneidet - und wie genau diese Linie liegt,
// haengt daran, wie STEIL der Hang sie schneidet. Bei sechs Zentimetern auf
// zwei Meter Ufer sind das keine zwei Grad: eine Unebenheit von fuenf
// Zentimetern verschob die Uferlinie um anderthalb Meter, und heraus kam eine
// ausgefranste Pfuetze. Bei dreissig Zentimetern auf achtzig sind es
// fuenfunddreissig Grad, und dieselbe Unebenheit verschiebt sie um sieben.
const SPIEGEL_UNTER_GRUND = 0.30;
/**
 * DIE FARBE DES WASSERS IN DER KARTE.
 *
 * Ein ruhiges Graublau, flach aufgetragen. In der Vogelperspektive faellt der
 * Spiegel aus: dort blickt eine orthografische Kamera auf den Garten, und die
 * Spiegelkonstruktion braucht eine perspektivische (siehe `onBeforeRender`).
 * Uebrig blieb bisher das ZULETZT gerechnete Spiegelbild - ein eingefrorenes
 * Standbild aus der Augenhoehe, das quer ueber dem Teich lag und mit nichts in
 * der Karte etwas zu tun hatte.
 *
 * Die Karte ist eine Zeichnung, kein Bild. Wasser ist darin eine Flaeche, so
 * wie die Wiese eine ist.
 */
const KARTEN_FARBE = 0x8ea6b4;

// Wassertiefe unter dem Spiegel. Sieht man kaum - die Flaeche ist nicht
// durchsichtig -, aber der Boden soll nicht durchscheinen.
const TIEFE = 0.25;
// Ueber wie viele Meter das Ufer zum Gelaende zurueckfindet.
const UFER = 0.8;
// Mindestabstand der Uferkante zur naechsten Wegflaeche.
const ABSTAND_WEG = 2.0;
// Wie schief die Stelle hoechstens sein darf: der Hoehenunterschied ueber dem
// Beckenrand. Mehr als die Spiegeltiefe geht nicht - dann laege die
// Wasserebene auf der tiefen Seite schon ueber dem umgebenden Gelaende, und
// der Tuempel liefe aus. Wird nichts Ebeneres gefunden, gibt es eben keinen:
// jeder Garten ist anders.
const MAX_SCHIEFE = SPIEGEL_UNTER_GRUND;

/**
 * Einen Platz fuer den Tuempel suchen: moeglichst eben, abseits der Wege, weit
 * genug vom Gartenrand.
 *
 * Gesucht wird der FLACHSTE unter einer Handvoll zufaelliger Kandidaten, nicht
 * der erste brauchbare. Ein Tuempel am Hang laeuft aus, und man sieht es ihm
 * an; die paar Dutzend Abfragen sind das billigste Mittel dagegen.
 */
export function planeTeich(base, cfg, paths) {
  if (cfg.see === 'ohne See') return null;
  const d = Math.max(0, cfg.teichDurchmesser);
  if (d <= 0) return null;

  const rng = stream(cfg._seed, 'teich');
  const R = cfg.durchmesser / 2;
  const rBecken = d / 2;
  const rGesamt = rBecken * 1.2 + UFER;      // aeusserste Ausdehnung des Ufers
  let best = null;

  for (let v = 0; v < 400; v++) {
    const rr = 0.75 * R * Math.sqrt(rng());
    const aa = rng() * Math.PI * 2;
    const x = Math.cos(aa) * rr, z = Math.sin(aa) * rr;
    if (Math.hypot(x, z) + rGesamt > 0.85 * R) continue;
    // Abstand zu allen Wegen: das Becken darf keinen beruehren, und auch das
    // Ufer soll nicht in die Wegkante schneiden.
    let frei = true;
    for (const p of paths) {
      if (abstandZumWeg(p, x, z) < rGesamt + ABSTAND_WEG) { frei = false; break; }
    }
    if (!frei) continue;

    // Ebenheit: der Hoehenunterschied ueber dem Becken. Acht Punkte auf dem
    // Rand plus die Mitte genuegen - ein Tuempel ist keine Wasserwaage, aber
    // eine schiefe Ebene faellt auf.
    let lo = Infinity, hi = -Infinity, summe = 0;
    for (let k = 0; k < 8; k++) {
      const w = (k / 8) * Math.PI * 2;
      const y = base.heightAt(x + Math.cos(w) * rBecken, z + Math.sin(w) * rBecken);
      lo = Math.min(lo, y); hi = Math.max(hi, y); summe += y;
    }
    const mitte = base.heightAt(x, z);
    summe += mitte;
    const spanne = hi - lo;
    if (!best || spanne < best.spanne) {
      best = { x, z, spanne, niveau: summe / 9 };
    }
    if (spanne < 0.05) break;              // eben genug, nicht weitersuchen
  }
  // Nichts Passendes gefunden - dann eben keinen Tuempel. Lieber gar keiner als
  // einer, der am Hang ausliefe.
  if (!best || best.spanne > MAX_SCHIEFE) return null;

  // DAS UFER DARF NICHT KREISRUND SEIN.
  //
  // Die Senkung haengt nur vom Abstand zur Mitte ab, und damit ist auch die
  // Linie, an der der Hang die Wasserebene schneidet, ein exakter Kreis - man
  // sieht ihm die Konstruktion an. Drei Oberwellen ueber den Winkel machen
  // daraus eine Bucht und eine Nase, ohne dass es dafuer Rauschen braeuchte:
  // der Beckenrand atmet um ein Sechstel seines Halbmessers.
  const wellen = [];
  for (let k = 0; k < 3; k++) wellen.push({ n: 2 + k, phase: rng() * Math.PI * 2 });

  const spiegel = best.niveau - SPIEGEL_UNTER_GRUND;
  return {
    x: best.x, z: best.z,
    rBecken, rUfer: UFER, rScheibe: rGesamt,
    wellen,
    grund: spiegel - TIEFE,
    spiegel,
    spanne: best.spanne,
  };
}

/** Abstand zur Flaeche eines Weges; negativ heisst drauf. */
function abstandZumWeg(p, x, z) {
  const sm = p.samples;
  const segs = p.closed ? sm.length : sm.length - 1;
  let best = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = sm[i], b = sm[(i + 1) % sm.length];
    const vx = b.x - a.x, vz = b.z - a.z;
    const wx = x - a.x, wz = z - a.z;
    const l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? (wx * vx + wz * vz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * vx, dz = wz - t * vz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best) - p.width / 2;
}

/**
 * DER BECKENHALBMESSER IN EINER RICHTUNG.
 *
 * Er steht hier fuer sich, weil ZWEI Dinge ihn brauchen und beide genau
 * denselben Wert bekommen muessen: das Ausheben der Mulde und der Umriss der
 * Wasserscheibe. Solange die Scheibe ein Kreis war und die Mulde nicht, ragte
 * sie dort, wo der Beckenrand eingezogen ist, ueber die Boeschung hinaus - und
 * lag dann auf unveraendertem Gelaende. Liegt das tiefer als der Spiegel, kam
 * das Wasser jenseits des Ufers wieder heraus.
 */
export function beckenHalbmesser(teich, winkel) {
  let f = 1;
  for (const w of teich.wellen) f += 0.09 * Math.sin(w.n * winkel + w.phase);
  return teich.rBecken * Math.min(1.2, Math.max(0.5, f));
}

/**
 * Das Becken ausheben: die Wiesenpunkte senken.
 *
 * Innerhalb des Beckens auf eine feste Hoehe - ein Teichboden ist eben -, nach
 * aussen ueber das Ufer zurueck aufs Gelaende, mit waagerechter Tangente an
 * beiden Enden, damit weder am Beckenrand noch am Uferende ein Knick steht.
 *
 * Nur nach UNTEN. Waere das Gelaende an einer Stelle ohnehin tiefer als der
 * Beckenboden, bliebe es dort - sonst hoebe der Tuempel eine Mulde an, statt
 * eine auszuheben.
 */
export function hebeAus(P, teich, RASTER) {
  if (!teich) return 0;
  const { x, z, rBecken, rUfer, grund } = teich;
  let n = 0;
  for (let i = 0; i < P.x.length; i++) {
    if (P.art[i] !== RASTER || P.aus[i]) continue;
    const dx = P.x[i] - x, dz = P.z[i] - z;
    const d = Math.hypot(dx, dz);
    if (d >= rBecken * 1.2 + rUfer) continue;
    const rb = beckenHalbmesser(teich, Math.atan2(dz, dx));
    if (d >= rb + rUfer) continue;
    let soll;
    if (d <= rb) {
      soll = grund;
    } else {
      const t = (d - rb) / rUfer;
      const s = t * t * (3 - 2 * t);
      soll = grund + (P.y[i] - grund) * s;
    }
    if (soll < P.y[i]) { P.y[i] = soll; n++; }
  }
  return n;
}

/**
 * FEINERE PUNKTE FUER DAS UFER.
 *
 * Die sichtbare Uferlinie ist die Schnittkante zwischen Wiesennetz und
 * Wasserebene - sie kann also nie feiner sein als das Netz. Bei einem halben
 * Meter Rasterweite laeuft sie in geraden Stuecken von einem halben Meter, und
 * das sieht man: der Tuempel bekommt Ecken.
 *
 * Also wird im Bereich des Tuempels ein eigenes, feineres Raster gelegt - in
 * Ringen, weil sowohl das Becken als auch das Ufer kreisfoermig angelegt sind
 * und die Punkte so von selbst parallel zur Uferlinie laufen.
 *
 * VERWACKELT, und zwar staerker als das Wiesenraster: Punkte auf konzentrischen
 * Kreisen sind der denkbar schlimmste Fall fuer Delaunay - je vier von ihnen
 * liegen exakt auf einem Kreis, und welches Dreieck entsteht, entscheidet dann
 * der Rundungsfehler.
 */
export function teichPunkte(P, teich, rng, RASTER) {
  if (!teich) return 0;
  const aussen = teich.rScheibe + 0.4;
  // Fein nur dort, wo es darauf ankommt. Der Beckenboden ist eben - dort
  // beschreibt jeder zusaetzliche Punkt dieselbe waagerechte Flaeche noch
  // einmal und kostet nur Triangulierungszeit.
  const nah = 0.20;                    // am Ufer
  const weit = 0.45;                   // im Becken
  const uferAb = teich.rBecken * 0.75;
  let n = 0;
  P.neu(teich.x, teich.z, RASTER);
  n++;
  for (let r = weit; r <= aussen; r += (r < uferAb ? weit : nah)) {
    const schritt = r < uferAb ? weit : nah;
    const m = Math.max(6, Math.round((2 * Math.PI * r) / schritt));
    const dreh = rng() * Math.PI * 2;
    for (let k = 0; k < m; k++) {
      const w = dreh + (k / m) * Math.PI * 2;
      const rr = r + (rng() - 0.5) * schritt * 0.7;
      P.neu(teich.x + Math.cos(w) * rr, teich.z + Math.sin(w) * rr, RASTER);
      n++;
    }
  }
  return n;
}

/** Liegt der Punkt im Bereich, den `teichPunkte` selbst fuellt? */
export function imTeichfeld(teich, x, z) {
  if (!teich) return false;
  const d = teich.rScheibe + 0.6;
  return (x - teich.x) ** 2 + (z - teich.z) ** 2 < d * d;
}

/* ---------------- Die Wasserflaeche ---------------- */

/**
 * DREI STUFEN, EIN NETZ.
 *
 *   einfarbig    Eine Flaeche in einer Farbe, mit der Normalkarte als
 *                Oberflaechenstruktur. Kostet so viel wie jedes andere Dreieck
 *                und laeuft ueberall.
 *   spiegel      Ein echter Spiegel: die Szene wird je Bild ein zweites Mal
 *                gezeichnet, aus der an der Wasserebene gespiegelten Kamera.
 *
 * Dazwischen stand einmal eine metallische Stufe: spiegelnd gegen eine gemalte
 * Umgebung, ohne zweiten Durchgang. Sie ist entfallen. Eine gemalte Umgebung
 * kann nur zeigen, was auf ihr gemalt ist - Himmel und eine gruene Flaeche -,
 * und das sah dem Wasser nicht aehnlich, sondern nach Blech aus. Zwischen
 * „einfarbig" und „richtig gespiegelt" liegt hier nichts Ueberzeugendes.
 *
 * Gemessen kostet der Spiegel etwa so viel wie ein zweites Bild - beim
 * dichtesten Standpunkt 0,35 ms gegen 0,31 ms. Das ist bezahlbar; teuer ist
 * daran die GEOMETRIE, nicht die Aufloesung (vierfache Pixelzahl kostete 6 %).
 * Deshalb spiegelt er in voller Aufloesung, laesst dafuer aber das Gras
 * draussen - 122 000 Halme, die im Spiegelbild ohnehin niemand einzeln sieht.
 */
export function baueWasser(teich, cfg, normalKarte, qualitaet) {
  if (!teich) return null;
  const geo = scheibenNetz(teich);

  const karte = normalKarte.clone();
  karte.needsUpdate = true;
  karte.wrapS = karte.wrapT = THREE.RepeatWrapping;

  if (qualitaet === 'spiegel') return spiegelFlaeche(geo, teich, karte, cfg);

  const material = new THREE.MeshStandardMaterial({
    // Gruenlich, hell, wenig gesaettigt - stehendes Wasser in einer Wiese ist
    // kein Meerblau.
    color: 0x6f9179,
    normalMap: karte,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 0.45,
    metalness: 0.1,
    wireframe: cfg.drahtgitter,
  });
  // Die Normalkarte in Metern kacheln, nicht ueber die ganze Scheibe.
  karte.repeat.set(teich.rScheibe / 1.5, teich.rScheibe / 1.5);

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(teich.x, teich.spiegel, teich.z);
  mesh.name = 'wasser';
  mesh.receiveShadow = false;
  // Auch ohne Spiegel gilt in der Karte das Graublau - die beiden Stufen
  // sollen dort nicht verschieden aussehen.
  const gruen = material.color.clone();
  const grau = new THREE.Color(KARTEN_FARBE);
  mesh.onBeforeRender = (renderer, scene, camera) => {
    material.color.copy(camera.isPerspectiveCamera ? gruen : grau);
  };
  return mesh;
}

/**
 * DIE WASSERSCHEIBE, dem Ufer nachgezogen.
 *
 * Sie endet genau dort, wo die Boeschung wieder auf Gelaendehoehe angekommen
 * ist - also am aeusseren Rand dessen, was ueberhaupt abgesenkt wurde. Weiter
 * darf sie nicht: dahinter liegt unberuehrtes Gelaende, und wo das tiefer liegt
 * als der Spiegel, stuende sonst Wasser mitten in der Wiese. Naeher darf sie
 * auch nicht, sonst schwebte ihre Kante frei ueber dem Hang.
 */
function scheibenNetz(teich, segmente = 128) {
  const pos = [0, 0, 0];
  const uv = [0.5, 0.5];
  const nor = [0, 1, 0];
  const idx = [];
  const mass = teich.rBecken * 1.2 + teich.rUfer;      // fuer die Kachelung
  for (let i = 0; i < segmente; i++) {
    const w = (i / segmente) * Math.PI * 2;
    const r = beckenHalbmesser(teich, w) + teich.rUfer;
    const x = Math.cos(w) * r, z = Math.sin(w) * r;
    pos.push(x, 0, z);
    uv.push(0.5 + x / (2 * mass), 0.5 + z / (2 * mass));
    nor.push(0, 1, 0);
  }
  // Wicklung gegen den Uhrzeigersinn IN DER EBENE, damit die Flaeche nach oben
  // blickt - mit wachsendem Winkel laeuft sie in x/z andersherum, als man es
  // von einem Bildschirm gewohnt ist.
  for (let i = 0; i < segmente; i++) {
    idx.push(0, 1 + ((i + 1) % segmente), 1 + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Der echte Spiegel.
 *
 * Die virtuelle Kamera wird nicht mit einer Spiegelmatrix gebaut, sondern aus
 * gespiegelter Position, gespiegeltem Ziel und gespiegeltem Oben. Eine
 * Spiegelmatrix kehrt die Haendigkeit um; alle Vorderseiten waeren danach
 * Rueckseiten, und man saehe die Szene von innen.
 *
 * Dazu die SCHIEFE NAHEBENE: die dritte Zeile der Projektionsmatrix wird durch
 * die Wasserebene ersetzt, damit alles, was unter Wasser liegt, gar nicht erst
 * gezeichnet wird. Ohne sie spiegelte sich der Beckenboden mit.
 */
function spiegelFlaeche(geo, teich, karte, cfg) {
  const ziel = new THREE.WebGLRenderTarget(1024, 1024, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const spiegelKamera = new THREE.PerspectiveCamera();
  const texturMatrix = new THREE.Matrix4();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tSpiegel: { value: ziel.texture },
      tNormal: { value: karte },
      texturMatrix: { value: texturMatrix },
      farbe: { value: new THREE.Color(0x6f9179) },
      // 1, solange die Karte gezeichnet wird - dann tritt `kartenFarbe` an die
      // Stelle von allem, was der Spiegel sonst beitraegt.
      karte: { value: 0 },
      kartenFarbe: { value: new THREE.Color(KARTEN_FARBE) },
      // WIE VIEL WASSERFARBE UEBERHAUPT MITSPIELT. Null heisst: reiner
      // Spiegel, so klar wie die Rechnung ihn hergibt. Eine Toenung macht das
      // Bild ruhiger, kostet aber genau die Klarheit, fuer die der zweite
      // Durchgang bezahlt wurde - deshalb ist sie ab Werk aus und ein Regler.
      toenung: { value: 0 },
      zeit: { value: 0 },
      wellen: { value: 0.042 },
    },
    vertexShader: `
      uniform mat4 texturMatrix;
      varying vec4 vSpiegel;
      varying vec3 vWelt;
      void main() {
        vec4 welt = modelMatrix * vec4(position, 1.0);
        vWelt = welt.xyz;
        vSpiegel = texturMatrix * welt;
        gl_Position = projectionMatrix * viewMatrix * welt;
      }
    `,
    fragmentShader: `
      uniform sampler2D tSpiegel;
      uniform sampler2D tNormal;
      uniform vec3 farbe;
      uniform float karte;
      uniform vec3 kartenFarbe;
      uniform float toenung;
      uniform float zeit;
      uniform float wellen;
      varying vec4 vSpiegel;
      varying vec3 vWelt;
      void main() {
        // Zwei gegenlaeufige Lagen derselben Karte - eine allein zoege als
        // erkennbares Muster ueber die Flaeche.
        // GROESSERE WELLEN, GLEICHE GESCHWINDIGKEIT. Der Massstab und der
        // Vorschub sind gemeinsam heruntergesetzt: die Karte laeuft dadurch in
        // Weltmetern genauso schnell wie vorher, ihr Muster ist nur groeber.
        vec3 n1 = texture2D(tNormal, vWelt.xz * 0.210 + vec2( 0.0147,  0.0098) * zeit).rgb;
        vec3 n2 = texture2D(tNormal, vWelt.xz * 0.091 + vec2(-0.0091,  0.0133) * zeit).rgb;
        vec2 stoerung = (n1.xy + n2.xy - 1.0) * wellen;

        // DIE SPIEGELTEXTUR HAT EINEN RAND, und hinter ihm steht nichts.
        //
        // Sie zeigt genau das, was die gespiegelte Kamera sieht - also den
        // Bildausschnitt. Wo die Wasserflaeche bis an den Bildrand laeuft,
        // schiebt die Wellenstoerung die Abtastung darueber hinaus, und dort
        // gibt es keine Auskunft mehr: der Randpixel wird zu einem Streifen
        // ausgezogen, und quer zur Kante entstehen die Fransen.
        //
        // Zwei Massnahmen, und beide braucht es. Die Stoerung wird nahe dem
        // Rand ausgeblendet, damit die Abtastung gar nicht erst hinauslaeuft -
        // ein weicher Uebergang ueber einen schmalen Saum, den man nicht sieht,
        // weil die Wellen dort ohnehin fast senkrecht betrachtet werden. Und
        // was danach noch draussen liegt, wird auf den Rand geklemmt statt
        // fortgesetzt: dann steht dort der Randpixel, wie er soll.
        //
        // Geteilt wird von Hand statt mit texture2DProj: hinter der Kamera wird
        // w negativ, und die Projektion lieferte dann einen Punkt aus dem
        // Nichts.
        float w = max(vSpiegel.w, 1e-4);
        vec2 basis = vSpiegel.xy / w;
        float saum = min(min(basis.x, 1.0 - basis.x), min(basis.y, 1.0 - basis.y));
        float daempfung = clamp(saum / 0.05, 0.0, 1.0);
        vec2 abtast = clamp(basis + stoerung * daempfung, 0.0, 1.0);
        vec3 gespiegelt = texture2D(tSpiegel, abtast).rgb;

        // Fresnel: von oben sieht man ins Wasser, flach darueber den Spiegel.
        // Bei ausgeschalteter Toenung faellt er weg - dann ist die Flaeche
        // ueberall Spiegel, und genau das war gewuenscht: erst so klar wie
        // moeglich, die Faerbung danach.
        vec3 blick = normalize(cameraPosition - vWelt);
        float f = pow(1.0 - clamp(blick.y, 0.0, 1.0), 2.5);
        float anteil = mix(1.0, 0.12 + 0.80 * f, toenung);
        vec3 ergebnis = mix(farbe, gespiegelt, anteil);
        // IN DER KARTE FAELLT ALLES DAVON WEG. Ueberblendet statt verzweigt:
        // karte ist 0 oder 1, und ein Zweig im Fragmentshader kostet mehr,
        // als er hier spart.
        ergebnis = mix(ergebnis, kartenFarbe, karte);
        gl_FragColor = vec4(ergebnis, 1.0);
        // OHNE DIESE ZEILE IST DAS WASSER TINTE.
        //
        // Derselbe Fehler, den buildSky in scene.js schon einmal hatte: eine
        // THREE.Color rechnet ihren Hexwert in den linearen Arbeitsfarbraum um,
        // der Bildschirm will ihn aber in sRGB. Die Standardmaterialien haengen
        // die Rueckrechnung selbst an, ein eigener Shader muss es tun - sonst
        // kommt jede Farbe deutlich zu dunkel und zu satt heraus. Das
        // Spiegelbild kommt ebenfalls linear aus dem Renderziel und braucht
        // dieselbe Behandlung.
        #include <colorspace_fragment>
      }
    `,
    wireframe: cfg.drahtgitter,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(teich.x, teich.spiegel, teich.z);
  mesh.name = 'wasser';
  // Was NICHT gespiegelt wird - vom Aufrufer gefuellt (siehe `garden.js`).
  mesh.userData.nichtSpiegeln = [];
  mesh.userData.zielGroesse = 1024;

  const masse = new THREE.Vector2();
  const ebene = new THREE.Plane();
  const normale = new THREE.Vector3(0, 1, 0);
  const ort = new THREE.Vector3();
  const kOrt = new THREE.Vector3();
  const blick = new THREE.Vector3();
  const ziel3 = new THREE.Vector3();
  const dreh = new THREE.Matrix4();
  const schief = new THREE.Vector4();
  const q = new THREE.Vector4();

  mesh.onBeforeRender = function (renderer, scene, camera) {
    if (mesh.userData.imSpiegel) return;      // keine Spiegelung im Spiegel
    // In der Vogelperspektive blickt eine ORTHOGRAFISCHE Kamera auf den Garten.
    // Fuer die taugt die Konstruktion nicht, und gebraucht wird sie dort auch
    // nicht: die Karte ist eine Zeichnung, kein Bild.
    //
    // Der Shader muss das WISSEN. Sonst zeigte er weiter das Renderziel her,
    // und darin steht noch das letzte Spiegelbild aus der Augenhoehe - genau
    // die Streifen, die quer ueber dem Teich lagen. Gesetzt wird die Kennung
    // deshalb VOR dem Abbruch; three laedt die Uniforms erst danach hoch, der
    // Wert gilt also schon fuer diesen Zug.
    const inKarte = !camera.isPerspectiveCamera;
    material.uniforms.karte.value = inKarte ? 1 : 0;
    if (inKarte) return;

    // DAS ZIEL BEKOMMT DAS SEITENVERHAELTNIS DES BILDES, in CSS-Punkten.
    // Quadratisch gerechnet waere es zwar in sich stimmig - die Texturmatrix
    // zoege es wieder gerade -, aber quer verloere es die Haelfte seiner
    // Aufloesung.
    //
    // Die halbe Kantenzahl gegenueber der Leinwand ist Absicht und faellt nicht
    // auf. Hier stand zwischendurch die Geraetegroesse, weil die Krone im
    // Spiegel verwaschen wirkte - das lag aber nicht an der Aufloesung, sondern
    // daran, dass ihr RawShaderMaterial in ein Renderziel schon in sRGB
    // schrieb, waehrend alles andere linear ankam; der Spiegel rechnete dann
    // ein zweites Mal um. Das ist an der Quelle behoben (`billboardMaterial` in
    // baumloader/baum-import.js), und damit reicht die halbe Kantenzahl wieder.
    renderer.getSize(masse);
    const lang = Math.max(1, Math.round(Math.min(1024, Math.max(masse.x, masse.y))));
    const kurz = Math.max(1, Math.round(lang * (masse.x > masse.y ? masse.y / masse.x : masse.x / masse.y)));
    const br = masse.x >= masse.y ? lang : kurz;
    const ho = masse.x >= masse.y ? kurz : lang;
    if (ziel.width !== br || ziel.height !== ho) ziel.setSize(br, ho);

    ort.setFromMatrixPosition(mesh.matrixWorld);
    kOrt.setFromMatrixPosition(camera.matrixWorld);
    blick.subVectors(ort, kOrt);
    if (blick.dot(normale) > 0) return;       // von unten - nichts zu spiegeln

    blick.reflect(normale).negate().add(ort);
    dreh.extractRotation(camera.matrixWorld);
    ziel3.set(0, 0, -1).applyMatrix4(dreh).add(kOrt);
    ziel3.subVectors(ort, ziel3).reflect(normale).negate().add(ort);

    spiegelKamera.position.copy(blick);
    spiegelKamera.up.set(0, 1, 0).applyMatrix4(dreh).reflect(normale);
    spiegelKamera.lookAt(ziel3);
    spiegelKamera.updateMatrixWorld();
    // DIE PROJEKTION WIRD UEBERNOMMEN, nicht neu gerechnet. Sie muss genau die
    // der Bildkamera sein - dieselbe Oeffnung, dasselbe Seitenverhaeltnis -,
    // sonst fehlte im Spiegelbild seitlich ein Stueck. `updateProjectionMatrix`
    // darf danach nicht mehr laufen, es warf die Kopie wieder weg.
    spiegelKamera.projectionMatrix.copy(camera.projectionMatrix);
    spiegelKamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);

    // Weltkoordinate -> Bildkoordinate der Spiegeltextur
    texturMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    texturMatrix.multiply(spiegelKamera.projectionMatrix);
    texturMatrix.multiply(spiegelKamera.matrixWorldInverse);

    // Schiefe Nahebene auf Hoehe des Wassers
    ebene.setFromNormalAndCoplanarPoint(normale, ort);
    ebene.applyMatrix4(spiegelKamera.matrixWorldInverse);
    schief.set(ebene.normal.x, ebene.normal.y, ebene.normal.z, ebene.constant);
    const pm = spiegelKamera.projectionMatrix;
    q.x = (Math.sign(schief.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(schief.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    schief.multiplyScalar(2.0 / schief.dot(q));
    pm.elements[2] = schief.x;
    pm.elements[6] = schief.y;
    pm.elements[10] = schief.z + 1.0 - 0.003;
    pm.elements[14] = schief.w;

    const versteckt = mesh.userData.nichtSpiegeln;
    for (const o of versteckt) o.visible = false;
    mesh.visible = false;
    mesh.userData.imSpiegel = true;

    const altesZiel = renderer.getRenderTarget();
    const altAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;      // der Schatten ist eingebacken
    renderer.setRenderTarget(ziel);
    renderer.clear();
    renderer.render(scene, spiegelKamera);
    renderer.setRenderTarget(altesZiel);
    renderer.shadowMap.autoUpdate = altAuto;

    mesh.userData.imSpiegel = false;
    mesh.visible = true;
    for (const o of versteckt) o.visible = true;
  };

  mesh.userData.tick = (t) => { material.uniforms.zeit.value = t; };
  mesh.userData.setzeToenung = (v) => { material.uniforms.toenung.value = v; };
  mesh.userData.ziel = ziel;                  // zum Nachmessen
  mesh.userData.dispose = () => ziel.dispose();
  return mesh;
}
