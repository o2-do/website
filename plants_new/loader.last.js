/**
 * loader.js — Konfigurations-Schema, Validierung, Laden & Speichern
 * ------------------------------------------------------------------
 * Bewusst frei von Abhängigkeiten (kein three.js, kein DOM-Zwang), damit die
 * Datei 1:1 in den Gartensimulator übernommen werden kann.
 *
 * Verwendung:
 *   Browser (classic script):  <script src="loader.js"></script>  ->  window.PflanzenLoader
 *   Node / Bundler:            const Loader = require('./loader.js')
 *   ES-Modul:                  import './loader.js'; const Loader = window.PflanzenLoader;
 *
 * Kern-API:
 *   PflanzenLoader.PARAMS            Parameter-Schema (Array)
 *   PflanzenLoader.DEFAULTS          Standardkonfiguration (Objekt)
 *   PflanzenLoader.normalize(obj)    -> { config, warnings }
 *   PflanzenLoader.parse(jsonText)   -> { config, warnings }
 *   PflanzenLoader.fromFile(file)    -> Promise<{ config, warnings }>   (Browser)
 *   PflanzenLoader.fromUrl(url)      -> Promise<{ config, warnings }>   (Browser)
 *   PflanzenLoader.serialize(config, extra) -> JSON-String
 *   PflanzenLoader.download(config, dateiname, extra)                  (Browser)
 *
 * `extra` = { name, durchmesser } — zwei Angaben, die nicht zur Form der Pflanze
 * gehören, aber mit in die Datei müssen: der frei vergebene Name und der
 * breiteste Durchmesser in der Aufsicht (mm, aus PflanzenGeometry.durchmesser).
 * Letzterer ist die Grundlage der Schattenkarte im Garten.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PflanzenLoader = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT = 'pflanzen-generator/grasbueschel';
  var VERSION = 1;

  /**
   * Parameter-Schema. Die UI wird vollständig hieraus generiert.
   * type: 'range' | 'color' | 'bool' | 'image'
   */
  var PARAMS = [
    // --- Form des Halms ---
    { key: 'winkel_haupt', type: 'range', min: -45, max: 45, step: 1, def: 25,
      group: 'Halm-Form', unit: '°', label: 'Winkel Hauptsegmente',
      hint: 'Knickwinkel der 2 Hauptsegmente. 45° → 90° zwischen den Hälften, 20° → 140°, 0° → flach. ' +
            'Positiv: Kiel zeigt zur Büschelmitte, das Blatt schalt sich nach außen-unten (Gras). ' +
            'Negativ: gleicher Winkel, aber andersherum gefaltet — das Blatt schalt sich nach oben, ' +
            'wie bei großblättrigen Pflanzen.' },
    { key: 'anzahl_segmente', type: 'range', min: 0, max: 20, step: 1, def: 8,
      group: 'Halm-Form', unit: '', label: 'Anzahl Teilsegmente',
      hint: 'Teilsegmente je Hauptsegment übereinander. 0 → nur der Stiel bleibt übrig.' },

    // --- Breiten ---
    { key: 'breite_unten', type: 'range', min: 1, max: 100, step: 0.5, def: 4,
      group: 'Breiten', unit: 'mm', label: 'Breite unten',
      hint: 'Breite EINES Hauptsegmentes an der Unterkante (Halm ist also 2× so breit).' },
    { key: 'breite_mitte', type: 'range', min: 1, max: 200, step: 0.5, def: 14,
      group: 'Breiten', unit: 'mm', label: 'Breite Mitte',
      hint: 'Breite eines Hauptsegmentes an der breitesten Stelle.' },
    { key: 'breite_oben', type: 'range', min: 0, max: 100, step: 0.5, def: 0,
      group: 'Breiten', unit: 'mm', label: 'Breite oben',
      hint: '0 erzeugt eine Spitze.' },

    // --- Höhen ---
    { key: 'hoehe_mitte', type: 'range', min: 0, max: 2000, step: 5, def: 260,
      group: 'Höhen', unit: 'mm', label: 'Höhe breiteste Stelle',
      hint: 'Abstand der breitesten Stelle von der Unterkante des untersten Segmentes.' },
    { key: 'hoehe_oben', type: 'range', min: 0, max: 2000, step: 5, def: 700,
      group: 'Höhen', unit: 'mm', label: 'Höhe Spitze',
      hint: 'Länge des Blattteils ab Unterkante des untersten Segmentes.' },
    { key: 'hoehe_stil', type: 'range', min: 0, max: 2000, step: 5, def: 80,
      group: 'Höhen', unit: 'mm', label: 'Höhe Stiel',
      hint: 'Rechteckige Verlängerung nach unten bis zum Boden. Gesamthöhe = Stiel + Spitze.' },

    // --- Neigung ---
    { key: 'winkel_unten', type: 'range', min: 0, max: 45, step: 1, def: 20,
      group: 'Neigung', unit: '°', label: 'Winkel unten (außen)',
      hint: 'Neigung des untersten Segmentes zur Senkrechten. Gilt für die äußersten Halme; zum Zentrum hin auf 0 auslaufend.' },
    { key: 'winkel_versatz', type: 'range', min: 0, max: 45, step: 0.5, def: 4,
      group: 'Neigung', unit: '°', label: 'Winkel-Versatz je Segment',
      hint: 'Zusätzliche Kippung jedes Segmentes gegenüber dem darunterliegenden.' },

    // --- Büschel ---
    { key: 'grundflaeche_radius', type: 'range', min: 0, max: 500, step: 1, def: 45,
      group: 'Büschel', unit: 'mm', label: 'Radius Grundfläche',
      hint: 'Kreisfläche, auf der die Halme gleichmäßig verteilt wachsen.' },
    { key: 'anzahl', type: 'range', min: 0, max: 200, step: 1, def: 70,
      group: 'Büschel', unit: '', label: 'Anzahl Halme' },

    // --- Aussehen ---
    { key: 'farbe_unten', type: 'color', def: '3f7a1e',
      group: 'Aussehen', label: 'Farbe unten', hint: '6 Zeichen Hex, ohne Raute.' },
    { key: 'farbe_oben', type: 'color', def: 'a8d24e',
      group: 'Aussehen', label: 'Farbe oben', hint: '6 Zeichen Hex, ohne Raute.' },
    { key: 'farbverlauf_start', type: 'range', min: 0, max: 100, step: 1, def: 0,
      group: 'Aussehen', unit: '%', label: 'Startwert für Farbverlauf',
      hint: 'Schiebt den Farbverlauf nach oben. 0 % = Verlauf über den ganzen Halm. ' +
            '50 % = untere Hälfte durchgehend "Farbe unten", darüber der Verlauf. ' +
            'An der Spitze wird immer "Farbe oben" erreicht.' },
    { key: 'glanz', type: 'range', min: 0, max: 100, step: 1, def: 20,
      group: 'Aussehen', unit: '%', label: 'Glanz',
      hint: '0 % = stumpf matt, 100 % = speckig glänzend. Steuert die Rauheit des Materials; ' +
            'der Glanzfleck kommt vom gerichteten Licht und wandert beim Drehen mit.' },
    { key: 'halm_textur', type: 'image', def: null,
      group: 'Aussehen', label: 'Halm-Textur (optional)',
      hint: 'Wird auf beide Hauptsegmente gemappt, an der vertikalen Mittellinie gespiegelt.' },
    { key: 'schatten', type: 'bool', def: true,
      group: 'Aussehen', label: 'Schatten' }
  ];

  /** Felder, die nicht zur Form gehören, aber unverändert erhalten bleiben. */
  var PASSTHROUGH = { seed: true, name: true, durchmesser: true };

  var PARAMS_BY_KEY = {};
  for (var i = 0; i < PARAMS.length; i++) PARAMS_BY_KEY[PARAMS[i].key] = PARAMS[i];

  var DEFAULTS = (function () {
    var d = {};
    for (var i = 0; i < PARAMS.length; i++) d[PARAMS[i].key] = PARAMS[i].def;
    return d;
  }());

  // ---------------------------------------------------------------- Helfer

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** '#A0FF33' | 'a0ff33' -> 'a0ff33' ; ungültig -> null */
  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    var s = value.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return s.toLowerCase();
  }

  /**
   * $glanz (0–100 %) -> roughness des Materials.
   * Hier zentral, damit Vorschau und Gartenexport garantiert dasselbe Material
   * bauen. 0 % ergibt stumpfes Blattgrün, 100 % eine speckig glänzende Fläche.
   */
  function glanzToRoughness(percent) {
    var g = clamp(typeof percent === 'number' ? percent : 0, 0, 100) / 100;
    return 1.0 - g * 0.88;   // 0 % -> 1.00 ... 100 % -> 0.12
  }

  /** 'a0ff33' -> { r, g, b } im Bereich 0..1 (sRGB) */
  function hexToRgb(hex) {
    var h = normalizeHex(hex) || '000000';
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255
    };
  }

  // ------------------------------------------------------------ Validierung

  /**
   * Bringt ein beliebiges Objekt auf eine vollständige, gültige Konfiguration.
   * Unbekannte Felder werden verworfen, fehlende mit Defaults gefüllt,
   * Zahlen auf ihren Wertebereich geklemmt.
   */
  function normalize(raw) {
    var warnings = [];
    var src = (raw && typeof raw === 'object') ? raw : {};

    // Verschachtelte Datei-Struktur { format, version, config } zulassen
    if (src.config && typeof src.config === 'object') src = src.config;

    var cfg = {};
    var missing = [];
    for (var i = 0; i < PARAMS.length; i++) {
      var p = PARAMS[i];
      var v = src[p.key];

      if (v === undefined || v === null) {
        if (p.type === 'image') { cfg[p.key] = null; continue; }
        cfg[p.key] = p.def;
        if (v === undefined) missing.push(p.key);
        continue;
      }

      if (p.type === 'range') {
        var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
        if (!isFinite(n)) {
          warnings.push('"' + p.key + '" ist keine Zahl – Standardwert ' + p.def + ' verwendet.');
          n = p.def;
        }
        var c = clamp(n, p.min, p.max);
        if (c !== n) warnings.push('"' + p.key + '" (' + n + ') auf ' + c + ' begrenzt [' + p.min + '…' + p.max + '].');
        cfg[p.key] = c;
      } else if (p.type === 'color') {
        var hex = normalizeHex(v);
        if (!hex) {
          warnings.push('"' + p.key + '" ist keine gültige Hex-Farbe – Standardwert ' + p.def + ' verwendet.');
          hex = p.def;
        }
        cfg[p.key] = hex;
      } else if (p.type === 'bool') {
        cfg[p.key] = (v === true || v === 'true' || v === 1 || v === '1');
      } else if (p.type === 'image') {
        cfg[p.key] = (typeof v === 'string' && v.length) ? v : null;
      }
    }

    if (missing.length) {
      warnings.unshift(missing.length + ' Feld(er) nicht enthalten – Standardwerte verwendet: ' + missing.join(', '));
    }

    // `seed` gehört zum Gartensimulator, nicht zum Generator: unverändert
    // durchreichen, damit ein Umweg über den Generator nichts verliert.
    if (src.seed !== undefined) cfg.seed = src.seed;

    // `name` und `durchmesser` beschreiben nicht die Form, sondern die Pflanze
    // als Ganzes. Sie werden ebenfalls durchgereicht — `durchmesser` wird beim
    // Speichern allerdings immer neu aus der Geometrie bestimmt.
    if (typeof src.name === 'string' && src.name.trim()) cfg.name = src.name.trim();
    var dm = typeof src.durchmesser === 'number' ? src.durchmesser
      : (typeof src.durchmesser === 'string' ? parseFloat(src.durchmesser) : NaN);
    if (isFinite(dm) && dm >= 0) cfg.durchmesser = dm;

    var unknown = [];
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k) && !PARAMS_BY_KEY[k] &&
          !PASSTHROUGH[k] && k !== 'format' && k !== 'version') {
        unknown.push(k);
      }
    }
    if (unknown.length) warnings.push('Unbekannte Felder ignoriert: ' + unknown.join(', '));

    // Fachliche Plausibilität
    if (cfg.hoehe_mitte > cfg.hoehe_oben) {
      warnings.push('"hoehe_mitte" liegt über "hoehe_oben" – die breiteste Stelle wird an die Spitze gelegt.');
    }

    return { config: cfg, warnings: warnings };
  }

  // ------------------------------------------------------------ Laden

  /** JSON-Text -> { config, warnings }. Wirft bei kaputtem JSON. */
  function parse(jsonText) {
    var data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      throw new Error('Datei enthält kein gültiges JSON: ' + e.message);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Datei enthält kein Konfigurationsobjekt.');
    }
    var res = normalize(data);
    if (data.format && data.format !== FORMAT) {
      res.warnings.unshift('Fremdes Format "' + data.format + '" – es wurde trotzdem versucht zu laden.');
    }
    return res;
  }

  /** File-Objekt (input[type=file] / Drag&Drop) -> Promise<{config, warnings}> */
  function fromFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('Keine Datei übergeben.')); return; }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Datei konnte nicht gelesen werden.')); };
      reader.onload = function () {
        try { resolve(parse(String(reader.result))); }
        catch (e) { reject(e); }
      };
      reader.readAsText(file);
    });
  }

  /** URL -> Promise<{config, warnings}> */
  function fromUrl(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' beim Laden von ' + url);
      return r.text();
    }).then(parse);
  }

  // ------------------------------------------------------------ Speichern

  /**
   * @param {object} config
   * @param {object} [extra]  { name, durchmesser } — siehe Kopf der Datei.
   *        Fehlt ein Wert, wird der aus der Konfiguration durchgereichte genommen.
   */
  function serialize(config, extra) {
    var res = normalize(config);
    var ex = extra || {};
    var out = { format: FORMAT, version: VERSION };

    var name = typeof ex.name === 'string' ? ex.name.trim() : res.config.name;
    if (name) out.name = name;

    // Durchmesser in mm, auf 0,1 mm gerundet. Er steht bewusst weit oben in der
    // Datei: der Garten liest ihn für die Schattenkarte, ohne die Formparameter
    // überhaupt anzufassen.
    var dm = typeof ex.durchmesser === 'number' ? ex.durchmesser : res.config.durchmesser;
    out.durchmesser = (typeof dm === 'number' && isFinite(dm) && dm >= 0)
      ? Math.round(dm * 10) / 10 : 0;

    if (res.config.seed !== undefined) out.seed = res.config.seed;
    for (var i = 0; i < PARAMS.length; i++) {
      var p = PARAMS[i];
      if (p.type === 'image' && !res.config[p.key]) continue; // leere Textur weglassen
      out[p.key] = res.config[p.key];
    }
    return JSON.stringify(out, null, 2);
  }

  function download(config, filename, extra) {
    var blob = new Blob([serialize(config, extra)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'grasbueschel.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    PARAMS: PARAMS,
    PARAMS_BY_KEY: PARAMS_BY_KEY,
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    parse: parse,
    fromFile: fromFile,
    fromUrl: fromUrl,
    serialize: serialize,
    download: download,
    normalizeHex: normalizeHex,
    hexToRgb: hexToRgb,
    glanzToRoughness: glanzToRoughness
  };
}));
