/**
 * Engmaschiges Belegungsraster ueber den Garten.
 *
 * Wer zuerst platziert wird, sperrt die Zellen, die er einnimmt; alle spaeteren
 * Objekte fragen vorher ab. Die Reihenfolge legt damit die Rangfolge fest:
 *   Weg -> Baumstamm -> Fels -> Grasbueschel
 *
 * Grosse Objekte sperren automatisch entsprechend viele Zellen - ein 2-m-Fels
 * belegt bei 15 cm Rasterweite rund 560 Zellen.
 *
 * Bewusst NICHT ueber das Raster laufen die Dinge, die absichtlich dicht am Weg
 * stehen (Schildpfahl 10 cm von der Kante, Randgras direkt an der Kante). Die
 * Rasterweite waere dort groesser als der geforderte Abstand; sie benutzen
 * weiterhin die exakte Abstandsabfrage des Weg-Index.
 *
 * WEGE STEHEN GETRENNT DARIN. Eine Zelle merkt sich, ob sie von einem Weg
 * gesperrt ist oder von einem Ding, und `free` kann die Wege auf Wunsch
 * uebergehen. Gebraucht wird das von den Felsen: ihr Abstand zur Wegkante darf
 * negativ sein - ein Findling, um den herum der Weg gebaut wurde -, und ohne
 * die Unterscheidung haette das Raster genau das verhindert, waehrend die
 * exakte Abfrage es schon erlaubt hatte. Fuer alles andere aendert sich nichts:
 * ohne das Kennzeichen sperrt ein Weg wie eh und je.
 *
 * DASSELBE RASTER TRAEGT AUCH DIE HINDERNISSE DES GEHERS (siehe `garden.js`).
 * Dort bedeutet die Unterscheidung etwas anderes: die Wegflaeche steht darin,
 * damit der weite Abstand, den die Kamera zu einem Gegenstand halten soll, an
 * der Wegkante endet - sonst schnuerte ein Fels, der bis an den Weg reicht,
 * den Weg zu. `belegt` uebergeht die Wegzellen deshalb.
 */
// Zellinhalt: 0 frei, 1 von einem Ding belegt, 2 von einem Weg.
const DING = 1;
const WEG = 2;

export function createOccupancy(radius, cell = 0.15) {
  const n = Math.ceil((2 * radius) / cell) + 4;
  const grid = new Uint8Array(n * n);
  const org = -radius - 2 * cell;
  const half = cell * 0.5;
  const diag = Math.SQRT1_2 * cell;      // halbe Zelldiagonale
  let blocked = 0;

  const idx = (v) => Math.floor((v - org) / cell);
  const pos = (i) => org + (i + 0.5) * cell;

  function forCircle(x, z, r, fn) {
    const i0 = Math.max(0, idx(x - r)), i1 = Math.min(n - 1, idx(x + r));
    const j0 = Math.max(0, idx(z - r)), j1 = Math.min(n - 1, idx(z + r));
    const r2 = r * r;
    for (let i = i0; i <= i1; i++) {
      const dx = pos(i) - x;
      for (let j = j0; j <= j1; j++) {
        const dz = pos(j) - z;
        if (dx * dx + dz * dz <= r2) { if (fn(i * n + j) === false) return false; }
      }
    }
    return true;
  }

  return {
    cell,
    get blockedCells() { return blocked; },
    get cells() { return n * n; },

    /** Kreisflaeche sperren - als Ding. Ein Weg darunter wird ueberschrieben. */
    block(x, z, r) {
      forCircle(x, z, r, (k) => {
        if (!grid[k]) blocked++;
        grid[k] = DING;
      });
    },

    /** Dasselbe, aber als WEG gekennzeichnet - ein Ding behaelt Vorrang. */
    blockWeg(x, z, r) {
      forCircle(x, z, r, (k) => { if (!grid[k]) { grid[k] = WEG; blocked++; } });
    },

    /**
     * Sperren, ABER NUR WO NOCH NICHTS STEHT - ein Weg bleibt ein Weg.
     *
     * Damit laesst sich ein Ding zweimal eintragen: eng mit seinem koerperlichen
     * Halbmesser (`block`, der ueberschreibt auch den Weg), und weit mit dem
     * Abstand, den die Kamera braucht (hier). Der weite Ring endet dann an der
     * Wegkante, statt einen Weg zuzuschnueren, an dem ein Fels steht.
     */
    blockSanft(x, z, r) {
      forCircle(x, z, r, (k) => { if (!grid[k]) { grid[k] = DING; blocked++; } });
    },

    /** Kapsel entlang einer Strecke sperren (fuer Wegbaender). */
    blockSegment(ax, az, bx, bz, r, wie = 'ding') {
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / (cell * 0.8)));
      const setze = wie === true || wie === 'weg' ? this.blockWeg
        : wie === 'sanft' ? this.blockSanft : this.block;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        setze.call(this, ax + (bx - ax) * t, az + (bz - az) * t, r);
      }
    },

    /**
     * EIN Feldzugriff: steht an dieser Stelle etwas?
     *
     * Ohne Halbmesser und ohne Zuschlag - wer das benutzt, hat die Ausdehnung
     * seines Gegenstands schon beim Eintragen aufgeschlagen. Genau dafuer ist
     * das Hindernisraster gedacht, das der Geher sechzigmal je Sekunde fragt.
     */
    belegt(x, z) {
      const i = idx(x), j = idx(z);
      if (i < 0 || j < 0 || i >= n || j >= n) return false;
      // NUR DINGE SPERREN. Eine Wegzelle steht im Raster, damit der weite
      // Kameraabstand an ihr haltmacht (siehe `blockSanft`) - laufen darf man
      // auf ihr selbstverstaendlich.
      return grid[i * n + j] === DING;
    },

    /**
     * true, wenn im Umkreis r keine gesperrte Zelle liegt.
     * Der Zuschlag einer halben Zelldiagonale macht die Abfrage konservativ:
     * lieber einmal zu viel ablehnen als Objekte ineinander stellen.
     *
     * `ohneWege` uebergeht die Zellen, die nur ein Weg belegt - wer das setzt,
     * hat eine eigene, genauere Abfrage gegen die Wegflaeche.
     */
    free(x, z, r, ohneWege = false) {
      const sperrt = ohneWege ? (v) => v === DING : (v) => v !== 0;
      return forCircle(x, z, r + diag, (k) => (sperrt(grid[k]) ? false : undefined));
    },
  };
}
