/**
 * viewer.js — three.js-Szene: Wiese, Licht, Schatten, Kamerasteuerung.
 * Bekommt die fertigen Buffer von geometry.js und hängt sie in die Szene.
 */
(function (root) {
  'use strict';

  // Weiße, sehr große Grundfläche: der Schattenwurf ist darauf gut zu beurteilen,
  // und weil der Hintergrund ebenfalls weiß ist, wirkt sie wie ein endloser Boden.
  var GROUND_RADIUS = 6000;  // mm
  var MIN_FRAME_RADIUS = 260; // mm — worauf die Ansicht mindestens eingepasst wird
  var SUN_DIR = [-0.62, 0.72, 0.31];  // links schräg oben, ca. 46° über dem Horizont

  function Viewer(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    THREE.ColorManagement.legacyMode = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 20000);
    this.camera.position.set(700, 550, 950);

    this.controls = new THREE.OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 6000;
    this.controls.maxPolarAngle = Math.PI * 0.495;   // nicht unter den Boden fahren
    this.controls.target.set(0, 250, 0);

    this._buildEnvironment();

    this.tuft = null;
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      metalness: 0.0
    });
    this._envMap = null;   // wird erst beim ersten Glanz > 0 gebaut (~23 ms)
    this.setGloss(PflanzenLoader.DEFAULTS.glanz);

    var self = this;
    this._onResize = function () { self.resize(); };
    window.addEventListener('resize', this._onResize);
    this.resize();
    this._animate();
  }

  Viewer.prototype._buildEnvironment = function () {
    // Grundfläche: weiße Kreisfläche. Der Weißwert bleibt bewusst knapp unter 1,
    // sonst läuft die beleuchtete Fläche ins Clipping und der Schatten verliert
    // seine Abstufungen.
    var ground = new THREE.Mesh(
      new THREE.CircleGeometry(GROUND_RADIUS, 128),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 1.0, metalness: 0.0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.ground = ground;
    this.scene.add(ground);

    // Licht von links schräg oben
    var sun = new THREE.DirectionalLight(0xfff6e8, 2.0);
    sun.position.set(-900, 1100, 500);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var c = sun.shadow.camera;
    c.left = -GROUND_RADIUS * 1.4; c.right = GROUND_RADIUS * 1.4;
    c.top = GROUND_RADIUS * 1.4; c.bottom = -GROUND_RADIUS * 1.4;
    c.near = 100; c.far = 4000;
    c.updateProjectionMatrix();
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 1.0;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // Umgebungslicht bewusst knapp: es trifft ungerichtet auch tief im Büschel
    // auf, dort wo eigentlich Verschattung sein sollte. Der Ausgleich läuft über
    // das gerichtete Licht oben — das wird von den äußeren Halmen abgefangen,
    // sodass die Grundfläche hell bleibt und das Innere trotzdem absäuft.
    this.scene.add(new THREE.HemisphereLight(0xeef4ff, 0xdcdcd6, 0.20));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.09));
  };

  /** Geometrie aus geometry.js in die Szene übernehmen */
  Viewer.prototype.setTuft = function (data, options) {
    options = options || {};

    if (this.tuft) {
      this.scene.remove(this.tuft);
      this.tuft.geometry.dispose();
      this.tuft = null;
    }

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    g.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    g.computeBoundingSphere();

    var mesh = new THREE.Mesh(g, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.tuft = mesh;
    this.scene.add(mesh);

    this.setShadows(options.shadows !== false);
    if (options.gloss !== undefined) this.setGloss(options.gloss);
    this.lastStats = data.stats;
  };

  /** Textur setzen (data-URL oder null) */
  Viewer.prototype.setTexture = function (url, onDone) {
    var self = this;
    if (this.material.map) {
      this.material.map.dispose();
      this.material.map = null;
    }
    if (!url) {
      this.material.alphaTest = 0;
      this.material.transparent = false;
      this.material.needsUpdate = true;
      if (onDone) onDone(null);
      return;
    }
    new THREE.TextureLoader().load(url, function (tex) {
      tex.encoding = THREE.sRGBEncoding;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = self.renderer.capabilities.getMaxAnisotropy();
      self.material.map = tex;
      self.material.alphaTest = 0.5;      // transparente PNGs schneiden die Halmform aus
      self.material.needsUpdate = true;
      if (onDone) onDone(tex);
    }, undefined, function () {
      if (onDone) onDone(null, new Error('Textur konnte nicht geladen werden.'));
    });
  };

  /**
   * Kleine Studio-Umgebung als Spiegelbild für die Halme.
   *
   * Ohne etwas zum Spiegeln bliebe "Glanz" wirkungslos: ein einzelnes gerichtetes
   * Licht erzeugt nur eine sehr schmale Glanzkeule, die bei sinkender Rauheit noch
   * schmaler wird — gemessen wurde das Bild dadurch sogar minimal dunkler statt
   * glänzender. Die Umgebung liefert die Fläche, auf der der Glanz entsteht.
   *
   * Sie hängt bewusst NUR am Halm-Material, nicht an der Szene: so bleibt die
   * Grundfläche wie eingestellt, und bei Glanz 0 % ist die Umgebung komplett
   * abgeschaltet (envMapIntensity 0) — das Büschel bleibt innen so dunkel wie
   * ohne diese Ergänzung.
   */
  Viewer.prototype._buildEnvMap = function () {
    var W = 256, H = 128;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');

    var grd = x.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.00, '#ffffff');   // Zenit
    grd.addColorStop(0.50, '#c9d4e0');   // Horizont
    grd.addColorStop(1.00, '#f4f4f1');   // Boden, entspricht der weißen Fläche
    x.fillStyle = grd;
    x.fillRect(0, 0, W, H);

    // Heller Fleck in Blickrichtung der Sonne — daran entsteht der Glanzfleck.
    // Umrechnung der Sonnenrichtung in Äquirektangular-Koordinaten:
    //   u = atan2(z, x) / 2π + 0.5 ,  v = asin(y) / π + 0.5 ,  Zeile = (1 − v)·H
    var d = SUN_DIR;
    var u = (Math.atan2(d[2], d[0]) / (Math.PI * 2) + 0.5) * W;
    var v = (1 - (Math.asin(d[1]) / Math.PI + 0.5)) * H;
    var spot = x.createRadialGradient(u, v, 0, u, v, H * 0.28);
    spot.addColorStop(0, 'rgba(255,255,255,1)');
    spot.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = spot;
    x.fillRect(0, 0, W, H);

    var tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.encoding = THREE.sRGBEncoding;

    var pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    var env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose();
    tex.dispose();
    return env;
  };

  /**
   * Glanz 0–100 % — wirkt sofort, die Geometrie bleibt unberührt.
   *
   * Der Wert selbst kostet nichts, er landet in Uniforms. Die envMap dagegen ist
   * eine eigene Shader-Variante und kostet gemessen rund 0,8 ms je Bild bei
   * 16 800 Dreiecken auf 1200×900. Deshalb wird sie bei Glanz 0 ganz abgehängt
   * statt nur mit 0 multipliziert — ein mattes Büschel rendert dann exakt so
   * schnell wie vor der Glanz-Ergänzung. Der Shader wird dabei nur neu übersetzt,
   * wenn der Regler die 0 überquert, nicht bei jeder Bewegung.
   *
   * Auch der einmalige Aufbau der Umgebung (~23 ms) läuft erst beim ersten
   * Glanz > 0 — wer nur matt arbeitet, zahlt ihn nie.
   */
  Viewer.prototype.setGloss = function (percent) {
    var g = Math.min(100, Math.max(0, percent || 0)) / 100;
    this.material.roughness = PflanzenLoader.glanzToRoughness(percent);
    this.material.envMapIntensity = g;

    if (g > 0 && !this._envMap) this._envMap = this._buildEnvMap();
    var env = g > 0 ? this._envMap : null;
    if (this.material.envMap !== env) {
      this.material.envMap = env;
      this.material.needsUpdate = true;
    }
  };

  Viewer.prototype.setShadows = function (on) {
    this.renderer.shadowMap.enabled = !!on;
    this.sun.castShadow = !!on;
    if (this.tuft) this.tuft.castShadow = !!on;
    this.ground.receiveShadow = !!on;
    this.material.needsUpdate = true;
    if (this.ground.material) this.ground.material.needsUpdate = true;
  };

  /**
   * Kamera auf das Büschel einpassen. Bezug ist bewusst der Büschel, nicht die
   * Grundfläche — die ist absichtlich viel größer als das, was man sehen will.
   */
  Viewer.prototype.frame = function (height, radius) {
    var h = Math.max(height || 0, 100);
    var rad = Math.max(radius || 0, MIN_FRAME_RADIUS);

    // Umkugel um den Büschel, daraus den nötigen Abstand ableiten. Der Zuschlag
    // ist großzügig, damit der Schlagschatten neben der Pflanze mit ins Bild kommt.
    var cy = h * 0.38;
    var sphere = Math.hypot(rad, h * 0.5) * 1.45;
    var halfFovY = THREE.MathUtils.degToRad(this.camera.fov) * 0.5;
    var halfFovX = Math.atan(Math.tan(halfFovY) * Math.max(this.camera.aspect, 0.2));
    var dist = sphere / Math.sin(Math.min(halfFovY, halfFovX));

    this.controls.target.set(0, cy, 0);
    // Blickrichtung: leicht von vorne rechts, etwa 22° über dem Horizont
    var az = Math.PI * 0.28, el = THREE.MathUtils.degToRad(22);
    this.camera.position.set(
      Math.sin(az) * Math.cos(el) * dist,
      cy + Math.sin(el) * dist,
      Math.cos(az) * Math.cos(el) * dist
    );
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // Schattenkamera muss Wiese UND die schräg projizierten Halme fassen
    var s = rad * 1.15 + h * 0.8;
    var c = this.sun.shadow.camera;
    c.left = -s; c.right = s; c.top = s; c.bottom = -s;
    c.near = 10;
    c.far = s * 6 + 2000;
    c.updateProjectionMatrix();
    // Licht von links schräg oben. Die Richtung ist fest (SUN_DIR), nur der
    // Abstand wächst mit — sonst passte der Glanzfleck der Umgebung nicht mehr.
    var d = s * 3 + 500;
    this.sun.position.set(SUN_DIR[0] * d, SUN_DIR[1] * d, SUN_DIR[2] * d);
    this.sun.shadow.normalBias = Math.max(1, s * 0.004);
  };

  Viewer.prototype.resize = function () {
    var w = this.canvas.clientWidth || 1;
    var h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  Viewer.prototype._animate = function () {
    var self = this;
    function loop() {
      requestAnimationFrame(loop);
      self.controls.update();
      self.renderer.render(self.scene, self.camera);
    }
    loop();
  };

  Viewer.GROUND_RADIUS = GROUND_RADIUS;
  root.PflanzenViewer = Viewer;
}(window));
