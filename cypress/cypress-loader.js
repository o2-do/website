import * as THREE from 'three';

/**
 * Berechnet den Radiusfaktor abhängig von der Position v (0..1),
 * Peak und Form-Exponent
 */
function getRadiusFactor(v, peakPos, topShape) {
  if (v <= 0 || v >= 1) return 0;
  
  if (v <= peakPos) {
    let normV = (v / peakPos) * 0.5;
    let factor = Math.sin(normV * Math.PI);
    return Math.pow(factor, 0.8);
  } else {
    let normV = 0.5 + ((v - peakPos) / (1 - peakPos)) * 0.5;
    let factor = Math.sin(normV * Math.PI);
    return Math.pow(factor, topShape);
  }
}

/**
 * Erstellt die BufferGeometry basierend auf den Parametern aus der JSON-Datei
 */
export function createZypresseGeometry(config) {
  const {
    height = 6.2,
    segmentsY = 8,
    segmentsRadial = 8,
    maxRadius = 0.7,
    peakPosition = 0.4,
    topShape = 0.5,
    variation = 0.0
  } = config;

  const vertices = [];
  const indices = [];
  const uvs = [];

  const lastV = 1;
  const topRadiusFactor = getRadiusFactor(lastV, peakPosition, topShape);
  const topRadius = Math.max(maxRadius * topRadiusFactor, 0.05);
  const tipHeight = topRadius * Math.tan(30 * Math.PI / 180);

  for (let yIndex = 0; yIndex <= segmentsY; yIndex++) {
    const v = yIndex / segmentsY;
    const yPos = Math.pow(v, 1.2) * (height - tipHeight);

    let radiusFactor = getRadiusFactor(v, peakPosition, topShape);
    let currentRadius = maxRadius * radiusFactor;

    if (yIndex % 2 === 0) {
      currentRadius *= (1 + variation);
    } else {
      currentRadius *= (1 - variation);
    }

    currentRadius = Math.max(currentRadius, 0.05);

    for (let rIndex = 0; rIndex <= segmentsRadial; rIndex++) {
      const u = rIndex / segmentsRadial;
      const angle = u * Math.PI * 2;

      const x = Math.cos(angle) * currentRadius;
      const z = Math.sin(angle) * currentRadius;

      vertices.push(x, yPos, z);
      uvs.push(u, v);
    }
  }

  const stride = segmentsRadial + 1;
  for (let y = 0; y < segmentsY; y++) {
    for (let r = 0; r < segmentsRadial; r++) {
      const current = y * stride + r;
      const next = current + stride;

      indices.push(current, next, current + 1);
      indices.push(current + 1, next, next + 1);
    }
  }

  const topCenterIndex = vertices.length / 3;
  const lastRingStart = segmentsY * stride;

  vertices.push(0, height, 0);
  uvs.push(0.5, 1.0);

  for (let r = 0; r < segmentsRadial; r++) {
    const current = lastRingStart + r;
    const next = current + 1;
    indices.push(topCenterIndex, next, current);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Erstellt das Material inklusive Textur
 */
export function createZypresseMaterial(textureBase, config) {
  const {
    height = 6.2,
    repeatU = 3,
    repeatV = 6,
    useRealSize = false,
    patternHeight = 1.0
  } = config;

  // Klonen der Textur, damit Instanzen unterschiedliche UV-Wiederholungen haben können
  const texture = textureBase.clone();
  texture.needsUpdate = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.rotation = -10 * Math.PI / 180;
  texture.center.set(0.5, 0.5);

  const calcRepeatV = useRealSize ? (height / patternHeight) : repeatV;
  texture.repeat.set(repeatU, calcRepeatV);

  return new THREE.MeshPhongMaterial({
    map: texture,
    color: 0xffffff,
    shininess: 10,
    flatShading: true
  });
}

/**
 * Lädt eine JSON-Exportdatei aus einem Pfad und gibt das fertige Mesh zurück
 */
export async function loadZypresseMesh(jsonUrl, textureBase) {
  const response = await fetch(jsonUrl);
  const config = await response.json();

  const geometry = createZypresseGeometry(config);
  const material = createZypresseMaterial(textureBase, config);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}