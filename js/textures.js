import * as THREE from 'three';
import { frisch } from './frisch.js';

// Einmal laden, danach cachen. Beim Neuaufbau des Gartens duerfen Texturen
// ausdruecklich NICHT disposed werden.
const cache = new Map();

export async function loadTextures(renderer) {
  const files = {
    wiese: 'img/wiese.jpg',
    weg: 'img/kopfstein.jpg',
    abk: 'img/abk2.jpg?v3',         // Belag der Abkuerzungen
    fels: 'img/felsstruktur.jpg',
    wald: 'img/wald.png',       // Silhouettenstreifen mit Alphakanal
    // Zwei Hoelzer, und die Trennung ist Absicht: was den Garten UMGIBT -
    // Zaun, Torsaeulen, Schildpfaehle - ist grau verwittert; was IN ihm
    // steht - die Gelaender an den steilen Wegen - ist warmes Holz.
    pfostenGrau: 'img/pfosten-grau.jpg',
    pfosten: 'img/pfosten.jpg', // Holz der Gelaender
    bordstein: 'img/bordstein.jpg',  // Kante rings um den Garten, 1,5 m je Kachel
    // Platzhalter fuer das Nadelkleid der Zypressen. Eine eigene Vorlage gibt
    // es noch nicht; die Wiesenkachel liest sich unter der Drehung und der
    // engen Wiederholung des Konfigurators als dichtes Gruen.
    zypresse: 'img/zypresse.jpg',
    wellen: 'img/waternormals.jpg',   // Normalkarte der Wasseroberflaeche
    granit: 'img/granit.jpg',           // Treppenstufen, 1 m je Kachel
    plakette: 'img/plakette.jpg',       // Vorderseite der Sammelmarken
  };
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const loader = new THREE.TextureLoader();
  const out = {};
  await Promise.all(Object.entries(files).map(async ([key, url]) => {
    if (!cache.has(url)) {
      const tex = await loader.loadAsync(frisch(url));
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      // Eine Normalkarte ist keine Farbe, sondern eine Richtung je Bildpunkt.
      // Durch die sRGB-Kurve gejagt zeigten die Wellen in die falsche Richtung.
      tex.colorSpace = key === 'wellen' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      cache.set(url, tex);
    }
    out[key] = cache.get(url);
  }));
  return out;
}
