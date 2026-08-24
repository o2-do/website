import * as THREE from 'three';
import { stream, rand } from './rng.js';
import { createZypresseGeometry, createZypresseMaterial } from '../cypress/cypress-loader.js';
import { frisch } from './frisch.js';

/**
 * Zypressen, und zwar zu dritt.
 *
 * Eine einzelne Zypresse ist ein schlanker Kegel und sieht aus der Ferne aus
 * wie ein Pfosten. Zu dritt im Dreieck stehend wird daraus eine Gruppe, die
 * Tiefe hat: die hintere verdeckt die vordere teilweise, und je nachdem, wo man
 * steht, verschiebt sich das Bild. Deshalb wird nicht die Zahl der Baeume
 * eingestellt, sondern die Zahl der GRUPPEN.
 *
 * Zwei Vorlagen, zweimal die eine und einmal die andere - so ist keine Gruppe
 * ganz gleichfoermig, ohne dass es dafuer eine dritte Datei braeuchte. Welche
 * der drei Ecken die abweichende bekommt, entscheidet der Zufall.
 *
 * Das Netz selbst kommt aus dem Zypressen-Konfigurator (`cypress/`), unveraendert
 * - hier wird nur gestellt.
 */

// Die beiden Vorlagen. Die erste steht zweimal je Gruppe, die zweite einmal.
export const ZYPRESSEN_DATEIEN = ['json/zypresse-1.json', 'json/zypresse-2.json'];

/**
 * Die Bauplaene laden und je Datei EINMAL Netz und Material bauen.
 *
 * Der Cache haelt sie ueber Neuaufbauten hinweg - eine Zypresse ist zwar
 * billig gerechnet, aber die Textur soll nicht bei jedem Umstellen eines
 * Reglers neu durch die Grafikkarte.
 */
const cache = new Map();

export async function ladeZypressen(textur) {
  const out = [];
  for (const datei of ZYPRESSEN_DATEIEN) {
    let eintrag = cache.get(datei);
    if (!eintrag) {
      const cfg = await (await fetch(frisch(datei))).json();
      const geo = createZypresseGeometry(cfg);
      geo.computeBoundingSphere();
      eintrag = {
        geo,
        material: createZypresseMaterial(textur, cfg),
        hoehe: cfg.height || 6,
        radius: cfg.maxRadius || 0.5,
      };
      cache.set(datei, eintrag);
    }
    out.push(eintrag);
  }
  return out;
}

/**
 * Die Gruppen setzen.
 *
 * Gesucht wird zuerst ein Platz fuer die GRUPPE - Kreisflaeche, abseits der
 * Wege, flach genug -, und erst danach werden die drei Ecken darauf gelegt.
 * Andersherum bekaeme man Gruppen, denen ein Baum fehlt, weil seine Ecke im Weg
 * lag; so faellt entweder die ganze Gruppe aus oder keiner.
 *
 * Zurueck kommt je Baum { vorlage, x, y, z, dreh } - `vorlage` ist der Index in
 * `ZYPRESSEN_DATEIEN`.
 */
export function planZypressen(hf, cfg, pathIndex, occ, sorten) {
  const gruppen = Math.max(0, Math.round(cfg.zypressenGruppen));
  const baeume = [];
  if (!gruppen || !sorten.length) return baeume;

  const rng = stream(cfg._seed, 'zypressen');
  const R = hf.radius;
  const seite = Math.max(0.1, cfg.zypressenAbstand);
  // Umkreis des gleichseitigen Dreiecks: die Ecken liegen `seite`/sqrt(3) von
  // der Mitte, und der Platzbedarf der Gruppe ist das plus ein Stammhalbmesser.
  const umkreis = seite / Math.sqrt(3);
  const dick = Math.max(...sorten.map((s) => s.radius));
  const platz = umkreis + dick;

  for (let g = 0; g < gruppen * 40 && baeume.length < gruppen * 3; g++) {
    const rr = 0.9 * R * Math.sqrt(rng());
    const aa = rng() * Math.PI * 2;
    const cx = Math.cos(aa) * rr, cz = Math.sin(aa) * rr;
    if (hf.neigung(cx, cz) > cfg.maxNeigung) continue;
    if (pathIndex && pathIndex.surfaceDistance(cx, cz) < platz + cfg.zypressenAbstandWeg) continue;
    if (occ && !occ.free(cx, cz, platz)) continue;

    // Das Dreieck als Ganzes gedreht, und die abweichende Vorlage auf eine
    // zufaellige Ecke - sonst zeigte jede Gruppe dasselbe Bild.
    const dreh = rng() * Math.PI * 2;
    const anders = Math.floor(rng() * 3);
    for (let k = 0; k < 3; k++) {
      const w = dreh + (k * 2 * Math.PI) / 3;
      const x = cx + Math.cos(w) * umkreis;
      const z = cz + Math.sin(w) * umkreis;
      baeume.push({
        vorlage: k === anders ? 1 : 0,
        x, z, y: hf.heightAt(x, z),
        dreh: rng() * Math.PI * 2,
      });
    }
    if (occ) occ.block(cx, cz, platz);
  }
  return baeume;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _skal = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _y = new THREE.Vector3(0, 1, 0);

/**
 * Die Netze - je Vorlage UND Sektor eines. Dieselbe Aufteilung wie ueberall
 * sonst, damit das Sichtvolumen ganze Felder verwerfen kann.
 */
export function baueZypressen(baeume, sorten, sektoren) {
  const meshes = [];
  sorten.forEach((sorte, v) => {
    const meine = baeume.filter((b) => b.vorlage === v);
    if (!meine.length) return;
    for (const [feld, teil] of sektoren.teile(meine)) {
      const netz = new THREE.InstancedMesh(sorte.geo, sorte.material, teil.length);
      netz.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      teil.forEach((b, i) => {
        _quat.setFromAxisAngle(_y, b.dreh);
        netz.setMatrixAt(i, _m.compose(_pos.set(b.x, b.y, b.z), _quat, _skal));
      });
      netz.instanceMatrix.needsUpdate = true;
      netz.computeBoundingSphere();
      netz.castShadow = true;
      netz.receiveShadow = true;
      // Geometrie und Material gehoeren dem Cache und ueberdauern den Garten.
      netz.userData.geteilt = true;
      netz.userData.instanzGeteilt = false;
      netz.name = `zypressen_${v}_${feld}`;
      meshes.push(netz);
    }
  });
  return meshes;
}

/**
 * Der eingebrannte Schatten: ein weicher Kreis je Baum, gegen die Sonne
 * versetzt - dasselbe Mittel wie bei Felsen und Pflanzen.
 */
export function stempelZypressenschatten(bodenkarte, baeume, sorten) {
  if (!bodenkarte || !baeume.length) return 0;
  for (const b of baeume) {
    const sorte = sorten[b.vorlage];
    bodenkarte.setzeKreis(b.x, b.z, sorte.radius * 2.4);
  }
  return baeume.length;
}
