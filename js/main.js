import * as THREE from 'three';
import { SCHEMA, defaults, normalize } from './config.js';
import { createViewer, KAMERA_FREI } from './scene.js';
import { loadTextures } from './textures.js';
import { buildGarden, disposeGarden } from './garden.js';
import { createWalker, MAX_PENDING } from './walker.js';
import { createWalkerMark, buildSignMarks, updateMarks } from './mapmarks.js';
import { parseTreeList, fetchTreeList, clearTreeCache } from './baumloader.js';
import { setTranslucency } from './translucency.js';
import { aktualisiereGrasSicht } from './grass.js';
import { zaunRadius, PFOSTEN_D } from './zaun.js';

// Wie weit vor dem Zaun der Spaziergang endet. Die Augenhoehe liegt bei 1,50 m,
// der Zaun ist 1 m hoch - wer bis an ihn heranlaeuft, hat ihn nicht mehr im
// Bild, sondern steckt darin.
// So weit vor dem Zaun endet der Auslauf: der Kameraabstand plus der halbe
// Pfosten, denn gemessen wird zur Pfostenmitte, gemeint ist seine Oberflaeche.
const LAUFABSTAND_ZAUN = KAMERA_FREI + PFOSTEN_D / 2;

const canvas = document.getElementById('view');
const form = document.getElementById('params');
const hud = document.getElementById('hud');
const spinner = document.getElementById('spinner');
const spinnerText = document.getElementById('spinner-text');
const queueCount = document.getElementById('queue-count');

const viewer = createViewer(canvas);
let garden = null;
let stats = null;
const walker = createWalker(viewer.walkCam, (x, z) => (garden ? garden.hf.heightAt(x, z) : 0));

// Landkarten-Marken leben ausserhalb des Gartens: der Standpunkt ueberdauert
// jeden Neuaufbau, die Namensschilder werden je Aufbau ersetzt.
const walkerMark = createWalkerMark();
viewer.scene.add(walkerMark);
let signMarks = null;

// Im Formular ausgewaehlte Dateien: Schluessel -> { name, daten }. Der Inhalt
// wird sofort gelesen und hier gehalten - eine Datei aus dem Dateidialog hat
// keinen Pfad, den man spaeter nachladen koennte.
const dateien = new Map();

/* ---------------- Formular aus dem Schema ---------------- */

function buildForm() {
  const cfg = defaults();
  const groups = new Map();
  for (const f of SCHEMA) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }

  for (const [name, fields] of groups) {
    const box = document.createElement('div');
    box.className = 'group';
    box.innerHTML = `<h3>${name}</h3>`;

    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'field' + (f.type === 'checkbox' ? ' check' : '');
      const id = `f_${f.key}`;

      if (f.type === 'checkbox') {
        wrap.innerHTML =
          `<label for="${id}"><input type="checkbox" id="${id}" ${f.default ? 'checked' : ''}>${f.label}</label>`;
      } else if (f.type === 'text') {
        wrap.innerHTML =
          `<label for="${id}">${f.label}</label>` +
          `<input type="text" id="${id}" value="${f.default}">`;
      } else if (f.type === 'file') {
        wrap.innerHTML =
          `<label for="${id}">${f.label}<span class="val" id="${id}_v">${f.default}</span></label>` +
          `<input type="file" id="${id}" accept="${f.accept || ''}" hidden>` +
          `<button type="button" class="nav ghost wide" id="${id}_b">Datei wählen …</button>`;
        const inp = wrap.querySelector('input');
        const out = wrap.querySelector('.val');
        wrap.querySelector('button').addEventListener('click', () => inp.click());
        inp.addEventListener('change', async () => {
          const file = inp.files && inp.files[0];
          if (!file) return;
          try {
            dateien.set(f.key, { name: file.name, daten: JSON.parse(await file.text()) });
            out.textContent = file.name;
          } catch (err) {
            out.textContent = 'unlesbar: ' + err.message;
          }
        });
        box.appendChild(wrap);
        continue;
      } else if (f.type === 'select') {
        wrap.innerHTML =
          `<label for="${id}">${f.label}` +
          `${f.unit ? '<span style="opacity:.7">' + f.unit + '</span>' : ''}</label>` +
          `<select id="${id}">` +
          f.options.map((o) => `<option value="${o}"${o === f.default ? ' selected' : ''}>${o}</option>`).join('') +
          `</select>`;
      } else {
        wrap.innerHTML =
          `<label for="${id}">${f.label}` +
          `<span><span class="val" id="${id}_v">${f.default}</span>` +
          `${f.unit ? ' <span style="opacity:.7">' + f.unit + '</span>' : ''}</span></label>` +
          `<input type="range" id="${id}" min="${f.min}" max="${f.max}" step="${f.step}" value="${f.default}">`;
      }
      box.appendChild(wrap);

      const inp = wrap.querySelector('input, select');
      if (f.type === 'range') {
        const out = wrap.querySelector('.val');
        inp.addEventListener('input', () => { out.textContent = inp.value; });
      }
      if (f.live) inp.addEventListener('input', applyLive);
    }
    form.appendChild(box);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.innerHTML =
    `<button type="submit" class="primary">Garten neu erzeugen</button>` +
    `<button type="button" class="nav ghost" id="btn-random">Zufälliger Startwert</button>` +
    `<button type="button" class="nav ghost" id="btn-save">Einstellungen speichern</button>` +
    `<button type="button" class="nav ghost" id="btn-load">Einstellungen laden …</button>` +
    `<input type="file" id="f-load" accept=".json" hidden>` +
    `<span class="queue" id="build-info"></span>`;
  form.appendChild(actions);

  document.getElementById('btn-random').addEventListener('click', () => {
    document.getElementById('f_seed').value = 'garten-' + Math.random().toString(36).slice(2, 8);
    rebuild();
  });
  document.getElementById('btn-save').addEventListener('click', saveSettings);
  document.getElementById('btn-load').addEventListener('click', () => document.getElementById('f-load').click());
  document.getElementById('f-load').addEventListener('change', loadSettings);

  return cfg;
}

/** Rohwerte des Formulars, so wie sie dastehen - Grundlage fuer Speichern. */
function readRaw() {
  const raw = {};
  for (const f of SCHEMA) {
    const el = document.getElementById(`f_${f.key}`);
    if (f.type === 'checkbox') raw[f.key] = el.checked;
    else if (f.type === 'text') raw[f.key] = el.value.trim() || f.default;
    else if (f.type === 'file') raw[f.key] = dateien.has(f.key) ? dateien.get(f.key).name : f.default;
    // Ein `select` liefert Zahlen, WENN seine Optionen Zahlen sind - sonst
    // haette `parseFloat` aus 'eingebrannt' ein NaN gemacht, und der Schalter
    // waere wirkungslos geblieben, ohne dass irgendwo etwas gemeldet wird.
    else if (f.type === 'select' && f.options.some((o) => typeof o === 'string'
                                                  && !Number.isFinite(parseFloat(o)))) {
      raw[f.key] = el.value;
    }
    else raw[f.key] = parseFloat(el.value);   // range und Zahlen-select
  }
  return raw;
}

function writeRaw(raw) {
  for (const f of SCHEMA) {
    if (!(f.key in raw)) continue;
    const el = document.getElementById(`f_${f.key}`);
    if (f.type === 'checkbox') el.checked = !!raw[f.key];
    else if (f.type === 'file') {
      const out = document.getElementById(`f_${f.key}_v`);
      if (out) out.textContent = raw[f.key];
    } else {
      el.value = raw[f.key];
      const out = document.getElementById(`f_${f.key}_v`);
      if (out && f.type === 'range') out.textContent = el.value;
    }
  }
}

function readForm() {
  return normalize(readRaw());
}

/* ---------------- Einstellungen speichern und laden ---------------- */

// Die Baumliste kommt mit in die Datei: eine im Dateidialog gewaehlte Liste hat
// keinen Pfad, unter dem sie sich spaeter wiederfinden liesse. Damit ist eine
// gespeicherte Einstellung fuer sich vollstaendig.
function saveSettings() {
  const daten = {
    typ: 'gartensimulator',
    version: 1,
    gespeichert: new Date().toISOString(),
    werte: readRaw(),
    baumListe: dateien.has('baumListe') ? dateien.get('baumListe').daten : null,
    // Die gesetzten Sammelmarken gehoeren zum Garten wie seine Einstellungen:
    // `game.html` liest sie aus derselben Datei.
    plaketten,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(daten, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${daten.werte.seed || 'garten'}.einstellungen.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadSettings(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';                       // dieselbe Datei erneut waehlbar
  if (!file) return;
  try {
    const daten = JSON.parse(await file.text());
    if (!daten || typeof daten !== 'object' || !daten.werte) {
      throw new Error('keine Einstellungsdatei des Gartensimulators');
    }
    if (daten.baumListe) dateien.set('baumListe', { name: daten.werte.baumListe, daten: daten.baumListe });
    else dateien.delete('baumListe');
    plaketten = Array.isArray(daten.plaketten) ? daten.plaketten : [];
    plakettenNr = plaketten.reduce((a, p) => Math.max(a, +p.nr || 0), 0);
    writeRaw(daten.werte);
    applyLive();
    rebuild();
  } catch (err) {
    document.getElementById('build-info').textContent = 'Einstellungen nicht lesbar: ' + err.message;
  }
}

/* ---------------- Sofort wirksame Parameter ---------------- */

let texturen = null;                 // aus dem letzten Aufbau, fuer applyLive

// Sichtweite der Grashalme, in Metern. Sie liegt hier und nicht in `cfg`, weil
// die Bildschleife sie jedes Bild braucht und `applyLive` jedes Mal ein frisch
// gelesenes cfg anlegt - ein dort festgehaltenes waere sofort veraltet.
let grasWeite = defaults().grasWeite;

// Was zuletzt eingebrannt wurde. Ohne dieses Gedaechtnis brennte jedes Zucken
// eines Reglers die Karte neu - und das ist ein zusaetzliches Bild mit voller
// Baumgeometrie.
let schattenStand = '';

/**
 * Die Schattenkarte der Szene einmal rechnen und einfrieren.
 *
 * Was darin steht, aendert sich nicht mehr: Felsen, Schilder, Gras und Beete
 * stehen still, und die Baeume werfen ihren Schatten aus einer Flaeche, die
 * sich weder mit der Kamera noch mit der Entfernung aendert. Der
 * Schattendurchgang je Bild faellt damit ersatzlos weg.
 */
function schattenEinbrennen(cfg) {
  const stufe = viewer.isBird() ? 'simpel' : cfg.schatten;
  const stand = [stufe, cfg.schattenAufloesung, !!garden].join('|');
  if (stufe !== 'detailliert' || !garden) {
    schattenStand = stand;
    return;
  }
  if (stand === schattenStand) return;
  schattenStand = stand;
  viewer.backeSchatten();
}

function applyLive() {
  const cfg = readForm();
  viewer.setFog(cfg.nebel);
  viewer.setBlickwinkel(cfg.blickwinkel);
  if (garden && garden.wasser && garden.wasser.userData.setzeToenung) {
    garden.wasser.userData.setzeToenung(cfg.wasserToenung / 100);
  }
  viewer.setSchattenAufloesung(cfg.schattenAufloesung);
  grasWeite = cfg.grasWeite;
  schattenAnwenden(cfg);
  if (texturen) viewer.setForest(texturen.wald, cfg.waldRadius, cfg.waldHoehe, cfg.wald);
  setTranslucency(cfg.transluzenz);
  if (garden) garden.bestand.setzeFerne(cfg.tafelAb, cfg.tafelBand);
  if (garden) {
    garden.group.traverse((o) => {
      if (!o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m.wireframe !== cfg.drahtgitter) { m.wireframe = cfg.drahtgitter; m.needsUpdate = true; }
      }
    });
  }
  schattenEinbrennen(cfg);
}

/**
 * Die Schattenstufe setzen - und in der Vogelperspektive immer „simpel".
 *
 * Die Karte hat als einzige Ansicht den ganzen Garten im Bild. Ein echter
 * Schattendurchgang muesste dort jedes Objekt einreichen, und zu sehen waere
 * bei senkrechtem Blick und fast senkrechter Sonne kaum etwas davon - die
 * eingebrannte Bodenkarte zeigt genau dasselbe und kostet nichts. „aus" waere
 * in der Karte ebenfalls falsch: ohne Schatten fehlt die Tiefe, und man
 * erkennt die Baeume nicht mehr als Baeume.
 */
function schattenAnwenden(cfg) {
  const stufe = viewer.isBird() ? 'simpel' : cfg.schatten;
  // Nur „detailliert" braucht den Schattendurchgang der Szene - und auch der
  // wird einmal gerechnet und dann eingefroren: Sonne und Garten stehen fest.
  viewer.setShadows(stufe === 'detailliert');
  viewer.setSchattenArt('eingebrannt');
  if (garden) garden.bestand.setzeSchatten(stufe);
}

/* ---------------- Aufbau ---------------- */

let building = false;
// Gesetzt, wenn der naechste Aufbau den Standpunkt behalten soll (siehe unten).
let haltePose = null;
const SPINNER_MIN_MS = 600;

async function rebuild() {
  if (building) return;
  building = true;
  const tStart = performance.now();
  spinner.hidden = false;
  spinnerText.textContent = 'Garten wird gebaut …';
  // Spinner muss einmal gezeichnet werden (Timeout-Fallback für Hintergrund-Tabs)
  await new Promise((r) => { let d = false; const f = () => { if (!d) { d = true; r(); } };
    requestAnimationFrame(f); setTimeout(f, 50); });

  try {
    const cfg = readForm();
    // Namensliste: entweder die im Dateidialog gewaehlte oder die Datei, die
    // im Formular steht.
    const gewaehlt = dateien.get('baumListe');
    spinnerText.textContent = 'Baumliste …';
    cfg._baumListe = gewaehlt ? parseTreeList(gewaehlt.daten) : await fetchTreeList(cfg.baumListe);
    // Von Hand gesetzt, nicht gewuerfelt - deshalb an cfg vorbei am Formular.
    cfg._plaketten = plaketten;

    viewer.setFog(cfg.nebel);
    setTranslucency(cfg.transluzenz);
    const R = cfg.durchmesser / 2;
    viewer.fitShadow(R);
    viewer.setSchattenAufloesung(cfg.schattenAufloesung);

    if (garden) { disposeGarden(garden.group); garden = null; }
    if (signMarks) { disposeGarden(signMarks); signMarks = null; }

    const tex = await loadTextures(viewer.renderer);
    texturen = tex;
    const built = await buildGarden(cfg, tex, (t) => { spinnerText.textContent = t; });
    viewer.scene.add(built.group);
    garden = built;
    // Was den Weg verstellt: Staemme, Felsen, Zypressen, Wasser, Gelaender.
    // Beete und Wege stehen bewusst NICHT darin - durch ein Beet laeuft man.
    walker.setzeHindernis((x, z) => built.hindernisse.belegt(x, z));
    stats = built.stats;

    viewer.setForest(tex.wald, cfg.waldRadius, cfg.waldHoehe, cfg.wald);
    viewer.setViewParts(
      built.group.getObjectByName('horizont'),
      built.group.getObjectByName('kartenmaske'),
      built.group.getObjectByName('kartenkasten'),
    );

    // Landkarte: Namensschilder und Standpunktgroesse skalieren mit dem Garten
    signMarks = buildSignMarks(built.signPlan, cfg.durchmesser * 0.022);
    viewer.scene.add(signMarks);
    walkerMark.scale.setScalar(cfg.durchmesser * 0.05);

    // Ein neuer Garten wirft andere Schatten: die eingebrannte Karte gilt nicht
    // mehr. Der Stand wird geleert, damit das Einbrennen wirklich laeuft.
    schattenStand = '';
    schattenAnwenden(cfg);
    schattenEinbrennen(cfg);

    // Nicht ueber den Zaun hinaus: die Schranke liegt ein Stueck davor, damit
    // die Kamera nicht in einen Pfosten hineinsieht. Ohne Zaun gilt die
    // Gartenkante - hinauslaufen soll man auch dann nicht.
    walker.setzeGrenze(cfg.zaun ? zaunRadius(cfg) - LAUFABSTAND_ZAUN : R);

    // WER PLAKETTEN SETZT, BLEIBT STEHEN. Jede gesetzte Marke baut den Garten
    // neu, und der Startpunkt am Rundweg waere dabei jedes Mal ein Sprung quer
    // ueber die Wiese - man muesste nach jeder Marke zurueckgehen. `haltePose`
    // traegt Standort UND Blickrichtung ueber den Aufbau.
    if (haltePose) {
      walker.reset(haltePose.x, haltePose.z, haltePose.yaw);
      haltePose = null;
    } else {
      // Start auf dem ersten Rundweg, Blick in Wegrichtung
      const p0 = built.paths[0];
      if (p0) {
        const s = p0.samples[0];
        walker.reset(s.x, s.z, Math.atan2(-s.tx, -s.tz));
      } else {
        walker.reset(0, 0, 0);
      }
    }
    viewer.birdFit(R);
    // Noch im Spinner: alle Shader uebersetzen. Danach kostet das erste
    // Auftauchen eines Objekts kein langes Bild mehr (siehe `waermeShader`).
    spinnerText.textContent = 'Shader …';
    await viewer.waermeShader();

    document.getElementById('build-info').textContent =
      `${stats.ms} ms · Gitter ${stats.gitter}² · Rundweg + ${stats.abkuerzungen} Abkürzungen ` +
      `(${stats.wegLaenge} m) · ${stats.felsen} Felsbrocken · ` +
      `${stats.baeume} Bäume (${stats.benannt} benannt, ${stats.sorten} Standardsorten) ` +
      `mit ${stats.blaetter.toLocaleString('de-DE')} Blattbildern in ` +
      `${stats.laubvarianten} Laubtönen · ` +
      `${stats.schilder} Schilder · ` +
      `${stats.beete} Beete (${stats.beetVorlagen} Vorlagen) mit ` +
      `${stats.pflanzen} Pflanzen in ${stats.pflanzenArten} Arten · ` +
      `${stats.halme.toLocaleString('de-DE')} Halme ` +
      `(${stats.halmeDetail.join(' / ')}) · ` +
      `Zaun ${stats.zaun.pfosten} Pfosten (r ${stats.zaun.radius} m, ` +
      `Umfang ${stats.zaun.umfang} m) · ` +
      `Raster ${stats.rasterBelegt}% belegt · Sektoren ${stats.sektoren} · ` +
      (stats.plaketten ? `${stats.plaketten} Plaketten · ` : '') +
      `${Math.round(stats.dreiecke / 1000)}k Dreiecke · ${stats.meshes} Meshes`;

    // Der Aufbau dauert je nach Parametern unter 200 ms - ohne Mindeststandzeit
    // blitzt der Spinner nur auf und man sieht nicht, dass etwas passiert ist.
    zeigePlakettenstand();

    const rest = SPINNER_MIN_MS - (performance.now() - tStart);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  } catch (err) {
    // Ohne finally bliebe der Spinner nach einem Fehler stehen und jeder
    // weitere Klick auf "neu erzeugen" wuerde am building-Flag abprallen.
    console.error(err);
    spinnerText.textContent = 'Fehler beim Aufbau: ' + err.message;
    document.getElementById('build-info').textContent = 'Aufbau fehlgeschlagen – siehe Konsole.';
    await new Promise((r) => setTimeout(r, 2000));
  } finally {
    spinner.hidden = true;
    building = false;
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); rebuild(); });

/* ---------------- Navigation ---------------- */

function flashQueueFull(btn) {
  const el = btn || queueCount.parentElement;
  el.classList.add('full');
  setTimeout(() => el.classList.remove('full'), 180);
}

function bindNav(id, type) {
  const btn = document.getElementById(id);
  btn.addEventListener('click', () => {
    if (!walker.enqueue(type)) flashQueueFull(btn);
  });
}
bindNav('btn-forward', 'forward');
bindNav('btn-back', 'back');
bindNav('btn-left', 'left');
bindNav('btn-right', 'right');

walker.onChange(() => {
  queueCount.textContent = walker.pending;
  queueCount.parentElement.style.color = walker.pending >= MAX_PENDING ? '#e0a99b' : '';
  document.getElementById('queue-max').textContent = MAX_PENDING;
});

// Die Pfeiltasten sind das Lenkrad und verhalten sich deshalb anders als die
// Knoepfe darunter: Vor und Zurueck haengen hinten an, Links und Rechts setzen
// sich vorne in die Warteschlange und verschmelzen mit einem wartenden
// Geradeaus zu einer Kurve (siehe `walker.enqueueTurn`). Die Knoepfe bleiben
// beim schlichten Anhaengen - dort zielt man auf ein Feld und meint genau das.
// WASD LIEGT NEBEN DEN PFEILEN, nicht statt ihrer: die eine Hand bleibt auf
// der Maus, die andere findet w-a-s-d blind. Verglichen wird kleingeschrieben,
// damit die Umschalttaste nicht dazwischenfunkt.
const RICHTUNG = {
  ArrowUp: 'vor', w: 'vor', ArrowDown: 'zurueck', s: 'zurueck',
  ArrowLeft: 'links', a: 'links', ArrowRight: 'rechts', d: 'rechts',
};

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const was = RICHTUNG[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!was) return;
  if (was === 'vor') walker.enqueue('forward');
  else if (was === 'zurueck') walker.enqueue('back');
  else walker.enqueueTurn(was === 'links' ? +1 : -1);
  e.preventDefault();
});

/* ---------------- Umschauen mit der Maus ---------------- */

const LOOK_SENS = 0.0045;   // rad je Pixel
const ORBIT_SENS = 0.006;
const DRAG_START = 4;       // px, ab hier gilt es als Ziehen und nicht als Klick

let lastX = 0, lastY = 0, downX = 0, downY = 0;
let pointerDown = false, dragging = false;
// Ob der zuletzt beendete Zeigerkontakt ein Ziehen war. `dragging` ist beim
// nachfolgenden `click` schon wieder false, taugt dort also nicht zur Abfrage.
let warZiehen = false;

canvas.style.cursor = 'grab';

canvas.addEventListener('pointerdown', (e) => {
  lastX = downX = e.clientX;
  lastY = downY = e.clientY;
  pointerDown = true;
  dragging = false;
  warZiehen = false;
  // Capture ist Komfort (Ziehen ueber den Canvasrand hinaus), kein Muss -
  // scheitert es, darf der Zustand oben trotzdem nicht verlorengehen.
  try { canvas.setPointerCapture(e.pointerId); } catch { /* egal */ }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointerDown) return;
  // Erst ab ein paar Pixeln wird gedreht. Sonst kippt jeder (Doppel-)Klick
  // die Blickrichtung um ein paar Grad, weil die Maus dabei immer wackelt.
  if (!dragging) {
    if (Math.abs(e.clientX - downX) < DRAG_START && Math.abs(e.clientY - downY) < DRAG_START) return;
    dragging = true;
    if (!viewer.isBird()) walker.beginLook();
    canvas.style.cursor = 'grabbing';
  }
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  // In der Karte dreht sich der Garten nur um die Hochachse - die Neigung
  // steht fest, senkrechtes Ziehen tut dort also nichts.
  if (viewer.isBird()) viewer.birdOrbit(dx * ORBIT_SENS);
  else walker.look(dx * LOOK_SENS, dy * LOOK_SENS);
});

const endDrag = (e) => {
  if (!pointerDown) return;
  pointerDown = false;
  if (dragging) {
    walker.endLook();
    dragging = false;
    // Nur ein echtes Ziehen unterdrueckt den folgenden Klick. Beim Zielen
    // wackelt die Maus fast immer ueber die 4-Pixel-Schwelle hinaus - das
    // darf den Doppelklick nicht verschlucken.
    warZiehen = Math.abs(lastX - downX) > DBL_PX || Math.abs(lastY - downY) > DBL_PX;
  }
  canvas.style.cursor = 'grab';
  if (e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);

/* ---------------- Doppelklick ---------------- */

// Eigene Paarerkennung statt des nativen `dblclick`. Der Browser zaehlt eine
// schnelle Klickfolge durch und meldet den Doppelklick nur bei jedem zweiten
// Klick der Kette - wer viermal schnell klickt, um vier Schritte in die
// Warteschlange zu legen, bekommt je nach Zaehlerstand nur einen oder zwei.
// Hier wird der Zaehler nach jedem erkannten Paar zurueckgesetzt, damit
// wirklich jedes Klickpaar einen Schritt ergibt.
const DBL_MS = 450;
const DBL_PX = 12;
let lastClick = { t: -1e9, x: 0, y: 0 };

canvas.addEventListener('click', (e) => {
  // Im EDIT-Modus setzt schon der EINFACHE Klick - dort geht es ums Zielen,
  // nicht ums Laufen.
  if (editModus) { if (!warZiehen) plakettenKlick(e); return; }
  const now = performance.now();
  const paar = now - lastClick.t < DBL_MS
    && Math.abs(e.clientX - lastClick.x) < DBL_PX
    && Math.abs(e.clientY - lastClick.y) < DBL_PX;
  lastClick = paar ? { t: -1e9, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
  if (!paar || warZiehen) return;
  if (viewer.isBird()) mapJump(e);
  else stepTowards(e);
});
// Der native Doppelklick markiert sonst Text bzw. loest den Zoom aus.
canvas.addEventListener('dblclick', (e) => e.preventDefault());

// Augenhoehe: 1 m in die angeklickte Richtung. Der horizontale Abstand von der
// Bildmitte wird ueber den Bildwinkel in einen Drehwinkel umgerechnet - weit
// links heisst also drehen und gehen zugleich. Landet wie jeder Klick in der
// Warteschlange.
function stepTowards(e) {
  const r = canvas.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;          // -1 … +1
  const cam = viewer.walkCam;
  const tanHalfX = Math.tan((cam.fov * Math.PI / 180) / 2) * cam.aspect;
  const yaw = -Math.atan(nx * tanHalfX);                        // links = +yaw
  if (!walker.enqueue('step', { yaw })) flashQueueFull();
}

// Landkarte: an die angeklickte Stelle versetzen, ohne die Ansicht zu
// verlassen. Der Sehstrahl wird mit der Gelaendeoberflaeche geschnitten - erst
// gegen die Ebene y = 0, dann zweimal gegen die Ebene der dort gefundenen
// Hoehe. Das konvergiert bei den flachen Neigungen hier in zwei Schritten.
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

function mapJump(e) {
  if (!garden) return;
  const r = canvas.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, viewer.birdCam);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  if (d.y >= -1e-6) return;                      // Strahl trifft den Boden nie

  let x = 0, z = 0, y = 0;
  for (let i = 0; i < 3; i++) {
    const t = (y - o.y) / d.y;
    x = o.x + d.x * t;
    z = o.z + d.z * t;
    y = garden.hf.heightAt(x, z);
  }

  // maximal bis zum Gartenrand
  const R = garden.hf.radius;
  const len = Math.hypot(x, z);
  if (len > R) { x = (x / len) * R; z = (z / len) * R; }

  walker.reset(x, z, walker.pose.yaw);
}

// Mausrad: zoomen, in beiden Ansichten. In Augenhöhe zieht es den Sichtwinkel
// enger, in der Karte den Ausschnitt.
//
// Das Rad gilt nur ÜBER DEM CANVAS. Darunter liegt das Formular, und dort
// scrollt es weiter die Seite - sonst käme man an die Regler nicht mehr heran.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  viewer.zoom(Math.sign(e.deltaY) * 3);
}, { passive: false });

document.getElementById('btn-bird').addEventListener('click', (e) => {
  const bird = !viewer.isBird();
  viewer.setCamera(bird ? 'bird' : 'walk');
  e.target.textContent = bird ? 'Augenhöhe 1,50 m' : 'Vogelperspektive';
  // Die Karte hat ihre eigene Schattenstufe (siehe `schattenAnwenden`).
  const cfg = readForm();
  schattenAnwenden(cfg);
  schattenEinbrennen(cfg);
});

/* ---------------- Plaketten setzen ---------------- */

/**
 * DER EDIT-MODUS.
 *
 * Solange er laeuft, setzt jeder Klick ins Bild eine Plakette dorthin, wo der
 * Sehstrahl die Landschaft trifft - mit der Normalen der getroffenen Flaeche,
 * damit sie in deren Schraeglage liegt. Ein Klick auf eine schon gesetzte
 * Plakette nimmt sie wieder weg.
 *
 * Gespeichert wird ORT UND NORMALE, nicht ein Dreieck (siehe `plaketten.js`).
 * Die Liste haengt am Formular wie eine Einstellung: sie ueberlebt einen
 * Neuaufbau und geht mit „Einstellungen speichern" in die Datei.
 */
let plaketten = [];
let plakettenNr = 0;
let editModus = false;

const editKnopf = document.getElementById('btn-edit');
editKnopf.addEventListener('click', () => {
  editModus = !editModus;
  editKnopf.classList.toggle('aktiv', editModus);
  editKnopf.textContent = editModus ? 'Plaketten: fertig' : 'Plaketten setzen';
  canvas.style.cursor = editModus ? 'crosshair' : 'grab';
  zeigePlakettenstand();
});

function zeigePlakettenstand() {
  const el = document.getElementById('build-info');
  if (!el || !editModus) return;
  el.textContent = `Plaketten setzen: ${plaketten.length} gesetzt · `
    + 'Klick ins Bild setzt eine, Klick auf eine vorhandene entfernt sie.';
}

// Welche Netze der Strahl treffen darf. Der Himmel, die Horizontscheibe und die
// Kartenteile gehoeren nicht dazu - eine Plakette an der Horizontscheibe waere
// einen halben Kilometer weit weg.
// Ausgenommen sind auch die Netze, deren Form erst im Shader entsteht - Laub,
// Fern-Tafeln und Grashalme. Ein Strahl trifft dort die zusammengeklappte
// Geometrie am Ankerpunkt und nicht das, was man sieht.
const NICHT_TREFFEN =
  /^(himmel|horizont|kartenmaske|kartenkasten|unterlage|waldhorizont|wasser|tafeln|laub|gras_)/;

function plakettenKlick(e) {
  if (!garden) return;
  const r = canvas.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
           -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, viewer.camera);

  // Erst pruefen, ob eine vorhandene Plakette getroffen ist - dann wird sie
  // weggenommen statt eine zweite darauf zu setzen.
  if (garden.plaketten) {
    const treffer = _ray.intersectObject(garden.plaketten, false);
    if (treffer.length) {
      const i = treffer[0].instanceId;
      if (i != null && plaketten[i]) {
        plaketten.splice(i, 1);
        haltePose = walker.pose;
        rebuild();
        return;
      }
    }
  }

  const ziele = [];
  garden.group.traverse((o) => {
    if (!o.isMesh || !o.visible || o === garden.plaketten) return;
    if (NICHT_TREFFEN.test(o.name || '')) return;
    ziele.push(o);
  });
  const treffer = _ray.intersectObjects(ziele, false);
  if (!treffer.length) return;
  const t = treffer[0];
  // Die Normale kommt im Koordinatensystem des Netzes; fuer eine Instanz gilt
  // zusaetzlich deren Matrix. `normalMatrix` des getroffenen Objekts reicht,
  // solange nichts ungleichmaessig skaliert ist - das ist hier nirgends so.
  const n = new THREE.Vector3(0, 1, 0);
  if (t.face) {
    n.copy(t.face.normal);
    if (t.instanceId != null && t.object.isInstancedMesh) {
      const im = new THREE.Matrix4();
      t.object.getMatrixAt(t.instanceId, im);
      n.transformDirection(im);
    }
    n.transformDirection(t.object.matrixWorld);
  }
  plaketten.push({
    nr: ++plakettenNr,
    x: +t.point.x.toFixed(3), y: +t.point.y.toFixed(3), z: +t.point.z.toFixed(3),
    nx: +n.x.toFixed(4), ny: +n.y.toFixed(4), nz: +n.z.toFixed(4),
  });
  // Ohne Neuaufbau: die neue Marke gleich ins bestehende Netz haengen waere
  // moeglich, aber das Netz hat eine feste Instanzzahl. Ein Neuaufbau ist beim
  // Setzen von Hand schnell genug und haelt die Sache einfach - der Standpunkt
  // bleibt dabei stehen.
  haltePose = walker.pose;
  rebuild();
}

/* ---------------- Frame ---------------- */

let wasserZeit = 0;

viewer.onFrame((dt) => {
  walker.update(dt);
  // Nah und fern: was jenseits der Grenze steht, wird zur Tafel. Nur in
  // Augenhoehe - in der Karte stehen immer die echten Baeume.
  if (garden) {
    garden.bestand.aktualisiere(viewer.camera, viewer.isBird());
    // Halme jenseits der Sichtweite: je Sektor, nicht je Halm (siehe grass.js).
    aktualisiereGrasSicht(garden.grasNetze, viewer.camera, grasWeite, viewer.isBird());
    // Die Wellen laufen ueber die Zeit, nicht ueber die Bildzahl - sonst
    // liefen sie auf einem schnellen Rechner schneller.
    if (garden.wasser && garden.wasser.userData.tick) {
      wasserZeit += dt;
      garden.wasser.userData.tick(wasserZeit);
    }
  }
  const pose = walker.pose;
  updateMarks(
    walkerMark, signMarks, viewer.birdCam, pose,
    garden ? garden.hf.heightAt(pose.x, pose.z) : 0,
    viewer.isBird(),
  );
  if (!stats) return;
  const s = viewer.stats();
  const p = pose;
  hud.textContent =
    `${s.fps.toFixed(0)} fps · ${s.calls} draw calls · ${(s.triangles / 1000).toFixed(0)}k tris · ` +
    (viewer.isBird()
      ? `isometrisch ${viewer.kartenNeigung.toFixed(1)}° · Zoom ${viewer.kartenZoom.toFixed(2)}×\n`
      // Der wirksame Winkel und der Zoom, der ihn aus dem eingestellten
      // Blickwinkel gemacht hat - sonst weiss man bei 15° nicht, ob 45° oder
      // 60° eingestellt sind.
      : `${viewer.fov.toFixed(0)}° FOV (${viewer.blickwinkel}° · Zoom ${viewer.gehZoom.toFixed(2)}×)\n`) +
    `x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  ` +
    `y ${(garden ? garden.hf.heightAt(p.x, p.z) : 0).toFixed(2)}  ` +
    `${((p.yaw * 180 / Math.PI) % 360).toFixed(0)}°`;
});

// Debug-Handle (Konsole): __sim.garden.hf.heightAt(x, z), __sim.walker.pose, …
window.__sim = {
  THREE, viewer, walker, get garden() { return garden; }, rebuild,
  // Der Bauplan-Cache haelt die Baumskelette ueber Neuaufbauten hinweg. Wer
  // eine Baumdatei geaendert hat, leert ihn und baut neu.
  baeumeNeu: async () => { clearTreeCache(); await rebuild(); },
  // Die eingebrannte Bodenkarte zum Ansehen: __sim.zeigeBodenkarte() haengt
  // die Leinwand in die Ecke.
  zeigeBodenkarte: () => {
    if (!garden) return null;
    const c = garden.bodenkarte.canvas;
    Object.assign(c.style, { position: 'fixed', right: '14px', top: '14px',
      width: '190px', height: '190px', border: '1px solid #999',
      background: '#fff', zIndex: 99 });
    document.body.appendChild(c);
    return c;
  },
};

buildForm();
rebuild();
