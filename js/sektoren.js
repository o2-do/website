/**
 * Raeumliches Aufteilen beim Aufbau - der einzige Hebel gegen ueberfluessige
 * Geometrie, der je Bild nichts kostet.
 *
 * DAS PROBLEM. three sortiert je OBJEKT aus, nicht je Instanz. Ein einziges
 * InstancedMesh mit 90 000 Grashalmen ueber den ganzen Garten hat eine
 * Huellkugel von 62 m Halbmesser, und man steht mitten darin: das Sichtvolumen
 * kann es nie verwerfen. Nachgemessen lagen 40 von 41 Objekten im Sichtvolumen,
 * es wurde also praktisch nichts gespart.
 *
 * DIE LOESUNG IST NICHT, MEHR ZU PRUEFEN. Der Test selbst kostet 0,0033 ms je
 * Bild fuer alle Objekte zusammen - er ist nicht das Problem, er sagt nur nie
 * „nein". Frueher Versuche, je Instanz zu entscheiden, waren deshalb allesamt
 * langsamer: die ganze Szene einzureichen kostet 0,09 ms CPU, und jede
 * Buchfuehrung, die je Bild mehr als das kostet, ist ein Verlustgeschaeft.
 *
 * DESHALB WIRD EINMAL BEIM AUFBAU AUFGETEILT. Der Garten bekommt ein grobes
 * Quadratraster; Gras, Pflanzen, Felsen und Beetboeden entstehen je Sektor als
 * eigenes Netz. Danach greift der vorhandene, kostenlose Test von selbst -
 * ohne eine einzige Zeile, die je Bild laeuft.
 *
 * WAS ES KOSTET: mehr Zeichenaufrufe. Ein Netz je Sektor statt eines fuer
 * alles; bei 16 m Rasterweite auf 100 m Garten sind das bis zu 49 Felder, von
 * denen aber nur die belegten ein Netz bekommen. Der Regler „Sektorweite"
 * stellt den Handel ein, 0 schaltet ihn ganz ab.
 */

/**
 * Ein Raster ueber den Garten.
 *
 *   an       ob ueberhaupt aufgeteilt wird (Sektorweite > 0)
 *   n        Felder je Achse
 *   weite    tatsaechliche Kantenlaenge eines Feldes in Metern
 *   index    (x, z) -> Feldnummer
 *   teile    Liste von Dingen mit x/z -> Map Feldnummer -> Teilliste
 *   teileMatrizen  dasselbe fuer einen rohen Matrixpuffer
 */
export function createSektoren(cfg) {
  const D = cfg.durchmesser;
  const soll = +cfg.sektorWeite || 0;
  const an = soll > 0 && soll < D;
  // Ganzzahlig viele Felder ueber die Gartenbreite, damit keine Randstreifen
  // uebrigbleiben; die tatsaechliche Weite weicht deshalb etwas vom Regler ab.
  const n = an ? Math.max(1, Math.round(D / soll)) : 1;
  const weite = D / n;
  const halb = D / 2;

  const index = an
    ? (x, z) => {
      const i = Math.min(n - 1, Math.max(0, Math.floor((x + halb) / weite)));
      const j = Math.min(n - 1, Math.max(0, Math.floor((z + halb) / weite)));
      return j * n + i;
    }
    : () => 0;

  return {
    an, n, weite, felder: n * n, index,

    /**
     * Eine Liste von Dingen mit `x` und `z` nach Feldern sortieren. Zurueck
     * kommt eine Map, damit leere Felder gar nicht erst auftauchen.
     */
    teile(liste) {
      const m = new Map();
      for (const e of liste) {
        const k = index(e.x, e.z);
        let a = m.get(k);
        if (!a) { a = []; m.set(k, a); }
        a.push(e);
      }
      return m;
    },

    /**
     * Dasselbe fuer einen rohen Matrixpuffer (16 Werte je Instanz, wie ihn
     * `grass.js` fuehrt). Der Ort steckt in den Elementen 12 und 14 - so muss
     * das Gras seine Halme nicht ein zweites Mal als Objekte fuehren, nur um
     * sie einsortieren zu koennen.
     *
     * Zurueck kommt eine Map Feldnummer -> Float32Array mit den Matrizen
     * dieses Feldes, fertig fuer `InstancedMesh.instanceMatrix`.
     */
    teileMatrizen(array, count) {
      if (!an) {
        return new Map(count ? [[0, array.subarray(0, count * 16)]] : []);
      }
      // Zweimal durchlaufen: erst zaehlen, dann fuellen. Das spart das
      // Umkopieren wachsender Felder bei 90 000 Halmen.
      const anzahl = new Map();
      const feld = new Int32Array(count);
      for (let i = 0; i < count; i++) {
        const k = index(array[i * 16 + 12], array[i * 16 + 14]);
        feld[i] = k;
        anzahl.set(k, (anzahl.get(k) || 0) + 1);
      }
      const out = new Map();
      const pos = new Map();
      for (const [k, c] of anzahl) { out.set(k, new Float32Array(c * 16)); pos.set(k, 0); }
      for (let i = 0; i < count; i++) {
        const k = feld[i];
        const p = pos.get(k);
        out.get(k).set(array.subarray(i * 16, i * 16 + 16), p * 16);
        pos.set(k, p + 1);
      }
      return out;
    },
  };
}
