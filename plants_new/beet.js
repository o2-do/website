/**
 * beet.js — Beet-Konfigurator
 * ---------------------------
 * Stellt ein rechteckiges Beet dar und verteilt darauf Pflanzen, die der
 * Pflanzen-Generator als JSON exportiert hat. Die Geometrie der Pflanzen kommt
 * über gartenloader.js (`window.Pflanze`) — also über exakt denselben Weg, den
 * auch der Gartensimulator nimmt.
 *
 * Maßeinheiten: hier durchgehend Meter. Der Generator rechnet in Millimetern;
 * die Umrechnung übernimmt gartenloader.js.
 *
 * Koordinaten der Pflanzen zählen von der Beetmitte:
 *   $x -> Weltachse X (rechts),  $y -> Weltachse Z (hinten).
 *
 * Zwei Modi:
 *   EDIT     Feste isometrische Ansicht von schräg oben. Linke Maustaste wählt
 *            eine Pflanze aus und zieht sie an ihren Platz.
 *   ANSICHT  Freies Drehen/Kippen mit der linken Maustaste, Zoom mit dem Rad.
 *
 * Die Beet-Datei speichert zu jeder Pflanze nur ihren Namen ($art), nicht ihre
 * Konfiguration. Beim Laden wird `json/{art}.json` geholt, ersatzweise
 * `{art}.json` neben der Beet-Datei; was fehlt, kann von Hand nachgereicht werden.
 */
(function () {
  'use strict';

  var FORMAT = 'gartensimulator/beet';
  var VERSION = 2;
  var BESCHREIBUNG = 'Beet aus dem Beetkonfigurator';

  // Wo die Pflanzen-JSONs gesucht werden. Der erste Treffer gewinnt.
  var PFLANZEN_PFADE = ['json/', ''];

  var MM_TO_M = 0.001;
  var DEFAULT_NAME = 'beet';
  var ISO_DIR = null;                 // wird nach dem THREE-Check gesetzt
  var SUN_DIR = [-0.62, 0.72, 0.31];  // wie im Pflanzen-Generator

  // ------------------------------------------------------------------ Zustand

  var state = {
    name: DEFAULT_NAME,
    breite: 4.0,
    hoehe: 2.0,
    textur: null,          // Data-URL oder null
    texturName: '',
    kacheln: false,
    kachelgroesse: 0.5,
    kachelpixel: 512,
    pflanzen: []           // { art, x, y, scale, mesh }
  };

  var arten = {};          // art -> { config, geometry, material, durchmesser, hoehe, triangles }
  var selected = null;     // Eintrag aus state.pflanzen
  var mode = 'edit';
  var missing = [];        // Arten, deren Datei beim Laden nicht gefunden wurde

  var el = {};
  var renderer, scene, ground, bedOutline, cage, sun;
  var camEdit, camView, controls;
  var plantRoot, proxies = [];
  var orthoHalfH = 3;      // halbe Höhe des Ortho-Ausschnitts, für Resize gemerkt

  var raycaster, pointer, groundPlane;
  var drag = null;         // { entry, offX, offZ }

  // ------------------------------------------------------------------ Helfer

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function num(v, def) {
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : def;
  }

  function round(v, digits) {
    var f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  }

  /** Dateiname -> Art. Nur die Endung .json fällt weg, "Segge.pflanze" bleibt ganz. */
  function artFromFilename(name) {
    return String(name || '').replace(/\.json$/i, '');
  }

  function cleanName(raw) {
    return String(raw || '').trim()
      .replace(/\.json$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function message(text, kind) {
    el.message.hidden = false;
    el.message.className = kind || '';
    el.message.textContent = text;
  }

  // ------------------------------------------------------------------ Szene

  function buildScene() {
    var canvas = document.getElementById('scene');

    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    THREE.ColorManagement.legacyMode = false;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef1f4);

    // Licht wie im Generator, damit eine Pflanze im Beet so aussieht wie in
    // ihrer Einzelvorschau.
    sun = new THREE.DirectionalLight(0xfff6e8, 2.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);
    scene.add(sun.target);
    scene.add(new THREE.HemisphereLight(0xeef4ff, 0xdcdcd6, 0.35));
    scene.add(new THREE.AmbientLight(0xffffff, 0.12));
    scene.environment = buildEnvMap();

    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x7c6a52, roughness: 1.0, metalness: 0.0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Dünner Umriss knapp über dem Boden — im EDIT-Modus die Bezugskante,
    // an der man sieht, ob eine Pflanze noch im Beet steht.
    bedOutline = new THREE.LineLoop(
      new THREE.BufferGeometry().setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(12), 3)),
      new THREE.LineBasicMaterial({ color: 0x2c3a47 })
    );
    scene.add(bedOutline);

    plantRoot = new THREE.Group();
    scene.add(plantRoot);

    cage = buildCage();
    cage.visible = false;
    scene.add(cage);

    ISO_DIR = new THREE.Vector3(1, 1, 1).normalize();

    // Isometrie = Parallelprojektion. Eine perspektivische Kamera von schräg
    // oben wäre keine, deshalb zwei getrennte Kameras statt einer geteilten.
    camEdit = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 200);
    camView = new THREE.PerspectiveCamera(40, 1, 0.02, 500);

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    animate();
  }

  /**
   * Kleine Studio-Umgebung als Spiegelbild — ohne sie bliebe der Parameter
   * $glanz der Pflanzen wirkungslos (siehe viewer.js im Pflanzen-Generator).
   */
  function buildEnvMap() {
    var W = 256, H = 128;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');

    var grd = x.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.00, '#ffffff');
    grd.addColorStop(0.50, '#c9d4e0');
    grd.addColorStop(1.00, '#e8e4dc');
    x.fillStyle = grd;
    x.fillRect(0, 0, W, H);

    var u = (Math.atan2(SUN_DIR[2], SUN_DIR[0]) / (Math.PI * 2) + 0.5) * W;
    var v = (1 - (Math.asin(SUN_DIR[1]) / Math.PI + 0.5)) * H;
    var spot = x.createRadialGradient(u, v, 0, u, v, H * 0.28);
    spot.addColorStop(0, 'rgba(255,255,255,1)');
    spot.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = spot;
    x.fillRect(0, 0, W, H);

    var tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.encoding = THREE.sRGBEncoding;

    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    var env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose();
    tex.dispose();
    return env;
  }

  /**
   * Auswahlrahmen: zwölf dünne Kästen als Kanten eines Quaders.
   *
   * Ein Drahtgitter aus Linien wäre einfacher, aber `linewidth` wirkt in WebGL
   * fast überall nicht — der Rahmen bliebe immer haarfein. Deshalb echte
   * Körper. `depthTest: false` hält ihn auch dann sichtbar, wenn die Pflanze
   * davor steht.
   */
  function buildCage() {
    var g = new THREE.Group();
    var geo = new THREE.BoxGeometry(1, 1, 1);
    var mat = new THREE.MeshBasicMaterial({ color: 0xff2323, depthTest: false });
    for (var i = 0; i < 12; i++) {
      var m = new THREE.Mesh(geo, mat);
      m.renderOrder = 999;
      g.add(m);
    }
    return g;
  }

  /** Rahmen auf Breite/Tiefe w×d und Höhe h setzen (Ursprung = Fußpunkt). */
  function fitCage(w, d, h) {
    var t = Math.max(0.012, Math.max(w, d) * 0.035);   // "dicker Rahmen"
    var hw = w / 2, hd = d / 2;
    var c = cage.children, n = 0;

    // 4 Kanten in X-Richtung (unten und oben, vorne und hinten)
    [0, h].forEach(function (y) {
      [-hd, hd].forEach(function (z) {
        c[n].scale.set(w + t, t, t);
        c[n].position.set(0, y, z);
        n++;
      });
    });
    // 4 Kanten in Z-Richtung
    [0, h].forEach(function (y) {
      [-hw, hw].forEach(function (x) {
        c[n].scale.set(t, t, d + t);
        c[n].position.set(x, y, 0);
        n++;
      });
    });
    // 4 senkrechte Kanten
    [-hw, hw].forEach(function (x) {
      [-hd, hd].forEach(function (z) {
        c[n].scale.set(t, h, t);
        c[n].position.set(x, h / 2, z);
        n++;
      });
    });
  }

  // ------------------------------------------------------------------ Boden

  function applyGround() {
    ground.geometry.dispose();
    ground.geometry = new THREE.PlaneGeometry(state.breite, state.hoehe);

    var hw = state.breite / 2, hh = state.hoehe / 2, y = 0.003;
    var p = bedOutline.geometry.getAttribute('position');
    p.setXYZ(0, -hw, y, -hh);
    p.setXYZ(1, hw, y, -hh);
    p.setXYZ(2, hw, y, hh);
    p.setXYZ(3, -hw, y, hh);
    p.needsUpdate = true;
    bedOutline.geometry.computeBoundingSphere();

    applyGroundTexture();
    updateShadowCamera();
  }

  function applyGroundTexture() {
    var mat = ground.material;
    if (mat.map) { mat.map.dispose(); mat.map = null; }

    if (!state.textur) {
      mat.color.setHex(0x7c6a52);
      mat.needsUpdate = true;
      updateTexNote();
      return;
    }

    var img = new Image();
    img.onload = function () {
      var tex;
      if (state.kacheln) {
        // Die Kachel ist quadratisch — ein beliebig proportioniertes Bild wird
        // dafür auf kachelpixel × kachelpixel umgerechnet. Nur so stimmt beim
        // Wiederholen das Seitenverhältnis mit der Kachelgröße in Metern überein.
        var n = state.kachelpixel;
        var c = document.createElement('canvas');
        c.width = n; c.height = n;
        c.getContext('2d').drawImage(img, 0, 0, n, n);
        tex = new THREE.CanvasTexture(c);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        var k = Math.max(0.02, state.kachelgroesse);
        tex.repeat.set(state.breite / k, state.hoehe / k);
      } else {
        // Ungekachelt: das Bild wird auf die vollen Beetmaße gezogen, egal
        // welche Größe oder welches Seitenverhältnis es hat.
        tex = new THREE.Texture(img);
        tex.needsUpdate = true;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.repeat.set(1, 1);
      }
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      mat.map = tex;
      mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
      updateTexNote(img.width + ' × ' + img.height + ' px');
    };
    img.onerror = function () {
      message('Die Bodentextur konnte nicht gelesen werden.', 'error');
    };
    img.src = state.textur;
  }

  function updateTexNote(size) {
    if (!state.textur) { el.texNote.textContent = ''; return; }
    if (state.kacheln) {
      var kx = state.breite / Math.max(0.02, state.kachelgroesse);
      var ky = state.hoehe / Math.max(0.02, state.kachelgroesse);
      el.texNote.textContent = 'Kachel ' + state.kachelpixel + ' × ' + state.kachelpixel +
        ' px auf ' + state.kachelgroesse.toFixed(2) + ' m — ' +
        kx.toFixed(1) + ' × ' + ky.toFixed(1) + ' Kacheln im Beet.';
    } else {
      el.texNote.textContent = 'Ungekachelt: das Bild' + (size ? ' (' + size + ')' : '') +
        ' wird auf ' + state.breite.toFixed(2) + ' × ' + state.hoehe.toFixed(2) + ' m gezogen.';
    }
  }

  // ------------------------------------------------------------------ Arten

  /**
   * Eine Pflanzenart aus einer Generator-Konfiguration aufbauen. Geometrie und
   * Material entstehen genau einmal je Art und werden von allen Exemplaren
   * geteilt — zehn gleiche Gräser kosten dadurch nur eine Geometrie.
   */
  function registerArt(art, rawConfig) {
    var cfg = window.Pflanze.normalizeConfig(rawConfig);

    // wurzeltiefe 0: das Beet ist eben, es gibt keinen Hang, unter dem der Fuß
    // verschwinden müsste. Die Halme setzen damit exakt auf y = 0 auf.
    var built = window.Pflanze.buildPlant({ config: cfg, wurzeltiefe: 0 });

    // Der Durchmesser aus der Datei hat Vorrang: er ist der Wert, mit dem der
    // Garten später seine Schattenkarte rechnet. Fehlt er (ältere Datei),
    // liefert die frisch gebaute Geometrie dasselbe Maß.
    var d = (typeof cfg.durchmesser === 'number' && cfg.durchmesser > 0)
      ? cfg.durchmesser * MM_TO_M
      : built.stats.footprint;

    // Dieselbe Art ein zweites Mal einfügen heißt: die Datei wurde inzwischen
    // geändert. Dann wird die Art ersetzt und alle bereits gesetzten Exemplare
    // ziehen mit — sonst stünden im Beet zwei Stände derselben Pflanze.
    var prev = arten[art];

    arten[art] = {
      config: cfg,
      geometry: built.geometry,
      material: window.Pflanze.buildMaterial({ config: cfg }),
      durchmesser: Math.max(d, 0.02),
      hoehe: Math.max(built.stats.height, 0.05),
      triangles: built.stats.triangles
    };

    if (prev) {
      refreshArt(art);
      prev.geometry.dispose();
      disposeMaterial(prev.material);
    }
    return arten[art];
  }

  /** Trägt die Pflanze Kolben, ist das Material ein Array [Blatt, Kolben]. */
  function disposeMaterial(m) {
    (Array.isArray(m) ? m : [m]).forEach(function (x) { x.dispose(); });
  }

  function proxyGeometry(art) {
    return new THREE.CylinderGeometry(art.durchmesser / 2, art.durchmesser / 2, art.hoehe, 12, 1, true);
  }

  /** Alle Exemplare einer neu eingelesenen Art auf deren Geometrie umhängen. */
  function refreshArt(name) {
    var a = arten[name];
    state.pflanzen.forEach(function (e) {
      if (e.art !== name || !e.mesh) return;
      e.mesh.geometry = a.geometry;
      e.mesh.material = a.material;
      e.proxy.geometry.dispose();
      e.proxy.geometry = proxyGeometry(a);
      e.proxy.position.y = a.hoehe / 2;
    });
    if (selected) updateCage();
    updateStats();
  }

  function readPlantFile(file) {
    return window.PflanzenLoader.fromFile(file).then(function (res) {
      return registerArt(artFromFilename(file.name), res.config);
    });
  }

  /** `json/{art}.json`, ersatzweise `{art}.json` holen. */
  function fetchArt(art) {
    var i = 0;
    function next() {
      if (i >= PFLANZEN_PFADE.length) {
        return Promise.reject(new Error('nicht gefunden'));
      }
      var url = PFLANZEN_PFADE[i++] + art + '.json';
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(next);
    }
    return next().then(function (cfg) { return registerArt(art, cfg); });
  }

  // ------------------------------------------------------------- Exemplare

  function addPlant(art, x, y, scale) {
    var entry = {
      art: art,
      x: num(x, 0),
      y: num(y, 0),
      scale: clamp(num(scale, 1), 0.05, 5),
      mesh: null
    };
    state.pflanzen.push(entry);
    return entry;
  }

  function makeMesh(entry) {
    var art = arten[entry.art];
    if (!art) return null;

    var mesh = new THREE.Mesh(art.geometry, art.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    // Trefferkörper: ein Zylinder über der Standfläche der Pflanze. Direkt auf
    // die Halme zu zielen wäre kaum zu treffen — zwischen ihnen ist mehr Luft
    // als Blatt. Er zeichnet nichts (colorWrite/depthWrite aus), wird vom
    // Raycaster aber gefunden.
    var proxy = new THREE.Mesh(
      proxyGeometry(art),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
    );
    proxy.position.y = art.hoehe / 2;
    proxy.userData.entry = entry;
    mesh.add(proxy);

    entry.mesh = mesh;
    entry.proxy = proxy;
    plantRoot.add(mesh);
    proxies.push(proxy);
    applyTransform(entry);
    return mesh;
  }

  function applyTransform(entry) {
    if (!entry.mesh) return;
    entry.mesh.position.set(entry.x, 0, entry.y);
    entry.mesh.scale.setScalar(entry.scale);
    if (entry === selected) updateCage();
  }

  function removeMesh(entry) {
    if (!entry.mesh) return;
    plantRoot.remove(entry.mesh);
    var i = proxies.indexOf(entry.proxy);
    if (i >= 0) proxies.splice(i, 1);
    entry.proxy.geometry.dispose();
    entry.proxy.material.dispose();
    entry.mesh = null;
    entry.proxy = null;
  }

  /** Für alle Einträge, deren Art inzwischen bekannt ist, ein Mesh anlegen. */
  function syncScene() {
    state.pflanzen.forEach(function (e) {
      if (!e.mesh && arten[e.art]) makeMesh(e);
      else applyTransform(e);
    });
    updateStats();
  }

  function clearPlants() {
    state.pflanzen.forEach(removeMesh);
    state.pflanzen = [];
    select(null);
  }

  function deleteSelected() {
    if (!selected) { message('Keine Pflanze ausgewählt.', 'warn'); return; }
    var i = state.pflanzen.indexOf(selected);
    removeMesh(selected);
    if (i >= 0) state.pflanzen.splice(i, 1);
    select(null);
    updateStats();
  }

  function duplicateSelected() {
    if (!selected) { message('Keine Pflanze ausgewählt.', 'warn'); return; }
    // Gleiche Position wie das Original — die Kopie ist markiert und wird
    // anschließend an ihren Platz gezogen.
    var copy = addPlant(selected.art, selected.x, selected.y, selected.scale);
    makeMesh(copy);
    select(copy);
    updateStats();
    message('Kopie liegt auf dem Original und ist ausgewählt — jetzt verschieben.', 'ok');
  }

  // ------------------------------------------------------------------ Auswahl

  function select(entry) {
    selected = entry || null;
    cage.visible = !!selected;
    if (selected) updateCage();
    syncSelectionUI();
  }

  function updateCage() {
    var art = arten[selected.art];
    if (!art) { cage.visible = false; return; }
    var w = art.durchmesser * selected.scale;
    fitCage(w, w, art.hoehe * selected.scale);
    cage.position.set(selected.x, 0, selected.y);
  }

  // ------------------------------------------------------------------ Modi

  function setMode(next) {
    mode = (next === 'view') ? 'view' : 'edit';
    el.btnModeEdit.classList.toggle('active', mode === 'edit');
    el.btnModeView.classList.toggle('active', mode === 'view');
    el.hint.textContent = mode === 'edit'
      ? 'Pflanze anklicken und ziehen · Rechts ziehen = verschieben · Rad = zoomen'
      : 'Ziehen = drehen und kippen · Rad = zoomen · Rechts ziehen = verschieben';

    if (controls) { controls.dispose(); controls = null; }

    var cam = camera();
    controls = new THREE.OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.target.set(0, 0, 0);

    if (mode === 'edit') {
      // Die Ansicht bleibt isometrisch: Drehen aus, Verschieben und Zoomen an.
      controls.enableRotate = false;
      controls.screenSpacePanning = true;
    } else {
      controls.maxPolarAngle = Math.PI * 0.495;   // nicht unter das Beet fahren
      controls.minDistance = 0.3;
    }

    resetView();
  }

  function camera() { return mode === 'edit' ? camEdit : camView; }

  /** Größte Pflanzenhöhe im Beet — die Ansicht soll sie mit fassen. */
  function contentHeight() {
    var h = 0.4;
    state.pflanzen.forEach(function (e) {
      var a = arten[e.art];
      if (a) h = Math.max(h, a.hoehe * e.scale);
    });
    return h;
  }

  function resetView() {
    var h = contentHeight();
    if (mode === 'edit') fitOrtho(h);
    else fitPerspective(h);
    controls.target.set(0, h * 0.25, 0);
    controls.update();
    updateShadowCamera();
  }

  /**
   * Isometrie einpassen: die acht Ecken des Beet-Quaders werden in den
   * Kameraraum gerechnet, daraus ergibt sich der nötige Ausschnitt. Das ist
   * genauer als eine Faustformel und passt auch bei sehr langen, schmalen Beeten.
   */
  function fitOrtho(h) {
    var dist = Math.max(20, (state.breite + state.hoehe + h) * 3);
    camEdit.position.copy(ISO_DIR).multiplyScalar(dist);
    camEdit.up.set(0, 1, 0);
    camEdit.lookAt(0, 0, 0);
    camEdit.updateMatrixWorld();

    var inv = new THREE.Matrix4().copy(camEdit.matrixWorld).invert();
    var hw = state.breite / 2, hd = state.hoehe / 2;
    var maxX = 0, maxY = 0;
    var v = new THREE.Vector3();
    [-hw, hw].forEach(function (x) {
      [-hd, hd].forEach(function (z) {
        [0, h].forEach(function (y) {
          v.set(x, y, z).applyMatrix4(inv);
          maxX = Math.max(maxX, Math.abs(v.x));
          maxY = Math.max(maxY, Math.abs(v.y));
        });
      });
    });

    var aspect = viewAspect();
    var halfH = Math.max(maxY, maxX / aspect) * 1.12;
    orthoHalfH = halfH;
    camEdit.zoom = 1;
    camEdit.near = 0.01;
    camEdit.far = dist * 3;
    applyOrthoFrustum();
  }

  function applyOrthoFrustum() {
    var halfW = orthoHalfH * viewAspect();
    camEdit.left = -halfW; camEdit.right = halfW;
    camEdit.top = orthoHalfH; camEdit.bottom = -orthoHalfH;
    camEdit.updateProjectionMatrix();
  }

  function fitPerspective(h) {
    var sphere = Math.hypot(state.breite, state.hoehe) * 0.5 + h * 0.5;
    var halfFovY = THREE.MathUtils.degToRad(camView.fov) * 0.5;
    var halfFovX = Math.atan(Math.tan(halfFovY) * Math.max(viewAspect(), 0.2));
    var dist = sphere / Math.sin(Math.min(halfFovY, halfFovX)) * 1.05;

    var az = Math.PI * 0.25, elev = THREE.MathUtils.degToRad(28);
    camView.position.set(
      Math.sin(az) * Math.cos(elev) * dist,
      h * 0.25 + Math.sin(elev) * dist,
      Math.cos(az) * Math.cos(elev) * dist
    );
    camView.near = Math.max(0.02, dist * 0.01);
    camView.far = dist * 8 + 50;
    camView.updateProjectionMatrix();
  }

  function updateShadowCamera() {
    var s = Math.max(state.breite, state.hoehe) * 0.75 + contentHeight() + 0.5;
    var c = sun.shadow.camera;
    c.left = -s; c.right = s; c.top = s; c.bottom = -s;
    c.near = 0.5;
    c.far = s * 8 + 10;
    c.updateProjectionMatrix();
    var d = s * 3 + 2;
    sun.position.set(SUN_DIR[0] * d, SUN_DIR[1] * d, SUN_DIR[2] * d);
    sun.shadow.normalBias = 0.02;
  }

  function viewAspect() {
    var c = renderer.domElement;
    return (c.clientWidth || 1) / (c.clientHeight || 1);
  }

  function resize() {
    var c = renderer.domElement;
    var w = c.clientWidth || 1, h = c.clientHeight || 1;
    renderer.setSize(w, h, false);
    camView.aspect = w / h;
    camView.updateProjectionMatrix();
    applyOrthoFrustum();
  }

  function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    renderer.render(scene, camera());
  }

  // ------------------------------------------------------- Maus im EDIT-Modus

  function setPointer(e) {
    var r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera());
  }

  /** Punkt, an dem der Mauszeiger die Beetebene trifft. */
  function pointOnGround() {
    var p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(groundPlane, p) ? p : null;
  }

  function onPointerDown(e) {
    if (mode !== 'edit' || e.button !== 0) return;

    scene.updateMatrixWorld();
    setPointer(e);
    var hits = raycaster.intersectObjects(proxies, false);
    if (!hits.length) { select(null); return; }

    var entry = hits[0].object.userData.entry;
    select(entry);

    // Gegriffen wird die Pflanze dort, wo der Zeiger die Beetebene trifft. Der
    // Abstand zum Fußpunkt wird festgehalten, sonst springt sie beim Anfassen
    // unter den Mauszeiger.
    var p = pointOnGround();
    drag = p ? { entry: entry, offX: entry.x - p.x, offZ: entry.y - p.z } : null;
    if (drag) {
      if (controls) controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
      renderer.domElement.style.cursor = 'grabbing';
    }
  }

  function onPointerMove(e) {
    if (!drag) return;
    setPointer(e);
    var p = pointOnGround();
    if (!p) return;

    var hw = state.breite / 2, hh = state.hoehe / 2;
    drag.entry.x = round(clamp(p.x + drag.offX, -hw, hw), 3);
    drag.entry.y = round(clamp(p.z + drag.offZ, -hh, hh), 3);
    applyTransform(drag.entry);
    syncSelectionUI();
  }

  function onPointerUp(e) {
    if (!drag) return;
    // Loslassen = endgültige Position. Mehr ist nicht zu tun, die Pflanze steht
    // bereits dort; hier wird nur der Zieh-Zustand aufgelöst.
    drag = null;
    if (controls) controls.enabled = true;
    renderer.domElement.style.cursor = '';
    if (renderer.domElement.hasPointerCapture(e.pointerId)) {
      renderer.domElement.releasePointerCapture(e.pointerId);
    }
  }

  // ------------------------------------------------------------------ Datei

  function serialize() {
    return JSON.stringify({
      format: FORMAT,
      version: VERSION,
      name: state.name,
      beschreibung: BESCHREIBUNG,
      breite: round(state.breite, 3),
      hoehe: round(state.hoehe, 3),
      textur: state.textur || null,
      kacheln: !!state.kacheln,
      kachelgroesse: round(state.kachelgroesse, 3),
      kachelpixel: state.kachelpixel,
      pflanzen: state.pflanzen.map(function (e) {
        var art = arten[e.art];
        return {
          art: e.art,
          x: round(e.x, 3),
          y: round(e.y, 3),
          scale: round(e.scale, 3),
          // Für die Schattenkarte: der Durchmesser des Exemplars, also der
          // Durchmesser der Art mal seiner Skalierung — damit muss der Garten
          // die Pflanzendatei dafür nicht öffnen.
          durchmesser: art ? round(art.durchmesser * e.scale, 3) : 0
        };
      })
    }, null, 2);
  }

  function save() {
    state.name = cleanName(el.beetName.value) || DEFAULT_NAME;
    el.beetName.value = state.name;

    var blob = new Blob([serialize()], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = state.name + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    message('Beet als "' + state.name + '.json" gespeichert — ' +
      state.pflanzen.length + ' Pflanze(n).' +
      (state.textur ? '\nDie Bodentextur ist als Data-URL eingebettet.' : ''), 'ok');
  }

  function loadBeet(file) {
    file.text().then(function (text) {
      var data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Datei enthält kein Beet-Objekt.');
      }
      var warnings = [];
      if (data.format && data.format !== FORMAT) {
        warnings.push('Fremdes Format "' + data.format + '" — es wurde trotzdem versucht zu laden.');
      }

      clearPlants();

      state.name = cleanName(data.name) || artFromFilename(file.name) || DEFAULT_NAME;
      state.breite = clamp(num(data.breite, 4.0), 0.2, 50);
      state.hoehe = clamp(num(data.hoehe, 2.0), 0.2, 50);
      state.textur = (typeof data.textur === 'string' && data.textur) ? data.textur : null;
      state.texturName = state.textur ? 'aus Beet-Datei' : '';
      state.kacheln = data.kacheln === true;
      state.kachelgroesse = clamp(num(data.kachelgroesse, 0.5), 0.02, 10);
      state.kachelpixel = [256, 512, 1024].indexOf(num(data.kachelpixel, 512)) >= 0
        ? num(data.kachelpixel, 512) : 512;

      var list = Array.isArray(data.pflanzen) ? data.pflanzen : [];
      list.forEach(function (p) {
        if (!p || typeof p.art !== 'string' || !p.art) {
          warnings.push('Ein Eintrag ohne "art" wurde übersprungen.');
          return;
        }
        var hw = state.breite / 2, hh = state.hoehe / 2;
        addPlant(p.art, clamp(num(p.x, 0), -hw, hw), clamp(num(p.y, 0), -hh, hh), p.scale);
      });

      syncUI();
      applyGround();

      return resolveArts(warnings, file.name);
    }).catch(function (e) {
      message('Laden fehlgeschlagen: ' + e.message, 'error');
    });
  }

  /** Alle noch unbekannten Arten nachladen, dann die Szene aufbauen. */
  function resolveArts(warnings, fileName) {
    var names = {};
    state.pflanzen.forEach(function (e) { if (!arten[e.art]) names[e.art] = true; });
    var todo = Object.keys(names);

    return Promise.all(todo.map(function (art) {
      return fetchArt(art).then(function () { return null; }, function () { return art; });
    })).then(function (results) {
      missing = results.filter(Boolean);
      syncScene();
      resetView();
      el.missingBox.hidden = missing.length === 0;

      var text = 'Beet "' + fileName + '" geladen — ' + state.pflanzen.length +
        ' Pflanze(n), ' + usedArts().length + ' Art(en).';
      if (missing.length) {
        text += '\nNicht gefunden: ' + missing.join(', ') +
          '\nGesucht wurde als "json/{art}.json" und "{art}.json". ' +
          'Die Dateien lassen sich unten von Hand nachreichen.';
        message(text + (warnings.length ? '\n• ' + warnings.join('\n• ') : ''), 'warn');
      } else if (warnings.length) {
        message(text + '\n• ' + warnings.join('\n• '), 'warn');
      } else {
        message(text, 'ok');
      }
    });
  }

  // ------------------------------------------------------------------ UI

  function syncUI() {
    el.breite.value = String(state.breite);
    el.hoehe.value = String(state.hoehe);
    el.kacheln.checked = state.kacheln;
    el.kachelgroesse.value = String(state.kachelgroesse);
    el.kachelpixel.value = String(state.kachelpixel);
    el.beetName.value = state.name;
    el.texName.textContent = state.textur ? (state.texturName || 'gesetzt') : 'keine';
    el.texPreview.hidden = !state.textur;
    if (state.textur) el.texPreview.src = state.textur;
    document.querySelectorAll('.row.tile-only').forEach(function (r) {
      r.classList.toggle('off', !state.kacheln);
    });
    updateTexNote();
    syncSelectionUI();
  }

  function syncSelectionUI() {
    var on = !!selected;
    el.selGroup.classList.toggle('empty', !on);
    el.selArt.textContent = on ? selected.art : '—';
    el.selX.value = on ? String(round(selected.x, 3)) : '';
    el.selY.value = on ? String(round(selected.y, 3)) : '';
    el.selScale.value = on ? String(selected.scale) : '';
    el.selScaleRange.value = on ? String(selected.scale) : '1';
    [el.selX, el.selY, el.selScale, el.selScaleRange].forEach(function (i) { i.disabled = !on; });

    if (!on) {
      el.selInfo.textContent = 'Keine Pflanze ausgewählt.';
      return;
    }
    var art = arten[selected.art];
    el.selInfo.textContent = art
      ? 'Durchmesser ' + (art.durchmesser * selected.scale).toFixed(2) + ' m · Höhe ' +
        (art.hoehe * selected.scale).toFixed(2) + ' m'
      : 'Datei "' + selected.art + '.json" fehlt — die Pflanze wird nicht dargestellt.';
  }

  /** Im Beet tatsächlich verwendete Arten — nicht alles, was je eingelesen wurde. */
  function usedArts() {
    var seen = {};
    state.pflanzen.forEach(function (e) { if (arten[e.art]) seen[e.art] = true; });
    return Object.keys(seen);
  }

  function updateStats() {
    var tris = 0;
    state.pflanzen.forEach(function (e) {
      var a = arten[e.art];
      if (a) tris += a.triangles;
    });
    el.stats.textContent = state.breite.toFixed(2) + ' × ' + state.hoehe.toFixed(2) + ' m · ' +
      state.pflanzen.length + ' Pflanzen · ' + usedArts().length + ' Arten · ' +
      tris.toLocaleString('de-DE') + ' Dreiecke';
  }

  function bindUI() {
    el = {
      message: document.getElementById('message'),
      stats: document.getElementById('stats'),
      hint: document.getElementById('hint-drag'),
      btnModeEdit: document.getElementById('btn-mode-edit'),
      btnModeView: document.getElementById('btn-mode-view'),
      breite: document.getElementById('b-breite'),
      hoehe: document.getElementById('b-hoehe'),
      kacheln: document.getElementById('b-kacheln'),
      kachelgroesse: document.getElementById('b-kachelgroesse'),
      kachelpixel: document.getElementById('b-kachelpixel'),
      texPreview: document.getElementById('tex-preview'),
      texName: document.getElementById('tex-name'),
      texNote: document.getElementById('tex-note'),
      fileTex: document.getElementById('file-tex'),
      filePlant: document.getElementById('file-plant'),
      fileBeet: document.getElementById('file-beet'),
      selGroup: document.getElementById('sel-group'),
      selArt: document.getElementById('sel-art'),
      selX: document.getElementById('sel-x'),
      selY: document.getElementById('sel-y'),
      selScale: document.getElementById('sel-scale'),
      selScaleRange: document.getElementById('sel-scale-range'),
      selInfo: document.getElementById('sel-info'),
      beetName: document.getElementById('beet-name'),
      missingBox: document.getElementById('missing-box')
    };

    el.btnModeEdit.addEventListener('click', function () { setMode('edit'); });
    el.btnModeView.addEventListener('click', function () { setMode('view'); });
    document.getElementById('btn-reset-view').addEventListener('click', resetView);

    // --- Beetmaße
    function sizeChanged() {
      state.breite = clamp(num(el.breite.value, state.breite), 0.2, 50);
      state.hoehe = clamp(num(el.hoehe.value, state.hoehe), 0.2, 50);
      // Pflanzen, die durch das Verkleinern draußen stünden, rücken nach innen.
      var hw = state.breite / 2, hh = state.hoehe / 2;
      state.pflanzen.forEach(function (e) {
        e.x = clamp(e.x, -hw, hw);
        e.y = clamp(e.y, -hh, hh);
        applyTransform(e);
      });
      applyGround();
      resetView();
      syncSelectionUI();
      updateStats();
    }
    el.breite.addEventListener('change', sizeChanged);
    el.hoehe.addEventListener('change', sizeChanged);

    // --- Boden
    document.getElementById('btn-tex-pick').addEventListener('click', function () { el.fileTex.click(); });
    document.getElementById('btn-tex-clear').addEventListener('click', function () {
      state.textur = null;
      state.texturName = '';
      el.fileTex.value = '';
      syncUI();
      applyGroundTexture();
    });
    el.fileTex.addEventListener('change', function () {
      var f = el.fileTex.files && el.fileTex.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        state.textur = String(reader.result);
        state.texturName = f.name;
        syncUI();
        applyGroundTexture();
      };
      reader.onerror = function () { message('Bild konnte nicht gelesen werden.', 'error'); };
      reader.readAsDataURL(f);
    });
    el.kacheln.addEventListener('change', function () {
      state.kacheln = el.kacheln.checked;
      syncUI();
      applyGroundTexture();
    });
    el.kachelgroesse.addEventListener('change', function () {
      state.kachelgroesse = clamp(num(el.kachelgroesse.value, state.kachelgroesse), 0.02, 10);
      syncUI();
      applyGroundTexture();
    });
    el.kachelpixel.addEventListener('change', function () {
      state.kachelpixel = num(el.kachelpixel.value, 512);
      syncUI();
      applyGroundTexture();
    });

    // --- Pflanzen
    document.getElementById('btn-plant-add').addEventListener('click', function () { el.filePlant.click(); });
    el.filePlant.addEventListener('change', function () {
      var files = Array.prototype.slice.call(el.filePlant.files || []);
      el.filePlant.value = '';
      if (!files.length) return;
      Promise.all(files.map(function (f) {
        return readPlantFile(f).then(function () {
          return addPlant(artFromFilename(f.name), 0, 0, 1);
        }, function (e) {
          message('"' + f.name + '": ' + e.message, 'error');
          return null;
        });
      })).then(function (added) {
        syncScene();
        var last = added.filter(Boolean).pop();
        if (last) {
          select(last);
          message('"' + last.art + '" in die Beetmitte eingefügt — jetzt verschieben.', 'ok');
        }
      });
    });
    document.getElementById('btn-plant-del').addEventListener('click', deleteSelected);
    document.getElementById('btn-plant-dup').addEventListener('click', duplicateSelected);

    // --- Auswahl
    function selPos() {
      if (!selected) return;
      var hw = state.breite / 2, hh = state.hoehe / 2;
      selected.x = clamp(num(el.selX.value, selected.x), -hw, hw);
      selected.y = clamp(num(el.selY.value, selected.y), -hh, hh);
      applyTransform(selected);
      syncSelectionUI();
    }
    el.selX.addEventListener('change', selPos);
    el.selY.addEventListener('change', selPos);

    function selScale(v) {
      if (!selected) return;
      selected.scale = clamp(num(v, selected.scale), 0.05, 5);
      applyTransform(selected);
      syncSelectionUI();
    }
    el.selScale.addEventListener('change', function () { selScale(el.selScale.value); });
    el.selScaleRange.addEventListener('input', function () { selScale(el.selScaleRange.value); });

    // --- Datei
    el.beetName.addEventListener('change', function () {
      state.name = cleanName(el.beetName.value) || DEFAULT_NAME;
      el.beetName.value = state.name;
    });
    document.getElementById('btn-save').addEventListener('click', save);
    document.getElementById('btn-load').addEventListener('click', function () { el.fileBeet.click(); });
    el.fileBeet.addEventListener('change', function () {
      var f = el.fileBeet.files && el.fileBeet.files[0];
      el.fileBeet.value = '';
      if (f) loadBeet(f);
    });

    // Fehlende Pflanzen-Dateien von Hand nachreichen (z. B. wenn die Seite über
    // file:// geöffnet ist und deshalb nichts nachladen darf).
    document.getElementById('btn-missing').addEventListener('click', function () { el.filePlant.click(); });

    // Beet-JSON per Drag & Drop aufs Fenster
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.json$/i.test(f.name)) loadBeet(f);
    });

    document.addEventListener('keydown', function (e) {
      if (mode !== 'edit' || !selected) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      if (e.key === 'Escape') select(null);
    });
  }

  // ------------------------------------------------------------------ Start

  function init() {
    if (!window.THREE) {
      document.getElementById('message').hidden = false;
      document.getElementById('message').className = 'error';
      document.getElementById('message').textContent =
        'three.js konnte nicht geladen werden — bitte prüfen, ob der Ordner "vendor" neben beetgenerator.html liegt.';
      return;
    }

    bindUI();
    buildScene();
    syncUI();
    applyGround();
    resize();
    setMode('edit');
    updateStats();

    window.BeetApp = {
      state: state,
      arten: arten,
      serialize: serialize,
      setMode: setMode,
      resetView: resetView
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
