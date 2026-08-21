import * as THREE from 'three';

/**
 * Transluzenz fuer Blaetter und Pflanzen - der billige Gegenlicht-Trick.
 *
 * Statt echter Lichtbrechung wird dort, wo die Sonne von HINTEN auf die Flaeche
 * faellt, ein inneres Leuchten addiert. Zwei Faktoren:
 *
 *   hinten  = max(0, -dot(N, L))    Licht steht hinter der Flaeche
 *   entgegen= max(0, -dot(V, L))    man schaut in Richtung Licht
 *
 * Beide zusammen ergeben das Aufleuchten, das ein Blatt hat, wenn die Sonne
 * dahinter steht - und nur dann. Das Leuchten nimmt die **eigene Farbe der
 * Flaeche** an (`diffuseColor`), nicht eine fest eingebaute: dadurch glimmt die
 * Rotbuche rot und die Birke gelbgruen, ohne dass irgendwo eine zweite Farbe
 * gepflegt werden muesste.
 *
 * Drei Dinge, die in der urspruenglichen Fassung des Tricks nicht stimmen:
 *
 * 1. `vNormal` liegt im **Sichtraum**. Eine fest verdrahtete Lichtrichtung
 *    dreht sich damit beim Umsehen mit - das Gegenlicht kaeme immer von da,
 *    wo man gerade hinschaut. Deshalb wird die Sonnenrichtung je Bild in den
 *    Sichtraum gerechnet und als Uniform uebergeben.
 * 2. Eingehaengt wird an `lights_fragment_end`, nicht an `dithering_fragment`.
 *    Nach dem Dithering ist die Farbe bereits tonwertkomprimiert, in den
 *    Ausgabefarbraum gewandelt und **vernebelt** - ein dort addiertes Leuchten
 *    strahlt durch den Nebel hindurch und ignoriert die Belichtung.
 * 3. `normal` statt `vNormal`: die Chunk-Variable ist normiert und bei
 *    beidseitigen Materialien bereits zur Kamera hin gedreht. Genau das
 *    braucht der Test "Licht steht dahinter".
 *
 * Kosten: ein Skalarprodukt, eine Potenz, eine Addition je Fragment. Gemessen
 * am Gartenbild nicht von 0 zu unterscheiden - der Garten haengt an der
 * Dreieckszahl, nicht am Fragmentshader (siehe unten).
 */

// Gemeinsame Uniformwerte fuer alle transluzenten Materialien: ein Objekt,
// eine Zuweisung je Bild - egal wie viele Materialien daran haengen.
const uLicht = { value: new THREE.Vector3(0, 1, 0) };   // Sonnenrichtung im Sichtraum
const uStaerke = { value: 0 };
const uFarbe = { value: new THREE.Color(1.0, 0.97, 0.82) };

const _dir = new THREE.Vector3();
const _view = new THREE.Matrix4();

/**
 * Ein Material transluzent machen. Der Anteil wird ueber ein Uniform gesteuert,
 * der Shader also unabhaengig von der Staerke nur einmal uebersetzt - damit
 * wirkt der Regler sofort, ohne Neuaufbau.
 */
export function makeTranslucent(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTransLicht = uLicht;
    shader.uniforms.uTransStaerke = uStaerke;
    shader.uniforms.uTransFarbe = uFarbe;

    // Der Blickterm braucht vViewPosition. Das hat der Standard-Shader, der
    // Phong-Shader nicht - dort bleibt es beim reinen Gegenlichtanteil.
    const mitBlick = shader.fragmentShader.includes('vViewPosition');
    const blick = mitBlick
      ? 'float trEntgegen = max( 0.0, - dot( normalize( vViewPosition ), uTransLicht ) );'
      : 'float trEntgegen = 1.0;';

    shader.fragmentShader = `
      uniform vec3 uTransLicht;
      uniform float uTransStaerke;
      uniform vec3 uTransFarbe;
    ` + shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
       float trHinten = max( 0.0, - dot( normal, uTransLicht ) );
       ${blick}
       reflectedLight.indirectDiffuse += diffuseColor.rgb * uTransFarbe * uTransStaerke
         * pow( trHinten, 1.5 ) * ( 0.30 + 0.70 * trEntgegen * trEntgegen );`,
    );
  };
  // Ohne eigenen Schluessel wuerde three das uebersetzte Programm mit einem
  // gleich konfigurierten, aber nicht transluzenten Material teilen.
  material.customProgramCacheKey = () => 'transluzenz';
  return material;
}

/** 0-100 aus dem Formular. */
export function setTranslucency(prozent) {
  uStaerke.value = Math.max(0, Math.min(100, prozent || 0)) / 100;
}

/**
 * Je Bild aufzurufen: Sonnenrichtung (Weltraum) in den Sichtraum drehen.
 * Die Sichtmatrix wird hier selbst gebildet - `camera.matrixWorldInverse`
 * stellt der Renderer erst in `render()` her und waere hier noch die des
 * vorigen Bildes.
 */
export function updateTranslucency(camera, sonneWelt) {
  if (uStaerke.value <= 0) return;
  camera.updateMatrixWorld();
  _view.copy(camera.matrixWorld).invert();
  _dir.copy(sonneWelt).transformDirection(_view);
  uLicht.value.copy(_dir);
}
