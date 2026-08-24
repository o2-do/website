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
  const { x, z, rBecken, rUfer, grund, wellen } = teich;
  // Der Beckenhalbmesser in einer Richtung - Grundmass plus die drei
  // Oberwellen. Nie kleiner als die Haelfte, nie groesser als 1,2 mal.
  const halbmesser = (winkel) => {
    let f = 1;
    for (const w of wellen) f += 0.09 * Math.sin(w.n * winkel + w.phase);
    return rBecken * Math.min(1.2, Math.max(0.5, f));
  };
  let n = 0;
  for (let i = 0; i < P.x.length; i++) {
    if (P.art[i] !== RASTER || P.aus[i]) continue;
    const dx = P.x[i] - x, dz = P.z[i] - z;
    const d = Math.hypot(dx, dz);
    if (d >= rBecken * 1.2 + rUfer) continue;
    const rb = halbmesser(Math.atan2(dz, dx));
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
  const geo = new THREE.CircleGeometry(teich.rScheibe, 64);
  geo.rotateX(-Math.PI / 2);

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
  return mesh;
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

        vec4 uv = vSpiegel;
        uv.xy += stoerung * uv.w;
        vec3 gespiegelt = texture2DProj(tSpiegel, uv).rgb;

        // Fresnel: von oben sieht man ins Wasser, flach darueber den Spiegel.
        // Bei ausgeschalteter Toenung faellt er weg - dann ist die Flaeche
        // ueberall Spiegel, und genau das war gewuenscht: erst so klar wie
        // moeglich, die Faerbung danach.
        vec3 blick = normalize(cameraPosition - vWelt);
        float f = pow(1.0 - clamp(blick.y, 0.0, 1.0), 2.5);
        float anteil = mix(1.0, 0.12 + 0.80 * f, toenung);
        gl_FragColor = vec4(mix(farbe, gespiegelt, anteil), 1.0);
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
    if (!camera.isPerspectiveCamera) return;

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
