import * as THREE from 'three';
import { sonnenVersatz } from './baumloader.js';

/**
 * DER WIRKLICHE SCHATTENRISS EINES NETZES.
 *
 * Bisher bekam alles, was keinen gebackenen Riss mitbringt - Felsen, Zypressen,
 * Pflanzen, Zaun -, einen weichen Kreis oder eine Ellipse in die Bodenkarte
 * (siehe `bodenkarte.js`). Das ist fuer ein Grasbueschel richtig und fuer einen
 * Findling falsch: ein Fels ist kantig, und sein Schatten sieht aus wie er.
 *
 * WIE ES GEHT. Der Schatten eines Koerpers ist sein Umriss, laengs der
 * Sonnenstrahlen auf den Boden geworfen. `sonnenVersatz(h)` sagt, wie weit ein
 * Punkt in der Hoehe h dabei wandert; damit wird aus jedem Eckpunkt ein
 * Bodenpunkt, und der Umriss ist die konvexe Huelle dieser Bodenpunkte.
 *
 * WARUM KONVEX. Ein wirklicher Riss waere die Vereinigung aller projizierten
 * Dreiecke - bei siebzig Felsbrocken mit je dreizehntausend Dreiecken sind das
 * eine Million Fuellungen auf der Leinwand. Die Huelle ist ein Zug. Fuer einen
 * kompakten Koerper - Fels, Zypresse, Pfosten, Pflanzenballen - ist sie
 * praktisch der Umriss; nur ein Gegenstand mit Loechern verlore sie, und der
 * wird deshalb in seine Teile zerlegt gestempelt (der Zaun etwa in Pfosten und
 * Querhoelzer).
 *
 * WARUM ES TROTZDEM SCHNELL IST. Je GEOMETRIE werden einmal die aeussersten
 * Eckpunkte in vielen Richtungen gesucht - ein paar Dutzend statt Tausender.
 * Nur die werden je Instanz noch angefasst. Bei zweitausend Pflanzen sind das
 * hunderttausend Punkte statt zehn Millionen.
 */

// Die Richtungen, in denen der aeusserste Eckpunkt gesucht wird. Azimut mal
// Hoehenwinkel; mehr braeuchte es nur fuer sehr zerklueftete Koerper.
const AZIMUTE = 16;
const HOEHEN = [-0.6, 0, 0.6, 1.0];

/**
 * Die aeussersten Eckpunkte einer Geometrie - einmal gerechnet und an der
 * Geometrie selbst vermerkt. Sie ueberdauert den Garten (Bauplan-Cache), also
 * ueberdauert auch das Ergebnis.
 */
export function huellEcken(geo) {
  if (geo.userData._huelle) return geo.userData._huelle;
  const pos = geo.attributes.position;
  const n = pos.count;
  const gewaehlt = new Set();
  for (let a = 0; a < AZIMUTE; a++) {
    const w = (a / AZIMUTE) * Math.PI * 2;
    const dx = Math.cos(w), dz = Math.sin(w);
    for (const dy of HOEHEN) {
      let best = -Infinity, bi = 0;
      for (let i = 0; i < n; i++) {
        const v = pos.getX(i) * dx + pos.getY(i) * dy + pos.getZ(i) * dz;
        if (v > best) { best = v; bi = i; }
      }
      gewaehlt.add(bi);
    }
  }
  const out = new Float32Array(gewaehlt.size * 3);
  let k = 0;
  for (const i of gewaehlt) {
    out[k++] = pos.getX(i); out[k++] = pos.getY(i); out[k++] = pos.getZ(i);
  }
  geo.userData._huelle = out;
  return out;
}

const _v = new THREE.Vector3();

/**
 * Den Riss eines Gegenstands in die Bodenkarte stempeln.
 *
 * `matrix` stellt ihn in die Welt, `yBoden` ist die Hoehe des Bodens unter ihm
 * - der Versatz gilt fuer die Hoehe UEBER dem Boden, nicht ueber der Null.
 */
export function stempleRiss(bodenkarte, geo, matrix, yBoden) {
  if (!bodenkarte) return false;
  const ecken = huellEcken(geo);
  const boden = [];
  for (let i = 0; i < ecken.length; i += 3) {
    _v.set(ecken[i], ecken[i + 1], ecken[i + 2]).applyMatrix4(matrix);
    const v = sonnenVersatz(Math.max(0, _v.y - yBoden));
    boden.push([_v.x + v.x, _v.z + v.z]);
  }
  const huelle = konvexeHuelle(boden);
  if (huelle.length < 3) return false;
  bodenkarte.setzeRiss(huelle);
  return true;
}

/**
 * Konvexe Huelle in der Ebene, Monotone Chain. Zurueck kommt ein Ringzug gegen
 * den Uhrzeigersinn, ohne den Startpunkt am Ende zu wiederholen.
 */
export function konvexeHuelle(punkte) {
  if (punkte.length < 3) return punkte;
  const p = [...punkte].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const kreuz = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const unten = [];
  for (const q of p) {
    while (unten.length >= 2 && kreuz(unten[unten.length - 2], unten[unten.length - 1], q) <= 0) unten.pop();
    unten.push(q);
  }
  const oben = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (oben.length >= 2 && kreuz(oben[oben.length - 2], oben[oben.length - 1], q) <= 0) oben.pop();
    oben.push(q);
  }
  unten.pop(); oben.pop();
  return unten.concat(oben);
}

const _m = new THREE.Matrix4();

/**
 * Ganze Netze stempeln - je Instanz ein Riss.
 *
 * Gedacht fuer alles, was aus vielen gleichen Teilen besteht: Zaun, Tor,
 * Gelaender. Jedes Teil bekommt seinen eigenen Riss, und das ist der Grund,
 * warum die konvexe Huelle hier nicht stoert: die Luecken zwischen Pfosten und
 * Querhoelzern bleiben Luecken, weil nie ueber sie hinweg gehuellt wird.
 */
export function stempleNetzschatten(bodenkarte, netze, hf) {
  if (!bodenkarte) return 0;
  let n = 0;
  for (const netz of netze) {
    if (!netz || !netz.geometry || !netz.geometry.attributes.position) continue;
    if (netz.isInstancedMesh) {
      for (let i = 0; i < netz.count; i++) {
        netz.getMatrixAt(i, _m);
        const x = _m.elements[12], z = _m.elements[14];
        if (stempleRiss(bodenkarte, netz.geometry, _m, hf.heightAt(x, z))) n++;
      }
    } else {
      netz.updateMatrix();
      const x = netz.position.x, z = netz.position.z;
      if (stempleRiss(bodenkarte, netz.geometry, netz.matrix, hf.heightAt(x, z))) n++;
    }
  }
  return n;
}
