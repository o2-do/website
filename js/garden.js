import * as THREE from 'three';
import { hashSeed, stream } from './rng.js';
import {
  createHeightField, buildHorizon, buildMapMask, buildMapBox,
} from './terrain.js';
import { buildPaths, makePathIndex, torWeg } from './paths.js';
import { verknuepfeWege } from './wegknoten.js';
import {
  baueNetz, verforme, ebnePfade, glaette, hoehenfeldAusNetz,
  baueWiesenMesh, baueWegMesh,
} from './wiesennetz.js';
import { planSigns, buildSigns } from './signs.js';
import { createOccupancy } from './occupancy.js';
import {
  createRockGeometries, planarUV, planRocks, buildRockMeshes, stempelFelsschatten,
} from './rocks.js';
import { planTrunks } from './trees.js';
import { ladeBauplaene, baueBestand } from './baumbestand.js';
import { createBodenkarte } from './bodenkarte.js';
import {
  loadPlantModel, loadBed, pflanzenAusBeeten, planBeds, buildPlantMeshes,
  buildBedFloors, stempelPflanzenschatten,
} from './plants.js';
import { createSektoren } from './sektoren.js';
import { buildZaun, buildTor, planTor } from './zaun.js';
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
    map: tex.wiese, roughness: 1, metalness: 0,
    wireframe: cfg.drahtgitter,
  }));
  const felsMat = new THREE.MeshStandardMaterial({
    map: tex.fels, roughness: 0.95, metalness: 0, flatShading: true,
    wireframe: cfg.drahtgitter,
  });
  const wegMat = imGrund(new THREE.MeshStandardMaterial({
    map: tex.weg, roughness: 1, metalness: 0,
    wireframe: cfg.drahtgitter,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  // Abkuerzungen sind Trampelpfade und haben ihren eigenen Belag.
  const abkMat = imGrund(new THREE.MeshStandardMaterial({
    map: tex.abk, roughness: 1, metalness: 0,
    wireframe: cfg.drahtgitter,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  // Maske und Kasten sind reine Kartengrafik: weiss, ohne Licht - und damit
  // auch ohne Schatten, denn ein Basismaterial nimmt keinen an.
  const kastenMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.DoubleSide, fog: false,
    wireframe: cfg.drahtgitter,
  });
  const pfahlMat = new THREE.MeshStandardMaterial({
    color: 0x997755, roughness: 1, metalness: 0,
    wireframe: cfg.drahtgitter,
  });
  const grasMat = imGrund(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    side: THREE.DoubleSide, vertexColors: true,
    wireframe: cfg.drahtgitter,
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

  // Bis hierher folgt jeder Weg fuer sich dem Rohgelaende. Jetzt werden sie
  // aneinander angeschlossen: wo einer in den anderen muendet, uebernimmt der
  // rangniedere dessen Ebene - Hoehe, Laengsgefaelle und Querneigung. Das muss
  // VOR dem Index passieren, denn der traegt beides in die Planie weiter.
  verknuepfeWege(paths, base, cfg);

  const pathIndex = makePathIndex(paths, cfg);

  // DAS NETZ. Erst in der Ebene: Gitter legen, Wegbaender darauf zeichnen,
  // Schnittflaechen bestimmen. Danach steht der Punktsatz fest, und die drei
  // Durchgaenge verschieben die Punkte nur noch senkrecht.
  //
  // Weil Wiese und Wegband sich an der Kante DIESELBEN Punkte teilen, kann dort
  // weder eine Fuge aufgehen noch eines durch das andere stossen. Die ganze
  // frueher noetige Kette - Weg anheben, Ausgleichswall, Untergriff, Saum -
  // ist damit hinfaellig.
  const netz = baueNetz(paths, cfg);
  verforme(netz.netz, base);
  ebnePfade(netz.netz, paths, cfg);
  glaette(netz.netz, netz.wiese, cfg);
  const alleDreiecke = netz.wiese.concat(...netz.baender);
  const hf = hoehenfeldAusNetz(netz.netz, alleDreiecke, base, cfg);

  paths.forEach((p, i) => {
    // Der Zugang zum Tor ist ein angelegter Weg, keine Abkuerzung - er bekommt
    // denselben Belag wie der Rundweg (siehe `makePath`).
    const wieRund = p.closed || p.art === 'tor';
    const mesh = baueWegMesh(netz.netz, p, netz.kante[i], cfg, wieRund ? wegMat : abkMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  // Belegungsraster: wer zuerst platziert wird, sperrt seine Zellen.
  // Reihenfolge: Weg -> Baumstamm -> Fels -> Grasbueschel
  const occ = createOccupancy(hf.radius, cfg.rasterWeite);
  for (const p of paths) {
    const sm = p.samples;
    const segs = p.closed ? sm.length : sm.length - 1;
    const halfW = p.width / 2;
    for (let i = 0; i < segs; i++) {
      const a = sm[i], b = sm[(i + 1) % sm.length];
      occ.blockSegment(a.x, a.z, b.x, b.z, halfW);
    }
  }

  stats.wege = paths.length;
  stats.abkuerzungen = paths.filter((p) => !p.closed).length;
  stats.wegLaenge = Math.round(paths.reduce((a, p) => a + p.total, 0));
  phase('wege');
  await nextFrame();
  tPhase = performance.now();

  onProgress('Wiese …');
  const ground = baueWiesenMesh(netz.netz, netz.wiese, cfg, wieseMat);
  ground.receiveShadow = true;
  group.add(ground);
  // Die weite Horizontscheibe fuer die Augenperspektive; in der Karte deckt
  // stattdessen die weisse Maske alles ab, was ausserhalb des Kreises liegt.
  group.add(buildHorizon(cfg, wieseMat));
  group.add(buildMapMask(cfg, kastenMat));
  group.add(buildMapBox(cfg, kastenMat, hf.amplitude + 0.5));
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

  const bestand = await baueBestand(cfg, liste, plaene, trunks, bodenkarte);
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

  onProgress('Schilder …');
  const signs = planSigns(benannt, paths, pathIndex, hf, cfg);
  const signMeshes = buildSigns(signs, cfg, pfahlMat);
  if (signs.length) group.add(signMeshes.group);
  stats.schilder = signs.length;
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
  stempelFelsschatten(bodenkarte, placements);
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
  bodenkarte.zeichne();

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
  const zaun = buildZaun(cfg, hf, tex.pfosten, sektoren, tor);
  // In der Karte bleibt der Zaun draussen: von oben ist er ein haarduenner
  // Ring am Rand, der wie eine Rahmenlinie wirkt und den runden Ausschnitt
  // doppelt. Der Garten endet dort ohnehin sichtbar.
  for (const m of zaun) { m.userData.nurAugenhoehe = true; group.add(m); }
  stats.zaun = zaun.stats || { pfosten: 0, quer: 0, umfang: 0, radius: 0 };
  // Das Tor bleibt in der Karte sichtbar: es ist der Zugang und damit eine
  // Angabe zur Anlage, nicht zur Bepflanzung.
  for (const m of buildTor(cfg, hf, tex.pfosten, tor)) group.add(m);
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
    group, hf, paths, pathIndex, trunks, occ, bestand, bodenkarte, sektoren,
    grasNetze, tor,
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
