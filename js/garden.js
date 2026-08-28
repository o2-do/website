import * as THREE from 'three';
import { hashSeed, stream } from './rng.js';
import {
  createHeightField, buildHorizon, buildMapMask, buildMapBox, buildUnterlage,
} from './terrain.js';
import { buildPaths, makePathIndex, torWeg, TOR_WEG_DRAUSSEN } from './paths.js';
import {
  baueGartennetz, hoehenfeldAusNetz, baueWiese, baueWegband, baueAussenweg,
} from './wegnetz.js';
import { planSigns, buildSigns, planWegweiser, buildWegweiser } from './signs.js';
import { createOccupancy } from './occupancy.js';
import {
  createRockGeometries, planarUV, planRocks, buildRockMeshes, stempelFelsschatten,
} from './rocks.js';
import { planTrunks } from './trees.js';
import { ladeBauplaene, baueBestand } from './baumbestand.js';
import { createBodenkarte } from './bodenkarte.js';
import { stempleNetzschatten } from './schattenriss.js';
import { bauePlaketten } from './plaketten.js';
import {
  loadPlantModel, loadBed, pflanzenAusBeeten, planBeds, buildPlantMeshes,
  buildBedFloors, stempelPflanzenschatten,
} from './plants.js';
import { createSektoren } from './sektoren.js';
import { KAMERA_FREI } from './scene.js';
import {
  buildZaun, buildTor, buildBordstein, planTor, planeGelaender, buildGelaender,
} from './zaun.js';
import { ladeZypressen, planZypressen, baueZypressen, stempelZypressenschatten } from './zypressen.js';
import { planeTeich, baueWasser } from './wasser.js';
import { planeStufen, baueStufen } from './stufen.js';
import {
  createBladeGeometry, planEdgeGrass, planPatchGrass, planTrunkGrass, buildGrassMeshes,
} from './grass.js';

// Kurz an den Browser abgeben, damit Spinner und Fortschrittstext gezeichnet
// werden. Mit Timeout-Fallback, weil rAF in Hintergrund-Tabs nicht feuert und
// der Aufbau dort sonst haengen bliebe.
let yielded = 0;
const nextFrame = () => new Promise((r) => {
  const t = performance.now();
  let done = false;
  const fin = () => { if (!done) { done = true; yielded += performance.now() - t; r(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 50);
});

export async function buildGarden(cfg, tex, onProgress = () => {}) {
  const t0 = performance.now();
  yielded = 0;
  cfg._seed = hashSeed(cfg.seed);

  const group = new THREE.Group();
  group.name = 'garten';
  const stats = { vertices: 0, dreiecke: 0, felsen: 0, meshes: 0, phasen: {} };
  let tPhase = performance.now();
  const phase = (name) => {
    const now = performance.now();
    stats.phasen[name] = Math.round(now - tPhase);
    tPhase = now;
  };

  // Die eingebrannten Baumschatten. Die Karte entsteht leer und wird gezeichnet,
  // sobald die Baeume stehen - in die Materialien muss sie aber jetzt schon,
  // denn ein Material laesst sich spaeter nicht mehr um ein Uniform erweitern,
  // ohne den Shader neu zu uebersetzen.
  const bodenkarte = createBodenkarte(cfg);
  // Das Raster, nach dem Gras, Pflanzen, Felsen und Beetboeden in eigene Netze
  // zerfallen. Ohne es haette jedes dieser Gewerke eine gartenweite Huellkugel
  // und waere nie aus dem Sichtvolumen zu werfen (siehe `sektoren.js`).
  const sektoren = createSektoren(cfg);
  // Alles, was Grund ist: Wiese, Wege, Boeschungswaelle, Grasbueschel.
  // Abgetastet wird ueber x und z, jedes von ihnen schlaegt also in derselben
  // Karte nach, ohne von den anderen zu wissen.
  const imGrund = (m) => bodenkarte.bindeMaterial(m);

  const wieseMat = imGrund(new THREE.MeshStandardMaterial({
    map: tex.wiese,
    roughness: 1,
    metalness: 0,
    wireframe: cfg.drahtgitter,
  }));
  const felsMat = new THREE.MeshStandardMaterial({
    map: tex.fels,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    wireframe: cfg.drahtgitter,
  });
  const wegMat = imGrund(new THREE.MeshStandardMaterial({
    map: tex.weg,
    roughness: 1,
    metalness: 0,
    wireframe: cfg.drahtgitter,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));
  // Abkuerzungen sind Trampelpfade und haben ihren eigenen Belag.
  const abkMat = imGrund(new THREE.MeshStandardMaterial({
    map: tex.abk,
    roughness: 1,
    metalness: 0,
    wireframe: cfg.drahtgitter,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));
  // Maske und Kasten sind reine Kartengrafik: weiss, ohne Licht - und damit
  // auch ohne Schatten, denn ein Basismaterial nimmt keinen an.
  const kastenMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    fog: false,
    wireframe: cfg.drahtgitter,
  });
  // Die Schilder gehoeren zum Aussenwerk: grau verwittert wie Zaun und Tor.
  const pfahlMat = new THREE.MeshStandardMaterial({
    map: tex.pfostenGrau,
    roughness: 1,
    metalness: 0,
    wireframe: cfg.drahtgitter,
  });
  const grasMat = imGrund(new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide
    /* ,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    wireframe: cfg.drahtgitter, */
  }));

  // Die Wege brauchen ein Hoehenfeld, das Hoehenfeld braucht die Wege (fuer die
  // Planie). Deshalb zwei Stufen: erst das reine Rauschgelaende, daraus die
  // Wegfuehrung, danach das planierte Feld, mit dem alles Weitere arbeitet.
  onProgress('Hoehenfeld …');
  const base = createHeightField(cfg);
  phase('hoehenfeld');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Wege …');
  const paths = buildPaths(base, cfg);

  // Das Tor braucht die Wege (es sucht sich die flachste, parallelste Stelle
  // zwischen Zaun und Weg), und sein Zugangsweg gehoert zu den Wegen. Deshalb
  // steht beides hier, VOR dem Wegindex und der Planie - danach gilt der
  // Zugang wie jeder andere Weg: Belag, Wall, Gras, Belegung.
  const tor = planTor(cfg, base, paths);
  const zugang = torWeg(cfg, base, paths, tor, paths.length);
  if (zugang) paths.push(zugang);

  // Der Anschluss der Wege aneinander wird NICHT MEHR GERECHNET.
  //
  // Hier stand `verknuepfeWege`: es hat die Querneigung an einer Einmuendung
  // aus dem Gefaellevektor des Hauptwegs projiziert, das Plateau am Tor
  // konstruiert und beides ueber eine Auslauflaenge eingeblendet. Das ist
  // hinfaellig, seit die Stirnseite einer Abkuerzung ihre Hoehe von zwei
  // Querschnitten des Rundwegs erbt (wegnetz.js): dann kippt sie genau in
  // dessen Ebene, weil sie es geometrisch gar nicht anders kann.
  //
  // Der Knick dahinter - der Weg fiel hinter der Naht schlagartig wieder auf
  // seine eigene waagerechte Lage zurueck - ist ebenfalls erledigt, und zwar
  // an derselben Stelle: `neigeAnschluesse` laesst die Randpunkte im Anlauf
  // vor der Muendung auf wandernde Referenzpunkte zeigen (wegnetz.js).

  const pathIndex = makePathIndex(paths, cfg);

  // DAS NETZ. Erst ausschliesslich in der Ebene: Wegpunkte sammeln, Kanten
  // schneiden, Rasterpunkte streuen, triangulieren. Danach steht jeder Punkt
  // fest, es kommt keiner mehr hinzu - und die Hoehe verschiebt ihn nur noch
  // senkrecht.
  //
  // Weil Wiese und Wegband an der Kante DIESELBEN Punkte benutzen, kann dort
  // weder eine Fuge aufgehen noch eines durch das andere stossen. Die ganze
  // frueher noetige Kette - Weg anheben, Ausgleichswall, Ueberstand, Untergriff,
  // Saum - ist damit hinfaellig.
  // DER TUEMPEL WIRD VOR DEM NETZ GEPLANT, nicht danach: sein Becken ist keine
  // eigene Geometrie, sondern eine Senkung derselben Wiesenpunkte, und die
  // muss beim Bauen des Netzes schon bekannt sein.
  const teich = planeTeich(base, cfg, paths);
  const netz = baueGartennetz(paths, cfg, base, stream(cfg._seed, 'wiese'), teich);
  const alleDreiecke = netz.wiese.concat(...netz.baender);
  const hf = hoehenfeldAusNetz(netz.P, alleDreiecke, base, cfg);

  paths.forEach((p, i) => {
    // Der Zugang zum Tor ist ein angelegter Weg, keine Abkuerzung - er bekommt
    // denselben Belag wie der Rundweg (siehe `makePath`).
    const wieRund = p.closed || p.art === 'tor';
    const mesh = baueWegband(netz.P, netz.baender[i], p, cfg, wieRund ? wegMat : abkMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  // Treppen dort, wo der Rundweg zu steil wird. Sie liegen AUF dem Weg - das
  // Netz darunter bleibt die Rampe.
  const treppen = planeStufen(paths, hf, cfg);
  const stufen = baueStufen(treppen, cfg, tex.granit, sektoren);
  for (const m of stufen) group.add(m);
  stats.stufen = stufen.stats || null;

  // Belegungsraster: wer zuerst platziert wird, sperrt seine Zellen.
  // Reihenfolge: Weg -> Baumstamm -> Fels -> Grasbueschel
  const occ = createOccupancy(hf.radius, cfg.rasterWeite);
  // DAS ZWEITE RASTER: WAS DEN WEG VERSTELLT.
  //
  // Nicht dasselbe wie das Belegungsraster. Dort steht, wo nichts mehr HIN
  // darf - Wege, Grasbueschel, Beete; hier steht, wo niemand DURCH darf.
  // Wege gehoeren also gerade nicht hinein, Beete auch nicht (durch ein Beet
  // laeuft man), Baumstaemme, Felsen, Zypressen, Wasser und Gelaender dagegen
  // schon.
  //
  // Jedes Hindernis wird um den Halbmesser des Gehers AUFGEBLASEN eingetragen.
  // Damit ist die Abfrage spaeter ein einziger Feldzugriff statt einer Suche
  // ueber eine Kreisflaeche - und sie faellt sechzigmal je Sekunde an.
  const hindernisse = createOccupancy(hf.radius, cfg.rasterWeite);

  // ZWEI HALBMESSER, UND SIE MEINEN VERSCHIEDENES.
  //
  // `R_GEHER` ist der Koerper: so dicht darf man an etwas heran, ohne
  // hineinzulaufen. `R_KAMERA` ist der Abstand, den das AUGE braucht. Die
  // Near-Plane der Laufkamera steht bei 40 cm (siehe `scene.js`); alles, was
  // naeher kommt, wird angeschnitten - und zwar am Bildrand zuerst, weil dort
  // der Sehstrahl schraeg steht und die Tiefe entsprechend kleiner ist. Bei
  // weitem Blickwinkel und breitem Fenster steht der Randstrahl gut 60 Grad
  // schief; aus 0,4 m / cos 60 Grad wird knapp 0,9 m.
  //
  // Der weite Abstand gilt aber nur NEBEN dem Weg. Auf dem Weg zaehlt der
  // Koerper - sonst schnuerte ein Fels, der bis an die Wegkante reicht, den Weg
  // zu, und ein Gelaender machte ihn ganz unpassierbar. Dafuer steht die
  // Wegflaeche im Hindernisraster (siehe `blockSanft` in `occupancy.js`).
  const R_GEHER = 0.30;
  const R_KAMERA = KAMERA_FREI;
  for (const p of paths) {
    const sm = p.samples;
    const segs = p.closed ? sm.length : sm.length - 1;
    const halfW = p.width / 2;
    for (let i = 0; i < segs; i++) {
      const a = sm[i], b = sm[(i + 1) % sm.length];
      // Als WEG gekennzeichnet: die Felsen duerfen diese Zellen uebergehen,
      // wenn ihr eingestellter Abstand zur Wegkante negativ ist.
      occ.blockSegment(a.x, a.z, b.x, b.z, halfW, 'weg');
      hindernisse.blockSegment(a.x, a.z, b.x, b.z, halfW, 'weg');
    }
  }

  /**
   * Einen Gegenstand ins Hindernisraster eintragen - eng und weit.
   *
   * Eng ueberschreibt auch den Weg (durch einen Felsen laeuft man nicht,
   * gleich wo er steht), weit macht an der Wegkante halt.
   */
  const sperre = (x, z, eigen) => {
    hindernisse.block(x, z, eigen + R_GEHER);
    hindernisse.blockSanft(x, z, eigen + R_KAMERA);
  };

  // Der Tuempel sperrt seinen Platz, bevor Baeume, Felsen und Gras kommen -
  // samt Ufer, damit nichts halb im Wasser steht.
  if (teich) occ.block(teich.x, teich.z, teich.rScheibe);

  stats.wege = paths.length;
  stats.abkuerzungen = paths.filter((p) => !p.closed).length;
  stats.wegLaenge = Math.round(paths.reduce((a, p) => a + p.total, 0));
  phase('wege');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Wiese …');
  // Ein Netz je Sektor (siehe `baueWiese`) - eine Viertelmillion Dreiecke
  // Wiese waeren in einem Stueck nie aus dem Sichtvolumen zu werfen.
  const grundNetze = baueWiese(netz.P, netz.wiese, cfg, wieseMat, sektoren);
  for (const m of grundNetze) { m.receiveShadow = true; group.add(m); }
  // Die weite Horizontscheibe fuer die Augenperspektive; in der Karte deckt
  // stattdessen die weisse Maske alles ab, was ausserhalb des Kreises liegt.
  group.add(buildHorizon(cfg, wieseMat));
  group.add(buildMapMask(cfg, kastenMat));
  group.add(buildMapBox(cfg, kastenMat, hf.amplitude + 0.5));
  // Grau statt Himmel hinter den Haarrissen der Grundflaechen.
  group.add(buildUnterlage(cfg, base.tief + 0.5));
  phase('wiese');
  await nextFrame();
  tPhase = performance.now();

  // Baeume vor den Felsen: die Felsen weichen ihnen aus.
  onProgress('Baeume …');
  const liste = cfg._baumListe || { baeume: [], standard: ['baum.json'] };
  // Jede Baumdatei nur einmal rechnen; der Bauplan-Cache haelt sie ueber
  // Neuaufbauten hinweg. Wie viele Baeume daraus werden, kostet nichts mehr -
  // sie sind Instanzen desselben Netzpaars.
  const plaene = await ladeBauplaene(liste, (d) => onProgress(`Baeume … ${d}`));
  await nextFrame();
  // Geplant wird mit dem dicksten Stamm des groessten Baums - dann passt jeder
  // Baum auf jeden Platz.
  const stammR = Math.max(...[...plaene.values()].map((b) => b.stammRadius))
                 * (1 + cfg.baumStreuung / 100);
  // Alle benannten Baeume muessen unterkommen, auch wenn die Liste laenger ist
  // als die eingestellte Baumzahl.
  const want = Math.max(Math.round(cfg.anzahlBaeume), liste.baeume.length);
  const trunks = planTrunks(paths, pathIndex, hf, cfg, occ, stammR, want);

  for (const t of trunks) sperre(t.x, t.z, stammR);

  const bestand = await baueBestand(cfg, liste, plaene, trunks, bodenkarte, sektoren);
  group.add(bestand.group);
  const benannt = bestand.benannt;

  stats.baeume = bestand.stats.baeume;
  stats.benannt = bestand.stats.benannt;
  stats.sorten = bestand.stats.sorten;
  stats.blaetter = bestand.stats.billboards;
  stats.laubvarianten = bestand.stats.laubvarianten || 1;
  phase('baeume');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Zypressen …');
  const zypSorten = await ladeZypressen(tex.zypresse);
  const zypressen = planZypressen(hf, cfg, pathIndex, occ, zypSorten);
  for (const m of baueZypressen(zypressen, zypSorten, sektoren)) group.add(m);
  for (const b of zypressen) sperre(b.x, b.z, zypSorten[b.vorlage].radius);
  stats.zypressen = zypressen.length;
  stats.zypressenGruppen = zypressen.length / 3;
  phase('zypressen');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Schilder …');
  const signs = planSigns(benannt, paths, pathIndex, hf, cfg);
  const signMeshes = buildSigns(signs, cfg, pfahlMat);
  if (signs.length) group.add(signMeshes.group);
  const weiser = buildWegweiser(planWegweiser(paths, tor, pathIndex, hf, cfg), cfg, pfahlMat);
  if (weiser) group.add(weiser);
  stats.schilder = signs.length;
  stats.wegweiser = !!weiser;
  phase('schilder');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Felsen …');
  const rockRng = stream(cfg._seed, 'rock-shapes');
  const geos = createRockGeometries(rockRng, cfg.felsSorten, cfg.felsDetail);
  for (const g of geos) planarUV(g, cfg.kachelFels);
  const placements = planRocks(hf, cfg, geos, pathIndex, occ);
  const rockMeshes = buildRockMeshes(geos, placements, felsMat, sektoren);
  for (const m of rockMeshes) group.add(m);
  // NUR DER KOERPER, KEIN KAMERAABSTAND. Ein Felsblock liegt fast immer
  // unter Augenhoehe; die Near-Plane schneidet ihn also kaum je an. Wichtiger
  // ist, dass man zwischen zwei Brocken durchkommt, wo sichtbar Platz ist -
  // mit dem weiten Abstand wuchsen zwei Findlinge in anderthalb Metern
  // Entfernung zu einer Mauer zusammen. Am steilen Hang kann dafuer einmal
  // eine Kante angeschnitten werden; das ist der bessere Handel.
  for (const pl of placements) hindernisse.block(pl.x, pl.z, pl.radXZ + R_GEHER);
  stempelFelsschatten(bodenkarte, placements, geos, hf);
  stats.felsen = placements.length;
  phase('felsen');
  await nextFrame();
  tPhase = performance.now();

  // Beete vor dem Gras: sie sind die groesseren Gebilde und sollen ihren
  // Platz zuerst bekommen.
  //
  // Welche Pflanzen geladen werden, sagen seit Fassung 2 die Beete selbst -
  // sie nennen ihre Arten beim Dateinamen. Der frueher noetige Vorrat samt
  // Regler „Verwendete Arten" ist damit entfallen.
  onProgress('Beete …');
  const beete = [];
  for (const datei of liste.beete || []) {
    beete.push(await loadBed(datei));
  }
  const modelle = new Map();
  for (const datei of pflanzenAusBeeten(beete)) {
    modelle.set(datei, await loadPlantModel(datei));
  }
  const beetPlan = planBeds(beete, paths, pathIndex, hf, occ, cfg);

  let pAnzahl = 0;
  for (const [datei, stellen] of beetPlan.stellen) {
    const model = modelle.get(datei);
    if (!model) continue;
    // Beete bleiben in der Karte stehen. Ihr Schatten steckt in der Bodenkarte
    // und laesst sich nicht mit ausblenden - ohne die Pflanzen daneben laegen
    // dort Schattenflecken auf blanker Wiese, und man suchte, was sie wirft.
    for (const mesh of buildPlantMeshes(model, stellen, sektoren)) {
      group.add(mesh);
      pAnzahl += mesh.count;
    }
  }
  // Der Beetboden: eine Flaeche je Vorlage und Sektor, dem Gelaende folgend.
  for (const m of buildBedFloors(beetPlan.plaetze, hf, cfg, imGrund, sektoren)) {
    group.add(m);
  }
  // Und ihr Pseudoschatten in dieselbe Bodenkarte, in die auch die Baeume
  // stempeln. Die Karte wird danach noch einmal gezeichnet - die Baeume haben
  // sie beim Aufbau des Bestandes schon einmal gefuellt.
  stats.pflanzenschatten = stempelPflanzenschatten(bodenkarte, beetPlan.stellen, modelle);
  stempelZypressenschatten(bodenkarte, zypressen, zypSorten);
  // Gezeichnet wird die Karte erst, wenn ALLES darin steht - Zaun, Tor und
  // Gelaender kommen weiter unten noch dazu.

  stats.pflanzen = pAnzahl;
  stats.pflanzenArten = modelle.size;
  stats.beete = beetPlan.beete;
  stats.beetVorlagen = beete.length;
  phase('beete');
  await nextFrame();
  tPhase = performance.now();

  // Der Zaun steht auf der Gartenkante und stoert deshalb niemanden - er
  // braucht weder das Belegungsraster noch eine eigene Phase im Gelaende.
  onProgress('Zaun …');
  const zaun = buildZaun(cfg, hf, tex.pfostenGrau, sektoren, tor);
  // In der Karte bleibt der Zaun draussen: von oben ist er ein haarduenner
  // Ring am Rand, der wie eine Rahmenlinie wirkt und den runden Ausschnitt
  // doppelt. Der Garten endet dort ohnehin sichtbar.
  for (const m of zaun) { m.userData.nurAugenhoehe = true; group.add(m); }
  stats.zaun = zaun.stats || { pfosten: 0, quer: 0, umfang: 0, radius: 0 };
  // Der Bordstein ebenso: vier Zentimeter hoch, in der Aufsicht also nichts als
  // eine Linie auf der Kante, die der runde Ausschnitt schon zieht.
  /*
  const bord = buildBordstein(cfg, hf, tex.bordstein, sektoren, tor);
  for (const m of bord) { m.userData.nurAugenhoehe = true; group.add(m); }
  stats.bordstein = bord.stats || null;
  */
  // Und die Gelaender: an den steilen Stellen neben den Wegen, und AN JEDER
  // TREPPE auf beiden Seiten. Eine angehobene Treppe steht mit ihren Wangen
  // ueber dem Gelaende; das Gelaender erklaert diese Kante, statt dass der
  // Boden daneben dafuer verbogen werden muesste.
  const gelaenderLaeufe = planeGelaender(paths, hf, cfg, treppen);
  const gelaender = buildGelaender(gelaenderLaeufe, cfg, tex.pfosten, sektoren);
  // Das Gelaender ist eine Linie, kein Fleck - eingetragen wird es als Kapsel
  // laengs jedes Laufs.
  for (const lauf of gelaenderLaeufe) {
    for (let k = 0; k + 1 < lauf.length; k++) {
      const a = lauf[k], b = lauf[k + 1];
      hindernisse.blockSegment(a.x, a.z, b.x, b.z, R_GEHER);
      // Der weite Abstand greift nur nach aussen: zum Weg hin steht das
      // Gelaender fuenf Zentimeter neben der Kante, dort bleibt es beim Koerper.
      hindernisse.blockSegment(a.x, a.z, b.x, b.z, R_KAMERA, 'sanft');
    }
  }
  for (const m of gelaender) { m.userData.nurAugenhoehe = true; group.add(m); }
  stats.gelaender = gelaender.stats || null;
  // Das Tor bleibt in der Karte sichtbar: es ist der Zugang und damit eine
  // Angabe zur Anlage, nicht zur Bepflanzung.
  const torTeile = buildTor(cfg, hf, tex.pfostenGrau, tor);
  for (const m of torTeile) group.add(m);
  // Zaun, Tor und Gelaender in die Bodenkarte - Teil fuer Teil, damit die
  // Luecken zwischen Pfosten und Querhoelzern Luecken bleiben.
  stats.zaunschatten = stempleNetzschatten(bodenkarte, [...zaun, ...torTeile, ...gelaender], hf);
  // Jetzt steht alles darin: einmal zeichnen.
  bodenkarte.zeichne();
  // Der Weg jenseits des Tors - eigenes Band, gleiche Breite, gleicher Belag.
  const draussen = baueAussenweg(cfg, hf, tor, TOR_WEG_DRAUSSEN, wegMat);
  if (draussen) group.add(draussen);
  stats.tor = tor
    ? { steilste: +tor.steilste.toFixed(3), parallel: +tor.parallel.toFixed(2),
        x: +tor.mitte.x.toFixed(1), z: +tor.mitte.z.toFixed(1) }
    : null;
  phase('zaun');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Gras …');
  const blade = createBladeGeometry();
  const g1 = planEdgeGrass(paths, hf, pathIndex, cfg);
  const g2 = planPatchGrass(hf, pathIndex, occ, cfg);
  const g3 = planTrunkGrass(trunks, hf, pathIndex, cfg);
  const grasNetze = [
    ...buildGrassMeshes(g1, blade, grasMat, 'gras_weg', cfg, 'grass-edge', sektoren),
    ...buildGrassMeshes(g2, blade, grasMat, 'gras_wiese', cfg, 'grass-patch', sektoren),
    ...buildGrassMeshes(g3, blade, grasMat, 'gras_stamm', cfg, 'grass-trunk', sektoren),
  ];
  for (const m of grasNetze) { m.userData.nurAugenhoehe = true; group.add(m); }
  // Die Netze kommen mit zurueck: die Bildschleife blendet sie nach Entfernung
  // aus (siehe `aktualisiereGrasSicht`), und dafuer soll sie nicht jedes Bild
  // die ganze Szene durchlaufen muessen.
  stats.halme = g1.count + g2.count + g3.count;
  stats.halmeDetail = [g1.count, g2.count, g3.count];
  phase('gras');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Wasser …');
  const wasser = baueWasser(teich, cfg, tex.wellen, cfg.wasserQualitaet);
  if (wasser) {
    if (wasser.userData.setzeToenung) wasser.userData.setzeToenung(cfg.wasserToenung / 100);
    // WAS NICHT GESPIEGELT WIRD. Das Gras ist der mit Abstand groesste Posten
    // der Szene und im Spiegelbild ohnehin nur eine gruene Flaeche; die Halme
    // einzeln zu spiegeln waere der teuerste Weg zu genau diesem Ergebnis.
    // Ebenso die Kartengrafik, die in Augenhoehe gar nicht sichtbar ist.
    if (wasser.userData.nichtSpiegeln) {
      wasser.userData.nichtSpiegeln.push(...grasNetze);
    }
    group.add(wasser);
  }
  stats.teich = teich
    ? { x: +teich.x.toFixed(1), z: +teich.z.toFixed(1),
        becken: +(teich.rBecken * 2).toFixed(1),
        spiegel: +teich.spiegel.toFixed(2),
        tiefe: +(teich.spiegel - teich.grund).toFixed(2),
        unebenheit: +teich.spanne.toFixed(3),
        art: cfg.wasserQualitaet }
    : null;
  phase('wasser');

  // Das Wasser: gesperrt wird, wo der Boden UNTER dem Spiegel liegt - also
  // genau die nasse Flaeche. Ein Kreis waere zu grob; das Ufer soll begehbar
  // bleiben, und es ist absichtlich nicht rund.
  if (teich) {
    const schritt = cfg.rasterWeite;
    const w = teich.rScheibe;
    for (let dx = -w; dx <= w; dx += schritt) {
      for (let dz = -w; dz <= w; dz += schritt) {
        if (dx * dx + dz * dz > w * w) continue;
        const x = teich.x + dx, z = teich.z + dz;
        if (hf.heightAt(x, z) >= teich.spiegel) continue;
        hindernisse.block(x, z, R_GEHER);
        hindernisse.blockSanft(x, z, R_KAMERA);
      }
    }
  }
  // DIE SAMMELPLAKETTEN. Sie sind keine gewuerfelte Ausstattung, sondern von
  // Hand gesetzte Daten - sie stehen deshalb nicht im Formular, sondern kommen
  // als Liste herein (siehe `plaketten.js`). Ein Netz fuer alle.
  const plaketten = bauePlaketten(cfg._plaketten || [], tex.plakette);
  if (plaketten) group.add(plaketten);
  stats.plaketten = plaketten ? plaketten.count : 0;

  stats.hindernisse = Math.round((hindernisse.blockedCells / hindernisse.cells) * 100);

  stats.rasterBelegt = Math.round((occ.blockedCells / occ.cells) * 100);

  group.traverse((o) => {
    if (!o.geometry) return;
    stats.meshes++;
    const p = o.geometry.attributes.position;
    const count = o.isInstancedMesh ? o.count : 1;
    stats.vertices += p.count * count;
    stats.dreiecke += (o.geometry.index ? o.geometry.index.count / 3 : p.count / 3) * count;
  });
  stats.gitter = netz.seg;
  stats.ms = Math.round(performance.now() - t0 - yielded);   // reine Rechenzeit

  // `signs` sind die Schildflaechen (fuer setSignName), `signPlan` Position und
  // Text - den braucht die Landkarte in der Vogelperspektive.
  stats.sektoren = sektoren.an ? `${sektoren.n}² à ${sektoren.weite.toFixed(0)} m` : 'aus';

  return {
    group, hf, paths, pathIndex, trunks, occ, bestand, bodenkarte, sektoren, plaketten,
    grasNetze, tor, wasser, teich, hindernisse,
    signs: signMeshes.faces, signPlan: signs, stats,
  };
}

export function disposeGarden(group) {
  if (!group) return;
  group.traverse((o) => {
    // Baumgeometrien und -materialien sind geteilt und ueberdauern den Garten:
    // das Skelett kostet je Baumsorte einige hundert Millisekunden und wird
    // beim naechsten Aufbau wieder gebraucht (der Bauplan-Cache in
    // `baumloader.js` haelt es).
    if (o.userData && o.userData.geteilt) {
      if (o.isInstancedMesh && !o.userData.instanzGeteilt) o.dispose();
      return;
    }
    if (o.userData && o.userData.dispose) o.userData.dispose();
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        // Gemeinsame Bildtexturen bleiben im Cache; die pro Schild erzeugten
        // Canvas-Texturen gehoeren zum Garten und muessen mit weg.
        if (m.map && m.map.isCanvasTexture) m.map.dispose();
        m.dispose();
      }
    }
    if (o.isInstancedMesh) o.dispose();
  });
  group.clear();
  group.removeFromParent();
}
