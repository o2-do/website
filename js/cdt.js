/**
 * Constrained Delaunay - Triangulierung mit Zwangskanten.
 *
 * WOZU. Die Wiese ist kein Gitter mehr, das an den Wegen beschnitten wird,
 * sondern eine Punktwolke: die Randpunkte der Wege, dazu Rasterpunkte, die dem
 * Rand bewusst fernbleiben. Aus so einer Wolke ein Netz zu machen, ist genau
 * das, was Delaunay tut - und die ZWANGSKANTEN sorgen dafuer, dass die
 * Wegkanten wirklich Kanten des Netzes werden und nicht ueberbrueckt.
 *
 * Ohne den Zwang wuerde die Triangulierung in einem spitzen Winkel - und genau
 * dort sassen bisher die Luecken - munter ueber die Wegkante hinweg verbinden,
 * weil die Punkte auf der anderen Seite naeher liegen.
 *
 * Verfahren: Bowyer-Watson. Ein Superdreieck umschliesst alles, dann wird Punkt
 * fuer Punkt eingefuegt: alle Dreiecke, in deren Umkreis der neue Punkt faellt,
 * bilden ein Loch, das sternfoermig neu vernetzt wird. Danach werden die
 * Zwangskanten erzwungen, indem die von ihnen durchschnittenen Dreiecke
 * entfernt und die beiden entstehenden Vielecke neu vernetzt werden.
 *
 * ZUR ROBUSTHEIT: ein regelmaessiges Raster ist der schlimmste denkbare Fall
 * fuer Delaunay, weil je vier Punkte auf einem Kreis liegen und die Entscheidung
 * dann am Rundungsfehler haengt. Deshalb werden die Rasterpunkte verwackelt
 * (siehe `wegnetz.js`) - das nimmt die Entartung und sieht bei einer Wiese
 * ohnehin besser aus als ein Schachbrett.
 */

const EPS = 1e-12;

export const flaeche2 = (ax, az, bx, bz, cx, cz) =>
  (bx - ax) * (cz - az) - (cx - ax) * (bz - az);

/** Liegt p im Umkreis des (gegen den Uhrzeigersinn gelegten) Dreiecks abc? */
function imKreis(ax, az, bx, bz, cx, cz, px, pz) {
  const adx = ax - px, adz = az - pz;
  const bdx = bx - px, bdz = bz - pz;
  const cdx = cx - px, cdz = cz - pz;
  const ad = adx * adx + adz * adz;
  const bd = bdx * bdx + bdz * bdz;
  const cd = cdx * cdx + cdz * cdz;
  return adx * (bdz * cd - bd * cdz)
       - adz * (bdx * cd - bd * cdx)
       + ad * (bdx * cdz - bdz * cdx) > EPS;
}

/**
 * Netz aus Dreiecken mit Nachbarschaft.
 *
 * `t[3i..3i+2]` sind die Ecken, `n[3i+e]` das Dreieck jenseits der Kante e
 * (die Kante e liegt zwischen Ecke e und e+1), oder -1.
 */
function netz() {
  return { t: [], n: [], tot: [] };
}

const setzeNachbar = (N, tri, kante, andere) => { N.n[tri * 3 + kante] = andere; };

function kanteVon(N, tri, a, b) {
  for (let e = 0; e < 3; e++) {
    if (N.t[tri * 3 + e] === a && N.t[tri * 3 + (e + 1) % 3] === b) return e;
  }
  return -1;
}

export function triangulate(px, pz, zwang) {
  const n = px.length;
  if (n < 3) return [];

  // Superdreieck: gross genug, dass alle Punkte weit im Inneren liegen.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (px[i] < minX) minX = px[i];
    if (px[i] > maxX) maxX = px[i];
    if (pz[i] < minZ) minZ = pz[i];
    if (pz[i] > maxZ) maxZ = pz[i];
  }
  const d = Math.max(maxX - minX, maxZ - minZ) * 10 + 10;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const X = Float64Array.from([...px, cx - d, cx + d, cx]);
  const Z = Float64Array.from([...pz, cz - d, cz - d, cz + d]);
  const S = [n, n + 1, n + 2];

  const N = netz();
  N.t.push(S[0], S[1], S[2]);
  N.n.push(-1, -1, -1);
  N.tot.push(false);

  const lebt = (i) => !N.tot[i];
  const anz = () => N.tot.length;

  /** Enthaelt das Dreieck den Punkt? */
  const drin = (i, x, z) => {
    const a = N.t[i * 3], b = N.t[i * 3 + 1], c = N.t[i * 3 + 2];
    return flaeche2(X[a], Z[a], X[b], Z[b], x, z) >= -1e-10
        && flaeche2(X[b], Z[b], X[c], Z[c], x, z) >= -1e-10
        && flaeche2(X[c], Z[c], X[a], Z[a], x, z) >= -1e-10;
  };

  /** Von `start` aus zum Dreieck laufen, das den Punkt enthaelt. */
  let letztes = 0;
  function suche(x, z) {
    let i = letztes;
    if (i >= anz() || N.tot[i]) { i = 0; while (i < anz() && N.tot[i]) i++; }
    if (i >= anz()) return -1;
    for (let schritt = 0; schritt < 5 * anz() + 20; schritt++) {
      let weiter = -1;
      for (let e = 0; e < 3; e++) {
        const a = N.t[i * 3 + e], b = N.t[i * 3 + (e + 1) % 3];
        if (flaeche2(X[a], Z[a], X[b], Z[b], x, z) < -1e-10) {
          const nb = N.n[i * 3 + e];
          if (nb >= 0) { weiter = nb; break; }
        }
      }
      if (weiter < 0) return i;
      i = weiter;
    }
    for (let k = 0; k < anz(); k++) if (lebt(k) && drin(k, x, z)) return k;
    return -1;
  }

  /** Punkt einfuegen (Bowyer-Watson). */
  function einfuegen(p) {
    const start = suche(X[p], Z[p]);
    if (start < 0) return;

    // Das Loch: alle Dreiecke, in deren Umkreis p faellt.
    const loch = [];
    const gesehen = new Set([start]);
    const stapel = [start];
    while (stapel.length) {
      const i = stapel.pop();
      const a = N.t[i * 3], b = N.t[i * 3 + 1], c = N.t[i * 3 + 2];
      if (i !== start && !imKreis(X[a], Z[a], X[b], Z[b], X[c], Z[c], X[p], Z[p])) continue;
      loch.push(i);
      for (let e = 0; e < 3; e++) {
        const nb = N.n[i * 3 + e];
        if (nb >= 0 && !gesehen.has(nb)) { gesehen.add(nb); stapel.push(nb); }
      }
    }

    // Der Rand des Lochs: Kanten, deren Gegenueber nicht im Loch liegt.
    const imLoch = new Set(loch);
    const rand = [];
    for (const i of loch) {
      for (let e = 0; e < 3; e++) {
        const nb = N.n[i * 3 + e];
        if (nb >= 0 && imLoch.has(nb)) continue;
        rand.push([N.t[i * 3 + e], N.t[i * 3 + (e + 1) % 3], nb]);
      }
    }
    for (const i of loch) N.tot[i] = true;

    // Sternfoermig neu vernetzen und die Nachbarschaft flicken.
    const neu = [];
    for (const [a, b, aussen] of rand) {
      const i = anz();
      N.t.push(a, b, p);
      N.n.push(aussen, -1, -1);
      N.tot.push(false);
      neu.push(i);
      if (aussen >= 0) {
        const e = kanteVon(N, aussen, b, a);
        if (e >= 0) setzeNachbar(N, aussen, e, i);
      }
    }
    // Die neuen Dreiecke untereinander verbinden.
    //
    // Jedes hat die Ecken (a, b, p) und damit die Kanten (a,b), (b,p), (p,a).
    // Kante 2 von i - also (p,a) - grenzt an dasjenige Dreieck, dessen Kante 1
    // (b,p) dieselbe Strecke ist, das also b = a hat. Ein Nachschlag ueber b
    // genuegt.
    const nachB = new Map();
    for (const i of neu) nachB.set(N.t[i * 3 + 1], i);
    for (const i of neu) {
      const j = nachB.get(N.t[i * 3]);
      if (j !== undefined) { setzeNachbar(N, i, 2, j); setzeNachbar(N, j, 1, i); }
    }
    letztes = neu.length ? neu[0] : letztes;
  }

  for (let p = 0; p < n; p++) einfuegen(p);

  /* ---- Zwangskanten erzwingen ---- */

  // Schneller Nachschlag: welche Dreiecke haengen an einem Punkt?
  const anPunkt = new Map();
  const merkeEcken = () => {
    anPunkt.clear();
    for (let i = 0; i < anz(); i++) {
      if (N.tot[i]) continue;
      for (let e = 0; e < 3; e++) {
        const v = N.t[i * 3 + e];
        if (!anPunkt.has(v)) anPunkt.set(v, []);
        anPunkt.get(v).push(i);
      }
    }
  };
  merkeEcken();

  /**
   * Die Nachbarschaft aus den Dreiecken neu aufbauen.
   *
   * Noetig, weil das Ohrenschneiden beim Durchsetzen einer Zwangskante neue
   * Dreiecke ohne Nachbarn anlegt. Ohne den Neuaufbau laeuft der naechste
   * Korridor in dieses Gebiet und findet dort eine Sackgasse - die Zwangskante
   * wird dann stillschweigend nicht durchgesetzt, und die Triangulierung
   * verbindet quer ueber die Wegkante hinweg.
   */
  const baueNachbarn = () => {
    const kante = new Map();
    for (let i = 0; i < anz(); i++) {
      if (N.tot[i]) continue;
      for (let e = 0; e < 3; e++) {
        N.n[i * 3 + e] = -1;
        const p1 = N.t[i * 3 + e], p2 = N.t[i * 3 + (e + 1) % 3];
        const k = p1 < p2 ? `${p1},${p2}` : `${p2},${p1}`;
        const da = kante.get(k);
        if (da === undefined) kante.set(k, i * 3 + e);
        else { N.n[i * 3 + e] = (da / 3) | 0; N.n[da] = i; }
      }
    }
  };

  const kanteDa = (a, b) => {
    for (const i of anPunkt.get(a) || []) {
      if (N.tot[i]) continue;
      for (let e = 0; e < 3; e++) {
        const u = N.t[i * 3 + e], v = N.t[i * 3 + (e + 1) % 3];
        if ((u === a && v === b) || (u === b && v === a)) return true;
      }
    }
    return false;
  };

  /** Die dritte Ecke des Dreiecks neben u,v. */
  const dritte = (tri, u, v) => {
    for (let e = 0; e < 3; e++) {
      const w = N.t[tri * 3 + e];
      if (w !== u && w !== v) return w;
    }
    return -1;
  };
  const nachbarUeber = (tri, u, v) => {
    for (let e = 0; e < 3; e++) {
      const p1 = N.t[tri * 3 + e], p2 = N.t[tri * 3 + (e + 1) % 3];
      if ((p1 === u && p2 === v) || (p1 === v && p2 === u)) return N.n[tri * 3 + e];
    }
    return -1;
  };

  /**
   * Ein Vieleck vernetzen - Ohrenschneiden, umlaufsinnfest.
   *
   * Die beiden Haelften eines aufgetrennten Korridors sind einfach, aber nicht
   * konvex; ein Faecher vom ersten Punkt aus wuerde ueber die Kerbe
   * hinweggreifen.
   */
  function ohren(poly) {
    if (poly.length < 3) return;
    let f = 0;
    for (let k = 1; k + 1 < poly.length; k++) {
      f += flaeche2(X[poly[0]], Z[poly[0]], X[poly[k]], Z[poly[k]],
                    X[poly[k + 1]], Z[poly[k + 1]]);
    }
    const rest = f < 0 ? poly.slice().reverse() : poly.slice();
    let wache = 0;
    while (rest.length > 2 && wache++ < 4 * poly.length) {
      let ok = false;
      let flachste = -1, flachsteFlaeche = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const u = rest[(i - 1 + rest.length) % rest.length];
        const v = rest[i];
        const q = rest[(i + 1) % rest.length];
        const fl = flaeche2(X[u], Z[u], X[v], Z[v], X[q], Z[q]);
        if (Math.abs(fl) < flachsteFlaeche) { flachsteFlaeche = Math.abs(fl); flachste = i; }
        if (fl <= EPS) continue;
        let frei = true;
        for (const r of rest) {
          if (r === u || r === v || r === q) continue;
          if (flaeche2(X[u], Z[u], X[v], Z[v], X[r], Z[r]) >= 0
           && flaeche2(X[v], Z[v], X[q], Z[q], X[r], Z[r]) >= 0
           && flaeche2(X[q], Z[q], X[u], Z[u], X[r], Z[r]) >= 0) { frei = false; break; }
        }
        if (!frei) continue;
        N.t.push(u, v, q); N.n.push(-1, -1, -1); N.tot.push(false);
        rest.splice(i, 1);
        ok = true;
        break;
      }
      if (ok) continue;
      // KEIN GUELTIGES OHR MEHR - trotzdem weitermachen.
      //
      // An den Einmuendungen haeufen sich Punkte, und viele liegen fast auf
      // einer Geraden. Dann findet das Ohrenschneiden kein Dreieck mehr mit
      // echter Flaeche und bliebe stehen - das Vieleck bliebe unvollstaendig
      // vernetzt, und mit ihm fehlten Kanten seines Randes. Genau das waren die
      // Stellen, an denen ein Dreieck ueber die Wegkante hinweggriff: die
      // Zwangskante war dort schlicht nicht im Netz.
      //
      // Statt aufzugeben wird die FLACHSTE Ecke entfernt, ohne ein Dreieck
      // auszugeben. Sie hat ohnehin keine Flaeche beizutragen; das Vieleck
      // schliesst sich um sie herum, und sein Rand bleibt vollstaendig.
      if (flachste < 0 || rest.length <= 3) break;
      rest.splice(flachste, 1);
    }
  }

  for (const [a, b] of zwang) {
    if (a === b || kanteDa(a, b)) continue;

    // DEN KORRIDOR ABLAUFEN, nicht absuchen.
    //
    // Von a aus in das Dreieck eintreten, in dessen Keil b liegt, und dann
    // immer durch die Kante weitergehen, durch die die Strecke wieder
    // hinausfuehrt. Nebenbei sammeln sich die Ecken links und rechts der
    // Strecke - das sind genau die beiden Vielecke, die danach neu zu vernetzen
    // sind. Eine Breitensuche kam hier nicht weit: sie hoerte auf, sobald ein
    // Dreieck die Strecke nicht mehr schnitt, und verlor damit gerade das
    // letzte am Zielpunkt.
    let start = -1, u0 = -1, v0 = -1;
    for (const tri of anPunkt.get(a) || []) {
      if (N.tot[tri]) continue;
      for (let e = 0; e < 3; e++) {
        if (N.t[tri * 3 + e] !== a) continue;
        const u = N.t[tri * 3 + (e + 1) % 3], v = N.t[tri * 3 + (e + 2) % 3];
        if (u === b || v === b) { start = -2; break; }
        if (flaeche2(X[a], Z[a], X[u], Z[u], X[b], Z[b]) > 0
         && flaeche2(X[a], Z[a], X[v], Z[v], X[b], Z[b]) < 0) {
          start = tri; u0 = u; v0 = v;
        }
      }
      if (start === -2 || start >= 0) break;
    }
    if (start < 0) continue;

    const korridor = [start];
    const links = [a, v0], rechts = [a, u0];
    let u = u0, v = v0, tri = start, ok = false;
    for (let schritt = 0; schritt < anz() + 10; schritt++) {
      const nb = nachbarUeber(tri, u, v);
      if (nb < 0) break;
      korridor.push(nb);
      const w = dritte(nb, u, v);
      if (w === b) { ok = true; break; }
      if (flaeche2(X[a], Z[a], X[b], Z[b], X[w], Z[w]) > 0) { links.push(w); v = w; }
      else { rechts.push(w); u = w; }
      tri = nb;
    }
    if (!ok) continue;
    links.push(b); rechts.push(b);

    for (const i of korridor) N.tot[i] = true;
    ohren(links);
    ohren(rechts);
    baueNachbarn();
    merkeEcken();
  }

  // Nachbarschaft neu aufbauen und das Superdreieck entfernen.
  const raus = [];
  for (let i = 0; i < anz(); i++) {
    if (N.tot[i]) continue;
    const a = N.t[i * 3], b = N.t[i * 3 + 1], c = N.t[i * 3 + 2];
    if (a >= n || b >= n || c >= n) continue;
    // AUSGEGEBEN WIRD MIT DER NORMALEN NACH OBEN.
    //
    // Intern rechnet alles mit positiver Flaeche nach `flaeche2` - das ist der
    // uebliche Umlaufsinn gegen den Uhrzeigersinn in einer (x,y)-Ebene. Hier
    // liegt die Ebene aber in x und z, und die y-Achse zeigt nach oben: derselbe
    // Umlaufsinn ergibt dann eine Normale nach UNTEN. Beim Herausgeben wird
    // deshalb gedreht, sonst liegt die ganze Wiese mit dem Ruecken nach oben und
    // wird von unten beleuchtet.
    if (flaeche2(X[a], Z[a], X[b], Z[b], X[c], Z[c]) > 0) raus.push(a, c, b);
    else raus.push(a, b, c);
  }
  return raus;
}
