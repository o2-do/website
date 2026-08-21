import * as THREE from 'three';

/**
 * Marken, die nur in der Vogelperspektive sichtbar sind und aus ihr eine
 * Landkarte machen:
 *
 *   - der eigene Standpunkt als rotes, laengliches Dreieck, flach auf dem
 *     Boden liegend und in Laufrichtung zeigend,
 *   - je Schild ein weisses Rechteck mit dem Namen.
 *
 * Beide liegen bewusst **ueber** allem anderen: `depthTest: false` und eine
 * hohe `renderOrder`. Sonst verschwinden die Schildnamen spaeter hinter den
 * Baumkronen, und genau die soll man auf der Karte ja finden.
 *
 * Die Namensschilder sind Billboards, die die Kameradrehung uebernehmen -
 * damit steht die Schrift in jeder Blickrichtung waagerecht auf dem Schirm.
 * Ein flach auf den Boden gelegtes Rechteck wuerde beim Umkreisen mitkippen
 * und auf dem Kopf stehen.
 */

const PX = 512;                 // Pixelhoehe der Namenstextur
const FONT = (px) => `600 ${px}px system-ui, -apple-system, Segoe UI, sans-serif`;

let _measure = null;
function measureCtx() {
  if (!_measure) _measure = document.createElement('canvas').getContext('2d');
  return _measure;
}

function labelTexture(text) {
  const fontPx = Math.round(PX * 0.62);
  const padX = Math.round(PX * 0.32);
  const ctx = measureCtx();
  ctx.font = FONT(fontPx);
  const w = Math.max(8, Math.round(ctx.measureText(text).width) + 2 * padX);

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = PX;
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w, PX);
  c.font = FONT(fontPx);
  c.fillStyle = '#333333';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, w / 2, PX * 0.54);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { texture: tex, aspect: w / PX };
}

/** Rotes Dreieck, flach in der XZ-Ebene, Spitze in -Z (= Blickrichtung bei yaw 0). */
export function createWalkerMark() {
  const geo = new THREE.BufferGeometry();
  // laenglich: Spitze vorn, zwei Ecken hinten, hinten leicht eingezogen
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
     0.0, 0, -0.62,
     0.30, 0, 0.38,
     0.0, 0, 0.16,

     0.0, 0, -0.62,
     0.0, 0, 0.16,
    -0.30, 0, 0.38,
  ], 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    color: 0xd62828, side: THREE.DoubleSide, fog: false,
    depthTest: false, depthWrite: false, transparent: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'karte_standpunkt';
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/**
 * Ein Namensschild je Schild. Die Textur wird je Text nur einmal gebaut -
 * bei zehn gleichen Namen ist das ein Canvas statt zehn.
 */
export function buildSignMarks(signs, size) {
  const group = new THREE.Group();
  group.name = 'karte_schilder';
  group.visible = false;
  group.renderOrder = 1001;

  const cache = new Map();
  for (const s of signs) {
    let entry = cache.get(s.text);
    if (!entry) {
      const { texture, aspect } = labelTexture(s.text);
      entry = {
        material: new THREE.MeshBasicMaterial({
          map: texture, fog: false, side: THREE.DoubleSide,
          depthTest: false, depthWrite: false, transparent: true,
        }),
        geometry: new THREE.PlaneGeometry(size * aspect, size),
      };
      cache.set(s.text, entry);
    }
    const mesh = new THREE.Mesh(entry.geometry, entry.material);
    mesh.position.set(s.x, s.y + size, s.z);
    mesh.renderOrder = 1001;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

/**
 * Je Frame: Marken ein-/ausblenden, Standpunkt setzen, Namensschilder zur
 * Kamera drehen.
 */
export function updateMarks(mark, signGroup, camera, pose, groundY, show) {
  if (mark) {
    mark.visible = show;
    if (show) {
      mark.position.set(pose.x, groundY + 0.05, pose.z);
      mark.rotation.set(0, pose.yaw, 0);
    }
  }
  if (signGroup) {
    signGroup.visible = show;
    if (show) for (const m of signGroup.children) m.quaternion.copy(camera.quaternion);
  }
}
