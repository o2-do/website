/**
 * main.js — Verbindet UI, loader.js, geometry.js und viewer.js.
 * Die Bedienelemente werden vollständig aus PflanzenLoader.PARAMS erzeugt.
 */
(function () {
  'use strict';

  var Loader = window.PflanzenLoader;
  var Geo = window.PflanzenGeometry;

  var state = Loader.normalize({}).config;   // aktuelle Konfiguration
  var inputs = {};                           // key -> { set(v), get() }
  var viewer = null;
  var framed = false;
  var textureName = '';

  var el = {
    controls: document.getElementById('controls'),
    message: document.getElementById('message'),
    stats: document.getElementById('stats'),
    fileConfig: document.getElementById('file-config'),
    plantName: document.getElementById('plant-name')
  };

  var DEFAULT_NAME = 'pflanze';

  /**
   * Aus dem eingegebenen Namen einen brauchbaren Dateinamen machen.
   * Zeichen, die in Dateinamen nicht vorkommen dürfen, werden zu "-".
   * Der bereinigte Name geht auch in die Datei — der Beetkonfigurator sucht die
   * Pflanze später genau unter diesem Namen ($art).
   */
  function plantName() {
    var raw = (el.plantName.value || '').trim();
    var clean = raw.replace(/\.json$/i, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
    return clean || DEFAULT_NAME;
  }

  // ------------------------------------------------------------- UI-Aufbau

  function buildUI() {
    var groups = [];
    var byName = {};

    Loader.PARAMS.forEach(function (p) {
      if (!byName[p.group]) {
        byName[p.group] = { name: p.group, params: [] };
        groups.push(byName[p.group]);
      }
      byName[p.group].params.push(p);
    });

    groups.forEach(function (g) {
      var box = document.createElement('div');
      box.className = 'group';
      var h = document.createElement('h2');
      h.textContent = g.name;
      box.appendChild(h);
      g.params.forEach(function (p) { box.appendChild(buildRow(p)); });
      el.controls.appendChild(box);
    });
  }

  /**
   * Ohne das stellt der Browser beim Neuladen die zuletzt eingestellten Werte
   * wieder her — die Seite startet dann nicht mit den Standardwerten, und die
   * Anzeige stimmt nicht mehr mit `state` überein.
   */
  function noRestore(input) {
    input.setAttribute('autocomplete', 'off');
    return input;
  }

  function buildRow(p) {
    var row = document.createElement('div');
    row.className = 'row';

    var label = document.createElement('label');
    label.innerHTML = '<span>' + p.label + '</span>' +
      // "…" statt "–", sonst liest sich ein negatives Minimum als "-45–45"
      '<span class="key">$' + p.key + (p.type === 'range' ? ' (' + p.min + ' … ' + p.max + ')' : '') + '</span>';
    if (p.hint) label.title = p.hint;
    row.appendChild(label);

    var field = document.createElement('div');
    field.className = 'field';
    row.appendChild(field);

    if (p.type === 'range') buildRange(p, row, field);
    else if (p.type === 'color') buildColor(p, field);
    else if (p.type === 'bool') buildBool(p, field);
    else if (p.type === 'image') buildImage(p, row, field);

    return row;
  }

  function buildRange(p, row, field) {
    var num = noRestore(document.createElement('input'));
    num.type = 'number';
    num.id = 'p-' + p.key;
    num.min = p.min; num.max = p.max; num.step = p.step;

    var unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = p.unit || '';

    field.appendChild(num);
    field.appendChild(unit);

    var slider = noRestore(document.createElement('input'));
    slider.type = 'range';
    slider.min = p.min; slider.max = p.max; slider.step = p.step;
    slider.className = 'slider';
    var wrap = document.createElement('div');
    wrap.className = 'slider';
    wrap.appendChild(slider);
    row.appendChild(wrap);

    function commit(v, echoTo) {
      var n = parseFloat(v);
      if (!isFinite(n)) n = p.def;
      n = Math.min(p.max, Math.max(p.min, n));
      state[p.key] = n;
      if (echoTo !== num) num.value = String(n);
      if (echoTo !== slider) slider.value = String(n);
      onChange();
    }

    slider.addEventListener('input', function () { commit(slider.value, slider); });
    num.addEventListener('input', function () {
      // Beim Tippen nicht auf den Slider zurückschreiben — sonst springt der Cursor
      var n = parseFloat(num.value);
      if (isFinite(n)) { state[p.key] = Math.min(p.max, Math.max(p.min, n)); slider.value = num.value; onChange(); }
    });
    num.addEventListener('change', function () { commit(num.value); });

    inputs[p.key] = {
      set: function (v) { num.value = String(v); slider.value = String(v); }
    };
  }

  function buildColor(p, field) {
    var hex = noRestore(document.createElement('input'));
    hex.type = 'text';
    hex.id = 'p-' + p.key;
    hex.className = 'hex';
    hex.maxLength = 6;
    hex.spellcheck = false;
    hex.placeholder = p.def;

    var pick = noRestore(document.createElement('input'));
    pick.type = 'color';

    field.appendChild(hex);
    field.appendChild(pick);

    hex.addEventListener('input', function () {
      var v = Loader.normalizeHex(hex.value);
      if (v) { state[p.key] = v; pick.value = '#' + v; onChange(); }
    });
    hex.addEventListener('blur', function () { hex.value = state[p.key]; });
    pick.addEventListener('input', function () {
      var v = Loader.normalizeHex(pick.value);
      state[p.key] = v;
      hex.value = v;
      onChange();
    });

    inputs[p.key] = {
      set: function (v) { hex.value = v; pick.value = '#' + v; }
    };
  }

  function buildBool(p, field) {
    var cb = noRestore(document.createElement('input'));
    cb.type = 'checkbox';
    cb.id = 'p-' + p.key;
    field.appendChild(cb);
    cb.addEventListener('change', function () {
      state[p.key] = cb.checked;
      applyMaterial();                             // wirkt sofort, ohne Neuaufbau
    });
    inputs[p.key] = { set: function (v) { cb.checked = !!v; } };
  }

  function buildImage(p, row, field) {
    row.classList.add('tex-row');

    var img = document.createElement('img');
    img.id = 'tex-preview';
    img.alt = '';
    img.hidden = true;

    var pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = 'Bild wählen…';

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ghost';
    clear.textContent = 'Entfernen';

    var name = document.createElement('span');
    name.id = 'tex-name';
    name.textContent = 'keine';

    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;

    field.appendChild(img);
    field.appendChild(pick);
    field.appendChild(clear);
    field.appendChild(name);
    field.appendChild(file);

    pick.addEventListener('click', function () { file.click(); });
    clear.addEventListener('click', function () {
      state[p.key] = null;
      textureName = '';
      file.value = '';
      applyTexture();
    });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        state[p.key] = String(reader.result);
        textureName = f.name;
        applyTexture();
      };
      reader.onerror = function () { message('Bild konnte nicht gelesen werden.', 'error'); };
      reader.readAsDataURL(f);
    });

    inputs[p.key] = {
      set: function (v) {
        img.hidden = !v;
        if (v) img.src = v;
        name.textContent = v ? (textureName || 'aus Konfiguration geladen') : 'keine';
      }
    };
  }

  function applyTexture() {
    inputs.halm_textur.set(state.halm_textur);
    if (!viewer) return;
    viewer.setTexture(state.halm_textur, function (tex, err) {
      if (err) message(err.message, 'error');
    });
  }

  /** Alle Bedienelemente aus state füllen */
  function syncUI() {
    Loader.PARAMS.forEach(function (p) {
      if (inputs[p.key]) inputs[p.key].set(state[p.key]);
    });
  }

  // ------------------------------------------------------------- Erzeugen

  /** Materialwerte wirken ohne Neuaufbau der Geometrie — sofort anwenden. */
  function applyMaterial() {
    if (!viewer) return;
    viewer.setGloss(state.glanz);
    viewer.setShadows(state.schatten);
  }

  function onChange() {
    applyMaterial();
    if (document.getElementById('auto-update').checked) generate();
  }

  function generate() {
    var res = Loader.normalize(state);
    state = res.config;

    var t0 = performance.now();
    var data = Geo.buildTuft(state);
    viewer.setTuft(data, { shadows: state.schatten, gloss: state.glanz });
    var ms = performance.now() - t0;

    if (!framed) { resetView(data.stats); framed = true; }

    var s = data.stats;
    el.stats.textContent = s.blades + ' Halme · ' + s.segmentsPerBlade + ' Segmente/Halm · ' +
      (s.kolben ? s.kolben + ' Kolben · ' : '') +
      s.triangles.toLocaleString('de-DE') + ' Dreiecke · H ' + Math.round(s.height) + ' mm · ' +
      ms.toFixed(0) + ' ms';

    if (s.triangles === 0) {
      message('Leeres Ergebnis — "Anzahl Halme" bzw. "Anzahl Teilsegmente" und "Höhe Stiel" sind 0.', 'warn');
    } else {
      clearMessage();
    }
  }

  function resetView(stats) {
    var s = stats || (viewer.lastStats || { height: 700, radius: 300 });
    viewer.frame(s.height, s.radius);
  }

  // ------------------------------------------------------------- Meldungen

  function message(text, kind) {
    el.message.hidden = false;
    el.message.className = kind || '';
    el.message.textContent = text;
  }

  function clearMessage() {
    el.message.hidden = true;
    el.message.textContent = '';
  }

  // ------------------------------------------------------------- Speichern / Laden

  function save() {
    var name = plantName();
    el.plantName.value = name;

    // Der Durchmesser wird hier frisch aus `state` gebaut und nicht aus der
    // letzten Vorschau übernommen: ohne "automatisch" kann die Vorschau einen
    // älteren Stand zeigen als die Konfiguration, die gerade gespeichert wird.
    var durchmesser = Geo.durchmesser(Loader.normalize(state).config);

    Loader.download(state, name + '.json', { name: name, durchmesser: durchmesser });
    message('Konfiguration als "' + name + '.json" gespeichert.' +
      '\nDurchmesser in der Aufsicht: ' + (Math.round(durchmesser) / 1000).toFixed(3) + ' m.' +
      (state.halm_textur ? '\nDie Textur ist als Data-URL eingebettet — die Datei ist dadurch größer.' : ''), 'ok');
  }

  function load(file) {
    Loader.fromFile(file).then(function (res) {
      state = res.config;
      textureName = '';
      // Der Dateiname ist der Name der Pflanze — er gewinnt gegen ein evtl.
      // abweichendes Feld in der Datei, denn der Beetkonfigurator spricht die
      // Pflanze ebenfalls über den Dateinamen an.
      el.plantName.value = String(file.name || '').replace(/\.json$/i, '') || (state.name || DEFAULT_NAME);
      syncUI();
      generate();
      applyMaterial();
      applyTexture();
      if (res.warnings.length) {
        message('Geladen mit Hinweisen:\n• ' + res.warnings.join('\n• '), 'warn');
      } else {
        message('Konfiguration "' + file.name + '" geladen.', 'ok');
      }
    }).catch(function (e) {
      message('Laden fehlgeschlagen: ' + e.message, 'error');
    });
  }

  // ------------------------------------------------------------- Start

  function init() {
    if (!window.THREE) {
      message('three.js konnte nicht geladen werden — bitte prüfen, ob der Ordner "vendor" neben index.html liegt.', 'error');
      return;
    }

    buildUI();
    syncUI();

    viewer = new PflanzenViewer(document.getElementById('scene'));

    document.getElementById('btn-generate').addEventListener('click', function () { generate(); });
    document.getElementById('btn-reset-view').addEventListener('click', function () { resetView(); });
    document.getElementById('btn-save').addEventListener('click', save);
    document.getElementById('btn-load').addEventListener('click', function () { el.fileConfig.click(); });
    el.fileConfig.addEventListener('change', function () {
      if (el.fileConfig.files && el.fileConfig.files[0]) load(el.fileConfig.files[0]);
      el.fileConfig.value = '';
    });
    document.getElementById('btn-defaults').addEventListener('click', function () {
      state = Loader.normalize({}).config;
      textureName = '';
      syncUI();
      applyTexture();
      applyMaterial();
      generate();
      message('Standardwerte wiederhergestellt.', 'ok');
    });

    // JSON per Drag & Drop auf das Fenster
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.json$/i.test(f.name)) load(f);
    });

    generate();

    // Kleine Schnittstelle für Konsole / Einbindung von außen
    window.PflanzenApp = {
      viewer: viewer,
      getConfig: function () { return Loader.normalize(state).config; },
      setConfig: function (cfg) {
        state = Loader.normalize(cfg).config;
        syncUI();
        applyTexture();
        applyMaterial();
        generate();
      },
      generate: generate,
      resetView: function () { resetView(); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
