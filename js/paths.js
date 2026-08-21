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

/**
 * Unterbrechung der Ausgleichswaelle an Kreuzungen.
 *
 * Normalerweise endet der Wall dort, wo die Wegkante auf der Flaeche eines
 * anderen Weges liegt - sonst laeuft eine senkrechte Schuerze quer durch den
 * kreuzenden Weg. Vorlaeufig abgeschaltet, um zu sehen, wie der durchgehende
 * Wall wirkt. Zum Wiedereinschalten: auf true setzen.
 */
const WALL_AN_KREUZUNGEN_UNTERBRECHEN = false;

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

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
    samples.push({ x: p.x, z: p.z, y: hf.heightAt(p.x, p.z), tx, tz, nx: -tz, nz: tx, s });
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
  };
}

/* ---------------- 6. Abkuerzungen ---------------- */

/**
 * Die Vorlage nimmt jedes Punktpaar, das raeumlich nah und auf dem Weg weit
 * auseinander liegt, und wirft davon per Nachbarschaftsfilter wieder welche
 * weg. Das erzeugt viele Stichwege, die kaum etwas abkuerzen, und haeuft sie
 * an derselben Engstelle.
 *
 * Stattdessen wird bewertet, was eine Abkuerzung taugt: `gewinn` ist die
 * Wegstrecke, die man sich spart, je Meter Stichweg. Dann greedy in der
 * Reihenfolge des Gewinns, wobei jede angenommene Abkuerzung ihre Umgebung
 * sperrt - raeumlich wie auch entlang des Weges. So bleiben die wenigen
 * wirklich lohnenden Verbindungen uebrig, gleichmaessig verteilt.
 */
function planShortcuts(order, pts, cfg, maxDist, minSep) {
  const n = order.length;
  const want = Math.round(cfg.maxAbkuerzungen);
  if (want <= 0 || n < 2 * minSep) return [];

  // Bogenlaengen entlang der Rundreise
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cum[i + 1] = cum[i] + dist(pts[order[i]], pts[order[(i + 1) % n]]);
  }
  const perimeter = cum[n];

  const minLen = 3 * cfg.wegBreiteAbk;   // kuerzer lohnt sich kein eigener Weg
  const MIN_GEWINN = 3;                  // muss mindestens das Dreifache sparen
  const cand = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + minSep; j < n; j++) {
      if (Math.min(j - i, n - (j - i)) < minSep) continue;
      const a = pts[order[i]], b = pts[order[j]];
      const d = dist(a, b);
      if (d > maxDist || d < minLen) continue;
      const laengs = Math.min(cum[j] - cum[i], perimeter - (cum[j] - cum[i]));
      const gewinn = laengs / d;
      if (gewinn < MIN_GEWINN) continue;
      cand.push({ i, j, a, b, d, gewinn });
    }
  }
  cand.sort((p, q) => q.gewinn - p.gewinn);

  const sperreRaum = maxDist * 0.8;      // Abstand zwischen zwei Einmuendungen
  const out = [];
  for (const c of cand) {
    if (out.length >= want) break;
    const kollidiert = out.some((o) => {
      for (const p of [c.a, c.b]) {
        for (const q of [o.a, o.b]) if (dist(p, q) < sperreRaum) return true;
      }
      for (const p of [c.i, c.j]) {
        for (const q of [o.i, o.j]) {
          if (Math.min(Math.abs(p - q), n - Math.abs(p - q)) < minSep) return true;
        }
      }
      return false;
    });
    if (!kollidiert) out.push(c);
  }
  return out;
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
  const rounded = roundCorners(corners, cfg.wegGlaettung, step * 0.5);
  const loop = resample(rounded, step, true);
  const paths = [makePath(loop.pts, loop.total, true, 0, cfg, hf, 0)];

  const cuts = planShortcuts(order, attractors, cfg, cfg.durchmesser * 0.12, 5);
  if (cuts.length) {
    const main = paths[0].samples;
    const nearestSample = (p) => {
      let best = Infinity, at = 0;
      for (let k = 0; k < main.length; k++) {
        const d = (main[k].x - p.x) ** 2 + (main[k].z - p.z) ** 2;
        if (d < best) { best = d; at = k; }
      }
      return main[at];
    };

    // Wie weit ein Stichweg vor der Mittellinie des Rundwegs endet.
    //
    // Er soll an dessen KANTE aufhoeren, nicht bis in die Mitte laufen - sonst
    // liegt ein Meter Trampelpfad quer ueber dem Kiesband, und man sieht die
    // Naht von jedem Standpunkt aus. Wie weit das ist, haengt am Schnittwinkel:
    // wer schraeg einmuendet, hat einen laengeren Weg von der Mitte bis zur
    // Kante als wer rechtwinklig kommt, naemlich halbeBreite / sin(Winkel).
    //
    // Zwei Sicherungen: bei sehr flachem Winkel liefe die Rechnung davon
    // (deshalb der Deckel), und ein paar Zentimeter Ueberstand bleiben stehen,
    // damit an der Naht kein Spalt aufgeht statt einer Ueberlappung. Der
    // Rundweg ist krumm, seine Kante also keine Gerade - der Schraeganschnitt
    // trifft sie deshalb nur naeherungsweise, und ohne den Ueberstand blitzte
    // an einer Ecke ein Streifen Wiese durch.
    // ZWEI HALBE BREITEN, und sie gehoeren auseinandergehalten: gekuerzt wird
    // bis an die Kante des RUNDWEGS, angeschnitten wird die Ecke des
    // STICHWEGS. Seit beide ihre eigene Breite haben, ist das nicht mehr
    // dieselbe Zahl.
    const halbeHaupt = cfg.wegBreite / 2;
    const halbeAbk = cfg.wegBreiteAbk / 2;
    // Angeschnitten wird nur, solange die Abkuerzung NICHT BREITER ist als der
    // Weg, in den sie muendet. Sonst hat der Schraeganschnitt kein Ziel: seine
    // Stirnkante soll auf der Kante des Rundwegs liegen, aber ein 3,5 m breites
    // Maul reicht an einem 0,6 m breiten Weg links und rechts ins Gras, so weit
    // man es auch hineinschiebt. Dort ist der stumpfe Schnitt richtig - der
    // breite Trampelpfad laeuft eben breiter aus als der Weg, den er trifft,
    // und hat fuer sein Ende ohnehin einen eigenen Wall.
    const schraegAn = halbeAbk <= halbeHaupt;
    const UEBERSTAND = 0.12;
    const DECKEL = halbeHaupt * 4;
    const kuerzung = (probe, ux, uz) => {
      const sin = Math.abs(probe.tx * uz - probe.tz * ux);
      return Math.max(0, Math.min(DECKEL, halbeHaupt / Math.max(0.25, sin)) - UEBERSTAND);
    };

    /**
     * Der Schraeganschnitt: um wie viel eine Bandecke laengs der eigenen
     * Tangente vorruecken muss, damit sie auf der Kante des Rundwegs landet.
     *
     * Der Punkt der Ecke ist Stuetzstelle + n·halbe·sgn + t·d. Er soll auf der
     * Geraden liegen, die um `halbe` neben der Mittellinie des Rundwegs laeuft.
     * Einsetzen und nach d aufloesen ergibt d = -sgn·halbe·(n·Nm)/(t·Nm), mit
     * Nm der Normalen des Rundwegs an dieser Stelle. Zurueck kommt der Faktor
     * ohne das sgn - `bandPunkt` haengt es an.
     *
     * Gedeckelt, weil der Ausdruck bei sehr flachem Schnitt davonlaeuft: bei
     * 15 Grad waere die Ecke schon vier Meter verschoben, und die Stuetzstellen
     * liegen nur einen halben Meter auseinander - das Schlussviereck kippte um.
     */
    const schraege = (haupt, ende, h) => {
      const nenner = ende.tx * haupt.nx + ende.tz * haupt.nz;
      if (Math.abs(nenner) < 1e-6) return 0;
      const d = -h * (ende.nx * haupt.nx + ende.nz * haupt.nz) / nenner;
      return Math.max(-2 * h, Math.min(2 * h, d));
    };

    for (const c of cuts) {
      // Die Enden auf die tatsaechliche Mittellinie ziehen: die Attraktoren
      // liegen nach der Verrundung nicht mehr exakt auf dem Weg, ein Stichweg
      // dorthin wuerde die Kreuzung knapp verfehlen.
      const a = nearestSample(c.a), b = nearestSample(c.b);
      const dx = b.x - a.x, dz = b.z - a.z;
      const laenge = Math.hypot(dx, dz);
      if (laenge < 1e-6) continue;
      const ux = dx / laenge, uz = dz / laenge;

      // ... und dann von beiden Enden wieder zurueck bis an die Wegkante.
      const ka = kuerzung(a, ux, uz), kb = kuerzung(b, ux, uz);
      if (laenge - ka - kb < 3 * cfg.wegBreiteAbk) continue;
      const von = { x: a.x + ux * ka, z: a.z + uz * ka };
      const bis = { x: b.x - ux * kb, z: b.z - uz * kb };

      const line = resample([von, bis], step, false);
      if (line.total < 3 * cfg.wegBreiteAbk) continue;
      const weg = makePath(line.pts, line.total, false, paths.length, cfg, hf, 1);
      // Und schraeg anschneiden, damit die Stirnkante auf der Kante des
      // Rundwegs liegt statt quer dazu (siehe `bandPunkt`).
      if (schraegAn) {
        weg.anschnitt = { start: schraege(a, weg.samples[0], halbeAbk),
                          ende: schraege(b, weg.samples[weg.samples.length - 1], halbeAbk) };
      }
      paths.push(weg);
    }
  }
  return paths;
}

/**
 * Band entlang der Mittellinie. Beim Rundweg schliesst das letzte Segment
 * zurueck zum ersten Sample, beim Stichweg nicht.
 *
 * Beide Randvertices bekommen die Hoehe der Mittellinie - der Weg ist damit
 * quer zur Laufrichtung exakt waagerecht und steigt nur in Wegrichtung. Dass
 * er trotzdem im Gelaende liegt, besorgt die Wegplanie im Hoehenfeld
 * (terrain.js: withPathCorridor), die die Wiese seitlich an diese Hoehe
 * heranzieht.
 *
 * Die Textur laeuft ueber die Bogenlaenge und kachelt endlos mit dem Weg mit.
 */
export function buildPathMesh(path, cfg, material) {
  const sm = path.samples;
  const m = sm.length;
  const half = path.width / 2;
  const tile = path.kachel;
  const lift = pathLift(cfg, path);

  // DIE NAHT DES RUNDWEGS BRAUCHT EIGENE ECKPUNKTE.
  //
  // Die Textur laeuft ueber die Bogenlaenge: v = s / kachel. Beim geschlossenen
  // Weg schliesst das letzte Viereck an Stuetzstelle 0 an, und deren s ist 0 -
  // das eine Viereck spannte damit die gesamte Kachelung des ganzen Rundwegs
  // auf 50 cm zusammen. Die Grafikkarte greift dafuer zur groebsten
  // Mipmap-Stufe, und heraus kam ein einfarbig graues Band quer ueber den Weg,
  // genau am Startpunkt des Spaziergangs.
  //
  // Abhilfe: die erste Stuetzstelle ein zweites Mal ausgeben, diesmal mit
  // s = Gesamtlaenge. Geometrisch derselbe Punkt, in der Textur der richtige.
  const n = path.closed ? m + 1 : m;

  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx = [];

  for (let k = 0; k < n; k++) {
    const p = sm[k % m];
    const s = (k === m) ? path.total : p.s;
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;
      const e = bandPunkt(path, k % m, sgn, half, lift);
      const o = (k * 2 + side) * 3;
      pos[o] = e.x;
      pos[o + 1] = e.y;               // Mittellinienhoehe -> Querschnitt waagerecht
      pos[o + 2] = e.z;
      const u = (k * 2 + side) * 2;
      uv[u] = (sgn * half) / tile + 0.5;
      uv[u + 1] = s / tile;
    }
  }
  // Wicklung gegen den Uhrzeigersinn von oben -> Flaechennormale +Y. Andersherum
  // wird das Band als Rueckseite weggeculled und ist nur im Drahtgitter sichtbar.
  for (let k = 0; k < n - 1; k++) {
    const k2 = k + 1;
    const a = k * 2, b = k * 2 + 1, c = k2 * 2, d = k2 * 2 + 1;
    idx.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = `weg_${path.index}`;
  return mesh;
}

/* ---------------- Ausgleichswall ---------------- */

/**
 * Der Wall ist eine Folge von "Rippen": Oberkante auf der Bandkante,
 * Unterkante unter 45 Grad nach aussen-unten bis unter das Gelaende.
 * `ox/oz` ist die waagerechte Aussenrichtung der Rippe.
 *
 * Die Reihenfolge im Streifen muss so sein, dass die Aussenrichtung die um
 * 90 Grad gedrehte Laufrichtung ist - sonst zeigen die Normalen nach innen.
 * Beim Rundweg sind das zwei geschlossene Streifen (links und rechts), beim
 * Stichweg ein einziger, der einmal um das ganze Band herumlaeuft: rechte
 * Seite vorwaerts, Eckfaecher, Stirnseite quer, Eckfaecher, linke Seite
 * zurueck, und dasselbe am Anfang. Dadurch schliessen Laengs- und Stirnwall
 * ohne Naht aneinander an.
 */
/**
 * Ein Punkt auf der Bandkante - und die einzige Stelle, an der der
 * Schraeganschnitt der Abkuerzungen steckt.
 *
 * Ohne ihn endet ein Stichweg mit einer STUMPFEN Kante quer zu seiner eigenen
 * Laufrichtung. Wo er schraeg auf den Rundweg trifft, klafft dann auf der
 * einen Seite ein Zwickel Wiese zwischen beiden Baendern, waehrend die andere
 * Seite ueber die Wegkante hinausragt.
 *
 * `anschnitt` ist der Betrag, um den die Kante je Seite laengs der eigenen
 * Tangente verschoben wird - antisymmetrisch, die eine Ecke nach vorn, die
 * andere nach hinten. Damit liegt die Stirnkante genau auf der Kante des
 * Rundwegs. Weil der Versatz linear in `sgn` ist, stimmen auch die
 * Zwischenpunkte des Stirnwalls von selbst.
 */
export function bandPunkt(path, k, sgn, half, lift) {
  const p = path.samples[k];
  const a = path.anschnitt;
  let d = 0;
  if (a) {
    if (k === 0) d = a.start * sgn;
    else if (k === path.samples.length - 1) d = a.ende * sgn;
  }
  return {
    x: p.x + p.nx * half * sgn + p.tx * d,
    z: p.z + p.nz * half * sgn + p.tz * d,
    y: p.y + lift,
  };
}

function wallRibs(path, half, lift) {
  const sm = path.samples;
  const m = sm.length;
  const top = (k, sgn) => bandPunkt(path, k, sgn, half, lift);

  if (path.closed) {
    const strips = [];
    for (const sgn of [1, -1]) {
      const list = [];
      for (let i = 0; i < m; i++) {
        const k = sgn > 0 ? i : m - 1 - i;
        list.push({ ...top(k, sgn), ox: sm[k].nx * sgn, oz: sm[k].nz * sgn, seite: true });
      }
      strips.push(list);
    }
    return strips;
  }

  const list = [];
  const FAN = 3;      // Zwischenrippen je Ecke
  const CAP = 4;      // Rippen quer ueber die Stirnseite

  // Eckfaecher: gleicher Oberkantenpunkt, Aussenrichtung dreht sich um -90 Grad
  const fan = (k, sgn, ax, az) => {
    const a0 = Math.atan2(az, ax);
    const p = top(k, sgn);
    for (let i = 1; i < FAN; i++) {
      const a = a0 - (Math.PI / 2) * (i / FAN);
      list.push({ ...p, ox: Math.cos(a), oz: Math.sin(a), seite: false });
    }
  };
  // Stirnseite: Oberkante quer ueber das Band, Aussenrichtung ist die Tangente
  const cap = (k, from, dir) => {
    for (let i = 0; i <= CAP; i++) {
      const sgn = from * (1 - (2 * i) / CAP);
      list.push({ ...top(k, sgn), ox: sm[k].tx * dir, oz: sm[k].tz * dir, seite: false });
    }
  };

  for (let k = 0; k < m; k++) list.push({ ...top(k, 1), ox: sm[k].nx, oz: sm[k].nz, seite: true });
  fan(m - 1, 1, sm[m - 1].nx, sm[m - 1].nz);
  cap(m - 1, 1, 1);
  fan(m - 1, -1, sm[m - 1].tx, sm[m - 1].tz);
  for (let k = m - 1; k >= 0; k--) list.push({ ...top(k, -1), ox: -sm[k].nx, oz: -sm[k].nz, seite: true });
  fan(0, -1, -sm[0].nx, -sm[0].nz);
  cap(0, -1, -1);
  fan(0, 1, -sm[0].tx, -sm[0].tz);
  return [list];
}

/**
 * Ausgleichswall rings um das Wegband.
 *
 * Die Planie setzt die Hoehe des naechstliegenden Weges an. Wo zwei Wege sich
 * kreuzen oder dicht beieinander laufen, gewinnt mal der eine, mal der andere -
 * das Band des hoeheren schwebt dann ueber dem Boden und man schaut darunter.
 * Der Wall ist eine 45-Grad-Boeschung von der Bandkante nach aussen bis unter
 * das Gelaende und schliesst diesen Hohlraum. Im Normalfall faellt er als
 * 5-cm-Fase kaum auf.
 *
 * Eigene Vertices je Rippe, damit die Normalen an der Bandkante hart bleiben;
 * das Material ist beidseitig, weil man an Kreuzungen auch von unten hinsieht.
 */
export function buildPathWalls(path, cfg, hf, pathIndex, material) {
  const half = path.width / 2;
  const tile = path.kachel;
  const lift = pathLift(cfg, path);
  const tief = cfg.wegWallTiefe;

  const pos = [];
  const uv = [];
  const idx = [];

  // Die Boeschung liegt unter 45 Grad: der waagerechte Versatz nach aussen ist
  // genau so gross wie der Hoehenabfall, beides ist das eine Mass `o`. Wie weit
  // es geht, haengt vom Gelaende am Fusspunkt ab, das aber erst mit `o`
  // feststeht - also schrittweise vergroessern, bis der Fusspunkt unter Grund
  // liegt. Nur wachsend, damit es nicht schwingt.
  const fussMass = (r, start) => {
    let o = start;
    for (let i = 0; i < 6; i++) {
      const need = r.y - hf.heightAt(r.x + r.ox * o, r.z + r.oz * o) + tief;
      if (need <= o) break;
      o = need;
    }
    return o;
  };
  const fussPunkt = (r, o) => ({ x: r.x + r.ox * o, y: r.y - o, z: r.z + r.oz * o });

  for (const strip of wallRibs(path, half, lift)) {
    const base = pos.length / 3;
    const n = strip.length;
    const o = strip.map((r) => fussMass(r, 0));

    // Senkt das Gelaende zwischen zwei Rippen ab, bliebe unter der geraden
    // Fusslinie ein Schlitz - besonders an den Eckfaechern, wo die Fusspunkte
    // weit auseinanderliegen. Deshalb die Strecke abtasten und beide Enden
    // entsprechend weiter hinausziehen. Weiter statt tiefer: so bleiben es
    // 45 Grad.
    for (let pass = 0; pass < 3; pass++) {
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const a = fussPunkt(strip[k], o[k]), b = fussPunkt(strip[k2], o[k2]);
        // Abtastung nach Laenge, nicht nach fester Anzahl: an einer Kreuzung
        // faellt das Gelaende auf wenigen Zentimetern in die Boeschung des
        // anderen Weges ab, und genau dort sass sonst der Schlitz.
        const steps = Math.min(12, Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.08)));
        for (let i = 1; i < steps; i++) {
          const f = i / steps;
          const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
          const need = a.y + (b.y - a.y) * f - (hf.heightAt(x, z) - tief);
          if (need > 0) { o[k] += need; o[k2] += need; }
        }
      }
    }
    for (let k = 0; k < n; k++) o[k] = fussMass(strip[k], o[k]);

    // Ein Streifen ist immer geschlossen - beim Rundweg von selbst, beim
    // Stichweg, weil er um das ganze Band herumlaeuft. Die letzte Rippe wird
    // deshalb noch einmal ausgegeben, mit fortgezaehlter Bogenlaenge: sonst
    // spannte das Schlussviereck die ganze Kachelung auf eine Rippenbreite
    // zusammen und wurde einfarbig grau (siehe `buildPathMesh`).
    let s = 0;
    for (let k = 0; k <= n; k++) {
      const kk = k % n;
      const r = strip[kk];
      const b = fussPunkt(r, o[kk]);
      if (k > 0) {
        const q = strip[(k - 1) % n];
        s += Math.hypot(r.x - q.x, r.z - q.z);
      }
      pos.push(r.x, r.y, r.z, b.x, b.y, b.z);
      uv.push(s / tile, 0, s / tile, -(o[kk] * Math.SQRT2) / tile);
    }

    // An Kreuzungen liegt die Wegkante auf der Flaeche eines anderen Weges;
    // dort wuerde der Wall quer durch den kreuzenden Weg laufen.
    const gap = strip.map((r) => WALL_AN_KREUZUNGEN_UNTERBRECHEN && r.seite
      && pathIndex.onSurface(r.x, r.z, path.index));

    for (let k = 0; k < n; k++) {
      if (gap[k] || gap[(k + 1) % n]) continue;
      const t1 = base + k * 2, u1 = base + k * 2 + 1;
      const t2 = base + (k + 1) * 2, u2 = base + (k + 1) * 2 + 1;
      idx.push(t1, u1, t2, u1, u2, t2);
    }
  }
  if (idx.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = `wegwall_${path.index}`;
  return mesh;
}

export const pathLift = (cfg, path) => cfg.wegHoehe + (path.liftIndex || 0) * 0.004;

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
  // [pfad, ax, az, bx, bz, ay, by, halbe] - ay/by sind die Basis-Gelaendehoehen
  // der Mittellinie, aus denen die Wegquerschnittshoehe interpoliert wird.
  //
  // Die halbe Breite steht je SEGMENT darin und nicht mehr einmal fuer alle:
  // seit die Abkuerzungen schmaler sein duerfen als der Rundweg, gibt es keine
  // Wegbreite mehr, sondern nur noch die Breite dieses Weges.
  const STRIDE = 8;
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
      arr.push(p.index, a.x, a.z, b.x, b.z, a.y, b.y, halb);
    }
  }
  // Ein Segment ist wegSample lang; liegt es naeher als maxDist an der Abfrage,
  // liegt sein Anfangspunkt hoechstens maxDist + wegSample entfernt.
  const reachFor = (maxDist) =>
    Math.min(4, Math.max(1, Math.ceil((maxDist + cfg.wegSample) / cell)));
  const MAX_REACH = reachFor(6);

  // Ergebnis der letzten Abfrage: Hoehe der Mittellinie am naechsten Punkt und
  // die halbe Breite GENAU DIESES Weges. Beide gehoeren zusammen - die Breite
  // eines anderen Weges wuerde die Kante an die falsche Stelle legen.
  let lastHeight = 0;
  let lastHalb = maxHalb;

  function distanceTo(x, z, except = -1, maxDist = Infinity) {
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
            lastHeight = arr[n + 5] + (arr[n + 6] - arr[n + 5]) * t;
            lastHalb = arr[n + 7];
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
     * Grundlage der Wegplanie: der Weg ist quer zur Laufrichtung waagerecht,
     * also gilt fuer den ganzen Querschnitt die Hoehe der Mittellinie.
     */
    nearestSurface(x, z) {
      const d = distanceTo(x, z);
      return { sd: d === Infinity ? Infinity : d - lastHalb, h: lastHeight };
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

// Wie weit der Weg ueber die Gartengrenze hinaus nach draussen laeuft.
const TOR_WEG_DRAUSSEN = 4.0;

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

  // Nach innen abschreiten, bis eine Wegflaeche erreicht ist.
  const schritt = 0.25;
  let innen = null;
  for (let d = 0; d <= r; d += schritt) {
    const x = m.x - ux * d, z = m.z - uz * d;
    for (const w of paths) {
      const halb = w.width / 2;
      for (const s of w.samples) {
        if (Math.hypot(s.x - x, s.z - z) <= halb) { innen = { x, z }; break; }
      }
      if (innen) break;
    }
    if (innen) break;
  }
  if (!innen) return null;

  const aussenR = cfg.durchmesser / 2 + TOR_WEG_DRAUSSEN;
  const aussen = { x: ux * aussenR, z: uz * aussenR };
  const linie = resample([innen, aussen], cfg.wegSample, false);
  if (linie.total < cfg.wegBreite) return null;
  return makePath(linie.pts, linie.total, false, index, cfg, hf, 1, 'tor');
}
