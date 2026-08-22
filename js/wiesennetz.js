import * as THREE from 'three';
import { bandPunkt } from './paths.js';

/**
 * Das Wiesennetz: ein einziger Punktsatz fuer Wiese UND Wege.
 *
 * WARUM DAS DIE GANZE FRUEHERE MUEHE ERSPART. Solange die Hoehe eine Funktion
 * war, die man an beliebiger Stelle abfragt, war jedes Netz nur eine Naeherung
 * davon - und Wiese und Wegband waren ZWEI Naeherungen derselben Kante, mit
 * verschiedenen Stuetzstellen. Die treffen sich nie genau. Dagegen brauchte es
 * einen Untergriff, damit keine Fuge aufgeht, einen Saum, damit der Untergriff
 * nicht ueber den Belag ragt, eine Absenkung gegen den Knick der Planie und
 * eine Unterteilung gegen die groben Zellen. Vier Mittel gegen ein Problem.
 *
 * Hier gibt es das Problem nicht. Erst wird in der EBENE gerechnet: Gitter
 * legen, Wegbaender darauf zeichnen, Schnittpunkte bestimmen. Danach steht der
 * Punktsatz fest, und alles Weitere verschiebt die Punkte nur noch SENKRECHT.
 * Wiese und Weg teilen sich an der Kante dieselben Punkte - eine Fuge kann es
 * nicht geben, ein Durchstich auch nicht.
 *
 * Drei Durchgaenge, in dieser Reihenfolge:
 *
 *   1. `verforme`   - das Gelaende, fuer jeden Punkt seine Rauschhoehe.
 *   2. `ebnePfade`  - die Wegpunkte auf ihre Bandhoehe. Ab hier sind sie fest.
 *   3. `glaette`    - die uebrigen Punkte iterativ ausgleichen, damit die
 *                     Wiese ohne Knick an den Weg anschliesst.
 */

/* ---------------- Hilfsgeometrie ---------------- */

const EPS = 1e-9;

/** Flaeche mal zwei, mit Vorzeichen. Positiv = gegen den Uhrzeigersinn. */
const flaeche2 = (ax, az, bx, bz, cx, cz) =>
  (bx - ax) * (cz - az) - (cx - ax) * (bz - az);

/**
 * Schnittpunkt zweier Strecken in der Ebene, als Laufparameter.
 * Null bei parallel oder wenn der Schnitt ausserhalb einer der beiden liegt.
 */
function strecken(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az;
  const sx = dx - cx, sz = dz - cz;
  const n = rx * sz - rz * sx;
  if (Math.abs(n) < 1e-12) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / n;
  const u = ((cx - ax) * rz - (cz - az) * rx) / n;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u };
}

/**
 * Ohrenschneiden. Die Wiesenreste einer Zelle sind nach dem Beschneiden nicht
 * mehr zwangslaeufig konvex - ein Faecher vom ersten Punkt aus wuerde dann
 * ueber die Kerbe hinweggreifen.
 */
function ohren(poly, px, pz, out) {
  const n = poly.length;
  if (n < 3) return;
  if (n === 3) { out.push(poly[0], poly[1], poly[2]); return; }

  // UMLAUFSINN-UNABHAENGIG. Bei unserer Achsenlage (x nach rechts, z nach
  // hinten) hat ein Polygon, dessen Normale nach oben zeigt, eine NEGATIVE
  // Flaeche nach `flaeche2`. Das Ohrenschneiden rechnet aber mit positiver.
  // Also innen umdrehen und die Dreiecke am Ende wieder zurueckdrehen - sonst
  // zeigt die halbe Wiese nach unten und wird weggecullt.
  let f = 0;
  for (let k = 1; k + 1 < n; k++) {
    f += flaeche2(px[poly[0]], pz[poly[0]], px[poly[k]], pz[poly[k]],
                  px[poly[k + 1]], pz[poly[k + 1]]);
  }
  const gedreht = f < 0;
  const roh = [];
  const rest = gedreht ? poly.slice().reverse() : poly.slice();
  let wache = 0;
  while (rest.length > 3 && wache++ < 4 * n) {
    let geschnitten = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[(i - 1 + rest.length) % rest.length];
      const b = rest[i];
      const c = rest[(i + 1) % rest.length];
      const f = flaeche2(px[a], pz[a], px[b], pz[b], px[c], pz[c]);
      if (f <= EPS) continue;                       // Kerbe oder entartet
      let frei = true;
      for (const q of rest) {
        if (q === a || q === b || q === c) continue;
        const f1 = flaeche2(px[a], pz[a], px[b], pz[b], px[q], pz[q]);
        const f2 = flaeche2(px[b], pz[b], px[c], pz[c], px[q], pz[q]);
        const f3 = flaeche2(px[c], pz[c], px[a], pz[a], px[q], pz[q]);
        if (f1 >= -EPS && f2 >= -EPS && f3 >= -EPS) { frei = false; break; }
      }
      if (!frei) continue;
      roh.push(a, b, c);
      rest.splice(i, 1);
      geschnitten = true;
      break;
    }
    if (!geschnitten) break;                        // entartet, Rest verwerfen
  }
  if (rest.length === 3) roh.push(rest[0], rest[1], rest[2]);
  for (let t = 0; t < roh.length; t += 3) {
    const a = roh[t], b = roh[t + 1], c = roh[t + 2];
    // Flaechenlose Dreiecke verderben die Normalen und tragen nichts bei.
    if (Math.abs(flaeche2(px[a], pz[a], px[b], pz[b], px[c], pz[c])) < 1e-7) continue;
    if (gedreht) out.push(a, c, b); else out.push(a, b, c);
  }
}



/**
 * Die Marke eines Punktes ZWISCHEN zwei markierten Punkten.
 *
 * Ohne sie waere die ganze Uebung umsonst. Wo eine Zellkante die Wegkante
 * kreuzt, entsteht ein neuer Punkt - und der liegt zwar auf der Bandkante, weiss
 * es aber nicht. `ebnePfade` liesse ihn frei, `glaette` zoege ihn zum Gelaende,
 * und die Wiese saesse dort um Dezimeter neben dem Belag. Genau dafuer traegt
 * die Marke eine GEBROCHENE Stuetzstellennummer: k = 7.3 heisst „auf der
 * Bandkante, drei Zehntel zwischen Stuetzstelle 7 und 8".
 *
 * Auch `sgn` darf gebrochen sein - auf einer Stirnseite laeuft die Kante quer
 * ueber das Band, von der einen Seite zur anderen.
 */
function zwischenMarke(ma, mb, t) {
  if (!ma && !mb) return null;
  if (ma && mb && ma.p === mb.p) {
    if (ma.sgn === mb.sgn && Math.abs(ma.k - mb.k) <= 1.0001) {
      return { p: ma.p, k: ma.k + (mb.k - ma.k) * t, sgn: ma.sgn };
    }
    if (Math.abs(ma.k - mb.k) < 1e-9) {                   // Stirnseite
      return { p: ma.p, k: ma.k, sgn: ma.sgn + (mb.sgn - ma.sgn) * t };
    }
  }
  // Kein sauberes Paar - das kommt an drei Stellen vor: beim Ringschluss, wo
  // die Stuetzstellennummer von m-1 auf 0 springt, an der Naht zwischen den
  // Umrissen zweier Wege, und wenn ein Ende gar nicht markiert ist. Dann gilt
  // die NAEHERE Marke. Der Fehler bleibt auf eine halbe Stuetzstelle begrenzt,
  // und an einer Naht sind die Hoehen beider Wege ohnehin angeglichen - aber
  // ganz ohne Marke bliebe der Punkt frei, und die Glaettung zoege ihn
  // dezimeterweit vom Belag weg.
  return (t < 0.5 ? ma : mb) || ma || mb;
}

/* ---------------- Der Umriss der Wegflaechen ---------------- */

/**
 * Der Umriss EINES Weges als geschlossener Ring von Punktnummern.
 *
 * Beim Rundweg sind es zwei Ringe - aussen und innen -, beim Stichweg einer,
 * der einmal herumlaeuft: rechte Kante vorwaerts, Stirnseite, linke Kante
 * zurueck, Stirnseite.
 */
function umriss(p, kante) {
  const m = p.samples.length;
  const { links, rechts } = kante;
  // Der erste Punkt kommt am Ende noch einmal - der Ring muss GESCHLOSSEN
  // sein. Sonst fehlt genau eine Strecke im Umriss, und an der einen Stelle
  // laeuft die Wiese ungehindert ueber den Weg.
  if (p.closed) {
    const a = [], b = [];
    for (let k = 0; k < m; k++) { a.push(rechts[k]); b.push(links[m - 1 - k]); }
    a.push(a[0]); b.push(b[0]);
    return [a, b];
  }
  const r = [];
  for (let k = 0; k < m; k++) r.push(rechts[k]);
  for (let k = m - 1; k >= 0; k--) r.push(links[k]);
  r.push(r[0]);
  return [r];
}

/**
 * Aus den Einzelumrissen den UMRISS DER VEREINIGUNG machen.
 *
 * Wo eine Abkuerzung unter dem Rundweg liegt, gehoert ihre Kante nicht zum
 * Rand der befestigten Flaeche - dort ist ja Weg auf beiden Seiten. Solche
 * Stuecke fallen weg. Damit das sauber aufgeht, werden die Ringe zuvor an
 * ihren gegenseitigen Schnittpunkten geteilt: der Teilungspunkt ist dann ein
 * gemeinsamer Punkt beider Wege, und die Wiese schliesst dort an beide an.
 *
 * Zurueck kommen offene Streckenzuege - geschlossen muessen sie nicht sein,
 * denn geschnitten wird zellenweise, und eine Zelle sieht ohnehin nur ein
 * Stueck davon.
 */
function vereinigungsUmriss(paths, kanten, netz) {
  const { px, pz } = netz;
  const ringe = [];
  paths.forEach((p, i) => {
    for (const r of umriss(p, kanten[i])) ringe.push({ p: p.index, punkte: r });
  });

  // 1. Schnittpunkte zwischen Ringen VERSCHIEDENER Wege einsammeln
  const teilung = ringe.map(() => new Map());     // Kantenindex -> [{t, id}]
  for (let a = 0; a < ringe.length; a++) {
    for (let b = a + 1; b < ringe.length; b++) {
      if (ringe[a].p === ringe[b].p) continue;
      const A = ringe[a].punkte, B = ringe[b].punkte;
      for (let i = 0; i + 1 < A.length; i++) {
        for (let j = 0; j + 1 < B.length; j++) {
          const s = strecken(px[A[i]], pz[A[i]], px[A[i + 1]], pz[A[i + 1]],
                             px[B[j]], pz[B[j]], px[B[j + 1]], pz[B[j + 1]]);
          if (!s) continue;
          const x = px[A[i]] + (px[A[i + 1]] - px[A[i]]) * s.t;
          const z = pz[A[i]] + (pz[A[i + 1]] - pz[A[i]]) * s.t;
          // Der Punkt liegt auf BEIDEN Kanten. Die des ranghoeheren Weges
          // gewinnt - dort sind die Hoehen ohnehin angeglichen, und der
          // Rundweg soll die Fuehrung behalten.
          const id = netz.punkt(x, z,
            zwischenMarke(netz.marke[A[i]], netz.marke[A[i + 1]], s.t)
            || zwischenMarke(netz.marke[B[j]], netz.marke[B[j + 1]], s.u));
          if (!teilung[a].has(i)) teilung[a].set(i, []);
          if (!teilung[b].has(j)) teilung[b].set(j, []);
          teilung[a].get(i).push({ t: s.t, id });
          teilung[b].get(j).push({ t: s.u, id });
        }
      }
    }
  }

  // 2. Ringe an den Schnittpunkten teilen und die verdeckten Stuecke weglassen
  const zuege = [];
  ringe.forEach((ring, ri) => {
    const roh = [];
    for (let i = 0; i + 1 < ring.punkte.length; i++) {
      const teile = (teilung[ri].get(i) || []).slice().sort((u, v) => u.t - v.t);
      let vorher = ring.punkte[i];
      for (const t of teile) {
        if (t.id !== vorher) roh.push([vorher, t.id]);
        vorher = t.id;
      }
      if (vorher !== ring.punkte[i + 1]) roh.push([vorher, ring.punkte[i + 1]]);
    }
    let lauf = null;
    for (const [a, b] of roh) {
      const mx = (px[a] + px[b]) / 2, mz = (pz[a] + pz[b]) / 2;
      let verdeckt = false;
      for (const q of paths) {
        if (q.index === ring.p) continue;
        if (flaechenAbstandLokal(q, mx, mz) < -1e-4) { verdeckt = true; break; }
      }
      if (verdeckt) { lauf = null; continue; }
      if (lauf && lauf[lauf.length - 1] === a) lauf.push(b);
      else { lauf = [a, b]; zuege.push(lauf); }
    }
  });

  // 3. Bruchstuecke wieder zusammensetzen.
  //
  // An einem Kreuzungspunkt endet die Kante des einen Weges und die des
  // anderen faengt an - der Umriss der Vereinigung laeuft dort durch. Bleiben
  // die Stuecke getrennt, endet in der Zelle rings um den Kreuzungspunkt eine
  // Kette mitten im Raum, statt die Zelle zu durchqueren, und der Schnitt
  // scheitert. Genau dort sassen die meisten Risse.
  const anfang = new Map();
  for (const z of zuege) {
    const k = z[0];
    if (!anfang.has(k)) anfang.set(k, []);
    anfang.get(k).push(z);
  }
  const benutzt = new Set();
  const ganz = [];

  /**
   * Der naechste Anfang zu einem Ende - notfalls auch ohne genaue Deckung.
   *
   * Die Verdeckungspruefung entscheidet je Strecke an deren MITTELPUNKT. Wo
   * eine fremde Kante mitten in eine Strecke hineinreicht, faellt die ganze
   * Strecke weg oder bleibt ganz stehen, und zwischen zwei Stuecken bleibt ein
   * Rest von wenigen Zentimetern offen. Ein offenes Ende ist aber teuer: die
   * Zelle, in der es liegt, laesst sich nicht mehr laengs des Umrisses teilen
   * und faellt als GANZE aus - und dann legt sie sich womoeglich ueber den
   * Belag. Ein gerades Stueck ueber die Luecke ist das kleinere Uebel; es
   * liegt ohnehin auf der Wegkante.
   */
  const passt = (ende) => {
    const genau = (anfang.get(ende) || []).find((q) => !benutzt.has(q));
    if (genau) return genau;
    let best = null, bestD = 0.3;
    for (const q of zuege) {
      if (benutzt.has(q)) continue;
      const d = Math.hypot(px[q[0]] - px[ende], pz[q[0]] - pz[ende]);
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  };

  for (const z of zuege) {
    if (benutzt.has(z)) continue;
    benutzt.add(z);
    const lauf = z.slice();
    for (let runde = 0; runde < zuege.length; runde++) {
      const weiter = passt(lauf[lauf.length - 1]);
      if (!weiter) break;
      benutzt.add(weiter);
      const ab = weiter[0] === lauf[lauf.length - 1] ? 1 : 0;
      for (let i = ab; i < weiter.length; i++) lauf.push(weiter[i]);
      if (lauf[0] === lauf[lauf.length - 1]) break;      // Ring geschlossen
    }
    // Und zuletzt den Ring wirklich schliessen.
    if (lauf.length > 2 && lauf[0] !== lauf[lauf.length - 1]
        && Math.hypot(px[lauf[0]] - px[lauf[lauf.length - 1]],
                      pz[lauf[0]] - pz[lauf[lauf.length - 1]]) < 0.3) {
      lauf.push(lauf[0]);
    }
    ganz.push(lauf);
  }
  return ganz;
}

/** Abstand zur Flaeche eines Weges; negativ heisst drauf. */
function flaechenAbstandLokal(p, x, z) {
  const sm = p.samples;
  const segs = p.closed ? sm.length : sm.length - 1;
  let best = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = sm[i], b = sm[(i + 1) % sm.length];
    const vx = b.x - a.x, vz = b.z - a.z;
    const wx = x - a.x, wz = z - a.z;
    const l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? (wx * vx + wz * vz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * vx, dz = wz - t * vz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best) - p.width / 2;
}

/* ---------------- Eine Zelle an einer Kette teilen ---------------- */

/**
 * Ein konvexes Zellpolygon an einem Streckenzug teilen.
 *
 * Der Streckenzug tritt an einer Stelle in die Zelle ein und an einer anderen
 * wieder aus. Beide Polygone entstehen daraus: der Zug selbst plus jeweils
 * einer der beiden Boegen des Zellrands.
 *
 * DER ENTSCHEIDENDE UNTERSCHIED ZUM FRUEHEREN HALBEBENEN-ABZUG: geschnitten
 * wird an der KANTE, nicht an ihrer verlaengerten Geraden. Ein Schnittpunkt auf
 * dem Zellrand entsteht nur dort, wo der Zug den Rand wirklich kreuzt - und
 * dann kreuzt er ihn auch fuer die Nachbarzelle, mit derselben Rechnung. So
 * kann keine T-Naht entstehen. Die Halbebenen schnitten dagegen quer durch die
 * Wiese hinaus, und ob eine ferne Zelle den Schnitt mitbekam, hing daran, ob
 * das Viereck zufaellig in ihrem Eimer lag.
 *
 * Zurueck kommt `null`, wenn der Zug die Zelle nicht sauber durchquert - dann
 * uebernimmt die Unterteilung in `baueNetz`.
 */
function teileZelle(zelle, zug, netz) {
  const { px, pz } = netz;
  const n = zelle.length;

  const drin = (x, z) => {
    for (let i = 0; i < n; i++) {
      const a = zelle[i], b = zelle[(i + 1) % n];
      if (flaeche2(px[a], pz[a], px[b], pz[b], x, z) > 1e-9) return false;
    }
    return true;
  };

  // Die Stelle suchen, an der der Zug den Zellrand kreuzt.
  const treffer = [];
  for (let k = 0; k + 1 < zug.length; k++) {
    for (let i = 0; i < n; i++) {
      const a = zelle[i], b = zelle[(i + 1) % n];
      const s = strecken(px[zug[k]], pz[zug[k]], px[zug[k + 1]], pz[zug[k + 1]],
                         px[a], pz[a], px[b], pz[b]);
      if (!s) continue;
      const x = px[zug[k]] + (px[zug[k + 1]] - px[zug[k]]) * s.t;
      const z = pz[zug[k]] + (pz[zug[k + 1]] - pz[zug[k]]) * s.t;
      const m = zwischenMarke(netz.marke[zug[k]], netz.marke[zug[k + 1]], s.t);
      treffer.push({ k, t: s.t, rand: i, u: s.u, id: netz.punkt(x, z, m) });
    }
  }
  // KEINE KREUZUNG heisst nicht „ungeloest", sondern meistens „geht mich
  // nichts an": eingetragen wird nach Kaesten, und der Kasten einer schraegen
  // Strecke deckt Zellen ab, durch die sie gar nicht laeuft. Nur wenn der Lauf
  // dabei INNERHALB der Zelle liegt, ist wirklich etwas offen - dann endet er
  // dort, und die Zelle kann nicht laengs seiner geteilt werden.
  if (treffer.length === 0) {
    return drin(px[zug[0]], pz[zug[0]]) ? null : [];
  }
  if (treffer.length !== 2) return null;
  treffer.sort((a, b) => (a.k - b.k) || (a.t - b.t));
  const [ein, aus] = treffer;
  if (ein.id === aus.id) return null;

  // Das Stueck des Zuges zwischen den beiden Kreuzungen
  const mitte = [ein.id];
  for (let k = ein.k + 1; k <= aus.k; k++) {
    if (drin(px[zug[k]], pz[zug[k]])) mitte.push(zug[k]);
  }
  mitte.push(aus.id);

  // Der Zellrand von `aus` bis `ein` - und einmal andersherum
  const bogen = (von, bis) => {
    const out = [von.id];
    let i = von.rand;
    let wache = 0;
    while (wache++ <= n) {
      if (i === bis.rand && !(von.rand === bis.rand && bis.u < von.u)) break;
      out.push(zelle[(i + 1) % n]);
      i = (i + 1) % n;
    }
    out.push(bis.id);
    return out;
  };

  const a = mitte.concat(bogen(aus, ein).slice(1, -1));
  const b = mitte.slice().reverse().concat(bogen(ein, aus).slice(1, -1));
  return [a, b].filter((q) => q.length >= 3);
}

/* ---------------- Der Punktsatz ---------------- */

/**
 * Punkte werden ueber ein Raster entdoppelt. Zwei Zellen, die dieselbe Wegkante
 * schneiden, rechnen denselben Schnittpunkt zweimal aus; ohne Entdoppelung
 * stuenden dort zwei Knoten aufeinander. Geometrisch waere das dicht, aber
 * jeder spaetere Durchgang muesste beide gleich behandeln - und beim Glaetten
 * taeten sie es nicht.
 */
function punktSatz(zelle = 1e-4) {
  const px = [], pz = [], marke = [];
  const map = new Map();
  const schluessel = (x, z) =>
    `${Math.round(x / zelle)},${Math.round(z / zelle)}`;

  function punkt(x, z, m = null) {
    const k = schluessel(x, z);
    const da = map.get(k);
    if (da !== undefined) {
      if (m && !marke[da]) marke[da] = m;
      return da;
    }
    px.push(x); pz.push(z); marke.push(m);
    const id = px.length - 1;
    map.set(k, id);
    return id;
  }
  return { px, pz, marke, punkt };
}

/* ---------------- Aufbau ---------------- */

/**
 * Das Netz in der EBENE aufbauen. Danach steht der Punktsatz fest.
 *
 * Zurueck kommt:
 *   punkte  { px, pz, py, marke }   marke[i] = { p, k, sgn } bei Wegpunkten
 *   wiese   Dreiecksindizes der Wiese
 *   baender Dreiecksindizes je Weg
 */
export function baueNetz(paths, cfg) {
  const netz = punktSatz();
  const { px, pz } = netz;
  const size = cfg.durchmesser;
  const seg = Math.min(1024, Math.max(8, Math.round(size / cfg.gitter)));
  const step = size / seg;
  const wo = (i) => -size / 2 + i * step;

  // ---- 1. Bandpunkte und Banddreiecke ----
  const kante = paths.map((p) => {
    const m = p.samples.length;
    const half = p.width / 2;
    const links = new Int32Array(m), rechts = new Int32Array(m);
    for (let k = 0; k < m; k++) {
      const a = bandPunkt(p, k, -1, half, 0);
      const b = bandPunkt(p, k, 1, half, 0);
      links[k] = netz.punkt(a.x, a.z, { p: p.index, k, sgn: -1 });
      rechts[k] = netz.punkt(b.x, b.z, { p: p.index, k, sgn: 1 });
    }
    return { links, rechts };
  });

  const baender = paths.map((p, pi) => {
    const m = p.samples.length;
    const n = p.closed ? m : m - 1;
    const { links, rechts } = kante[pi];
    const tri = [];
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % m;
      // Wicklung wie in `buildPathMesh`: gegen den Uhrzeigersinn von oben.
      tri.push(links[k], rechts[k], links[k2]);
      tri.push(rechts[k], rechts[k2], links[k2]);
    }
    return tri;
  });

  // ---- 2. Den Umriss der Wegflaechen in Zellen einsortieren ----
  const zuege = vereinigungsUmriss(paths, kante, netz);
  const eimer = new Map();
  const schl = (i, j) => i * 100000 + j;
  const zuI = (x) => Math.floor((x + size / 2) / step);
  // EINGETRAGEN WIRD JEDE STRECKE EINZELN, nicht der ganze Streckenzug.
  //
  // Ein Zug ist nach dem Zusammensetzen mehrere hundert Meter lang und
  // durchquert dieselbe Zelle unter Umstaenden mehrfach - an einer Schlinge des
  // Rundwegs etwa. Wer ihn als Ganzes uebergibt, bekommt vier statt zwei
  // Kreuzungen mit dem Zellrand und weiss nicht mehr, welche zu welcher
  // gehoert. Aus den Einzelstrecken setzt die Zelle sich ihre LAEUFE selbst
  // zusammen, und jeder Lauf durchquert sie genau einmal.
  zuege.forEach((zug, zi) => {
    for (let k = 0; k + 1 < zug.length; k++) {
      const a = zug[k], b = zug[k + 1];
      const i0 = Math.min(zuI(px[a]), zuI(px[b])), i1 = Math.max(zuI(px[a]), zuI(px[b]));
      const j0 = Math.min(zuI(pz[a]), zuI(pz[b])), j1 = Math.max(zuI(pz[a]), zuI(pz[b]));
      for (let i = Math.max(0, i0); i <= Math.min(seg - 1, i1); i++) {
        for (let j = Math.max(0, j0); j <= Math.min(seg - 1, j1); j++) {
          const s = schl(i, j);
          if (!eimer.has(s)) eimer.set(s, []);
          eimer.get(s).push(zi * 1e6 + k);
        }
      }
    }
  });

  /** Aus den Strecken einer Zelle zusammenhaengende Laeufe machen. */
  const laeufe = (liste) => {
    const sortiert = liste.slice().sort((a, b) => a - b);
    let out = [];
    let lauf = null, vorZi = -1, vorK = -2;
    for (const s of sortiert) {
      const zi = Math.floor(s / 1e6), k = s % 1e6;
      if (zi === vorZi && k === vorK + 1) lauf.push(zuege[zi][k + 1]);
      else { lauf = [zuege[zi][k], zuege[zi][k + 1]]; out.push(lauf); }
      vorZi = zi; vorK = k;
    }

    // UND DANN UEBER DIE ZUGGRENZEN HINWEG ZUSAMMENHAENGEN.
    //
    // Wo die Kante einer Abkuerzung auf die des Rundwegs trifft, hoert der eine
    // Streckenzug auf und der andere faengt an - am selben Punkt. Bleiben die
    // beiden Laeufe getrennt, endet in dieser Zelle ein Lauf mitten im Raum,
    // statt sie zu durchqueren, und die Zelle laesst sich nicht teilen. Sie
    // fiel dann als GANZE aus - und weil ihr Mittelpunkt zufaellig neben dem
    // Weg lag, wurde sie ganz ausgegeben und legte sich ueber den Belag.
    for (let runde = 0; runde < out.length; runde++) {
      let verbunden = false;
      for (let i = 0; i < out.length && !verbunden; i++) {
        for (let j = 0; j < out.length; j++) {
          if (i === j) continue;
          if (out[i][out[i].length - 1] !== out[j][0]) continue;
          out[i] = out[i].concat(out[j].slice(1));
          out.splice(j, 1);
          verbunden = true;
          break;
        }
      }
      if (!verbunden) break;
    }
    return out;
  };

  // Liegt ein Punkt auf einer befestigten Flaeche?
  const aufWeg = (x, z) => {
    for (const p of paths) if (flaechenAbstandLokal(p, x, z) < 0) return true;
    return false;
  };

  // ---- 3. Zellen beschneiden ----
  const wiese = [];
  const ausgeben = (poly) => {
    let f = 0;
    for (let k = 1; k + 1 < poly.length; k++) {
      f += flaeche2(px[poly[0]], pz[poly[0]], px[poly[k]], pz[poly[k]],
                    px[poly[k + 1]], pz[poly[k + 1]]);
    }
    // NUR ECHT FLAECHENLOSES WEGWERFEN. Ein Splitter von einem Quadratmillimeter
    // sieht man nicht - das Loch, das er hinterlaesst, aber schon: dort liegt
    // dann weder Wiese noch Belag, und man schaut in die Landschaft. Die Grenze
    // liegt deshalb bei einem Hundertstel Quadratmillimeter, nicht bei zwei
    // Quadratzentimetern.
    if (Math.abs(f) < 2e-8) return;
    ohren(poly, px, pz, wiese);
  };

  const mitte2 = (poly) => {
    let x = 0, z = 0;
    for (const q of poly) { x += px[q]; z += pz[q]; }
    return [x / poly.length, z / poly.length];
  };

  /** Eine Zelle (als Polygon) gegen die Zuege beschneiden. */
  let rueckfaelle = 0;
  function zelle(poly, zi) {
    if (!zi || zi.length === 0) {
      const [mx, mz] = mitte2(poly);
      if (!aufWeg(mx, mz)) ausgeben(poly);
      return;
    }
    // Ein Lauf nach dem anderen; die Stuecke wandern weiter.
    let stuecke = [poly];
    let offen = false;
    for (const lauf of laeufe(zi)) {
      const naechste = [];
      for (const st of stuecke) {
        const geteilt = teileZelle(st, lauf, netz);
        if (geteilt === null) { naechste.push(st); offen = true; }
        else if (geteilt.length === 0) naechste.push(st);   // beruehrt nicht
        else naechste.push(...geteilt);
      }
      stuecke = naechste;
    }
    if (offen) {
      // Eine Zelle, die der Umriss nicht sauber durchquert - das kommt an
      // Einmuendungen vor, wo mehrere Kanten zusammenlaufen. Sie wird ALS
      // GANZES entschieden.
      //
      // Nicht unterteilt: eine unterteilte Zelle bekaeme auf ihrem Rand Punkte,
      // die die ganze Nachbarzelle nicht hat, und genau das ist eine T-Naht.
      // Lieber eine Zelle zu viel oder zu wenig an einer Stelle, die ohnehin
      // unter dem Weg liegt, als ein Riss, durch den man in die Landschaft
      // sieht.
      rueckfaelle++;
      const [mx, mz] = mitte2(poly);
      if (!aufWeg(mx, mz)) ausgeben(poly);
      return;
    }
    for (const st of stuecke) {
      const [mx, mz] = mitte2(st);
      if (!aufWeg(mx, mz)) ausgeben(st);
    }
  }

  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const c = [
        netz.punkt(wo(i), wo(j)), netz.punkt(wo(i), wo(j + 1)),
        netz.punkt(wo(i + 1), wo(j + 1)), netz.punkt(wo(i + 1), wo(j)),
      ];
      zelle(c, eimer.get(schl(i, j)));
    }
  }

  return { netz, wiese, baender, kante, zuege, seg, step, rueckfaelle };
}

/* ---------------- Durchgang 1: das Gelaende ---------------- */

/** Jeder Punkt bekommt seine Rauschhoehe. Mehr passiert hier nicht. */
export function verforme(netz, base) {
  const { px, pz } = netz;
  const py = new Float64Array(px.length);
  for (let i = 0; i < px.length; i++) py[i] = base.heightAt(px[i], pz[i]);
  netz.py = py;
  return py;
}

/* ---------------- Durchgang 2: die Wege ebnen ---------------- */

/**
 * Die Wegpunkte auf ihre Bandhoehe setzen - und damit festnageln.
 *
 * Die Hoehen stehen laengst fest: `verknuepfeWege` hat sie gerechnet, mitsamt
 * der Querneigung an den Einmuendungen und dem Plateau am Tor. Hier werden sie
 * nur noch in das Netz uebertragen. Rueckgabe ist das Feld `fest`: was darin
 * steht, ruehrt Durchgang 3 nicht mehr an.
 */
export function ebnePfade(netz, paths, cfg) {
  const { marke, py } = netz;
  const fest = new Uint8Array(py.length);
  const nachIndex = new Map(paths.map((p) => [p.index, p]));
  for (let i = 0; i < marke.length; i++) {
    const m = marke[i];
    if (!m) continue;
    const p = nachIndex.get(m.p);
    if (!p) continue;
    const half = p.width / 2;
    const len = p.samples.length;
    const k0 = Math.min(len - 1, Math.max(0, Math.floor(m.k + 1e-9)));
    const f = m.k - k0;
    const k1 = p.closed ? (k0 + 1) % len : Math.min(k0 + 1, len - 1);
    const a = p.samples[k0], b = p.samples[k1];
    // Die Bandkante zwischen zwei Stuetzstellen ist eine Gerade im Raum - eine
    // lineare Mischung der beiden Randhoehen trifft sie also genau.
    const ya = a.y + a.roll * half * m.sgn;
    const yb = b.y + b.roll * half * m.sgn;
    py[i] = ya + (yb - ya) * f;
    fest[i] = 1;
  }
  netz.fest = fest;
  return fest;
}

/* ---------------- Durchgang 3: die Gefaelle glaetten ---------------- */

/**
 * Was frueher die Wegplanie war, ist jetzt ein Ausgleich im Netz.
 *
 * Die alte Loesung hat die Wiese in einem Streifen neben dem Weg auf dessen
 * Hoehe gezogen und dabei IMMER NUR EINEN Weg gefragt, den naechsten. Wo zwei
 * Wege dicht beieinander laufen, sprang die Antwort von einem zum anderen, und
 * dazwischen stand eine Stufe.
 *
 * Der Ausgleich kennt dieses Problem nicht: er fragt nicht nach Wegen, sondern
 * mittelt jeden freien Punkt gegen seine Nachbarn. Liegen links und rechts zwei
 * verschieden hohe Wege, ergibt sich die Rampe dazwischen von selbst.
 *
 * Gewichtet nach Abstand zum naechsten festen Punkt - in RINGEN gezaehlt, nicht
 * in Metern, denn das Netz ist neben den Wegen feiner als in der Flaeche. Wer
 * weit genug weg ist, bleibt unangetastet: die Huegel der Wiese sollen ja nicht
 * weggeglaettet werden.
 */
export function glaette(netz, dreiecke, cfg) {
  const { py, fest } = netz;
  const n = py.length;

  // Nachbarschaft aus den Dreiecken
  const grad = new Int32Array(n);
  for (let t = 0; t < dreiecke.length; t += 3) {
    grad[dreiecke[t]] += 2; grad[dreiecke[t + 1]] += 2; grad[dreiecke[t + 2]] += 2;
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + grad[i];
  const nachbar = new Int32Array(start[n]);
  const fuell = start.slice(0, n);
  const setze = (a, b) => { nachbar[fuell[a]++] = b; };
  for (let t = 0; t < dreiecke.length; t += 3) {
    const a = dreiecke[t], b = dreiecke[t + 1], c = dreiecke[t + 2];
    setze(a, b); setze(a, c); setze(b, a); setze(b, c); setze(c, a); setze(c, b);
  }

  // Ringabstand zu den festen Punkten
  const ring = new Int32Array(n).fill(-1);
  let welle = [];
  for (let i = 0; i < n; i++) if (fest[i]) { ring[i] = 0; welle.push(i); }
  if (!welle.length) return;
  const weite = Math.max(1, Math.round(cfg.wegBoeschung / cfg.gitter));
  for (let r = 1; r <= weite && welle.length; r++) {
    const naechste = [];
    for (const i of welle) {
      for (let e = start[i]; e < start[i + 1]; e++) {
        const j = nachbar[e];
        if (ring[j] < 0) { ring[j] = r; naechste.push(j); }
      }
    }
    welle = naechste;
  }

  const gewicht = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    gewicht[i] = fest[i] || ring[i] < 0 ? 0 : 1 - (ring[i] - 1) / weite;
  }

  const puffer = new Float64Array(n);
  const runden = weite * 8;
  for (let d = 0; d < runden; d++) {
    for (let i = 0; i < n; i++) {
      const w = gewicht[i];
      if (w <= 0) { puffer[i] = py[i]; continue; }
      let su = 0, z = 0;
      for (let e = start[i]; e < start[i + 1]; e++) { su += py[nachbar[e]]; z++; }
      puffer[i] = z ? py[i] + w * (su / z - py[i]) : py[i];
    }
    py.set(puffer);
  }
}

/* ---------------- Das Hoehenfeld aus dem Netz ---------------- */

/**
 * Ab hier ist DAS NETZ die Hoehenquelle - nicht mehr eine Formel, die man an
 * beliebiger Stelle abfragt.
 *
 * Das ist keine Formsache. Durchgang 3 erzeugt Hoehen, die keine geschlossene
 * Funktion mehr beschreibt; wer weiter die alte Formel fragte, bekaeme neben
 * den Wegen eine andere Antwort als das, was man dort sieht - und Felsen,
 * Baeume, Grasbueschel und die Kamera saessen um Zentimeter daneben.
 *
 * Die Signatur bleibt gleich, kein Aufrufer merkt etwas. Ausserhalb des
 * Gartenquadrats antwortet weiterhin das Rauschgelaende; dort ist es ohnehin
 * auf null ausgelaufen.
 */
export function hoehenfeldAusNetz(netz, dreiecke, base, cfg) {
  const { px, pz, py } = netz;
  const size = cfg.durchmesser;
  const zelle = Math.max(1, cfg.gitter * 2);
  const eimer = new Map();
  const schl = (i, j) => i * 100000 + j;
  const zuI = (v) => Math.floor(v / zelle);

  for (let t = 0; t < dreiecke.length; t += 3) {
    const a = dreiecke[t], b = dreiecke[t + 1], c = dreiecke[t + 2];
    const i0 = zuI(Math.min(px[a], px[b], px[c])), i1 = zuI(Math.max(px[a], px[b], px[c]));
    const j0 = zuI(Math.min(pz[a], pz[b], pz[c])), j1 = zuI(Math.max(pz[a], pz[b], pz[c]));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const s = schl(i, j);
        if (!eimer.has(s)) eimer.set(s, []);
        eimer.get(s).push(t);
      }
    }
  }

  function heightAt(x, z) {
    if (Math.abs(x) > size / 2 || Math.abs(z) > size / 2) return base.heightAt(x, z);
    const liste = eimer.get(schl(zuI(x), zuI(z)));
    if (liste) {
      for (const t of liste) {
        const a = dreiecke[t], b = dreiecke[t + 1], c = dreiecke[t + 2];
        const ax = px[a], az = pz[a], bx = px[b], bz = pz[b], cx = px[c], cz = pz[c];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        if (u < -1e-7) continue;
        const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        if (v < -1e-7 || u + v > 1 + 1e-7) continue;
        return u * py[a] + v * py[b] + (1 - u - v) * py[c];
      }
    }
    // Faellt eine Abfrage durch alle Dreiecke - an der Aussenkante, oder in
    // einem der wenigen Splitter, die beim Beschneiden verworfen wurden -,
    // antwortet das Rauschgelaende. Der Unterschied liegt dort im Millimeter.
    return base.heightAt(x, z);
  }

  function normalAt(x, z, eps = 0.25) {
    const hx = heightAt(x + eps, z) - heightAt(x - eps, z);
    const hz = heightAt(x, z + eps) - heightAt(x, z - eps);
    const l = Math.hypot(hx, 2 * eps, hz) || 1;
    return { x: -hx / l, y: (2 * eps) / l, z: -hz / l };
  }

  function neigung(x, z, eps = 0.4) {
    const gx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps);
    const gz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps);
    return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
  }

  return { ...base, heightAt, normalAt, neigung, base, netz };
}


/* ---------------- Netze ---------------- */

/** Die Wiese als ein Netz. Die Kachelung laeuft ueber die Weltkoordinaten. */
export function baueWiesenMesh(netz, wiese, cfg, material) {
  const { px, pz, py } = netz;
  const n = px.length;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const tile = cfg.kachelWiese;
  for (let i = 0; i < n; i++) {
    pos[i * 3] = px[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = pz[i];
    uv[i * 2] = px[i] / tile; uv[i * 2 + 1] = pz[i] / tile;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(wiese);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'boden';
  return mesh;
}

/**
 * Ein Wegband. Die Punkte kommen aus dem Netz - dieselben, an denen auch die
 * Wiese endet -, die Kachelung aus der Bogenlaenge.
 *
 * Eigene Vertexliste statt der gemeinsamen: die Naht des Rundwegs braucht die
 * erste Stuetzstelle ein zweites Mal, mit s = Gesamtlaenge. Geometrisch
 * derselbe Punkt, in der Textur der richtige - sonst spannte das letzte Viereck
 * die Kachelung des ganzen Rundwegs auf eine Stuetzstellenbreite zusammen und
 * wurde einfarbig grau.
 */
export function baueWegMesh(netz, path, kante, cfg, material) {
  const { px, pz, py } = netz;
  const m = path.samples.length;
  const half = path.width / 2;
  const tile = path.kachel;
  const n = path.closed ? m + 1 : m;

  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx = [];
  for (let k = 0; k < n; k++) {
    const kk = k % m;
    const s = k === m ? path.total : path.samples[kk].s;
    for (let side = 0; side < 2; side++) {
      const id = side === 0 ? kante.links[kk] : kante.rechts[kk];
      const o = (k * 2 + side) * 3;
      pos[o] = px[id]; pos[o + 1] = py[id]; pos[o + 2] = pz[id];
      const u = (k * 2 + side) * 2;
      uv[u] = ((side === 0 ? -half : half)) / tile + 0.5;
      uv[u + 1] = s / tile;
    }
  }
  for (let k = 0; k < n - 1; k++) {
    const a = k * 2, b = k * 2 + 1, c = (k + 1) * 2, d = (k + 1) * 2 + 1;
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
