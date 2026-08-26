import * as THREE from 'three';
import { stream, rand } from './rng.js';

/**
 * Wegfuehrung ueber Attraktoren (siehe garten_pfad.html):
 *
 *   1. Raster aus N x N Attraktoren, jeder leicht verwackelt.
 *   2. An jeder Ecke ein Dreieck von Attraktoren entfernen (1/3/6/10 Stueck)
 *      - das rundet den Grundriss ab, statt ihn quadratisch zu lassen.
 *   3. Mischen und nur den eingestellten Prozentsatz behalten. Erst die
 *      Zufallsauswahl macht die Schlaufe unregelmaessig.
 *   4. Nearest-Neighbor-Rundreise durch die verbliebenen Punkte,
 *      danach 2-opt, bis nichts mehr besser wird. 2-opt entfernt genau die
 *      Selbstueberschneidungen - der Rundweg schlingt sich, kreuzt sich aber
 *      nicht selbst.
 *   5. Ecken verrunden (Kreisbogen mit Glaettungsradius) und die Kontur
 *      gleichmaessig abtasten.
 *   6. Abkuerzungen: Stellen, die raeumlich nah, auf dem Rundweg aber weit
 *      voneinander entfernt liegen, werden mit einem geraden Stichweg
 *      verbunden. Erst dadurch entstehen Wegkreuzungen.
 *
 * Ergebnis je Weg:
 *   { index, closed, samples: [{x, z, y, tx, tz, nx, nz, s}], total, width }
 */

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Rangfolge der Wege. DER HAUPTWEG GEWINNT: wo zwei Flaechen denselben Boden
 * decken, gilt seine Hoehe, und die anderen haben sich daran anzuschliessen
 * (siehe `wegnetz.js`). Der Zugang zum Tor steht dazwischen - er ist ein
 * angelegter Weg, aber der Rundweg bleibt die Hauptsache.
 */
export const WEG_RANG = { rund: 2, tor: 1, abk: 0 };

/* ---------------- 1-3. Attraktoren ---------------- */

/**
 * Rasterpunkte, Ecken abgeschnitten, zufaellig ausgeduennt.
 * `eckAbzug` ist die Anzahl je Ecke (1, 3, 6, 10) = Dreieckszahl der
 * Dreiecksseite t, also t = 1..4.
 */
function createAttractors(cfg, R) {
  const rng = stream(cfg._seed, 'paths');
  const N = Math.max(2, Math.round(cfg.attraktoren));
  const D = 2 * R;
  const margin = (cfg.wegRand / 100) * D;
  const spacing = (D - 2 * margin) / (N - 1);

  // t aus der Dreieckszahl zurueckrechnen; nie mehr als die halbe Rasterbreite,
  // sonst loeschen sich die vier Eckdreiecke gegenseitig weg.
  const t = Math.min(
    Math.floor(N / 2),
    Math.round((Math.sqrt(8 * Math.max(0, cfg.attraktorenEcken) + 1) - 1) / 2),
  );

  const jitter = spacing * 0.15;
  const all = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const i2 = N - 1 - i, j2 = N - 1 - j;
      if (i + j < t || i2 + j < t || i + j2 < t || i2 + j2 < t) continue;
      all.push({
        x: -D / 2 + margin + i * spacing + rand(rng, -jitter, jitter),
        z: -D / 2 + margin + j * spacing + rand(rng, -jitter, jitter),
      });
    }
  }

  // Fisher-Yates, danach den Anfang behalten
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const keep = Math.max(4, Math.floor((all.length * cfg.attraktorenAnteil) / 100));
  return all.slice(0, Math.min(all.length, keep));
}

/* ---------------- 4. Rundreise ---------------- */

function nearestNeighbour(pts, rng) {
  const n = pts.length;
  const unvisited = Array.from({ length: n }, (_, i) => i);
  let cur = unvisited.splice(Math.floor(rng() * n), 1)[0];
  const order = [cur];

  while (unvisited.length) {
    let best = Infinity, at = 0;
    for (let i = 0; i < unvisited.length; i++) {
      const d = dist(pts[cur], pts[unvisited[i]]);
      if (d < best) { best = d; at = i; }
    }
    cur = unvisited.splice(at, 1)[0];
    order.push(cur);
  }
  return order;
}

/**
 * 2-opt ueber die Kantendifferenz statt ueber die Gesamtlaenge: eine Vertauschung
 * aendert nur zwei Kanten. Die Vorlage rechnete je Kandidat die komplette
 * Rundreise neu und begann nach jeder Verbesserung von vorn - bei bis zu 400
 * Attraktoren waeren das Milliarden Wurzeln. So sind es wenige Durchlaeufe zu
 * je n²/2 Vergleichen.
 */
function twoOpt(order, pts) {
  const n = order.length;
  if (n < 5) return order;
  const d = (a, b) => dist(pts[a], pts[b]);

  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    for (let i = 0; i < n - 2; i++) {
      for (let k = i + 2; k < n; k++) {
        if (i === 0 && k === n - 1) continue;      // schliessende Kante
        const a = order[i], b = order[i + 1];
        const c = order[k], e = order[(k + 1) % n];
        if (d(a, c) + d(b, e) < d(a, b) + d(c, e) - 1e-9) {
          for (let lo = i + 1, hi = k; lo < hi; lo++, hi--) {
            const tmp = order[lo]; order[lo] = order[hi]; order[hi] = tmp;
          }
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

/* ---------------- 5. Verrundung und Abtastung ---------------- */

/**
 * Der Mindestkurvenradius, als Vielfaches der halben Wegbreite.
 *
 * Unterhalb der EINFACHEN halben Breite faltet sich das Band ueber sich
 * selbst: der innere Bandrand laeuft dann am Kruemmungsmittelpunkt vorbei auf
 * die andere Seite. Die Planie fragt fuer so einen Randpunkt die naechste
 * Mittellinie, findet aber die des gegenueberliegenden Kurvenastes - und
 * uebernimmt deren Hoehe, die einen halben Bogen weiter entfernt liegt. Das
 * ist die Sorte Naht, die keine Anschlusslogik heilen kann, weil schon die
 * Geometrie entartet ist.
 *
 * Das Doppelte laesst dem inneren Rand noch eine halbe Breite Luft bis zum
 * Mittelpunkt und ist auch gaertnerisch die untere Grenze: enger geht man
 * einen Weg nicht, man tritt die Kurve ab.
 */
const MIN_RADIUS_FAKTOR = 2.0;

/**
 * Ecken, die fuer den Mindestradius zu spitz sind, ganz entfernen.
 *
 * Den Radius einfach hochzusetzen geht nicht: die Tangentenlaenge waechst mit
 * `r / tan(halber Innenwinkel)`, und passt sie nicht mehr in die anliegenden
 * Strecken, greift die Verrundung in die Nachbarecke hinueber. Wo der Platz
 * fehlt, ist die Ecke selbst das Problem - sie faellt weg, und der Weg laeuft
 * dort eben durch. Je Durchlauf nur die schlimmste, danach neu gerechnet: das
 * Entfernen aendert die Winkel der Nachbarn.
 */
function entschaerfeEcken(pts, rMin) {
  const list = pts.slice();
  for (let pass = 0; pass < 40 && list.length > 4; pass++) {
    let schlimmste = -1, fehl = 0;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const prev = list[(i - 1 + n) % n], cur = list[i], next = list[(i + 1) % n];
      const d1 = dist(prev, cur), d2 = dist(cur, next);
      if (d1 < 1e-6 || d2 < 1e-6) continue;
      const v1x = (prev.x - cur.x) / d1, v1z = (prev.z - cur.z) / d1;
      const v2x = (next.x - cur.x) / d2, v2z = (next.z - cur.z) / d2;
      const cos = Math.max(-1, Math.min(1, v1x * v2x + v1z * v2z));
      const half = Math.acos(cos) / 2;
      const tanH = Math.tan(half);
      if (tanH < 1e-4) { schlimmste = i; fehl = Infinity; break; }   // Kehrtwende
      const braucht = rMin / tanH;              // noetige Tangentenlaenge
      const platz = Math.min(d1, d2) / 2;
      if (braucht - platz > fehl) { fehl = braucht - platz; schlimmste = i; }
    }
    if (schlimmste < 0) break;
    list.splice(schlimmste, 1);
  }
  return list;
}

/**
 * Polygonzug mit verrundeten Ecken. Der Radius je Ecke ist der kleinere von
 * Glaettungsradius und dem, was die beiden anliegenden Strecken hergeben
 * (Tangentenlaenge hoechstens halbe Streckenlaenge) - dieselbe Regel wie
 * `ctx.arcTo`, nur als Punktliste statt als Canvas-Pfad.
 */
function roundCorners(pts, maxRadius, step) {
  const n = pts.length;
  const out = [];

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const d1 = dist(prev, cur), d2 = dist(cur, next);
    if (d1 < 1e-6 || d2 < 1e-6) { out.push({ x: cur.x, z: cur.z }); continue; }

    const v1x = (prev.x - cur.x) / d1, v1z = (prev.z - cur.z) / d1;
    const v2x = (next.x - cur.x) / d2, v2z = (next.z - cur.z) / d2;
    const cos = Math.max(-1, Math.min(1, v1x * v2x + v1z * v2z));
    const half = Math.acos(cos) / 2;                 // halber Innenwinkel

    const sinH = Math.sin(half), tanH = Math.tan(half);
    // sinH ~ 0: Kehrtwende (kein Bogen moeglich), cos ~ -1: gerade Strecke
    if (sinH < 1e-4 || cos < -1 + 1e-6) { out.push({ x: cur.x, z: cur.z }); continue; }

    const r = Math.min(maxRadius, (Math.min(d1, d2) / 2) * tanH);
    if (!Number.isFinite(r) || r < 0.01) { out.push({ x: cur.x, z: cur.z }); continue; }

    const L = r / tanH;                              // Tangentenabstand von der Ecke
    const bl = Math.hypot(v1x + v2x, v1z + v2z);
    const cx = cur.x + ((v1x + v2x) / bl) * (r / sinH);
    const cz = cur.z + ((v1z + v2z) / bl) * (r / sinH);

    const a1 = Math.atan2(cur.z + v1z * L - cz, cur.x + v1x * L - cx);
    const a2 = Math.atan2(cur.z + v2z * L - cz, cur.x + v2x * L - cx);
    let da = a2 - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;

    const segs = Math.max(1, Math.ceil((Math.abs(da) * r) / step));
    for (let k = 0; k <= segs; k++) {
      const a = a1 + (da * k) / segs;
      out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
    }
  }
  return out;
}

/** Polygonzug gleichmaessig abtasten. Geschlossen: der Ringschluss zaehlt mit. */
function resample(poly, step, closed) {
  const n = poly.length;
  const seg = [];
  let total = 0;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const l = dist(poly[i], poly[(i + 1) % n]);
    seg.push(l);
    total += l;
  }
  if (total < 1e-6) return { pts: [poly[0]], total: 0 };

  const m = Math.max(closed ? 8 : 2, Math.round(total / step));
  const ds = closed ? total / m : total / (m - 1);
  const pts = [];
  let i = 0, acc = 0;
  for (let k = 0; k < m; k++) {
    const target = k * ds;
    while (i < seg.length - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const f = seg[i] > 1e-9 ? Math.min(1, (target - acc) / seg[i]) : 0;
    const a = poly[i], b = poly[(i + 1) % n];
    pts.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
  }
  return { pts, total };
}

/** Aus abgetasteten Punkten die Wegdatenstruktur bauen (Tangente, Normale, s). */
function makePath(pts, total, closed, index, cfg, hf, liftIndex, art) {
  const m = pts.length;
  const samples = [];
  let s = 0;
  for (let k = 0; k < m; k++) {
    const p = pts[k];
    const a = closed ? pts[(k - 1 + m) % m] : pts[Math.max(0, k - 1)];
    const b = closed ? pts[(k + 1) % m] : pts[Math.min(m - 1, k + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    if (k > 0) s += dist(p, pts[k - 1]);
    // `roll` ist die Querneigung: Hoehenzuwachs je Meter seitlichem Versatz in
    // Richtung +n. Sie ist ueberall null, seit die Hoehe eines Wegpunktes nicht
    // mehr gerechnet, sondern von einem Referenzpunkt geerbt wird
    // (`wegnetz.js`). Das Feld steht noch, weil der Wegindex es liest.
    samples.push({ x: p.x, z: p.z, y: hf.heightAt(p.x, p.z), tx, tz, nx: -tz, nz: tx, s, roll: 0, glon: 0 });
  }
  // Abkuerzungen haben ihren eigenen Belag, ihre eigene Kachelung und ihre
  // eigene Breite. Ab hier fragt niemand mehr `cfg` nach der Wegbreite,
  // sondern den Weg selbst - `path.width` ist die einzige Wahrheit dazu.
  //
  // Beim Rundweg wird die eingestellte Kachelgroesse leicht nachgezogen, damit
  // eine ganze Zahl von Kacheln auf den Umfang geht: sonst trifft an der Naht
  // ein angeschnittenes Pflaster auf ein volles. Der Unterschied zur Vorgabe
  // liegt bei einem Weg von einigen hundert Metern unter einem Prozent.
  // Der Torweg ist zwar offen wie eine Abkuerzung, aber kein Trampelpfad: er
  // ist der angelegte Zugang und traegt deshalb Belag, Kachelung und Breite
  // des Rundwegs.
  const wieRundweg = closed || art === 'tor';
  let kachel = wieRundweg ? cfg.kachelWeg : cfg.kachelAbk;
  if (closed) kachel = total / Math.max(1, Math.round(total / kachel));

  return {
    index, closed, samples, total, liftIndex, kachel, art: art || (closed ? 'rund' : 'abk'),
    width: wieRundweg ? cfg.wegBreite : cfg.wegBreiteAbk,
    // WIE DIE TEXTUR QUER ZUM WEG SITZT.
    //
    // Der Rundweg traegt eine Kachel - Pflaster hat eine eigene Groesse, und
    // die soll in beiden Richtungen dieselbe sein. Die Abkuerzung traegt ein
    // BAND: ein Bild, das den Trampelpfad einmal in ganzer Breite zeigt, mit
    // ausgetretener Mitte und Gras an den Kanten. Bei ihr gehoert der linke
    // Bildrand an die linke Wegkante und der rechte an die rechte, sonst laeuft
    // die Naht mitten ueber den Pfad.
    bandQuer: !wieRundweg,
  };
}

/* ---------------- 6. Abkuerzungen ---------------- */

// Laengste zugelassene Abkuerzung, als Anteil des Gartendurchmessers. Ein
// Trampelpfad quer durch den halben Garten ist keine Abkuerzung mehr, sondern
// ein zweiter Hauptweg.
const ABK_MAX_LAENGE = 0.25;
// Mindestabstand zwischen zwei Einmuendungen, ebenso als Anteil. BEWUSST NICHT
// mehr an die Maximallaenge gekoppelt: solange beides zusammenhing, sperrte
// eine grosszuegigere Laengengrenze zugleich mehr Kandidaten weg, und die
// Ausbeute SANK, je mehr man zuliess.
const ABK_SPERRE = 0.08;
// Wie viel Wegstrecke eine Abkuerzung mindestens sparen muss, je Meter
// Trampelpfad.
const ABK_MIN_GEWINN = 2.5;

/**
 * Wo lohnt sich ein Trampelpfad?
 *
 * Bewertet wird, was eine Abkuerzung taugt: `gewinn` ist die Wegstrecke, die
 * man sich spart, je Meter Stichweg. Dann greedy in der Reihenfolge des
 * Gewinns, wobei jede angenommene Abkuerzung ihre Umgebung sperrt. So bleiben
 * die wenigen wirklich lohnenden Verbindungen uebrig, gleichmaessig verteilt.
 *
 * GESUCHT WIRD AUF DER ABGETASTETEN MITTELLINIE, nicht auf den Attraktoren.
 * Das war der Grund, warum der Garten meistens gar keine Abkuerzung bekam,
 * obwohl reichlich moeglich gewesen waeren: die Attraktoren stehen ein Raster
 * weit auseinander - bei den Vorgabewerten 9,6 m -, und genau so gross war die
 * zugelassene Hoechstlaenge. Es blieben also fast nur Paare uebrig, die beides
 * zugleich erfuellen mussten, und das taten sie kaum je. Gemessen ueber 20
 * Startwerte: 17 Gaerten ohne eine einzige Abkuerzung, bei eingestellten vier.
 * Auf der Mittellinie liegt alle 50 cm ein Punkt, und die Suche findet, was
 * wirklich da ist.
 *
 * Abgetastet wird nur jeder zweite Meter - feiner braucht es nicht zu sein,
 * denn zwei Kandidaten einen halben Meter nebeneinander sind dieselbe
 * Abkuerzung, und die Sperrung wuerfe den zweiten ohnehin weg.
 */
function planShortcuts(loop, cfg) {
  const want = Math.round(cfg.maxAbkuerzungen);
  if (want <= 0) return [];

  const sm = loop.samples;
  const n = sm.length;
  const T = loop.total;
  const maxDist = cfg.durchmesser * ABK_MAX_LAENGE;
  const minLen = 3 * cfg.wegBreiteAbk;      // kuerzer lohnt sich kein eigener Weg
  const stride = Math.max(1, Math.round(1 / cfg.wegSample));

  const cand = [];
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      const a = sm[i], b = sm[j];
      const d = dist(a, b);
      if (d > maxDist || d < minLen) continue;
      // Laengs des Rundwegs herum - in beide Richtungen, die kuerzere zaehlt.
      let laengs = Math.abs(b.s - a.s);
      if (laengs > T - laengs) laengs = T - laengs;
      const gewinn = laengs / d;
      if (gewinn < ABK_MIN_GEWINN) continue;
      cand.push({ a, b, d, gewinn });
    }
  }
  cand.sort((p, q) => q.gewinn - p.gewinn);

  const sperre = cfg.durchmesser * ABK_SPERRE;
  const out = [];
  for (const c of cand) {
    if (out.length >= want) break;
    const kollidiert = out.some((o) => {
      for (const p of [c.a, c.b]) {
        for (const q of [o.a, o.b]) if (dist(p, q) < sperre) return true;
      }
      return false;
    });
    if (!kollidiert) out.push(c);
  }
  return out;
}

/** Abstand zur FLAECHE eines Weges; negativ heisst drauf. */
export function flaechenAbstand(p, x, z) {
  const sm = p.samples;
  const segs = p.closed ? sm.length : sm.length - 1;
  let best = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = sm[i], b = sm[(i + 1) % sm.length];
    const vx = b.x - a.x, vz = b.z - a.z;
    const wx = x - a.x, wz = z - a.z;
    const len2 = vx * vx + vz * vz;
    let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * vx, dz = wz - t * vz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best) - p.width / 2;
}


/* ---------------- Aufbau ---------------- */

export function buildPaths(hf, cfg) {
  const R = hf.radius;
  const rng = stream(cfg._seed, 'paths-tour');
  const attractors = createAttractors(cfg, R);
  if (attractors.length < 3) return [];

  const order = twoOpt(nearestNeighbour(attractors, rng), attractors);
  const corners = order.map((i) => attractors[i]);

  const step = cfg.wegSample;
  // Zu spitze Ecken zuerst entfernen, dann verrunden. Der Glaettungsradius darf
  // dabei nicht unter den Mindestradius rutschen - er ist eine Gestaltungs-
  // groesse, der Mindestradius eine geometrische Bedingung, und die gewinnt.
  const rMin = (cfg.wegBreite / 2) * MIN_RADIUS_FAKTOR;
  const ecken = entschaerfeEcken(corners, rMin);
  const rounded = roundCorners(ecken, Math.max(cfg.wegGlaettung, rMin), step * 0.5);
  const loop = resample(rounded, step, true);
  const paths = [makePath(loop.pts, loop.total, true, 0, cfg, hf, 0)];

  const cuts = planShortcuts(paths[0], cfg);
  const loopWeg = paths[0];
  for (const c of cuts) {
    // BIS ZUR MITTELLINIE, NICHT BIS ZUR KANTE.
    //
    // Frueher wurde der Stichweg auf die Kante des Rundwegs gekuerzt und dort
    // schraeg angeschnitten - mit gesuchtem Endpunkt, gesuchtem Anschnitt und
    // drei Zentimetern Ueberstand, damit an der Naht keine Fuge aufgeht. Das
    // war der Preis dafuer, dass beide Baender getrennt gerechnet wurden.
    //
    // Jetzt laeuft er absichtlich bis in die Mitte hinein. Wo seine Kanten die
    // des Rundwegs kreuzen, entstehen GEMEINSAME Punkte (wegnetz.js), und was
    // dahinter liegt, faellt beim Verschneiden weg. Eine Fuge kann es nicht
    // geben, weil es keine zwei Kanten mehr gibt, die sich treffen muessten.
    const von = { x: c.a.x, z: c.a.z };
    const bis = { x: c.b.x, z: c.b.z };
    const laenge = Math.hypot(bis.x - von.x, bis.z - von.z);
    if (laenge < 3 * cfg.wegBreiteAbk) continue;
    const line = resample([von, bis], step, false);

    // EINE ABKUERZUNG DARF DEN RUNDWEG UNTERWEGS NICHT NOCHMAL UEBERQUEREN.
    //
    // Die Sehne zwischen zwei Punkten einer maeandernden Schlaufe kann einen
    // dritten Ast schneiden. Was dann entsteht, ist keine Abkuerzung, sondern
    // ein Trampelpfad, der ueber den Weg laeuft und ein Stueck weiter neben ihm
    // wieder endet. Die beiden Enden sind ausgenommen - dort SOLL er drueber
    // liegen; wie weit, sagt die halbe Rundwegbreite plus ein Sample.
    const rand = Math.ceil((loopWeg.width / 2) / step) + 1;
    let quert = false;
    for (let k = rand; k < line.pts.length - rand && !quert; k++) {
      quert = flaechenAbstand(loopWeg, line.pts[k].x, line.pts[k].z) < -0.05;
    }
    if (quert) continue;

    paths.push(makePath(line.pts, line.total, false, paths.length, cfg, hf, 1));
  }
  return paths;
}

/**
 * Ein Punkt auf der Bandkante: die Stuetzstelle plus halbe Breite quer.
 *
 * Hier stand einmal der SCHRAEGANSCHNITT - eine Verschiebung laengs der
 * eigenen Tangente, mit der die Stirnkante eines Stichwegs auf der Kante des
 * Rundwegs zu liegen kam. Sie ist entfallen, weil es nichts mehr anzupassen
 * gibt: der Stichweg laeuft jetzt bis in die Mitte des Rundwegs hinein, und wo
 * die Kanten sich kreuzen, wird geschnitten statt gepasst.
 */
export function bandPunkt(path, k, sgn, half, lift) {
  const p = path.samples[k];
  return {
    x: p.x + p.nx * half * sgn,
    z: p.z + p.nz * half * sgn,
    y: p.y + lift + p.roll * half * sgn,
  };
}

export const pathLift = (cfg, path) => cfg.wegHoehe + 0.004 * (1 + (path.liftIndex || 0));

/** Punkt und Querrichtung an einer Bogenlaenge. */
export function atArcLength(path, s) {
  const sm = path.samples;
  const m = sm.length;
  let t;
  if (path.closed) {
    t = s % path.total;
    if (t < 0) t += path.total;
  } else {
    t = Math.min(path.total, Math.max(0, s));
  }

  let i = Math.min(m - 1, Math.max(0, Math.floor((t / path.total) * m)));
  while (i > 0 && sm[i].s > t) i--;
  while (i < m - 1 && sm[i + 1].s <= t) i++;

  const a = sm[i];
  const b = sm[path.closed ? (i + 1) % m : Math.min(m - 1, i + 1)];
  const segEnd = i === m - 1 ? path.total : b.s;
  const f = (t - a.s) / Math.max(1e-6, segEnd - a.s);
  let nx = a.nx + (b.nx - a.nx) * f;
  let nz = a.nz + (b.nz - a.nz) * f;
  const l = Math.hypot(nx, nz) || 1;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, nx: nx / l, nz: nz / l };
}

/* ---------------- Raeumlicher Index ---------------- */

/**
 * Uniform Grid ueber alle Mittellinienpunkte aller Wege.
 *
 * surfaceDistance(x,z) ist der Abstand zur Wegflaeche selbst (negativ = auf dem
 * Weg). Das ist die Abfrage, die Felsen, Staemme, Schilder und Gras brauchen.
 */
export function makePathIndex(paths, cfg, cell = 1.5) {
  // Registriert wird das Segment sample[i] -> sample[i+1], nicht der Punkt.
  // Der Abstand wird dann als Punkt-Strecken-Abstand berechnet und ist damit
  // exakt - kein Sicherheitszuschlag noetig, der sonst genau die Zone am
  // Wegrand auffressen wuerde (dort steht der Pfahl und dort ist das Gras
  // am dichtesten).
  // Je Zelle eine flache Zahlenliste [pfad, ax, az, bx, bz, …]. Ohne die
  // Objekt-Lookups kostet eine Abfrage rund ein Zehntel - bei ueber 100 000
  // Halmen ist das der Unterschied zwischen 1,6 s und 0,2 s Aufbauzeit.
  const map = new Map();
  const key = (i, j) => i * 100000 + j;
  // [pfad, ax, az, bx, bz, ay, by, halbe, aRoll, bRoll] - ay/by sind die Hoehen
  // der Mittellinie, aus denen die Wegquerschnittshoehe interpoliert wird.
  //
  // Die halbe Breite steht je SEGMENT darin und nicht mehr einmal fuer alle:
  // seit die Abkuerzungen schmaler sein duerfen als der Rundweg, gibt es keine
  // Wegbreite mehr, sondern nur noch die Breite dieses Weges.
  //
  // Die Querneigung steht ebenfalls je Segment darin - heute ueberall null,
  // seit die Hoehen aus dem Netz kommen (`wegnetz.js`) und nicht mehr aus
  // dieser Tabelle.
  const STRIDE = 12;
  // Die vorkommenden halben Breiten, entdoppelt. In der Praxis sind das zwei
  // (Rundweg und Abkuerzung), hoechstens drei - und genau darauf beruht der
  // Trick in `nearestSurface`: den Abstand zur FLAECHE zu minimieren braucht
  // eine Wurzel, aber nur eine je Breitenklasse und Abfrage statt einer je
  // Segment.
  const halben = [];
  for (const p of paths) {
    const h = p.width / 2;
    if (!halben.includes(h)) halben.push(h);
  }
  const klasse = new Map(halben.map((h, i) => [h, i]));
  const KLASSEN = halben.length;

  let maxHalb = 0;
  for (const p of paths) {
    const sm = p.samples;
    const segs = p.closed ? sm.length : sm.length - 1;
    const halb = p.width / 2;
    if (halb > maxHalb) maxHalb = halb;
    for (let i = 0; i < segs; i++) {
      const a = sm[i], b = sm[(i + 1) % sm.length];
      const k = key(Math.floor(a.x / cell), Math.floor(a.z / cell));
      let arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      // Letzter Wert: der Sehnenversatz (siehe `nearestSurface`). Er sagt, wie
      // weit sich der Fusspunkt eines seitlich versetzten Punktes laengs der
      // Sehne verschiebt - Sinus des halben Wendewinkels, durch die
      // Segmentlaenge.
      const sl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const sigma = (a.nx * (b.x - a.x) + a.nz * (b.z - a.z)) / (sl * sl);
      arr.push(p.index, a.x, a.z, b.x, b.z, a.y, b.y, halb, a.roll, b.roll,
               (WEG_RANG[p.art] ?? 0) * 8 + klasse.get(halb), sigma);
    }
  }
  // Ein Segment ist wegSample lang; liegt es naeher als maxDist an der Abfrage,
  // liegt sein Anfangspunkt hoechstens maxDist + wegSample entfernt.
  const reachFor = (maxDist) =>
    Math.min(4, Math.max(1, Math.ceil((maxDist + cfg.wegSample) / cell)));
  const MAX_REACH = reachFor(6);

  // Ergebnis der letzten Abfrage. `lastHalb` ist die halbe Breite GENAU DIESES
  // Weges - die Breite eines anderen wuerde die Kante an die falsche Stelle
  // legen.
  //
  // Die Hoehe wird NICHT hier ausgerechnet, sondern nur ihre Zutaten gemerkt.
  // `distanceTo` laeuft weit ueber hunderttausend Mal je Aufbau, und die
  // allermeisten Aufrufer (Gras, Felsen, Staemme, Schilder) wollen ausser dem
  // Abstand gar nichts wissen. Die Wurzel fuer den seitlichen Versatz faellt
  // deshalb erst in `nearestSurface` an - dem einzigen Aufrufer, der die Hoehe
  // wirklich braucht.
  let lastHalb = maxHalb;
  // Zwei Sieger. `nah*` ist die naechstliegende Mittellinie ueberhaupt - das
  // war schon immer so und bleibt die Grundlage fuer Abstandsfragen. `auf*`
  // ist der RANGHOECHSTE Weg, auf dessen Flaeche der Punkt tatsaechlich liegt.
  //
  // Beide auseinanderzuhalten ist noetig, seit die Wege verschiedene Breiten
  // haben. Am Rand des zwei Meter breiten Rundwegs ist dessen eigene
  // Mittellinie einen Meter entfernt; eine Abkuerzung, die einen halben Meter
  // daneben vorbeilaeuft, hat ihre Mittellinie naeher dran und gewinnt die
  // Abstandsfrage - obwohl der Punkt gar nicht auf ihr liegt. Die Planie nahm
  // dann deren Hoehe, und weil eine Abkuerzung kurz nach ihrer Einmuendung
  // gerade dabei ist, sich vom Rundweg wegzuneigen, klaffte am Bandrand des
  // Rundwegs bis zu einem Drittel Meter.
  let nahArr = null, nahN = 0, nahT = 0;
  // Je Breitenklasse der naechste Treffer. Aus diesen wenigen Kandidaten sucht
  // `nearestSurface` dann mit ein paar Wurzeln den flaechennaechsten heraus.
  const kD2 = new Float64Array(KLASSEN);
  const kArr = new Array(KLASSEN);
  const kN = new Int32Array(KLASSEN);
  const kT = new Float64Array(KLASSEN);
  const kRang = new Int32Array(KLASSEN);

  function distanceTo(x, z, except = -1, maxDist = Infinity, nachKlasse = false) {
    if (nachKlasse) { for (let i = 0; i < KLASSEN; i++) { kD2[i] = Infinity; kArr[i] = null; } }
    if (map.size === 0) return Infinity;
    const REACH = maxDist === Infinity ? MAX_REACH : reachFor(maxDist);
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    let best = Infinity;
    for (let di = -REACH; di <= REACH; di++) {
      for (let dj = -REACH; dj <= REACH; dj++) {
        const arr = map.get(key(ci + di, cj + dj));
        if (!arr) continue;
        for (let n = 0; n < arr.length; n += STRIDE) {
          if (arr[n] === except) continue;
          const ax = arr[n + 1], az = arr[n + 2];
          const vx = arr[n + 3] - ax, vz = arr[n + 4] - az;
          const wx = x - ax, wz = z - az;
          const len2 = vx * vx + vz * vz;
          let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = wx - t * vx, dz = wz - t * vz;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) {
            best = d2;
            lastHalb = arr[n + 7];
            nahArr = arr; nahN = n; nahT = t;
          }
          // Je Breitenklasse mitschreiben - ohne Wurzel, der Vergleich laeuft
          // ueber d². Nur wenn die Hoehe wirklich gebraucht wird; fuer die weit
          // ueber hunderttausend reinen Abstandsfragen von Gras und Felsen
          // waere es verschenkte Arbeit.
          if (nachKlasse) {
            const kk = arr[n + 10] & 7;
            if (d2 < kD2[kk]) {
              kD2[kk] = d2; kArr[kk] = arr; kN[kk] = n; kT[kk] = t;
              kRang[kk] = arr[n + 10] >> 3;
            }
          }
        }
      }
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  }

  return {
    cell,
    distanceTo,
    /**
     * Abstand zur befestigten Flaeche selbst (negativ = auf dem Weg).
     * `except` blendet einen Weg aus - fuer Objekte, die bewusst dicht an
     * ihrem eigenen Weg stehen und nur gegen die uebrigen geprueft werden.
     */
    surfaceDistance(x, z, except = -1) {
      const d = distanceTo(x, z, except);
      return d === Infinity ? Infinity : d - lastHalb;
    },

    /**
     * Abstand zur befestigten Flaeche UND deren Hoehe an dieser Stelle.
     * Grundlage der Wegfindung und der Objektabstaende.
     *
     * Die Hoehe ist die der WEGFLAECHE am Abfragepunkt, nicht die der
     * Mittellinie: Mittellinienhoehe plus Querneigung mal seitlichem Versatz.
     * Solange die Neigung null ist, kommt wie frueher die Mittellinienhoehe
     * heraus.
     *
     * Der Versatz wird auf die halbe Breite BEGRENZT. Ausserhalb des Weges
     * soll nicht weiter extrapoliert werden - dort setzt die Boeschung an, und
     * die hat an der KANTE des Weges zu beginnen. Ohne den Deckel liefe die
     * geneigte Ebene ueber die ganze Wiese weiter.
     */
    nearestSurface(x, z) {
      const d = distanceTo(x, z, -1, Infinity, true);
      if (d === Infinity) return { sd: Infinity, h: 0 };

      // GESUCHT IST DIE NAECHSTE FLAECHE, NICHT DIE NAECHSTE MITTELLINIE.
      //
      // Seit die Abkuerzungen schmaler sein duerfen als der Rundweg, ist das
      // nicht mehr dasselbe. Ein Punkt am Rand des zwei Meter breiten Rundwegs
      // liegt einen Meter von dessen Mittellinie entfernt - eine Abkuerzung,
      // die 31 cm daneben vorbeilaeuft, hat ihre Mittellinie mit 81 cm naeher
      // dran und gewann die Abfrage, obwohl der Punkt genau auf dem Rundweg
      // liegt und gar nicht auf ihr. Die Planie legte dort die Hoehe der
      // Abkuerzung an, und weil die kurz nach ihrer Einmuendung gerade dabei
      // ist, sich wegzuneigen, klaffte am Rand des Rundwegs bis zu 22 cm.
      //
      // Bei Gleichstand entscheidet der Rang: der Hauptweg gewinnt. Das greift
      // genau an der Kante, wo `sd` beider Wege null ist und sonst das
      // Rundungsverhalten der Gleitkommazahlen entschiede.
      let sd = Infinity, w = -1, wRang = -1;
      for (let i = 0; i < KLASSEN; i++) {
        if (kArr[i] === null) continue;
        const e = Math.sqrt(kD2[i]) - kArr[i][kN[i] + 7];
        if (e < sd - 1e-6 || (e < sd + 1e-6 && kRang[i] > wRang)) {
          sd = Math.min(sd, e); w = i; wRang = kRang[i];
        }
      }
      if (w < 0) return { sd: d - lastHalb, h: 0 };
      const arr = kArr[w], n = kN[w], t = kT[w];
      const halb = arr[n + 7];

      // Vorzeichenbehafteter Seitenversatz: Kreuzprodukt Segment x
      // Abfragevektor, durch die Segmentlaenge. Positiv auf der +n-Seite -
      // dieselbe Seite, die `bandPunkt` mit sgn = +1 meint. Auf die halbe
      // Breite begrenzt: ausserhalb des Weges setzt die Boeschung an, und die
      // hat an der KANTE zu beginnen, nicht auf einer bis in die Wiese
      // verlaengerten schiefen Ebene.
      const ax = arr[n + 1], az = arr[n + 2];
      const vx = arr[n + 3] - ax, vz = arr[n + 4] - az;
      const laenge = Math.hypot(vx, vz) || 1;
      let q = (vx * (z - az) - vz * (x - ax)) / laenge;
      if (q > halb) q = halb; else if (q < -halb) q = -halb;

      // DER SEHNENVERSATZ.
      //
      // Das Band entsteht aus den Normalen der Stuetzstellen, dieser Index aus
      // den Sehnen dazwischen - und auf einer engen Kurve ist das nicht
      // dasselbe. Der Bandpunkt neben Stuetzstelle k faellt nicht senkrecht auf
      // k zurueck, sondern ein Stueck weiter die Sehne entlang, denn die
      // Normale steht schief zu ihr. Bei zwei Metern Wegbreite, halbmeter
      // Abtastung und dem Mindestradius sind das ein Viertel Stuetzstelle, und
      // bei 20 Grad Laengsgefaelle heisst ein Viertel Stuetzstelle fuenf
      // Zentimeter falsche Hoehe - genau so viel, wie der Weg ueber der Wiese
      // liegt. Die Wiese stach also am Bandrand durch den Belag.
      //
      // Der Fusspunkt auf der Sehne ist t = u + q·sigma·(1 - 2u); nach der
      // wahren Bogenstelle u aufgeloest ergibt das die Zeile unten.
      //
      // NUR IM SEGMENTINNEREN. Wurde der Fusspunkt auf einen Segmentendpunkt
      // geklemmt, ist die naechste Stelle des Weges nicht die Sehne, sondern
      // die STUETZSTELLE selbst - und deren Hoehe gilt dann unverfaelscht.
      // Genau dort steht auch der Bandpunkt: er ist ja der seitliche Versatz
      // eben dieser Stuetzstelle. Die Korrektur trotzdem anzuwenden schob ihn
      // ein Stueck die Nachbarsehne hinauf, und bei knapp 100 % Laengsgefaelle
      // waren das 8 cm zu hoch - die Wiese stand dann so weit ueber dem Belag.
      let u = t;
      if (t > 1e-9 && t < 1 - 1e-9) {
        const beta = q * arr[n + 11];
        u = (t - beta) / (1 - 2 * beta);
        if (!(u >= 0)) u = 0; else if (u > 1) u = 1;
      }

      let h = arr[n + 5] + (arr[n + 6] - arr[n + 5]) * u;
      const roll = arr[n + 8] + (arr[n + 9] - arr[n + 8]) * u;
      if (roll !== 0) h += roll * q;
      return { sd, h };
    },

    /**
     * Reine Ja/Nein-Abfrage "liegt auf der befestigten Flaeche". Schaut nur so
     * weit, wie noetig - fuer die weit ueber hunderttausend Grasabfragen ist
     * das rund viermal schneller als der vollstaendige Abstand.
     *
     * Gesucht wird mit der GROESSTEN halben Breite, verglichen mit der des
     * gefundenen Weges: sonst uebersaehe die Suche einen breiten Weg, der
     * knapp ausserhalb des schmalen Suchradius beginnt.
     */
    onSurface(x, z, except = -1, margin = 0) {
      const d = distanceTo(x, z, except, maxHalb + margin);
      return d !== Infinity && d - lastHalb < margin;
    },

    /**
     * Ist im Umkreis r um (x,z) garantiert keine fremde befestigte Flaeche?
     * Damit laesst sich die Pruefung fuer ein ganzes Bueschel auf einen Test
     * reduzieren, statt sie fuer jeden einzelnen Halm zu wiederholen.
     */
    farFrom(x, z, r, except = -1) {
      const d = distanceTo(x, z, except, maxHalb + r);
      return d === Infinity || d - lastHalb > r;
    },
  };
}


/* ---------------- Der Weg zum Tor ---------------- */

/**
 * Schnitt zweier Strecken, als Laufparameter auf der ERSTEN.
 * Gebraucht wird nur, wie weit man auf ihr laufen muss - null, wenn sie sich
 * innerhalb ihrer Laenge nicht treffen.
 */
function strahlSchnitt(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az;
  const sx = dx - cx, sz = dz - cz;
  const n = rx * sz - rz * sx;
  if (Math.abs(n) < 1e-12) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / n;
  const u = ((cx - ax) * rz - (cz - az) * rx) / n;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}


// Wie weit der Weg jenseits des Tors nach draussen laeuft. Das ist ein EIGENES
// Stueck (`baueAussenweg` in `wegnetz.js`) und nicht mehr Teil des Zugangs:
// drinnen gehoert er zum Garten und wird mit ihm vernetzt, draussen liegt er
// auf der Horizontscheibe und hat mit dem Netz nichts zu schaffen. In der
// Vogelperspektive faellt er weg - dort hoert die Anlage am Rand auf.
export const TOR_WEG_DRAUSSEN = 10.0;

/**
 * Der Zugangsweg: vom Rundweg durch das Tor und noch ein Stueck nach draussen.
 *
 * DIE RICHTUNG IST RADIAL, also die Verlaengerung der Linie Gartenmitte -> Tor.
 * Das ist nicht dasselbe wie „zum naechsten Wegpunkt": ein Zugang, der schraeg
 * durch das Tor liefe, saehe aus, als haette man das Tor an die falsche Stelle
 * gesetzt. Weil `planTor` die Stelle ohnehin nach der Parallelitaet zum Weg
 * aussucht, treffen beide Richtungen dort fast zusammen.
 *
 * Der innere Endpunkt wird gesucht, nicht gerechnet: vom Tor aus nach innen
 * abgeschritten, bis der Punkt auf einer Wegflaeche liegt. So endet der Zugang
 * genau auf dem Rundweg, gleichgueltig wie der dort verlaeuft.
 *
 * In der Vogelperspektive verschwindet der aeussere Teil unter der weissen
 * Maske - die beginnt am Gartenrand, und dort hoert die Anlage optisch auf.
 */
export function torWeg(cfg, hf, paths, tor, index) {
  if (!tor) return null;
  const m = tor.mitte;
  const r = Math.hypot(m.x, m.z);
  if (r < 1e-6) return null;
  const ux = m.x / r, uz = m.z / r;             // nach aussen

  // Nach innen abschreiten, bis eine Wegflaeche erreicht ist - grob, nur um
  // herauszufinden, WELCHER Weg getroffen wird.
  const schritt = 0.25;
  let ziel = null, grob = 0;
  for (let d = 0; d <= r && !ziel; d += schritt) {
    const x = m.x - ux * d, z = m.z - uz * d;
    for (const w of paths) {
      if (flaechenAbstand(w, x, z) <= 0) { ziel = w; grob = d; break; }
    }
  }
  if (!ziel) return null;

  // ER ENDET AUF DER MITTELLINIE - NICHT DAHINTER.
  //
  // Hier lief er einmal ganz durch den Rundweg hindurch und wurde auf beiden
  // Seiten geschnitten. Das war eine Seite zu viel: geschnitten wird nur an der
  // Randlinie, die ihm ZUGEWANDT ist, und was dahinter liegt, faellt ohnehin
  // weg. Bis zur Mittellinie zu laufen genuegt vollauf, damit seine beiden
  // Randlinien diese eine Kante sauber kreuzen - und dort entstehen die
  // gemeinsamen Punkte.
  //
  // Der Endpunkt wird jetzt gerechnet statt abgeschritten: der Strahl vom Tor
  // zur Gartenmitte gegen die Mittellinie des getroffenen Weges, die erste
  // Kreuzung von aussen gewinnt.
  const sm = ziel.samples;
  const segs = ziel.closed ? sm.length : sm.length - 1;
  const ex = m.x - ux * r, ez = m.z - uz * r;
  let dMitte = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = sm[i], b = sm[(i + 1) % sm.length];
    const t = strahlSchnitt(m.x, m.z, ex, ez, a.x, a.z, b.x, b.z);
    if (t !== null && t * r < dMitte) dMitte = t * r;
  }
  // Trifft der Strahl die Mittellinie nicht (streifender Fall), bleibt es beim
  // abgeschrittenen Punkt plus halber Breite - dann liegt das Ende sicher
  // innerhalb der Flaeche.
  if (!isFinite(dMitte)) dMitte = grob + ziel.width / 2;
  const innen = { x: m.x - ux * dMitte, z: m.z - uz * dMitte };

  // UND ER ENDET AM WIESENRAND, NICHT IM TOR.
  //
  // Beides ist versucht worden. Im Tor zu enden liest sich besser - dort steht
  // die Schwelle, dort wechselt man von drinnen nach draussen. Nur endet er
  // dann MITTEN in der Wiese, und zwischen seiner Stirnkante und dem
  // anschliessenden Aussenstueck bleibt ein Streifen Wiese von wenigen
  // Zentimetern stehen: als gruener Faden quer ueber das Pflaster gut sichtbar.
  //
  // Am Wiesenrand gibt es diesen Streifen nicht. Dort wird der Weg an der
  // Randlinie GESCHNITTEN und teilt sich mit ihr die Punkte - dahinter ist
  // keine Wiese mehr, die durchscheinen koennte. Er laeuft deshalb ueber den
  // Rand hinaus und wird dort gekappt (`beschneideWege` in `wegnetz.js`).
  const ueberR = cfg.durchmesser / 2 + 1.0;
  const aussen = { x: ux * ueberR, z: uz * ueberR };
  const linie = resample([innen, aussen], cfg.wegSample, false);
  if (linie.total < cfg.wegBreite) return null;
  return makePath(linie.pts, linie.total, false, index, cfg, hf, 1, 'tor');
}
