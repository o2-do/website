import * as THREE from 'three';
import { atArcLength } from './paths.js';

/**
 * Schildtextur auf einem Canvas. Der Name muss vollstaendig aufs Schild passen,
 * deshalb wird die Schriftgroesse so lange verkleinert, bis er in die Breite
 * passt; erst wenn eine Untergrenze erreicht ist, wird auf zwei Zeilen
 * umgebrochen.
 */
const PX = 1000;                                     // Pixel je Meter
const FONT = (px) => `600 ${px}px system-ui, -apple-system, Segoe UI, sans-serif`;

let _measure = null;
function measureCtx() {
  if (!_measure) _measure = document.createElement('canvas').getContext('2d');
  return _measure;
}

/**
 * Die Schrift hat eine feste Groesse, das Schild richtet sich danach: kein
 * Umbruch, keine gestauchten Namen - stattdessen wird das Brett so breit wie
 * noetig. Die Hoehe ist fuer alle Schilder gleich (Schriftgroesse + Rand),
 * damit alle Schilder auf derselben Hoehe haengen.
 */
export function signSize(text, cfg) {
  const ctx = measureCtx();
  ctx.font = FONT(cfg.schriftGroesse * PX);
  const textW = ctx.measureText(text).width / PX;
  return {
    width: textW + 2 * cfg.schildRand,
    height: cfg.schildHoehe,          // = schriftGroesse * 1.35 + 2 * schildRand
  };
}

export function makeSignTexture(text, cfg) {
  const size = signSize(text, cfg);
  const w = Math.max(8, Math.round(size.width * PX));
  const h = Math.max(8, Math.round(size.height * PX));

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.font = FONT(cfg.schriftGroesse * PX);
  ctx.fillStyle = '#666666';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { texture: tex, ...size };
}

/**
 * Vor jedem benannten Baum steht ein Schild mit seinem Namen. Der Pfahl steht
 * 10 cm von der Wegkante auf derselben Bogenlaenge wie der Baum, das Schild
 * zeigt mit der lesbaren Seite zum Weg.
 *
 * `benannt` ist die Paarung aus Baumplatz und Name, die garden.js aus der
 * Namensliste bildet - die Schilderzahl ist damit nicht mehr frei einstellbar,
 * sondern die Zahl der Eintraege in der Liste.
 */
export function planSigns(benannt, paths, pathIndex, hf, cfg) {
  const out = [];
  for (const { trunk: t, name } of benannt) {
    const path = paths[t.pathIdx];
    if (!path) continue;
    // Die Kante des Weges, an dem der Baum steht - eine Abkuerzung ist
    // schmaler als der Rundweg.
    const offset = path.width / 2 + cfg.pfahlAbstandWeg;
    const c = atArcLength(path, t.s);
    const x = c.x + c.nx * offset * t.side;
    const z = c.z + c.nz * offset * t.side;
    // Der Pfahl steht bewusst dicht am eigenen Weg; geprueft wird gegen die
    // anderen Wege.
    if (pathIndex.surfaceDistance(x, z, t.pathIdx) < cfg.pfahlDurchmesser) continue;

    out.push({
      x, z, y: hf.heightAt(x, z), trunk: t, text: name,
      // Blickrichtung des Schildes: zurueck zum Weg
      fx: -c.nx * t.side, fz: -c.nz * t.side,
    });
  }
  return out;
}

export function buildSigns(signs, cfg, postMaterial) {
  const group = new THREE.Group();
  group.name = 'schilder';
  if (signs.length === 0) return { group, faces: [] };

  const pr = cfg.pfahlDurchmesser / 2;
  const ph = cfg.pfahlHoehe;
  const postGeo = new THREE.CylinderGeometry(pr, pr, ph, 8);
  const posts = new THREE.InstancedMesh(postGeo, postMaterial, signs.length);
  posts.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  posts.castShadow = true;
  posts.receiveShadow = true;
  posts.name = 'pfaehle';

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);

  const faces = [];

  signs.forEach((s, i) => {
    const sink = 0.05;
    p.set(s.x, s.y - sink + ph / 2, s.z);
    m.compose(p, q, one);
    posts.setMatrixAt(i, m);

    // Breite folgt dem Namen, Hoehe ist fuer alle gleich
    const sign = makeSignTexture(s.text, cfg);
    const boardGeo = new THREE.PlaneGeometry(sign.width, sign.height);
    const front = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({
      map: sign.texture, roughness: 0.9, metalness: 0,
    }));
    const back = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({
      color: 0xf2f2f2, roughness: 0.9, metalness: 0,
    }));

    const yaw = Math.atan2(s.fx, s.fz);
    const cy = cfg.schildMitteHoehe + s.y;      // Schildmitte auf Augenhoehe
    // knapp vor bzw. hinter dem Pfahl, damit nichts durchsticht
    for (const [mesh, dir, rot] of [[front, 1, yaw], [back, -1, yaw + Math.PI]]) {
      mesh.position.set(s.x + s.fx * pr * 1.2 * dir, cy, s.z + s.fz * pr * 1.2 * dir);
      mesh.rotation.set(0, rot, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    faces.push({ mesh: front, back, texture: sign.texture });
  });

  posts.instanceMatrix.needsUpdate = true;
  posts.computeBoundingSphere();
  group.add(posts);
  return { group, faces };
}

/**
 * Namen nachtraeglich setzen (spaetere Version: individuelle Namen je Schild).
 * Weil die Schildbreite dem Namen folgt, wird auch die Geometrie neu gebaut.
 */
export function setSignName(face, text, cfg) {
  face.texture.dispose();
  face.mesh.geometry.dispose();
  const sign = makeSignTexture(text, cfg);
  const geo = new THREE.PlaneGeometry(sign.width, sign.height);
  face.mesh.geometry = geo;
  face.back.geometry = geo;
  face.mesh.material.map = sign.texture;
  face.mesh.material.needsUpdate = true;
  face.texture = sign.texture;
}
