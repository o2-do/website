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
    pfosten: 'img/pfosten.jpg', // Holz von Zaunpfosten und Querhoelzern
    bordstein: 'img/bordstein.jpg',  // Kante rings um den Garten, 1,5 m je Kachel
    // Platzhalter fuer das Nadelkleid der Zypressen. Eine eigene Vorlage gibt
    // es noch nicht; die Wiesenkachel liest sich unter der Drehung und der
    // engen Wiederholung des Konfigurators als dichtes Gruen.
    zypresse: 'img/zypresse.jpg',
    wellen: 'water/waternormals.jpg',   // Normalkarte der Wasseroberflaeche
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
