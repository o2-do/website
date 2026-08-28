import * as THREE from 'three';
import { defaults, normalize } from './config.js';
import { createViewer, KAMERA_FREI } from './scene.js';
import { loadTextures } from './textures.js';
import { buildGarden, disposeGarden } from './garden.js';
import { createWalker } from './walker.js';
import { createWalkerMark, buildSignMarks, updateMarks } from './mapmarks.js';
import { fetchTreeList } from './baumloader.js';
import { setTranslucency } from './translucency.js';
import { aktualisiereGrasSicht } from './grass.js';
import { frisch } from './frisch.js';
import { zaunRadius, PFOSTEN_D } from './zaun.js';
import { plaketteInReichweite, nimmPlakette, setzePlakettenStand } from './plaketten.js';

/**
 * Der Spieleinstieg (`game.html`).
 *
 * WAS IHN VON `main.js` UNTERSCHEIDET: es gibt kein Formular. Der Garten steht
 * in `json/garten.json` - einer Datei, wie sie „Einstellungen speichern" im
 * Konfigurator schreibt -, und aus ihr wird gebaut, ohne dass jemand an
 * Reglern dreht. Was hier fehlt, fehlt deshalb mit Absicht: keine Live-Regler,
 * keine Kennzahlen, kein HUD.
 *
 * WAS ER MIT `main.js` TEILT: alles Uebrige. Szene, Garten, Walker und
 * Landkarte sind dieselben Bausteine; hier haengen nur andere Knoepfe daran.
 *
 * DIE EINSTELLUNGSDATEI WIRD UEBER DIE VORGABEN GELEGT, nicht als Ganzes
 * genommen. Eine gespeicherte Datei kennt nur die Parameter, die es zu ihrer
 * Zeit gab; kommt spaeter einer hinzu, stuende er sonst auf `undefined` und
 * der Aufbau liefe ins Leere.
 */

const canvas = document.getElementById('view');
const spinner = document.getElementById('spinner');
const spinnerText = document.getElementById('spinner-text');

const viewer = createViewer(canvas);
let garden = null;
let rohwerte = null;              // die Werte aus der Datei, ohne `normalize`

const walker = createWalker(viewer.walkCam, (x, z) => (garden ? garden.hf.heightAt(x, z) : 0));
const walkerMark = createWalkerMark();
viewer.scene.add(walkerMark);
let signMarks = null;
let texturen = null;
// Sichtweite der Grashalme in Metern - die Bildschleife braucht sie jedes Bild.
let grasWeite = defaults().grasWeite;

/* ---------------- Eingangssequenz ---------------- */

// Wo der Spaziergang beginnt und wie weit er von selbst laeuft.
const INTRO_DAVOR = 5.0;         // m vor dem Tor, draussen
const INTRO_SCHRITTE = 6;        // m, die von selbst gegangen werden

// Solange das Intro laeuft, nimmt der Walker keine Eingaben an: er soll ja
// gerade hereinkommen, und ein Klick koennte ihn wieder hinausdrehen.
let intro = false;
let introRest = 0;
let grenzeSoll = 0;

/**
 * Von draussen hereinlaufen.
 *
 * DIE SCHRANKE MUSS DABEI AUS SEIN. Sie haelt sonst genau das auf, was hier
 * gewollt ist - der Startpunkt liegt jenseits des Zauns. Gesetzt wird sie
 * erst, wenn die vier Schritte getan sind; von da an gilt der Garten.
 */
function starteIntro(cfg, built) {
  const t = built.tor;
  // So weit vor dem Zaun, wie die Near-Plane es verlangt (siehe `KAMERA_FREI`
  // in scene.js), plus den halben Pfosten - gemessen wird zur Pfostenmitte,
  // gemeint ist seine Oberflaeche.
  grenzeSoll = cfg.zaun ? zaunRadius(cfg) - (KAMERA_FREI + PFOSTEN_D / 2)
                        : cfg.durchmesser / 2;
  if (!t) {                                   // kein Tor: wie bisher am Weg
    intro = false;
    walker.setzeGrenze(grenzeSoll);
    const p0 = built.paths[0];
    if (p0) { const s = p0.samples[0]; walker.reset(s.x, s.z, Math.atan2(-s.tx, -s.tz)); }
    else walker.reset(0, 0, 0);
    return;
  }
  const r = Math.hypot(t.mitte.x, t.mitte.z) || 1;
  const ux = t.mitte.x / r, uz = t.mitte.z / r;      // nach aussen
  // Blick nach innen: vorwaerts ist (-sin yaw, -cos yaw), gewollt ist (-ux,-uz).
  const yaw = Math.atan2(ux, uz);

  walker.setzeGrenze(0);
  walker.reset(t.mitte.x + ux * INTRO_DAVOR, t.mitte.z + uz * INTRO_DAVOR, yaw);
  // NICHT alle Schritte auf einmal einreihen: die Warteschlange nimmt nur
  // MAX_PENDING zusaetzlich zur laufenden Aktion, der Rest fiele stumm unter
  // den Tisch. Nachgezaehlt: von vier Schritten kamen drei an. Deshalb wird
  // je Bild nachgelegt, solange noch etwas offen ist - nebenbei bleibt die
  // Schlange dabei voll, und der Gang laeuft ohne Zwischenbremsung durch.
  introRest = INTRO_SCHRITTE;
  intro = true;
}

/**
 * „Jemand wollte den Garten verlassen." Platzhalter - hier haengt spaeter das
 * Spiel dran; der Walker meldet nur (siehe `walker.js`).
 */
function exitGarden(detail) {   // eslint-disable-line no-unused-vars
}
window.addEventListener('garten-ausgang', (e) => exitGarden(e.detail));

/* ---------------- Einstellungen ---------------- */

let plaketten = [];

async function ladeEinstellungen(url) {
  const r = await fetch(frisch(url), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`„${url}“ liess sich nicht laden (${r.status}).`);
  const d = await r.json();
  if (!d || !d.werte) throw new Error(`„${url}“ ist keine Einstellungsdatei.`);
  // Die Sammelmarken stehen in derselben Datei wie die Einstellungen; gesetzt
  // wurden sie im Konfigurator (siehe `plaketten.js`).
  plaketten = Array.isArray(d.plaketten) ? d.plaketten.map((p) => ({ ...p, weg: false })) : [];
  return { ...defaults(), ...d.werte };
}

/* ---------------- Aufbau ---------------- */

let building = false;

async function rebuild() {
  if (building) return;
  building = true;
  spinner.hidden = false;
  spinnerText.textContent = 'Garten wird gebaut …';
  await new Promise((r) => { let d = false; const f = () => { if (!d) { d = true; r(); } };
    requestAnimationFrame(f); setTimeout(f, 50); });

  try {
    const cfg = normalize(rohwerte);
    cfg._baumListe = await fetchTreeList(cfg.baumListe);
    cfg._plaketten = plaketten;
    grasWeite = cfg.grasWeite;

    viewer.setFog(cfg.nebel);
    viewer.setBlickwinkel(cfg.blickwinkel);
    setTranslucency(cfg.transluzenz);
    const R = cfg.durchmesser / 2;
    viewer.fitShadow(R);
    viewer.setSchattenAufloesung(cfg.schattenAufloesung);

    if (garden) { disposeGarden(garden.group); garden = null; }
    if (signMarks) { disposeGarden(signMarks); signMarks = null; }

    texturen = await loadTextures(viewer.renderer);
    const built = await buildGarden(cfg, texturen, (t) => { spinnerText.textContent = t; });
    viewer.scene.add(built.group);
    garden = built;
    // Was den Weg verstellt: Staemme, Felsen, Zypressen, Wasser, Gelaender.
    // Beete und Wege stehen bewusst NICHT darin - durch ein Beet laeuft man.
    walker.setzeHindernis((x, z) => built.hindernisse.belegt(x, z));
    // Ein neuer Garten baut alle Marken wieder auf - was schon gefunden war,
    // bleibt gefunden.
    if (built.plaketten) {
      setzePlakettenStand(built.plaketten, plaketten.filter((q) => q.weg).map((q) => q.nr));
    }

    viewer.setForest(texturen.wald, cfg.waldRadius, cfg.waldHoehe, cfg.wald);
    viewer.setViewParts(
      built.group.getObjectByName('horizont'),
      built.group.getObjectByName('kartenmaske'),
      built.group.getObjectByName('kartenkasten'),
    );
    signMarks = buildSignMarks(built.signPlan, cfg.durchmesser * 0.022);
    viewer.scene.add(signMarks);
    walkerMark.scale.setScalar(cfg.durchmesser * 0.05);

    schattenAnwenden(cfg);
    starteIntro(cfg, built);
    viewer.birdFit(R);
    // Noch im Spinner alle Shader uebersetzen - sonst haelt jedes erstmals
    // sichtbare Objekt den Hauptfaden an (siehe `waermeShader` in scene.js).
    spinnerText.textContent = 'Shader …';
    await viewer.waermeShader();
    zeigeGesammelt();
  } catch (err) {
    console.error(err);
    spinnerText.textContent = 'Fehler beim Aufbau: ' + err.message;
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    spinner.hidden = true;
    building = false;
  }
}

// In der Karte gilt immer „simpel" - siehe `main.js`, dieselbe Ueberlegung.
function schattenAnwenden(cfg) {
  const stufe = viewer.isBird() ? 'simpel' : cfg.schatten;
  viewer.setShadows(stufe === 'detailliert');
  viewer.setSchattenArt('eingebrannt');
  if (garden) garden.bestand.setzeSchatten(stufe);
  if (stufe === 'detailliert') viewer.backeSchatten();
}

/* ---------------- Bedienung ---------------- */

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(e); });
}

/** Waehrend der Eingangssequenz gehoert die Steuerung dem Intro. */
const frei = () => !intro;

bind('btn-forward', () => frei() && walker.enqueue('forward'));
bind('btn-back', () => frei() && walker.enqueue('back'));
bind('btn-left', () => frei() && walker.enqueueTurn(+1));
bind('btn-right', () => frei() && walker.enqueueTurn(-1));

// Das Kartensymbol schaltet zwischen Augenhoehe und Vogelperspektive um.
// Das Symbol zeigt, WOHIN es geht, nicht wo man ist: in der Augenhoehe die
// Karte, in der Karte die Ansicht. Ein Knopf, der sein eigenes Ziel abbildet,
// braucht keine Beschriftung.
function zeigeKartenknopf(bird) {
  const knopf = document.getElementById('btn-karte');
  if (!knopf) return;
  knopf.classList.toggle('aktiv', bird);
  const bild = knopf.querySelector('img');
  if (bild) {
    bild.src = bird ? 'img/perspektive.jpg' : 'img/karte.jpg';
    bild.alt = bird ? 'Augenhöhe' : 'Karte';
  }
  knopf.title = bird ? 'Zurück in die Augenhöhe' : 'In die Vogelperspektive';
}

bind('btn-karte', () => {
  const bird = !viewer.isBird();
  viewer.setCamera(bird ? 'bird' : 'walk');
  zeigeKartenknopf(bird);
  schattenAnwenden(normalize(rohwerte));
});

// DELEGIERT, nicht fest gebunden: der Inhaltsbereich wird beim Einsammeln
// ausgetauscht, und die nachgeladenen Seiten bringen denselben Knopf wieder mit.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('#btn-neu');
  if (!a) return;
  e.preventDefault();
  rohwerte = { ...rohwerte, seed: 'garten-' + Math.random().toString(36).slice(2, 8) };
  if (viewer.isBird()) {
    viewer.setCamera('walk');
    zeigeKartenknopf(false);
  }
  rebuild();
});

// WASD neben den Pfeilen - dieselbe Belegung wie im Konfigurator.
const RICHTUNG = {
  ArrowUp: 'vor', w: 'vor', ArrowDown: 'zurueck', s: 'zurueck',
  ArrowLeft: 'links', a: 'links', ArrowRight: 'rechts', d: 'rechts',
};

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Leertaste: die Plakette in Reichweite einsammeln. Sie kommt vor der
  // Laufsteuerung, damit ein Druck nicht beides tut.
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    sammlePlakette();
    return;
  }
  const was = RICHTUNG[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!was) return;
  e.preventDefault();
  if (!frei()) return;
  if (was === 'vor') walker.enqueue('forward');
  else if (was === 'zurueck') walker.enqueue('back');
  else walker.enqueueTurn(was === 'links' ? +1 : -1);
});

/* ---------------- Umschauen und Hingehen ---------------- */

const LOOK_SENS = 0.0045;
const ORBIT_SENS = 0.006;
const DRAG_START = 4;
const DBL_MS = 450;
const DBL_PX = 12;

let lastX = 0, lastY = 0, downX = 0, downY = 0;
let pointerDown = false, dragging = false, warZiehen = false;
canvas.style.cursor = 'grab';

canvas.addEventListener('pointerdown', (e) => {
  lastX = downX = e.clientX; lastY = downY = e.clientY;
  pointerDown = true; dragging = false; warZiehen = false;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* egal */ }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointerDown) return;
  if (!dragging) {
    if (Math.abs(e.clientX - downX) < DRAG_START && Math.abs(e.clientY - downY) < DRAG_START) return;
    dragging = true;
    if (!viewer.isBird()) walker.beginLook();
    canvas.style.cursor = 'grabbing';
  }
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  if (viewer.isBird()) viewer.birdOrbit(dx * ORBIT_SENS);
  else walker.look(dx * LOOK_SENS, dy * LOOK_SENS);
});

const endDrag = (e) => {
  if (!pointerDown) return;
  pointerDown = false;
  if (dragging) {
    walker.endLook();
    dragging = false;
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

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let lastClick = { t: -1e9, x: 0, y: 0 };

canvas.addEventListener('click', (e) => {
  const now = performance.now();
  const paar = now - lastClick.t < DBL_MS
    && Math.abs(e.clientX - lastClick.x) < DBL_PX
    && Math.abs(e.clientY - lastClick.y) < DBL_PX;
  lastClick = paar ? { t: -1e9, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
  if (!paar || warZiehen) return;
  if (viewer.isBird()) mapJump(e);
  else if (frei()) stepTowards(e);
});
canvas.addEventListener('dblclick', (e) => e.preventDefault());

function stepTowards(e) {
  const r = canvas.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const cam = viewer.walkCam;
  const tanHalfX = Math.tan((cam.fov * Math.PI / 180) / 2) * cam.aspect;
  walker.enqueue('step', { yaw: -Math.atan(nx * tanHalfX) });
}

function mapJump(e) {
  if (!garden) return;
  const r = canvas.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, viewer.birdCam);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  if (d.y >= -1e-6) return;
  let x = 0, z = 0, y = 0;
  for (let i = 0; i < 3; i++) {
    const t = (y - o.y) / d.y;
    x = o.x + d.x * t;
    z = o.z + d.z * t;
    y = garden.hf.heightAt(x, z);
  }
  walker.reset(x, z, walker.pose.yaw);      // `reset` haelt die Zaungrenze ein
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  viewer.zoom(Math.sign(e.deltaY) * 3);
}, { passive: false });

/* ---------------- Frame ---------------- */

/* ---------------- Plaketten einsammeln ---------------- */

/**
 * WAS GREIFBAR IST, ZEIGT SICH.
 *
 * Je Bild wird gesucht, ob eine Plakette naeher als zwei Meter und im Blickfeld
 * liegt (siehe `plaketteInReichweite`). Ist eine da, erscheint sie unten links
 * im Bild; die Leertaste oder ein Klick darauf sammelt sie ein.
 *
 * Die Suche laeuft ueber die Liste, nicht ueber die Szene - es sind eine
 * Handvoll Marken, und ein Abstand ist billiger als ein Strahl.
 */
const plakettenKnopf = document.getElementById('plakette-knopf');
const plakettenNrFeld = document.getElementById('plakette-nr');
let greifbar = -1;

function zeigeGreifbar(i) {
  if (i === greifbar) return;
  greifbar = i;
  if (i < 0) { plakettenKnopf.hidden = true; return; }
  plakettenNrFeld.textContent = plaketten[i] ? plaketten[i].nr : '';
  plakettenKnopf.hidden = false;
}

/* ---------------- Seiteninhalt ---------------- */

const inhalt = document.getElementById('content');
const seite = document.getElementById('side-content');

/**
 * Ein geladenes Bruchstueck in einen Container haengen.
 *
 * Die Seitendateien (`plakette-1.html`, `gameover.html`) bringen ihre eigene
 * Spalte mit (`<div class="col-lg-9">`). Der Container IST aber schon die
 * Spalte - eine zweite darin machte den Text drei Viertel so breit. Traegt das
 * Bruchstueck also genau ein Wurzelelement mit einer Spaltenklasse, wird dessen
 * Inhalt genommen und die Huelle weggelassen.
 */
function setzeInhalt(ziel, html) {
  if (!ziel) return;
  const h = document.createElement('div');
  h.innerHTML = html;
  const kinder = [...h.children];
  if (kinder.length === 1 && /\bcol(-|\b)/.test(kinder[0].className || '')) {
    ziel.innerHTML = kinder[0].innerHTML;
  } else {
    ziel.innerHTML = html;
  }
}

/** Eine Seite nachladen. Faellt sie aus, bleibt stehen, was dasteht. */
async function ladeSeite(url, ziel = inhalt) {
  try {
    const r = await fetch(frisch(url), { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    setzeInhalt(ziel, await r.text());
    ziel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  } catch (err) {
    console.warn(`„${url}“ liess sich nicht laden:`, err.message);
    return false;
  }
}

/**
 * DIE SEITENSPALTE FUEHRT BUCH.
 *
 * Bis zur ersten Marke steht dort der Begleittext; sobald eine eingesammelt
 * ist, tritt an seine Stelle die Sammlung - je Marke ein Symbol mit ihrer
 * Nummer, das ihre Seite wieder aufruft. So bleibt der Hinweis, den sie
 * getragen hat, nachlesbar.
 */
function zeigeGesammelt() {
  if (!seite) return;
  const alle = plaketten.length;
  const weg = plaketten.filter((p) => p.weg);
  if (!weg.length) return;                       // noch nichts: Text bleibt stehen
  const marken = weg.map((p) => `
    <a class="plakette-link" href="#" data-plakette="${p.nr}"
       title="Plakette ${p.nr} noch einmal ansehen">
      <img src="./img/plakette.jpg" alt="Plakette ${p.nr}">
      <span class="badge rounded-pill">${p.nr}</span>
    </a>`).join('');
  seite.innerHTML = `
    <h2 class="h6">Gesammelt: ${weg.length} von ${alle}</h2>
    <div class="plakette-liste">${marken}</div>`;
}

// Ein Klick auf ein Sammlungssymbol holt die Seite zurueck. Delegiert, weil die
// Symbole erst entstehen, wenn eine Marke gefunden wurde.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-plakette]');
  if (!a) return;
  e.preventDefault();
  ladeSeite(`plakette-${a.dataset.plakette}.html`);
});

/**
 * ALLE GEFUNDEN. Der Haken fuer das Spielende; er laedt `gameover.html` in
 * denselben Container wie die Plakettenseiten.
 */
window.gameOver = async function gameOver() {
  await ladeSeite('gameover.html');
};

/* ---------------- Spielstand ---------------- */

const STAND_SCHLUESSEL = 'garten-spielstand';

/**
 * Den Stand auslesen und in den lokalen Speicher legen: wo man steht, wohin man
 * schaut, und welche Marken schon gefunden sind.
 */
window.getSpielstand = function getSpielstand() {
  const p = walker.pose;
  const stand = {
    x: +p.x.toFixed(3), z: +p.z.toFixed(3), yaw: +p.yaw.toFixed(4),
    gesammelt: plaketten.filter((q) => q.weg).map((q) => q.nr),
  };
  try {
    localStorage.setItem(STAND_SCHLUESSEL, JSON.stringify(stand));
    melde(`gesichert · ${stand.gesammelt.length} Plaketten`);
  } catch (err) {
    melde('konnte nicht gesichert werden');
  }
  return stand;
};

/** Und zurueck: Standort, Blickrichtung und die Sammlung. */
window.setSpielstand = function setSpielstand() {
  let stand = null;
  try { stand = JSON.parse(localStorage.getItem(STAND_SCHLUESSEL) || 'null'); }
  catch { stand = null; }
  if (!stand) { melde('kein Spielstand vorhanden'); return null; }
  if (garden && garden.plaketten) setzePlakettenStand(garden.plaketten, stand.gesammelt);
  else plaketten.forEach((q) => { q.weg = (stand.gesammelt || []).includes(q.nr); });
  // Das Intro darf nicht dazwischenfunken - wer laedt, will genau dort stehen.
  intro = false;
  introRest = 0;
  walker.setzeGrenze(grenzeSoll);
  walker.reset(stand.x, stand.z, stand.yaw);
  zeigeGreifbar(-1);
  zeigeGesammelt();
  melde(`geladen · ${(stand.gesammelt || []).length} Plaketten`);
  return stand;
};

function melde(text) {
  const el = document.getElementById('spielstand-hinweis');
  if (el) el.textContent = text;
}

/**
 * Einsammeln. Die Marke verschwindet aus der Szene, das Spiel erfaehrt es ueber
 * `addPlakette(nr)`, und ihre Seite tritt in den Inhaltsbereich - dort steht
 * der Hinweis auf die naechste.
 */
async function sammlePlakette() {
  if (greifbar < 0 || !garden || !garden.plaketten) return;
  const i = greifbar;
  const pl = plaketten[i];
  nimmPlakette(garden.plaketten, i);
  zeigeGreifbar(-1);
  if (pl && typeof window.addPlakette === 'function') window.addPlakette(pl.nr);
  zeigeGesammelt();
  if (pl) await ladeSeite(`plakette-${pl.nr}.html`);
  // Die letzte Marke beendet das Spiel; ihre Seite bleibt ueber die Sammlung
  // in der Seitenspalte erreichbar.
  if (plaketten.length && plaketten.every((q) => q.weg)) window.gameOver();
}

plakettenKnopf.addEventListener('click', (e) => { e.preventDefault(); sammlePlakette(); });

// Platzhalter, bis das Spiel den Haken ersetzt. Er wird nicht ueberschrieben,
// wenn schon einer da ist.
if (typeof window.addPlakette !== 'function') {
  window.addPlakette = (nr) => { console.log('Plakette', nr, 'eingesammelt'); };
}

/* ---------------- Frame ---------------- */

let wasserZeit = 0;

viewer.onFrame((dt) => {
  walker.update(dt);
  // Die Wellen laufen ueber die Zeit. Ohne diesen Aufruf stand das Wasser hier
  // still, waehrend es im Bauprogramm lief - dort haengt derselbe Tick in
  // seiner eigenen Bildschleife (`main.js`).
  if (garden && garden.wasser && garden.wasser.userData.tick) {
    wasserZeit += dt;
    garden.wasser.userData.tick(wasserZeit);
  }
  // Das Intro ist vorbei, sobald die Warteschlange leer ist. Erst dann greift
  // die Schranke - vorher stuende der Spaziergang schon vor dem Tor still.
  if (intro) {
    while (introRest > 0 && walker.enqueue('forward')) introRest--;
    if (introRest === 0 && !walker.beschaeftigt) {
      intro = false;
      walker.setzeGrenze(grenzeSoll);
    }
  }
  if (garden) {
    garden.bestand.aktualisiere(viewer.camera, viewer.isBird());
    // Halme jenseits der Sichtweite: je Sektor, nicht je Halm (siehe grass.js).
    aktualisiereGrasSicht(garden.grasNetze, viewer.camera, grasWeite, viewer.isBird());
  }
  // In der Karte wird nichts eingesammelt - dort steht man nicht davor.
  const pose = walker.pose;
  zeigeGreifbar(garden && !viewer.isBird() && !intro
    ? plaketteInReichweite(plaketten, viewer.camera, garden.hf.heightAt(pose.x, pose.z))
    : -1);
  updateMarks(
    walkerMark, signMarks, viewer.birdCam, pose,
    garden ? garden.hf.heightAt(pose.x, pose.z) : 0,
    viewer.isBird(),
  );
});

/* ---------------- Start ---------------- */

rohwerte = await ladeEinstellungen('json/garten.json');
await rebuild();

window.__spiel = { THREE, viewer, walker, get garden() { return garden; }, rebuild };
