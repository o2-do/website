/**
 * gartenloader.js — Anbindung an den Gartensimulator
 * --------------------------------------------------
 * Setzt die Schnittstelle aus PFLANZENKONFIGURATOR.md um: ein einziges globales
 * Objekt `window.Pflanze`, Ausgabe in Metern mit Ursprung am Fuß auf der Grasnarbe.
 *
 * Exportiert wird ausschließlich die Pflanze selbst: eine BufferGeometry mit
 * Position, Normale, UV und Vertexfarbe. NICHT dabei sind — der Garten stellt
 * das alles selbst — die runde Grundfläche/Wiese, Licht, Schatten, Kamera,
 * Renderer, Hintergrund und Nebel. Das Feld `schatten` aus der Konfiguration
 * betrifft nur die Vorschau im Generator und wird hier ignoriert.
 *
 * Einbindung (klassische Datei, nach dem THREE-Global, vor dem Modulstart):
 *
 *   <script defer src="pflanzenloader/loader.js"></script>
 *   <script defer src="pflanzenloader/geometry.js"></script>
 *   <script defer src="pflanzenloader/gartenloader.js"></script>
 *
 * Beim bloßen Laden der Datei passiert nichts außer dem Setzen von window.Pflanze.
 *
 * API:
 *   Pflanze.loadConfig(url)      -> Promise<config>
 *   Pflanze.normalizeConfig(obj) -> config
 *   Pflanze.buildPlant(opt)      -> { geometry, stats }
 *   Pflanze.buildMaterial(opt)   -> MeshStandardMaterial   (optional, s.u.)
 *
 * Hinweise zum Zusammenspiel:
 *   • Der Generator arbeitet durchweg in mm; hier wird auf Meter umgerechnet.
 *   • Der Fuß läuft unter y = 0 weiter: die Stiele setzen sich unter der
 *     Grundfläche fort und treffen sich in einem gemeinsamen Wurzelpunkt
 *     (0, -wurzeltiefe, 0). Auf geneigtem Gelände steht der Büschel damit
 *     nirgends in der Luft. Die Voreinstellung richtet sich nach dem Fußradius
 *     (mindestens 0,10 m, ausgelegt bis 20° Hang) und lässt sich über
 *     opt.wurzeltiefe überschreiben. `stats.minY` muss negativ sein.
 *   • Der Aufbau ist vollständig deterministisch (Fibonacci-Spirale statt
 *     Zufall). Ein `seed` ändert daher nichts — gleiche Konfiguration ergibt
 *     immer identische Vertexdaten. Ein vorhandenes Feld `seed` wird beim Laden
 *     durchgereicht und ignoriert.
 *   • Die Polygonzahl ist frei einstellbar und steckt in der Konfiguration,
 *     nicht im Code:
 *         Dreiecke = anzahl × (anzahl_segmente + Stiel + Wurzel) × 4
 *     Beispiel: 24 Halme × (3 + 1 + 1) Segmente × 4 = 480 Dreiecke.
 *     Für den Garten sind 100–500 sinnvoll, der Generator kann aber auch
 *     16 800 — das ist dann eine Einzelpflanze für die Nahansicht.
 *     Immer `stats.triangles` prüfen.
 */
(function (root) {
  'use strict';

  var MM_TO_M = 0.001;
  var MIN_SINK_M = 0.10;       // Mindestmaß, um das der Fuß unter y = 0 weiterläuft
  var MAX_SLOPE_DEG = 20;      // Hangneigung, für die die Voreinstellung ausgelegt ist

  /**
   * Voreingestellte Wurzeltiefe in Metern.
   * Maßgeblich ist der Radius der *Grundfläche* (wo die Stiele austreten), nicht
   * der Blattüberhang: eintauchen muss der Fuß, nicht die Blattspitze.
   *   Tiefe ≥ Fußradius × tan(Hangneigung),  mindestens 10 cm.
   */
  function defaultSink(cfg) {
    var footR = (cfg.grundflaeche_radius || 0) * MM_TO_M;
    return Math.max(MIN_SINK_M, footR * Math.tan(MAX_SLOPE_DEG * Math.PI / 180) + 0.03);
  }

  function loaderApi() {
    var L = root.PflanzenLoader;
    if (!L) throw new Error('gartenloader.js: loader.js muss vorher geladen sein.');
    return L;
  }

  function geometryApi() {
    var G = root.PflanzenGeometry;
    if (!G) throw new Error('gartenloader.js: geometry.js muss vorher geladen sein.');
    return G;
  }

  /** Fehlende Werte ergänzen, Wertebereiche klemmen. `seed` reicht loader.js durch. */
  function normalizeConfig(obj) {
    return loaderApi().normalize(obj).config;
  }

  /** .json holen und auffüllen. */
  function loadConfig(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Pflanze: HTTP ' + r.status + ' bei ' + url);
      return r.json();
    }).then(normalizeConfig);
  }

  /**
   * Geometrie im Weltmaßstab bauen.
   * @param {object} opt  entweder die Konfiguration selbst oder
   *                      { config, wurzeltiefe (m), skalierung }
   * @returns {{geometry: THREE.BufferGeometry, stats: object}}
   */
  function buildPlant(opt) {
    if (!root.THREE) throw new Error('gartenloader.js: window.THREE ist nicht gesetzt.');

    opt = opt || {};
    var cfg = normalizeConfig(opt.config || opt);
    var scale = typeof opt.skalierung === 'number' ? opt.skalierung : MM_TO_M;
    var sinkM = typeof opt.wurzeltiefe === 'number' ? opt.wurzeltiefe : defaultSink(cfg);

    var data = geometryApi().buildTuft(cfg, { wurzeltiefe: sinkM / scale });

    // mm -> m direkt im Puffer, spart eine Matrixmultiplikation im Garten
    var pos = data.positions;
    for (var i = 0; i < pos.length; i++) pos[i] *= scale;

    var g = new root.THREE.BufferGeometry();
    g.setAttribute('position', new root.THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new root.THREE.BufferAttribute(data.normals, 3));
    g.setAttribute('uv', new root.THREE.BufferAttribute(data.uvs, 2));
    g.setAttribute('color', new root.THREE.BufferAttribute(data.colors, 3));
    g.setIndex(new root.THREE.BufferAttribute(data.indices, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();

    var s = data.stats;
    return {
      geometry: g,
      stats: {
        height: s.height * scale,                        // m über der Grasnarbe
        footprint: s.radius * 2 * scale,                 // m Grundrissdurchmesser inkl. Blattüberhang
        footRadius: cfg.grundflaeche_radius * scale,     // m Radius, in dem die Stiele austreten
        rootDepth: sinkM,                                // m, um die der Fuß eintaucht
        minY: s.minY * scale,                            // muss negativ sein (Fuß im Boden)
        triangles: s.triangles,
        vertices: s.vertices,
        blades: s.blades
      }
    };
  }

  /**
   * Optionaler Materialbaustein — der Garten darf auch sein eigenes nehmen.
   * Wichtig sind nur: Vertexfarben an, Materialfarbe weiß, beidseitig,
   * Freistellen über alphaTest (nicht über transparent).
   */
  function buildMaterial(opt) {
    if (!root.THREE) throw new Error('gartenloader.js: window.THREE ist nicht gesetzt.');
    opt = opt || {};
    var cfg = opt.config ? normalizeConfig(opt.config) : null;

    var glanz = cfg ? cfg.glanz : loaderApi().DEFAULTS.glanz;

    var mat = new root.THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: root.THREE.DoubleSide,
      roughness: loaderApi().glanzToRoughness(glanz),
      metalness: 0.0,
      // Sichtbar wird der Glanz nur, wenn es etwas zu spiegeln gibt — also über
      // `scene.environment` des Gartens. Ohne Umgebung bleibt vom Glanz fast
      // nichts übrig, weil ein gerichtetes Licht allein nur eine sehr schmale
      // Glanzkeule erzeugt. Bei Glanz 0 % ist die Umgebung ganz abgeschaltet.
      envMapIntensity: Math.min(100, Math.max(0, glanz)) / 100
    });

    if (cfg && cfg.halm_textur) {
      var tex = new root.THREE.TextureLoader().load(cfg.halm_textur);
      if ('colorSpace' in tex) tex.colorSpace = root.THREE.SRGBColorSpace;
      else tex.encoding = root.THREE.sRGBEncoding;
      mat.map = tex;
      mat.alphaTest = 0.5;
    }
    return mat;
  }

  root.Pflanze = {
    loadConfig: loadConfig,
    normalizeConfig: normalizeConfig,
    buildPlant: buildPlant,
    buildMaterial: buildMaterial,
    defaultSink: defaultSink,
    MM_TO_M: MM_TO_M,
    MIN_SINK_M: MIN_SINK_M
  };
}(typeof window !== 'undefined' ? window : this));
