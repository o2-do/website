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

    /** Kapsel entlang einer Strecke sperren (fuer Wegbaender). */
    blockSegment(ax, az, bx, bz, r, alsWeg = false) {
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / (cell * 0.8)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        if (alsWeg) this.blockWeg(ax + (bx - ax) * t, az + (bz - az) * t, r);
        else this.block(ax + (bx - ax) * t, az + (bz - az) * t, r);
      }
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
