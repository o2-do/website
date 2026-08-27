import * as THREE from 'three';
import { updateTranslucency } from './translucency.js';
import { sonnenRichtung } from './baumloader.js';

// Zenit und Horizont des Himmelsverlaufs. SKY_BOTTOM ist zugleich die
// Nebelfarbe - was in den Dunst laeuft, trifft dort genau auf den Himmel.
const SKY_TOP = new THREE.Color(0x5588ff);
const SKY_BOTTOM = new THREE.Color(0xccddff);

function buildSky() {
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: SKY_TOP },
      bottom: { value: SKY_BOTTOM },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom;
      varying vec3 vDir;
      void main() {
        // 2. Den oberen Wert von smoothstep deutlich anheben (z. B. auf 0.85 oder 0.95),
        // damit das Grau weiter nach oben gezogen wird.
        float t = smoothstep(-0.05, 0.85, vDir.y);
        gl_FragColor = vec4(mix(bottom, top, t), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * WIE NAH DIE KAMERA AN ETWAS HERANDARF.
 *
 * Die Near-Plane bewusst nicht bei 0.1: die Wegbaender und die
 * Kreuzungsflaechen liegen nur 1–2 cm auseinander, und die Tiefenaufloesung
 * faellt quadratisch mit der Entfernung und linear mit 1/near. Bei 0.1
 * flackert es in der Ferne.
 *
 * Daraus folgt ein MINDESTABSTAND zu allem, was fest ist. Geschnitten wird
 * nach der TIEFE, nicht nach der Entfernung: ein Gegenstand am Bildrand steht
 * schraeg zur Blickachse, seine Tiefe ist entsprechend kleiner als sein
 * Abstand. In der Bildecke ist der Richtungskosinus
 *
 *     cos = 1 / sqrt(1 + tan(v/2)^2 + (tan(v/2)*Seitenverhaeltnis)^2)
 *
 * und bei weitestem Blickwinkel (60 Grad durch den kleinsten Zoom 0,75 macht
 * 80 Grad) und einem breiten Fenster (2,2:1, also Querformat auf dem Telefon)
 * sind das rund 0,45. Aus 0,40 m Tiefe werden damit 0,89 m Abstand.
 *
 * Wer den Wert benutzt, findet ihn in `garden.js` (Hindernisraster) und in
 * `main.js`/`game.js` (Auslauf vor dem Zaun) wieder.
 */
export const NEAR = 0.4;
export const KAMERA_FREI = 0.9;

export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(SKY_BOTTOM.getHex(), 0.0045);

  const sky = buildSky();
  scene.add(sky);

  // Waldhorizont: ein Zylinder um die Gartenmitte, von innen betrachtet, mit
  // dem Silhouettenstreifen bespannt. Die durchsichtigen Stellen des Bildes
  // werden per alphaTest verworfen statt echt transparent gezeichnet - sonst
  // muesste nach Tiefe sortiert werden, und der Wald verdeckte den Himmel
  // falsch. Der Nebel greift, damit er wie alles andere in den Dunst laeuft.
  const forestMat = new THREE.MeshBasicMaterial({
    transparent: false, alphaTest: 0.5, side: THREE.BackSide,
    fog: true, depthWrite: true,
  });
  let forest = null;
  function setForest(texture, radius, hoehe, an) {
    if (forest) { scene.remove(forest); forest.geometry.dispose(); forest = null; }
    if (!an || !texture) return;
    forestMat.map = texture;
    forestMat.needsUpdate = true;
    // Waagerecht so oft kacheln, dass das Bild sein Seitenverhaeltnis behaelt.
    // Ganzzahlig, sonst klafft an der Naht ein halber Baum.
    const bild = texture.image;
    const seiten = bild && bild.height ? bild.width / bild.height : 2.4;
    const kacheln = Math.max(1, Math.round((2 * Math.PI * radius) / (hoehe * seiten)));
    texture.repeat.set(kacheln, 1);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    const geo = new THREE.CylinderGeometry(radius, radius, hoehe, 96, 1, true);
    forest = new THREE.Mesh(geo, forestMat);
    forest.position.y = hoehe / 2;         // Fuss auf der Ebene y = 0
    forest.name = 'waldhorizont';
    forest.frustumCulled = false;
    scene.add(forest);
    forest.visible = active === walkCam;
  }

  // Zwei Lichter, und ihr Verhaeltnis macht den Eindruck: das Hemisphaerenlicht
  // ist das Himmelslicht, das ueberallhin faellt und den Schatten aufhellt, die
  // Sonne das gerichtete darueber. Beide zusammen bestimmen die Helligkeit,
  // ihr Abstand den Kontrast - die Sonne liegt deshalb deutlich hoeher.
  // Die obere Farbe ist absichtlich viel blasser als der gemalte Himmel: als
  // Licht wirkt sie auf alles, ein gesaettigtes Blau faerbte den ganzen Garten
  // kalt ein. Blaeulich bleibt der Schatten trotzdem, warm die Sonne dagegen.
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x6b7d45, 2.0);
  scene.add(hemi);
  // Die Sonnenrichtung ist nicht mehr frei: die drei Schattenbilder in jeder
  // Baumdatei sind fuer einen festen Stand gerechnet (Suedost, 20 Grad aus der
  // Senkrechten). Stuende die Sonne der Szene woanders, faellt der gebrannte
  // Schatten in die eine und der geworfene in die andere Richtung.
  const SONNE = sonnenRichtung();
  const sun = new THREE.DirectionalLight(0xfff0d6, 3.0);
  sun.position.copy(SONNE).multiplyScalar(100);
  scene.add(sun);
  scene.add(sun.target);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  // Zwei Betriebsarten, umschaltbar:
  //
  //   'jeBild'      Die Karte wird jedes Bild neu gerechnet (three macht das von
  //                 selbst, solange `autoUpdate` steht). Was man sieht, ist der
  //                 Schatten dessen, was gerade dasteht - auch wenn sich etwas
  //                 bewegt oder die Detailstufe umschaltet.
  //   'eingebrannt' Einmal gerechnet, dann eingefroren. Sonne und Garten stehen
  //                 fest, es gibt also nichts nachzufuehren - und der
  //                 Schattendurchgang faellt je Bild ersatzlos weg.

  const walkCam = new THREE.PerspectiveCamera(60, 1, NEAR, 2000);
  walkCam.rotation.order = 'YXZ';

  // Der Sichtwinkel in Augenhoehe hat zwei Anteile, und sie gehoeren getrennt:
  //
  //   grad   Der Blickwinkel des Objektivs. Er steht im Formular und ist eine
  //          Gestaltungsentscheidung - 60 Grad zeigen viel und lassen die
  //          Landschaft weit wirken, 45 Grad zeigen einen ruhigeren Ausschnitt
  //          mit weniger Randverzerrung.
  //   zoom   Das Mausrad. Es macht den Ausschnitt enger, ohne den eingestellten
  //          Blickwinkel zu vergessen - beim Zurueckdrehen steht wieder genau
  //          der da, der im Formular gewaehlt ist.
  //
  // Gerechnet wird `fov = grad / zoom`; auf `walkCam.fov` steht also immer der
  // WIRKSAME Winkel. Das ist wichtig, weil main.js aus ihm den Drehwinkel eines
  // Doppelklicks ableitet - der muss zum Bild passen, nicht zur Voreinstellung.
  const geh = { grad: 60, zoom: 1 };
  const GEH_ZOOM_MIN = 0.75, GEH_ZOOM_MAX = 8;
  function gehUpdate() {
    walkCam.fov = Math.min(100, Math.max(6, geh.grad / geh.zoom));
    walkCam.updateProjectionMatrix();
  }

  // Die Vogelperspektive ist eine Landkarte und deshalb orthogonal: alle
  // Sehstrahlen laufen parallel, der Massstab ist vorn wie hinten derselbe und
  // nichts stuerzt. Zwei Dinge folgen daraus:
  //
  //   - Die Groesse des Bildes haengt nicht mehr vom Abstand ab, sondern allein
  //     vom Ausschnitt (left/right/top/bottom). Der Abstand dient nur noch
  //     dazu, den Garten ganz zwischen Near- und Far-Ebene zu bekommen.
  //   - Zoom heisst hier nicht "naeher herangehen" (das aenderte nichts),
  //     sondern den Ausschnitt enger ziehen - `zoom` der Kamera tut genau das.
  //
  // Echte Isometrie: arctan(1/√2) = 35,264° ueber dem Horizont. Genau bei
  // diesem Winkel steht die Blickrichtung auf der Raumdiagonalen (1,1,1), und
  // nur dann sind alle drei Achsen gleich stark verkuerzt - daher der Name.
  //
  // Streng genommen gilt das zusaetzlich nur bei 45°, 135°, … Azimut, wenn man
  // also schraeg auf die Ecken schaut. Weil sich der Garten frei drehen laesst,
  // trifft es hier an vier Stellen genau zu; dazwischen ist es eine allgemeine
  // Axonometrie. Der Charakter - Parallelprojektion, fester Neigungswinkel,
  // gleicher Massstab vorn wie hinten - bleibt in jeder Drehung derselbe.
  const BIRD_EL = Math.atan(1 / Math.SQRT2);
  const BAUM_HOCH = 20;                    // Baumhoehe in m, fuer den Ausschnitt
  const birdCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  const bird = { az: 0, radius: 50, zoom: 1 };
  let seiten = 1;                          // Seitenverhaeltnis des Canvas

  let active = walkCam;
  const state = { onFrame: null, last: performance.now(), fps: 0, frames: 0, fpsT: 0 };

  // Die Vogelperspektive ist eine Landkarte, keine Landschaft: kein Himmel,
  // kein Nebel, kein Wald, weisser Grund. Die weite Wiesenscheibe bis zum
  // Horizont faellt weg; stattdessen deckt die weisse Maske alles ab, was
  // ausserhalb des runden Ausschnitts liegt. Der Kasten schliesst den Garten
  // nach unten.
  const nebel = scene.fog;
  const teile = { horizont: null, maske: null, kasten: null };
  function applyView() {
    const bird = active === birdCam;
    sky.visible = !bird;
    if (forest) forest.visible = !bird;
    if (teile.horizont) teile.horizont.visible = !bird;
    if (teile.maske) teile.maske.visible = bird;
    if (teile.kasten) teile.kasten.visible = bird;
    // Grasbueschel bleiben aus der Karte draussen: von oben sind sie nur ein
    // Rauschen, stellen aber die Haelfte aller Dreiecke, und die Karte hat als
    // einzige Ansicht immer den ganzen Garten im Bild.
    //
    // Die Beete bleiben stehen. Sie waren zuerst ebenfalls draussen, aber ihr
    // Schatten steckt in der Bodenkarte und laesst sich nicht mit ausblenden -
    // uebrig blieben Schattenflecken auf blanker Wiese.
    scene.traverse((o) => {
      if (o.userData.nurAugenhoehe) o.visible = !bird;
    });
    scene.fog = bird ? null : nebel;
    renderer.setClearColor(0xffffff, 1);
  }

  /**
   * Standpunkt und Ausschnitt der Kartenkamera herstellen. Beides haengt am
   * Azimut, am Zoom und am Seitenverhaeltnis des Canvas - jede Aenderung daran
   * ruft hier wieder herein.
   */
  function birdUpdate() {
    const c = Math.cos(BIRD_EL), s = Math.sin(BIRD_EL);
    // Der Abstand bestimmt bei einer Parallelprojektion nicht die Groesse,
    // sondern nur, dass alles zwischen Near und Far liegt. Deshalb weit weg.
    const d = bird.radius * 4;
    birdCam.position.set(d * c * Math.sin(bird.az), d * s, d * c * Math.cos(bird.az));
    birdCam.up.set(0, 1, 0);
    birdCam.lookAt(0, 0, 0);

    // Der Ausschnitt: waagerecht muss der Garten hineinpassen, senkrecht seine
    // um sin(Neigung) verkuerzte Tiefe plus die Hoehe der Baeume, die sich mit
    // cos(Neigung) ins Bild legt. Was von beidem mehr verlangt, gibt den
    // Massstab vor.
    const halbBreite = bird.radius * 1.06;
    const halbHoehe = bird.radius * 1.06 * s + BAUM_HOCH * c;
    const hoehe = Math.max(halbHoehe, halbBreite / seiten) / bird.zoom;
    birdCam.left = -hoehe * seiten; birdCam.right = hoehe * seiten;
    birdCam.top = hoehe; birdCam.bottom = -hoehe;
    birdCam.near = 0.1; birdCam.far = d * 2;
    birdCam.updateProjectionMatrix();
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    seiten = w / h;
    walkCam.aspect = seiten;
    walkCam.updateProjectionMatrix();
    // Die Karte hat kein `aspect`; ihr Seitenverhaeltnis steckt im Ausschnitt.
    birdUpdate();
  }
  window.addEventListener('resize', resize);
  resize();

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    state.frames++;
    state.fpsT += dt;
    if (state.fpsT >= 0.5) {
      state.fps = state.frames / state.fpsT;
      state.frames = 0; state.fpsT = 0;
    }
    if (state.onFrame) state.onFrame(dt);
    // Das Gegenlicht der Blaetter rechnet im Sichtraum - die Sonnenrichtung
    // muss deshalb jedem Kamerawechsel folgen.
    updateTranslucency(active, sun.position);
    sky.position.copy(active.position);
    sky.scale.setScalar(active.far * 0.9);
    renderer.render(scene, active);
  }
  requestAnimationFrame(loop);

  const viewer = {
    renderer, scene, walkCam, birdCam,
    get camera() { return active; },
    setCamera(which) { active = which === 'bird' ? birdCam : walkCam; applyView(); },
    isBird: () => active === birdCam,
    setFog(density) { nebel.density = density; },

    /** Waldsilhouette am Horizont, nur in Augenhoehe sichtbar. */
    setForest,
    /**
     * Die Teile, die je nach Ansicht ein- und ausgeblendet werden: weite
     * Horizontscheibe (Augenhoehe), weisse Maske und Kasten (Karte).
     */
    setViewParts(horizont, maske, kasten) {
      teile.horizont = horizont; teile.maske = maske; teile.kasten = kasten;
      applyView();
    },

    /* --- Vogelperspektive: Parallelprojektion, feste Neigung --- */
    birdFit(radius) {
      bird.radius = radius;
      bird.az = 0;
      bird.zoom = 1;
      birdUpdate();
    },
    /**
     * Ziehen dreht den Garten nur noch um die Hochachse; die Neigung steht.
     * Nach rechts ziehen fasst die Vorderkante des Gartens an und schiebt sie
     * nach rechts - der Garten dreht sich also gegen den Uhrzeigersinn. Das ist
     * die Karten-Gebaerde und damit umgekehrt zum Umsehen in Augenhoehe, wo die
     * Kamera selbst gedreht wird.
     */
    birdOrbit(dAz) {
      bird.az -= dAz;
      birdUpdate();
    },
    birdUpdate,

    /** Der Blickwinkel des Objektivs in Augenhoehe, in Grad. Zoom bleibt stehen. */
    setBlickwinkel(grad) {
      const g = Math.min(100, Math.max(10, +grad || 60));
      if (g === geh.grad) return;
      geh.grad = g;
      gehUpdate();
    },

    /**
     * Mausrad, in beiden Ansichten dasselbe Verhaeltnis je Raste. In Augenhoehe
     * wird der Sichtwinkel enger gezogen, in der Karte der Ausschnitt - eine
     * Parallelprojektion hat keinen Sichtwinkel, den man aendern koennte.
     */
    zoom(delta) {
      const f = delta > 0 ? 0.9 : 1 / 0.9;
      if (active === birdCam) {
        bird.zoom = Math.min(6, Math.max(0.5, bird.zoom * f));
        birdUpdate();
        return bird.zoom;
      }
      // Am Rad heisst „vorwaerts" naeher heran, also enger. Der Faktor wirkt
      // deshalb umgekehrt wie auf den Ausschnitt der Karte.
      geh.zoom = Math.min(GEH_ZOOM_MAX, Math.max(GEH_ZOOM_MIN, geh.zoom / f));
      gehUpdate();
      return geh.zoom;
    },

    /** Zoom in Augenhoehe zurueck auf den eingestellten Blickwinkel. */
    zoomZurueck() { geh.zoom = 1; gehUpdate(); },

    /** Der WIRKSAME Sichtwinkel in Augenhoehe (Blickwinkel geteilt durch Zoom). */
    get fov() { return walkCam.fov; },
    /** Der eingestellte Blickwinkel und der Zoom darauf - fuer die Anzeige. */
    get blickwinkel() { return geh.grad; },
    get gehZoom() { return geh.zoom; },
    /** Neigung der Karte in Grad und ihr Zoomfaktor - fuer die Anzeige. */
    get kartenNeigung() { return BIRD_EL * 180 / Math.PI; },
    get kartenZoom() { return bird.zoom; },

    // Schattenkamera auf die Gartengroesse spannen (2048er Map / 2.3R Kantenlaenge)
    fitShadow(radius) {
      const d = radius * 2.2;
      sun.position.copy(SONNE).multiplyScalar(d);
      sun.target.position.set(0, 0, 0);
      sun.target.updateMatrixWorld();
      const c = sun.shadow.camera;
      c.left = -radius * 1.15; c.right = radius * 1.15;
      c.top = radius * 1.15; c.bottom = -radius * 1.15;
      c.near = 1; c.far = d * 2.5;
      c.updateProjectionMatrix();
    },

    // Umschalten zur Laufzeit: Shader muessen neu uebersetzt werden.
    setShadows(on) {
      if (renderer.shadowMap.enabled === on) return;
      renderer.shadowMap.enabled = on;
      sun.castShadow = on;
      scene.traverse((o) => {
        if (!o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.needsUpdate = true;
      });
    },

    /** Kantenlaenge der Schattenkarte. */
    setSchattenAufloesung(px) {
      if (sun.shadow.mapSize.x === px) return;
      sun.shadow.mapSize.set(px, px);
      // Die alte Karte muss weg, sonst behaelt three ihre Groesse bei.
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    },

    /**
     * 'jeBild' oder 'eingebrannt'. Beim Wechsel auf 'eingebrannt' wird sofort
     * einmal gerechnet - sonst staende der Garten bis zum naechsten Anlass ohne
     * Schatten da, und von selbst entsteht keiner mehr.
     */
    setSchattenArt(art) {
      const eingebrannt = art === 'eingebrannt';
      renderer.shadowMap.autoUpdate = !eingebrannt;
      if (eingebrannt) renderer.shadowMap.needsUpdate = true;
    },

    /**
     * Die Karte neu einbrennen. Noetig nach jedem Neuaufbau, nach einer
     * geaenderten Aufloesung - und immer dann, wenn sich geaendert hat, WAS
     * Schatten wirft.
     *
     * `renderer.shadowMap.needsUpdate` allein genuegt nicht: Gerechnet wird
     * erst im naechsten `render()`. Deshalb wird hier von Hand eines ausgeloest.
     * three setzt das Kennzeichen danach selbst zurueck.
     */
    backeSchatten() {
      if (!renderer.shadowMap.enabled) return false;
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, active);
      return true;
    },

    /**
     * DIE SHADER VORHER UEBERSETZEN.
     *
     * three uebersetzt das Programm eines Materials erst, wenn das Objekt zum
     * ersten Mal im Bild ist. Beim Umsehen kommt also staendig ein neues dazu,
     * und jede Uebersetzung haelt den Hauptfaden fuer Zehntelsekunden an - das
     * ist das Ruckeln, das anfaengt, sobald viel im Blick ist, waehrend der
     * Bildzaehler weiter 60 anzeigt (er mittelt ueber eine halbe Sekunde und
     * merkt einzelne lange Bilder kaum).
     *
     * Deshalb wird nach dem Aufbau einmal alles uebersetzt, was in der Szene
     * steht - ob es gerade zu sehen ist oder nicht.
     */
    async waermeShader() {
      const vorher = renderer.info.programs.length;
      // ALLES SICHTBAR SCHALTEN, dann uebersetzen. three laeuft mit
      // `traverseVisible` durch die Szene - was beim Aufbau ausgeschaltet ist,
      // bekaeme sonst gerade kein Programm: die Fern-Tafeln der Baeume, das
      // Gras jenseits der Sichtweite, die Teile, die nur die Karte zeigt.
      // Genau die tauchen spaeter beim Umsehen zum ersten Mal auf, und dann
      // waere die Uebersetzung wieder da, wo sie nicht hingehoert.
      const stand = [];
      scene.traverse((o) => { if (!o.visible) { stand.push(o); o.visible = true; } });
      // UND ZWEIMAL, EINMAL JE FARBRAUM. Der Wasserspiegel zeichnet die Szene in
      // ein Renderziel, und dort ist die Ausgabe linear statt sRGB. Das steht im
      // Programmschluessel, also braucht jedes Material, das sich spiegelt, ein
      // ZWEITES Programm - nachgemessen achtzehn Stueck, und die uebersetzten
      // sich bisher genau dann, wenn der Teich ins Bild kam.
      const hilfsziel = new THREE.WebGLRenderTarget(1, 1);
      try {
        for (const ziel of [null, hilfsziel]) {
          renderer.setRenderTarget(ziel);
          if (renderer.compileAsync) await renderer.compileAsync(scene, active);
          else renderer.compile(scene, active);
        }
      } finally {
        renderer.setRenderTarget(null);
        hilfsziel.dispose();
        for (const o of stand) o.visible = false;
      }
      return renderer.info.programs.length - vorher;
    },

    onFrame(fn) { state.onFrame = fn; },
    stats: () => ({ fps: state.fps, ...renderer.info.render }),
    resize,
  };
  return viewer;
}
