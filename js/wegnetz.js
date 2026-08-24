import * as THREE from 'three';
import { bandPunkt, WEG_RANG } from './paths.js';
import { triangulate } from './cdt.js';

/**
 * Der Punktsatz des Gartens - erst die Ebene, dann die Höhe.
 *
 * DIE REIHENFOLGE IST DAS GANZE PRINZIP. Zuerst wird ausschliesslich in der
 * Ebene gerechnet: Wegpunkte sammeln, Kanten schneiden, Rasterpunkte streuen.
 * Danach steht jeder Punkt fest, es kommt keiner mehr hinzu - und alles
 * Weitere verschiebt ihn nur noch SENKRECHT.
 *
 * Solange die Hoehe eine Funktion war, die man an beliebiger Stelle abfragt,
 * waren Wiese und Wegband zwei getrennte Naeherungen derselben Kante. Die
 * treffen sich nie genau, und dagegen brauchte es Ueberstand, Untergriff,
 * Saum, Absenkung und Ausgleichswall - fuenf Mittel gegen ein Problem. Hier
 * gibt es das Problem nicht mehr: wo zwei Flaechen aneinanderstossen, benutzen
 * sie DENSELBEN Punkt.
 *
 * DIE ZUGEHOERIGKEIT ist der zweite tragende Gedanke. Jeder Randpunkt eines
 * Weges verweist auf genau einen Mittelpunkt und uebernimmt am Ende dessen
 * Hoehe. Damit ist der Querschnitt quer waagerecht - nicht ungefaehr, sondern
 * exakt. Und weil ein Punkt auch auf den Mittelpunkt eines FREMDEN Weges
 * verweisen darf, faellt die Querneigung an einer Einmuendung von selbst an:
 * die beiden Ecken der Stirnseite gehoeren zu zwei verschiedenen Querschnitten
 * des Rundwegs, also kippt die Stirnseite genau in dessen Ebene.
 */

/* ---------------- Punktsatz ---------------- */

export const MITTE = 0;
export const RAND = 1;
export const RASTER = 2;

function punktSatz() {
  const x = [], z = [], art = [], ref = [], weg = [], bogen = [], seite = [];
  // `aus` markiert Punkte, die zwar entstanden sind, aber nicht ins Netz
  // gehoeren - siehe `beschneideWege`.
  const aus = [];
  // `kreuz` markiert die Punkte, an denen sich die Randlinien zweier WEGE
  // treffen. An ihnen wird beschnitten - und zwar an ihnen und nicht an einer
  // Abstandsschwelle: sie liegen auf der Randlinie, die gegenueber der Sehne
  // der Mittellinie um Millimeter versetzt ist, und wuerden von jeder
  // geometrischen Pruefung als „innen" eingestuft und mit weggeschnitten.
  const kreuz = [];
  // Und ebenso die Kreuzungen mit dem WIESENRAND. Dort wird der Zugang zum Tor
  // gekappt - draussen gibt es keine Wiese mehr, und damit auch nichts, woran
  // er noch anschliessen koennte.
  const randKreuz = [];
  function neu(px, pz, a, r = -1, extra = {}) {
    x.push(px); z.push(pz); art.push(a); ref.push(r); aus.push(false);
    kreuz.push(!!extra.kreuz);
    randKreuz.push(!!extra.randKreuz);
    weg.push(extra.weg === undefined ? -1 : extra.weg);
    bogen.push(extra.bogen === undefined ? 0 : extra.bogen);
    seite.push(extra.seite === undefined ? 0 : extra.seite);
    return x.length - 1;
  }
  return { x, z, art, ref, weg, bogen, seite, aus, kreuz, randKreuz, neu };
}

/* ---------------- Schritt 1: Wegpunkte sammeln ---------------- */

/**
 * Je Weg drei Listen: Mittelpunkte und die beiden Randlinien.
 *
 * Die Randpunkte tragen ausserdem, wozu sie in der TEXTUR gehoeren - Weg,
 * Bogenlaenge, Seite. Das ist bewusst getrennt von der Zugehoerigkeit: die
 * sagt, welche HOEHE ein Punkt bekommt, und an einer Einmuendung ist das der
 * Mittelpunkt eines anderen Weges. Die Kachelung darf davon nichts wissen.
 */
export function sammleWegpunkte(paths, cfg) {
  const P = punktSatz();
  const wege = paths.map((p) => {
    const m = p.samples.length;
    const half = p.width / 2;
    const mitte = [], links = [], rechts = [];
    for (let k = 0; k < m; k++) {
      const s = p.samples[k];
      const mi = P.neu(s.x, s.z, MITTE, -1, { weg: p.index, bogen: s.s });
      const a = bandPunkt(p, k, -1, half, 0);
      const b = bandPunkt(p, k, 1, half, 0);
      mitte.push(mi);
      links.push(P.neu(a.x, a.z, RAND, mi, { weg: p.index, bogen: s.s, seite: -1 }));
      rechts.push(P.neu(b.x, b.z, RAND, mi, { weg: p.index, bogen: s.s, seite: 1 }));
    }
    return { p, mitte, links, rechts, rang: WEG_RANG[p.art] ?? 0 };
  });
  return { P, wege };
}

/* ---------------- Schritt 2: Schnittpunkte ---------------- */

const EPS = 1e-9;

/**
 * Wie nah eine Kreuzung an einem vorhandenen Punkt liegen darf, bevor sie auf
 * ihn gerastet wird. Zwei Zentimeter - die Punkte einer Randlinie stehen einen
 * halben Meter auseinander, es kann also nichts Falsches zusammenfallen.
 */
const SCHNAPP = 0.02;

/** Schnitt zweier Strecken in der Ebene, als Laufparameter. */
function strecken(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az;
  const sx = dx - cx, sz = dz - cz;
  const n = rx * sz - rz * sx;
  if (Math.abs(n) < 1e-12) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / n;
  const u = ((cx - ax) * rz - (cz - az) * rx) / n;
  if (t < EPS || t > 1 - EPS || u < EPS || u > 1 - EPS) return null;
  return { t, u };
}

/** Abstand zur Flaeche eines Weges; negativ heisst drauf. */
export function aufWeg(p, x, z) {
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

/**
 * Alle Kreuzungen zwischen Linienzuegen - und der Mittelpunkt, den der
 * Kreuzungspunkt erbt.
 *
 * An einer Kreuzung wird in BEIDE Linien derselbe Punkt eingetragen. Damit
 * teilen sich die beiden Zuege dort einen Knoten, und keine Fuge kann aufgehen
 * - und, ebenso wichtig, es kreuzen sich danach keine Zwangskanten mehr. Genau
 * das setzt die Triangulierung voraus.
 *
 * Die Hoehe kommt vom RANGHOEHEREN Zug: der Rundweg gewinnt gegen die
 * Abkuerzung, jeder Weg gegen den Gartenrand. Dafuer bekommt der ranghoehere
 * Weg an dieser Bogenlaenge einen NEUEN QUERSCHNITT eingefuegt - Mittelpunkt
 * und, mit ihm, die Zugehoerigkeit.
 *
 * UND EINEN GEGENRANDPUNKT. Ein Querschnitt besteht aus drei Punkten, nicht aus
 * zweien: Mittelpunkt, Randpunkt hier, Randpunkt drueben. Fehlt der drueben,
 * hat die eine Randlinie an der Einmuendung einen Knoten und die andere laeuft
 * geradlinig zwischen zwei Querschnitten durch - dann ist die Flaeche dort
 * nicht mehr quer waagerecht, und genau darauf beruht der ganze Anschluss.
 *
 * Frueher wurde das umgangen, indem der neue Mittelpunkt seine Hoehe nicht aus
 * dem Gelaende, sondern zwischen seinen Nachbarn interpoliert bekam. Das war
 * dieselbe Wirkung auf einem Umweg - mit dem Gegenrandpunkt darf jeder Punkt
 * wieder schlicht das Gelaende fragen.
 */
export function schneideLinien(P, linien) {
  const einfuegungen = linien.map(() => []);

  /**
   * Der neue Querschnitt an einer Kreuzung: Mittelpunkt UND Gegenrandpunkt.
   *
   * Der Gegenrandpunkt entsteht durch Spiegelung des Kreuzungspunktes am
   * Mittelpunkt. Damit liegt er per Konstruktion genau gegenueber - eine halbe
   * Wegbreite auf der anderen Seite - und der Mittelpunkt ist wirklich die
   * Mitte der beiden. Er wird in die andere Randlinie desselben Weges
   * einsortiert und verweist auf denselben Mittelpunkt.
   */
  const querschnitt = (H, hi, i, t, x, z) => {
    if (!H.querschnitt) return -1;
    const mi = H.querschnitt(i, t);
    if (mi < 0 || H.partner === undefined) return mi;
    const gid = P.neu(2 * P.x[mi] - x, 2 * P.z[mi] - z, RAND, mi, {
      weg: P.weg[mi], bogen: P.bogen[mi], seite: -H.seite,
    });
    einfuegungen[H.partner].push({ i, t, id: gid, spiegel: true });
    return mi;
  };

  for (let ai = 0; ai < linien.length; ai++) {
    for (let bi = ai + 1; bi < linien.length; bi++) {
      const A = linien[ai], B = linien[bi];
      if (A.quelle !== null && A.quelle === B.quelle) continue;   // derselbe Weg
      // Der ranghoehere stellt den Mittelpunkt.
      const [H, L, hi, li] = A.rang >= B.rang ? [A, B, ai, bi] : [B, A, bi, ai];
      const nH = H.geschlossen ? H.punkte.length : H.punkte.length - 1;
      const nL = L.geschlossen ? L.punkte.length : L.punkte.length - 1;
      for (let i = 0; i < nH; i++) {
        const a1 = H.punkte[i], a2 = H.punkte[(i + 1) % H.punkte.length];
        for (let j = 0; j < nL; j++) {
          const b1 = L.punkte[j], b2 = L.punkte[(j + 1) % L.punkte.length];
          const s = strecken(P.x[a1], P.z[a1], P.x[a2], P.z[a2],
                             P.x[b1], P.z[b1], P.x[b2], P.z[b2]);
          if (!s) continue;
          const x = P.x[a1] + (P.x[a2] - P.x[a1]) * s.t;
          const z = P.z[a1] + (P.z[a2] - P.z[a1]) * s.t;
          const istKreuz = H.quelle !== null && L.quelle !== null;
          const istRand = H.quelle === null || L.quelle === null;

          // AUF EINEN VORHANDENEN PUNKT RASTEN, wenn die Kreuzung dicht daneben
          // faellt.
          //
          // Sonst steht dort ein zweiter Knoten wenige Zehntelmillimeter neben
          // dem ersten, und die Triangulierung muss zwischen beiden ein
          // Dreieck aufspannen: bis zu zwei Meter lang und einen zehntel
          // Millimeter dick. Quer ueber so einen Splitter ist die
          // Texturableitung enorm, die Grafikkarte greift zur groebsten
          // Mipmap-Stufe - und heraus kommt das schmale graue Band, das quer
          // ueber das Pflaster laeuft.
          let id = -1, nurIn = -1;
          for (const [k, welche] of [[a1, hi], [a2, hi], [b1, li], [b2, li]]) {
            if (Math.hypot(P.x[k] - x, P.z[k] - z) >= SCHNAPP) continue;
            id = k;
            nurIn = welche === hi ? li : hi;      // in die ANDERE Liste eintragen
            break;
          }

          if (id >= 0) {
            if (istKreuz) P.kreuz[id] = true;
            if (istRand) P.randKreuz[id] = true;
            // Gehoert der Punkt dem rangniederen Weg, erbt er jetzt den
            // Querschnitt des ranghoeheren - genau wie ein neuer Kreuzungspunkt.
            if (nurIn === hi) {
              P.ref[id] = querschnitt(H, hi, i, s.t, P.x[id], P.z[id]);
              einfuegungen[hi].push({ i, t: s.t, id });
            } else {
              einfuegungen[li].push({ i: j, t: s.u, id });
            }
            continue;
          }

          const mi = H.querschnitt ? querschnitt(H, hi, i, s.t, x, z)
                   : (L.querschnitt ? querschnitt(L, li, j, s.u, x, z) : -1);
          id = P.neu(x, z, RAND, mi, {
            weg: mi >= 0 ? P.weg[mi] : -1,
            bogen: mi >= 0 ? P.bogen[mi] : 0,
            seite: H.seite,
            kreuz: istKreuz,
            randKreuz: istRand,
          });
          einfuegungen[hi].push({ i, t: s.t, id });
          einfuegungen[li].push({ i: j, t: s.u, id });
        }
      }
    }
  }

  // EINFUEGEN - und vorher die Spiegelpunkte entdoppeln.
  //
  // Kreuzen BEIDE Randlinien eines Weges denselben fremden Zug - so laeuft der
  // Zugang durch den Gartenrand -, dann liefert jede der beiden Kreuzungen
  // einen Spiegelpunkt fuer die andere Seite, und dort liegt schon die
  // Kreuzung der anderen Randlinie. Trifft der Weg rechtwinklig auf, fallen
  // beide auf denselben Punkt: zwei Knoten im Abstand null, dazwischen ein
  // entartetes Dreieck.
  //
  // Schraeg getroffen sind es dagegen wirklich vier verschiedene Punkte, und
  // alle vier werden gebraucht. Deshalb wird nicht der Fall unterschieden,
  // sondern der Abstand gemessen - und wo zwei zusammenfallen, gewinnt der
  // echte Kreuzungspunkt gegen den Spiegelpunkt.
  linien.forEach((linie, k) => {
    const treffer = einfuegungen[k].sort((a, b) => (a.i - b.i) || (a.t - b.t));
    const behalten = [];
    for (const e of treffer) {
      const v = behalten[behalten.length - 1];
      if (v && (v.spiegel || e.spiegel)
          && Math.hypot(P.x[v.id] - P.x[e.id], P.z[v.id] - P.z[e.id]) < SCHNAPP) {
        const raus = (v.spiegel && !e.spiegel) ? v : e;
        if (raus === v) behalten[behalten.length - 1] = e;
        // Weg heisst weg: sonst bliebe der Punkt als freie Ecke im Satz stehen
        // und saesse dort genau auf einer Zwangskante.
        P.aus[raus.id] = true;
        continue;
      }
      behalten.push(e);
    }
    for (let n = behalten.length - 1; n >= 0; n--) {
      linie.punkte.splice(behalten[n].i + 1, 0, behalten[n].id);
    }
  });
  return einfuegungen.reduce((a, l) => a + l.length, 0) / 2;
}

/**
 * Die Linienzuege eines Weges - beide Randlinien, mit gemeinsamem Querschnitt.
 *
 * `partner` sagt, wo die jeweils andere Randlinie in der Gesamtliste steht:
 * dorthin kommt der Gegenrandpunkt, wenn hier eine Kreuzung einen neuen
 * Querschnitt aufmacht. Gesetzt wird er vom Aufrufer, der die Liste fuehrt.
 */
export function wegLinien(P, w) {
  const querschnitt = (i, t) => {
    const m = w.mitte.length;
    const i2 = w.p.closed ? (i + 1) % m : Math.min(i + 1, m - 1);
    const a = w.mitte[i], b = w.mitte[i2];
    return P.neu(P.x[a] + (P.x[b] - P.x[a]) * t, P.z[a] + (P.z[b] - P.z[a]) * t,
      MITTE, -1, {
        weg: w.p.index,
        bogen: P.bogen[a] + (P.bogen[b] - P.bogen[a]) * t,
      });
  };
  // Die Randlinie hat so viele Abschnitte wie die Mittellinie; der Querschnitt
  // wird deshalb ueber DENSELBEN Index angesprochen. Das gilt nur, solange noch
  // nichts eingefuegt wurde - `schneideLinien` fuegt erst am Ende ein.
  return [
    { punkte: w.links, geschlossen: w.p.closed, rang: w.rang, quelle: w.p.index,
      seite: -1, querschnitt },
    { punkte: w.rechts, geschlossen: w.p.closed, rang: w.rang, quelle: w.p.index,
      seite: 1, querschnitt },
  ];
}

/**
 * DIE WEGE BESCHNEIDEN, BIS SIE SICH NICHT MEHR UEBERSCHNEIDEN.
 *
 * Bis hierher reicht eine Abkuerzung bis zur Mittellinie des Rundwegs und der
 * Zugang durchsticht ihn ganz - absichtlich, denn nur so kreuzen ihre Kanten
 * die seinen sauber und liefern GEMEINSAME Punkte. Von jetzt an waere die
 * Ueberschneidung aber nur noch schaedlich: die Randpunkte, die drinnen liegen,
 * sind Ecken von Dreiecken der Rundwegflaeche und tragen die Hoehe ihrer
 * eigenen Mittellinie - der Rundweg wird an der Einmuendung von unten
 * hochgezogen und woelbt sich.
 *
 * Also fallen sie weg. Was bleibt, ist:
 *
 *   - die eigene Randlinie ab dem Kreuzungspunkt nach aussen,
 *   - und als STIRNSEITE die Randpunkte des Rundwegs zwischen den beiden
 *     Kreuzungspunkten - dieselben Punkte, nicht Kopien.
 *
 * Danach stossen beide Flaechen laengs derselben Kante aneinander, jeder Punkt
 * gehoert zu genau einem Weg, und die Hoehen brauchen keine Schiedsrichter
 * mehr. Die Stirnseite kippt dabei von selbst in die Ebene des Rundwegs, weil
 * ihre Punkte dessen Querschnitten gehoeren.
 */
function beschneideWege(P, wege) {
  for (const w of wege) {
    if (w.p.closed) continue;
    const hoeher = wege.filter((q) => q.rang > w.rang);
    if (!hoeher.length) { w.stirn = [null, null]; w.muendung = [false, false]; continue; }

    /**
     * Der Kreuzungspunkt, an dem von diesem Ende her beschnitten wird.
     *
     * Beim Zugang ist es der ZWEITE - er durchsticht die fremde Flaeche ja, es
     * gibt also zwei. Gesucht wird nur in der dem Ende zugewandten Haelfte:
     * sonst faende das eine Ende die Kreuzung des anderen und schnitte den
     * ganzen Weg weg.
     */
    const grenze = (L, vonVorne) => {
      const n = L.length;
      const halb = Math.floor(n / 2);
      let treffer = -1;
      if (vonVorne) {
        for (let i = 0; i <= halb; i++) if (P.kreuz[L[i]]) treffer = i;
      } else {
        for (let i = n - 1; i >= halb; i--) if (P.kreuz[L[i]]) treffer = i;
      }
      return treffer;
    };

    const grenzeRand = (L, vonVorne) => {
      const n = L.length;
      const halb = Math.floor(n / 2);
      let treffer = -1;
      if (vonVorne) {
        for (let i = 0; i <= halb; i++) if (P.randKreuz[L[i]]) treffer = i;
      } else {
        for (let i = n - 1; i >= halb; i--) if (P.randKreuz[L[i]]) treffer = i;
      }
      return treffer;
    };

    const stirn = [null, null];
    // Welches Ende in einen anderen Weg muendet - und welches nur am
    // Gartenrand endet. Eine leere Stirnseite kommt in beiden Faellen vor
    // (bei sehr schmalem Maul gibt es keinen Punkt dazwischen), sie taugt
    // deshalb nicht zur Unterscheidung. Der Anlauf braucht sie aber.
    const muendung = [false, false];
    for (const vonVorne of [true, false]) {
      const gL = grenze(w.links, vonVorne);
      const gR = grenze(w.rechts, vonVorne);
      if (gL < 0 || gR < 0) continue;
      // Der Kreuzungspunkt selbst BLEIBT - er ist der gemeinsame Punkt.
      const weg = [];
      if (vonVorne) {
        weg.push(...w.links.slice(0, gL), ...w.rechts.slice(0, gR));
        w.links.splice(0, gL);
        w.rechts.splice(0, gR);
      } else {
        weg.push(...w.links.slice(gL + 1), ...w.rechts.slice(gR + 1));
        w.links.splice(gL + 1);
        w.rechts.splice(gR + 1);
      }
      // Weg heisst weg: sie stehen sonst weiter im Punktsatz und werden
      // mittrianguliert - als freie Ecken mitten in der fremden Flaeche.
      for (const id of weg) P.aus[id] = true;

      if (!w.links.length || !w.rechts.length) continue;
      const a = vonVorne ? w.links[0] : w.links[w.links.length - 1];
      const b = vonVorne ? w.rechts[0] : w.rechts[w.rechts.length - 1];
      stirn[vonVorne ? 0 : 1] = kanteZwischen(P, hoeher, a, b);
      muendung[vonVorne ? 0 : 1] = true;
      kuerzeStuetzstellen(P, w, a, b, vonVorne);
    }

    // Und am Wiesenrand kappen, wo der Weg hinauslaeuft. Die Stirnseite bleibt
    // dort LEER, die Kappe ist also eine gerade Sehne von einem Kreuzungspunkt
    // zum anderen. Die Ringpunkte dazwischen liegen in der Wegflaeche und
    // scheiden ohnehin aus (siehe `baueGartennetz`); die Sehne weicht bei
    // anderthalb Metern Wegbreite einen halben Zentimeter von der Rundung ab.
    for (const vonVorne of [true, false]) {
      if (stirn[vonVorne ? 0 : 1] !== null) continue;      // dieses Ende sitzt am Weg
      const gL = grenzeRand(w.links, vonVorne);
      const gR = grenzeRand(w.rechts, vonVorne);
      if (gL < 0 || gR < 0) continue;
      const weg = [];
      if (vonVorne) {
        weg.push(...w.links.slice(0, gL), ...w.rechts.slice(0, gR));
        w.links.splice(0, gL); w.rechts.splice(0, gR);
      } else {
        weg.push(...w.links.slice(gL + 1), ...w.rechts.slice(gR + 1));
        w.links.splice(gL + 1); w.rechts.splice(gR + 1);
      }
      for (const id of weg) P.aus[id] = true;
      if (!w.links.length || !w.rechts.length) continue;
      const a = vonVorne ? w.links[0] : w.links[w.links.length - 1];
      const b = vonVorne ? w.rechts[0] : w.rechts[w.rechts.length - 1];
      stirn[vonVorne ? 0 : 1] = [];
      kuerzeStuetzstellen(P, w, a, b, vonVorne);
      // Eine LEERE Stirnseite heisst: die Kappe ist eine gerade Strecke quer
      // ueber das Band - und die laeuft genau durch den Mittelpunkt dieses
      // Querschnitts. Ein Punkt auf einer Zwangskante macht sie unmoeglich,
      // also muss er weg.
      if (w.mitte.length) P.aus[vonVorne ? w.mitte[0] : w.mitte[w.mitte.length - 1]] = true;
    }
    w.stirn = stirn;
    w.muendung = muendung;
  }
}

/** Bogenlaenge eines Punktes auf der Mittellinie eines Weges. */
function bogenVon(P, sm, id) {
  const x = P.x[id], z = P.z[id];
  let best = Infinity, s = 0;
  for (let i = 0; i + 1 < sm.length; i++) {
    const p1 = sm[i], p2 = sm[i + 1];
    const vx = p2.x - p1.x, vz = p2.z - p1.z;
    const wx = x - p1.x, wz = z - p1.z;
    const l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? (wx * vx + wz * vz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d2 = (wx - t * vx) ** 2 + (wz - t * vz) ** 2;
    if (d2 < best) { best = d2; s = p1.s + Math.sqrt(l2) * t; }
  }
  return s;
}

/** Der Punkt auf der Mittellinie bei einer bestimmten Bogenlaenge. */
function aufMittellinie(sm, s) {
  const letzt = sm[sm.length - 1];
  if (s <= sm[0].s) return sm[0];
  if (s >= letzt.s) return letzt;
  for (let i = 0; i + 1 < sm.length; i++) {
    const a = sm[i], b = sm[i + 1];
    if (s > b.s) continue;
    const t = (s - a.s) / ((b.s - a.s) || 1);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
  return letzt;
}

/**
 * DER ANLAUF VOR DER EINMUENDUNG.
 *
 * Quer waagerecht zu liegen ist das Prinzip jedes Weges, und der Rundweg bleibt
 * ihm ausnahmslos treu: seine beiden Randpunkte haengen immer an demselben
 * Mittelpunkt. Eine Abkuerzung kann das an ihrer Muendung nicht. Dort erbt ihre
 * Stirnseite die Querneigung des Rundwegs - sie muss es, sonst klaffte die
 * Naht -, und einen halben Meter davor laege sie wieder waagerecht. Genau das
 * war der Knick.
 *
 * ALSO GIBT SIE IHRE WAAGERECHTE LAGE FRUEHER AUF, und zwar allmaehlich. Statt
 * beide Randpunkte an denselben Mittelpunkt zu haengen, bekommt jede Seite
 * einen eigenen Referenzpunkt, und der wandert: `anlauf` Meter vor der Muendung
 * sitzt er noch auf der Mittellinie, und je naeher die Muendung kommt, desto
 * weiter ruecken die beiden auseinander - nach links und nach rechts, auf einer
 * Geraden. Die Hoehe holen sie sich weiterhin schlicht aus dem Gelaende; die
 * Flaeche nimmt damit die Querneigung des Hangs auf, erst kaum, dann ganz.
 *
 * WO DIE GERADE ENDET, ist der einzige Punkt, an dem die Beschreibung
 * praeziser sein muss als „am Kreuzungspunkt". Der Kreuzungspunkt liegt zwar
 * genau richtig, aber seine Hoehe ist nicht die des Gelaendes unter ihm: er
 * haengt am Querschnitt des Rundwegs, also am Gelaende eine halbe Rundwegbreite
 * weiter innen. Wuerde die Gerade beim Kreuzungspunkt selbst enden, bliebe
 * zwischen ihm und seinem Nachbarn genau die Stufe stehen, die die
 * Querneigung des Rundwegs ausmacht - der Knick waere nur einen halben Meter
 * weit verschoben. Sie endet deshalb dort, WO DER KREUZUNGSPUNKT SEINE HOEHE
 * HERHAT: an dessen Referenzpunkt. Dann geht der Anlauf ohne Sprung in den
 * Rundweg ueber.
 *
 * Der Kreuzungspunkt selbst bleibt unangetastet - er gehoert dem Rundweg.
 */
function neigeAnschluesse(P, wege, cfg) {
  const voll = Math.max(0, cfg.wegAnlauf || 0);
  if (voll <= 0) return 0;
  let n = 0;
  for (const w of wege) {
    if (w.p.closed || !w.muendung) continue;
    const enden = w.muendung.filter(Boolean).length;
    if (!enden) continue;
    const sm = w.p.samples;
    if (sm.length < 2) continue;
    // Muenden beide Enden, teilen sie sich die Laenge - sonst ueberholten sich
    // die beiden Anlaeufe in der Mitte des Weges und ueberschrieben einander.
    const anlauf = Math.min(voll, w.p.total / enden);
    if (anlauf < 1e-3) continue;

    for (const ende of [0, 1]) {
      if (!w.muendung[ende]) continue;
      for (const name of ['links', 'rechts']) {
        const L = ende ? w[name].slice().reverse() : w[name];
        if (L.length < 2) continue;
        const C = L[0];                       // Kreuzungspunkt mit dem Rundweg
        const ziel = P.ref[C];                // und der Querschnitt, an dem er haengt
        if (ziel < 0) continue;
        const s0 = bogenVon(P, sm, C);
        // Der Anker: Mittellinie, `anlauf` Meter vor der Muendung. Dort ist der
        // Referenzpunkt wieder der Mittelpunkt, den der Randpunkt ohnehin hat -
        // der Uebergang in den ungestoerten Weg ist damit stetig.
        const A = aufMittellinie(sm, ende ? s0 - anlauf : s0 + anlauf);
        for (let k = 1; k < L.length; k++) {
          const d = Math.abs(bogenVon(P, sm, L[k]) - s0);
          if (d >= anlauf) break;
          const t = 1 - d / anlauf;
          P.ref[L[k]] = P.neu(
            A.x + (P.x[ziel] - A.x) * t,
            A.z + (P.z[ziel] - A.z) * t,
            MITTE, -1, { weg: w.p.index, bogen: P.bogen[L[k]] },
          );
          n++;
        }
      }
    }
  }
  return n;
}

/**
 * DIE MITTELLINIE MIT KUERZEN.
 *
 * Die Randlisten zu beschneiden genuegt nicht: die Zuordnung der Dreiecke
 * fragt nicht sie, sondern Mittellinie und Breite. Bliebe die Mittellinie
 * stehen, wuerde der Stummel jenseits des Rundwegs weiterhin als eigene
 * Flaeche gezeichnet - der graue Fleck ueber dem Pflaster.
 *
 * Geschnitten wird an der Bogenlaenge der beiden Kreuzungspunkte; genommen
 * wird die, die weniger wegnimmt, damit das Maul vollstaendig bleibt.
 */
function kuerzeStuetzstellen(P, w, a, b, vonVorne) {
  const sm = w.p.samples;
  const mi = w.mitte;
  if (sm.length < 3) return;
  const sa = bogenVon(P, sm, a), sb = bogenVon(P, sm, b);
  if (vonVorne) {
    const grenze = Math.min(sa, sb);
    let k = 0;
    while (k + 2 < sm.length && sm[k + 1].s <= grenze) k++;
    if (k > 0) {
      const raus = sm.splice(0, k);
      // Die Mittelpunkte laufen mit - sie sind jetzt Ecken des Netzes und
      // duerfen nicht in einer fremden Flaeche stehenbleiben.
      for (const id of mi.splice(0, k)) P.aus[id] = true;
      const versatz = sm[0].s;
      for (const st of sm) st.s -= versatz;
      w.p.total = sm[sm.length - 1].s;
      return raus;
    }
  } else {
    const grenze = Math.max(sa, sb);
    let k = sm.length - 1;
    while (k > 1 && sm[k - 1].s >= grenze) k--;
    if (k < sm.length - 1) {
      const raus = sm.splice(k + 1);
      for (const id of mi.splice(k + 1)) P.aus[id] = true;
      w.p.total = sm[sm.length - 1].s;
      return raus;
    }
  }
  return null;
}

/**
 * Die Randpunkte des ranghoeheren Weges zwischen zwei Kreuzungspunkten.
 *
 * Beide Kreuzungspunkte liegen auf DERSELBEN Randlinie des Rundwegs - eine
 * Abkuerzung muendet ja von einer Seite ein. Genommen wird der kuerzere der
 * beiden Woge herum; laenger als ein Maul breit ist, kann die Stirnseite nicht
 * sein.
 *
 * Zurueck kommen die Punkte OHNE die beiden Enden: die stehen schon in den
 * Randlisten der Abkuerzung.
 */
function kanteZwischen(P, hoeher, a, b) {
  for (const q of hoeher) {
    for (const name of ['links', 'rechts']) {
      const L = q[name];
      const ia = L.indexOf(a), ib = L.indexOf(b);
      if (ia < 0 || ib < 0) continue;
      const n = L.length;
      const vor = [], zurueck = [];
      for (let k = (ia + 1) % n; k !== ib; k = (k + 1) % n) {
        vor.push(L[k]);
        if (vor.length > n) break;
      }
      for (let k = (ia - 1 + n) % n; k !== ib; k = (k - 1 + n) % n) {
        zurueck.push(L[k]);
        if (zurueck.length > n) break;
      }
      // Beim offenen Weg darf nicht umlaufen werden.
      if (!q.p.closed) {
        return ia < ib ? L.slice(ia + 1, ib) : L.slice(ib + 1, ia).reverse();
      }
      return vor.length <= zurueck.length ? vor : zurueck;
    }
  }
  return [];
}

/* ---------------- Schritt 3: Rasterpunkte und Zwangskanten ---------------- */

/**
 * DER WIESENRAND IST EIN KREIS.
 *
 * Hier lag einmal ein Quadrat, und die vier Ecken waren totes Land: verformt
 * wird das Gelaende ohnehin nur innerhalb des Kreises - der Falloff drueckt es
 * ab `durchmesser/2` auf exakt null (`terrain.js`). Was darueber hinaus im
 * Quadrat lag, war flache Wiese, die genauso gut zur Horizontscheibe gehoeren
 * kann, und in der Karte verschwand sie ohnehin unter der runden Maske. Auch
 * der Zaun steht schon immer auf einem Kreis.
 *
 * Die Eckenzahl kommt aus `cfg.randSegmente` und nicht aus einer Rechnung an
 * Ort und Stelle: Horizontscheibe und Kartenkasten brauchen DIESELBEN Ecken,
 * sonst liegt das eine Vieleck innerhalb des anderen und an der Kante klafft
 * ein Spalt.
 *
 * Zurueck kommt ausserdem das Raster fuer die Wiesenpunkte - die Kantenlaenge
 * des Rings ist zugleich ihre Maschenweite.
 */
export function randPunkte(P, cfg) {
  const R = cfg.durchmesser / 2;
  const n = cfg.randSegmente;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(P.neu(Math.cos(a) * R, Math.sin(a) * R, RASTER));
  }
  // Das Innenraster bleibt achsparallel; nur seine Ausdehnung richtet sich
  // jetzt nach dem Kreis statt nach dem Quadrat.
  const seg = Math.min(1024, Math.max(8, Math.round((2 * R) / cfg.gitter)));
  return { ring, R, seg, step: (2 * R) / seg };
}

/**
 * Rasterpunkte fuer die Wiese - mit MINDESTABSTAND zu jeder Wegflaeche UND
 * zum Wiesenrand.
 *
 * Der Abstand ist der Grund, warum die kleinen Dreiecke verschwinden. Frueher
 * wurden Gitterzellen an der Wegkante zerschnitten; lief die Kante dicht an
 * einem Gitterpunkt vorbei, blieb zwangslaeufig ein Splitter uebrig. Jetzt
 * faellt so ein Punkt einfach weg, und die Triangulierung fuellt die Luecke mit
 * ordentlich geformten Dreiecken. Fuer den Ring am Wiesenrand gilt dasselbe:
 * ein Rasterpunkt dicht innerhalb des Rings ergaebe genau solche Splitter.
 *
 * VERWACKELT, und zwar mit Absicht: ein regelmaessiges Raster ist der
 * schlimmste Fall fuer Delaunay, weil je vier Punkte auf einem Kreis liegen und
 * die Entscheidung dann am Rundungsfehler haengt. Der Ring selbst bleibt
 * unverwackelt - er ist Zwangskante und muss rund bleiben.
 */
export function innenPunkte(P, paths, cfg, rng, rand) {
  const { seg, step, R } = rand;
  const abstand = step * 0.4;
  const wackel = step * 0.22;
  const innen = R - Math.max(abstand, step * 0.5);
  let n = 0;
  for (let i = 1; i < seg; i++) {
    for (let j = 1; j < seg; j++) {
      const x = -R + i * step + (rng() - 0.5) * 2 * wackel;
      const z = -R + j * step + (rng() - 0.5) * 2 * wackel;
      if (Math.hypot(x, z) > innen) continue;
      let frei = true;
      for (const p of paths) if (aufWeg(p, x, z) < abstand) { frei = false; break; }
      if (!frei) continue;
      P.neu(x, z, RASTER);
      n++;
    }
  }
  return n;
}

/**
 * Die Zwangskanten der Wege: beide Randlinien und, beim offenen Weg, die
 * beiden Stirnseiten.
 *
 * Sie sind es, die die Triangulierung davon abhalten, im spitzen Winkel ueber
 * die Wegkante hinwegzuverbinden - dort, wo bisher die Luecken sassen.
 */
export function wegKanten(wege) {
  const kanten = [];
  for (const w of wege) {
    for (const name of ['links', 'rechts']) {
      const L = w[name];
      const n = w.p.closed ? L.length : L.length - 1;
      for (let k = 0; k < n; k++) kanten.push([L[k], L[(k + 1) % L.length]]);
    }
    if (!w.p.closed) {
      kanten.push([w.links[0], w.rechts[0]]);
      kanten.push([w.links[w.links.length - 1], w.rechts[w.rechts.length - 1]]);
    }
  }
  return kanten;
}


/* ---------------- Schritt 3b: der Punktsatz fuer die Triangulierung ---------------- */

/**
 * Nur die Punkte, die wirklich vernetzt werden - Randpunkte und Raster.
 *
 * DIE MITTELPUNKTE BLEIBEN DRAUSSEN, und das ist keine Sparsamkeit, sondern
 * notwendig. Ein Mittelpunkt liegt der Bauart nach genau auf der Stirnseite
 * seines Weges, und ein Punkt, der auf einer Zwangskante liegt, macht diese
 * Kante unmoeglich: die Triangulierung kann sie dann nicht mehr als Kante
 * fuehren, und genau dort - an der Stirnseite einer Abkuerzung - verband sie
 * quer darueber hinweg.
 *
 * Gebraucht werden die Mittelpunkte trotzdem: sie tragen die Hoehe, auf die
 * ihre Randpunkte gezogen werden. Sie sind Referenz, nicht Geometrie.
 */
export function netzPunkte(P) {
  const nach = new Int32Array(P.x.length).fill(-1);
  const x = [], z = [], zurueck = [];
  for (let i = 0; i < P.x.length; i++) {
    // Die Mittelpunkte bleiben draussen: sie sind reine Hoehenreferenz. Ein
    // Mittelpunkt liegt der Bauart nach auf der Stirnseite seines Weges, und
    // ein Punkt auf einer Zwangskante macht diese Kante unmoeglich.
    //
    // Sie versuchsweise aufzunehmen - in der Hoffnung, damit die Splitter an
    // den Einmuendungen loszuwerden - hat die Zahl der Wegdreiecke verdoppelt
    // und die Splitter nicht verringert. Der Grund liegt woanders.
    if (P.art[i] === MITTE || P.aus[i]) continue;
    nach[i] = x.length;
    x.push(P.x[i]); z.push(P.z[i]); zurueck.push(i);
  }
  return { x, z, nach, zurueck };
}

/* ---------------- Schritt 3c: Dreiecke zuordnen ---------------- */

/** Raeumlicher Index ueber die Wegsegmente - fuer die Zuordnung der Dreiecke. */
function wegIndex(paths, zelle = 2) {
  const eimer = new Map();
  const K = (i, j) => i * 100000 + j;
  const zu = (v) => Math.floor(v / zelle);
  paths.forEach((p, pi) => {
    const sm = p.samples;
    const n = p.closed ? sm.length : sm.length - 1;
    const halb = p.width / 2;
    for (let i = 0; i < n; i++) {
      const a = sm[i], b = sm[(i + 1) % sm.length];
      const i0 = zu(Math.min(a.x, b.x) - halb), i1 = zu(Math.max(a.x, b.x) + halb);
      const j0 = zu(Math.min(a.z, b.z) - halb), j1 = zu(Math.max(a.z, b.z) + halb);
      for (let ii = i0; ii <= i1; ii++) {
        for (let jj = j0; jj <= j1; jj++) {
          const k = K(ii, jj);
          if (!eimer.has(k)) eimer.set(k, []);
          eimer.get(k).push(pi, a.x, a.z, b.x, b.z, halb);
        }
      }
    }
  });
  return (x, z) => {
    const arr = eimer.get(K(zu(x), zu(z)));
    if (!arr) return -1;
    let best = -1, rang = -1;
    for (let n = 0; n < arr.length; n += 6) {
      const pi = arr[n];
      const r = WEG_RANG[paths[pi].art] ?? 0;
      if (r <= rang) continue;
      const ax = arr[n + 1], az = arr[n + 2];
      const vx = arr[n + 3] - ax, vz = arr[n + 4] - az;
      const wx = x - ax, wz = z - az;
      const l2 = vx * vx + vz * vz;
      let t = l2 > 0 ? (wx * vx + wz * vz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = wx - t * vx, dz = wz - t * vz;
      if (dx * dx + dz * dz < arr[n + 5] * arr[n + 5]) { best = pi; rang = r; }
    }
    return best;
  };
}

/**
 * Jedes Dreieck bekommt sein Material - nach dem SCHWERPUNKT.
 *
 * Damit entfaellt das Vereinigen und Ausstanzen der Wegflaechen komplett. Die
 * Triangulierung hat ohnehin schon dafuer gesorgt, dass keine Wegkante
 * ueberbrueckt wird; ein Dreieck liegt also ganz auf einer Flaeche oder ganz
 * daneben, und ein einziger Punkt entscheidet, auf welcher.
 *
 * Wo Flaechen sich ueberlappen - eine Abkuerzung reicht ja bis in die Mitte des
 * Rundwegs -, gewinnt der ranghoehere Weg. Was ausserhalb des Gartens liegt und
 * zu keinem Weg gehoert, faellt weg: das ist der Zwickel zwischen dem
 * Torweg-Stummel und dem Gartenrand, den die konvexe Huelle mitgenommen hat.
 */
export function sortiereDreiecke(P, tri, paths, cfg) {
  const welcher = wegIndex(paths);
  const R = cfg.durchmesser / 2;
  const wiese = [];
  const baender = paths.map(() => []);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const cx = (P.x[a] + P.x[b] + P.x[c]) / 3;
    const cz = (P.z[a] + P.z[b] + P.z[c]) / 3;
    const pi = welcher(cx, cz);
    if (pi >= 0) { baender[pi].push(a, b, c); continue; }
    if (cx * cx + cz * cz > R * R) continue;
    wiese.push(a, b, c);
  }
  return { wiese, baender };
}

/* ---------------- Schritt 4: Hoehen ---------------- */

/**
 * Erst das Gelaende, dann die Zugehoerigkeit. In dieser Reihenfolge.
 *
 * 1. JEDER Punkt bekommt seine Rauschhoehe - ausnahmslos, auch die
 *    Referenzpunkte, die nie ein Dreieck sehen werden.
 * 2. Jeder Rand- und Stirnseitenpunkt zieht danach auf die Hoehe des Punktes,
 *    auf den er verweist. Damit ist der Querschnitt exakt waagerecht - und die
 *    Stirnseite einer Abkuerzung genau so gekippt, wie der Rundweg dort liegt.
 *
 * VERWIESEN WIRD IN KETTEN, nicht nur eine Stufe weit: der Kreuzungspunkt einer
 * Abkuerzung haengt am Querschnitt des Rundwegs, und die Randpunkte im Anlauf
 * davor haengen wiederum an Punkten, die selbst noch verweisen koennen.
 * Aufgeloest wird deshalb bis zur Wurzel, und gelesen wird dabei aus den ROHEN
 * Gelaendehoehen - sonst haenge das Ergebnis daran, in welcher Reihenfolge die
 * Punkte entstanden sind.
 */
export function hoehen(P, base) {
  const n = P.x.length;
  const roh = new Float64Array(n);
  for (let i = 0; i < n; i++) roh[i] = base.heightAt(P.x[i], P.z[i]);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let k = i;
    for (let schutz = 0; P.ref[k] >= 0 && schutz < 64; schutz++) k = P.ref[k];
    y[i] = roh[k];
  }
  P.y = y;
  return y;
}

/* ---------------- Schritt 4b: die Boeschung ---------------- */

/**
 * DIE WIESE DARF NEBEN DEM WEG NICHT ABSTUERZEN.
 *
 * Ein Weg liegt quer waagerecht, das Gelaende nicht. Am Hang steht seine
 * untere Kante deshalb ueber dem Boden - bei anderthalb Metern Breite und 30 %
 * Gefaelle gut zwanzig Zentimeter. Der naechste Wiesenpunkt liegt einen halben
 * Meter daneben auf Gelaendehoehe, und dazwischen faellt die Wiese mit
 * fuenfunddreissig Grad ab. Frueher stand dort ein AUSGLEICHSWALL, ein eigenes
 * Stueck Geometrie; er ist mit dem gemeinsamen Punktnetz entfallen, und damit
 * kam der Absatz zurueck.
 *
 * Jetzt braucht es dafuer keine Geometrie mehr, nur eine Verschiebung: die
 * Wiesenpunkte in der Naehe werden um denselben Betrag angehoben, um den die
 * Wegkante ueber dem Gelaende steht, und dieser Betrag laeuft ueber
 * `cfg.wegBoeschung` Meter auf null aus. An der Kante schliesst die Wiese damit
 * genau an den Weg an, ein paar Meter weiter liegt sie wieder auf dem Gelaende,
 * und dazwischen ist der Uebergang glatt.
 *
 * NUR NACH OBEN. An der bergseitigen Kante schneidet der Weg in den Hang; dort
 * ist der Aufwuchs negativ, und dort soll die Boeschung stehenbleiben, wie sie
 * ist - ein Weg am Hang hat auf einer Seite eine Stuetzmauer und auf der
 * anderen einen Anschnitt, das ist keine Stoerung, sondern die Sache selbst.
 *
 * Angefasst werden ausschliesslich RASTERPUNKTE. Die Randpunkte gehoeren den
 * Wegen und haengen an ihren Referenzpunkten; wer sie mitverschoebe, machte
 * genau den Querschnitt kaputt, um den es die ganze Zeit geht.
 *
 * Am Wiesenrand passiert von selbst nichts: der Falloff des Hoehenfeldes
 * laeuft dort waagerecht aus, ein Weg liegt also eben auf, und sein Aufwuchs
 * ist null.
 */
export function boeschung(P, wege, cfg, base) {
  const B = Math.max(0, cfg.wegBoeschung || 0);
  if (B <= 0) return 0;

  // GEMESSEN WIRD GEGEN DIE RANDKANTE, NICHT GEGEN DIE RANDPUNKTE.
  //
  // Hier stand einmal ein gewichtetes Mittel ueber alle Randpunkte in
  // Reichweite. Das sah plausibel aus und war falsch: bei sechs Metern
  // Reichweite liegt in einem Garten voller Wege fast jeder Wiesenpunkt in
  // Reichweite von IRGENDEINEM Weg, und weil das Mittel normiert ist, bekam
  // auch der Punkt mitten auf der Wiese noch acht Zentimeter ab. Die ganze
  // Wiese hob sich gleichmaessig - und eine gleichmaessige Anhebung sieht man
  // nicht. Der Regler schien wirkungslos, obwohl er kraeftig wirkte.
  //
  // Also die Strecken statt der Punkte: gesucht wird die naechste Stelle auf
  // der naechsten Randkante, und nur ihr Aufwuchs zaehlt. Was weiter weg liegt
  // als `B`, bleibt liegen - auch wenn dahinter noch ein Weg kommt.
  // DER WIESENRAND BLEIBT LIEGEN.
  //
  // Auf ihm sitzt die Naht zur Horizontscheibe, und die liegt auf exakt null.
  // Ein Weg, der bis dorthin hinauslaeuft, hat im Auslaufring durchaus einen
  // Aufwuchs - das Gelaende schmilzt dort zum Rand hin ab -, und ohne diesen
  // Saum hob die Boeschung die Randpunkte mit: gemessen bis zu 45 cm, ein
  // klaffender Absatz rings um den Garten. Innerhalb von `B` Metern vor dem
  // Rand laeuft die Anhebung deshalb auf null aus.
  const RG = cfg.durchmesser / 2;
  const saum = (x, z) => {
    const t = (Math.hypot(x, z) - (RG - B)) / B;
    if (t <= 0) return 1;
    if (t >= 1) return 0;
    return 1 - t * t * (3 - 2 * t);
  };

  const zelle = Math.max(B, 2);
  const eimer = new Map();
  const K = (i, j) => i * 100000 + j;
  const zu = (v) => Math.floor(v / zelle);
  const strecke = (a, b) => {
    if (P.aus[a] || P.aus[b]) return;
    const ax = P.x[a], az = P.z[a], bx = P.x[b], bz = P.z[b];
    const ha = P.y[a] - base.heightAt(ax, az);
    const hb = P.y[b] - base.heightAt(bx, bz);
    // In jede Zelle eintragen, die das um `B` aufgeblasene Rechteck beruehrt -
    // dann findet die Abfrage mit einem einzigen Zellengriff alles, was in
    // Reichweite liegt.
    const i0 = zu(Math.min(ax, bx) - B), i1 = zu(Math.max(ax, bx) + B);
    const j0 = zu(Math.min(az, bz) - B), j1 = zu(Math.max(az, bz) + B);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = K(i, j);
        let arr = eimer.get(k);
        if (!arr) { arr = []; eimer.set(k, arr); }
        arr.push(ax, az, ha, bx, bz, hb);
      }
    }
  };
  for (const w of wege) {
    for (const name of ['links', 'rechts']) {
      const L = w[name];
      const n = w.p.closed ? L.length : L.length - 1;
      for (let k = 0; k < n; k++) strecke(L[k], L[(k + 1) % L.length]);
    }
    // Die Stirnseiten schliessen den Umriss eines offenen Weges; ohne sie
    // bliebe vor einem Wegende ein Zwickel ohne Boeschung.
    if (!w.p.closed && w.links.length && w.rechts.length) {
      strecke(w.links[0], w.rechts[0]);
      strecke(w.links[w.links.length - 1], w.rechts[w.rechts.length - 1]);
    }
  }

  let n = 0;
  for (let id = 0; id < P.x.length; id++) {
    if (P.art[id] !== RASTER || P.aus[id]) continue;
    const x = P.x[id], z = P.z[id];
    const arr = eimer.get(K(zu(x), zu(z)));
    if (!arr) continue;
    let best = B * B, hub = 0;
    for (let k = 0; k < arr.length; k += 6) {
      const ax = arr[k], az = arr[k + 1], bx = arr[k + 3], bz = arr[k + 4];
      const vx = bx - ax, vz = bz - az;
      const l2 = vx * vx + vz * vz;
      let t = l2 > 0 ? ((x - ax) * vx + (z - az) * vz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - ax - t * vx, dz = z - az - t * vz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= best) continue;
      best = d2;
      hub = arr[k + 2] + (arr[k + 5] - arr[k + 2]) * t;
    }
    if (hub <= 0) continue;
    // Auslauf ueber die Boeschungsbreite. An beiden Enden mit waagerechter
    // Tangente: an der Wegkante, damit die Wiese dort so flach anschliesst wie
    // der Weg liegt, und am Ende, damit dort kein neuer Knick entsteht.
    const s = saum(x, z);
    if (s <= 0) continue;
    const t = Math.sqrt(best) / B;
    P.y[id] += hub * (1 - t * t * (3 - 2 * t)) * s;
    n++;
  }
  return n;
}

/* ---------------- Schritt 5: Netze ---------------- */

/**
 * Die ganze Kette auf einmal: Punkte sammeln, schneiden, Raster streuen,
 * triangulieren, zuordnen, Hoehen setzen.
 */
export function baueGartennetz(paths, cfg, base, rng) {
  const { P, wege } = sammleWegpunkte(paths, cfg);
  const rand = randPunkte(P, cfg);

  const linien = [];
  for (const w of wege) {
    const i = linien.length;
    linien.push(...wegLinien(P, w));
    // Die beiden Randlinien eines Weges kennen einander: dorthin kommt der
    // Gegenrandpunkt, wenn hier eine Kreuzung einen neuen Querschnitt aufmacht.
    linien[i].partner = i + 1;
    linien[i + 1].partner = i;
  }
  linien.push({ punkte: rand.ring, geschlossen: true, rang: -1, quelle: null,
                seite: 0, querschnitt: null });
  schneideLinien(P, linien);
  beschneideWege(P, wege);
  // Der Anlauf ERST JETZT: er braucht die Kreuzungspunkte, und er braucht die
  // schon gekuerzten Mittellinien, weil er in Bogenlaengen rechnet.
  neigeAnschluesse(P, wege, cfg);
  innenPunkte(P, paths, cfg, rng, rand);

  // EIN PUNKT IN EINER WEGFLAECHE GEHOERT ZU IHR ODER GAR NICHT.
  //
  // Das ist dieselbe Regel wie beim Beschneiden, nur zu Ende gedacht. Wer ohne
  // Zugehoerigkeit in einer Wegflaeche liegt, bekommt Gelaendehoehe und beult
  // sie aus - gleichgueltig, ob er vom Gartenrand stammt, wo der Zugang ihn
  // kreuzt, oder sonstwoher. Es sind wenige, aber jeder einzelne ist sichtbar.
  const welcher = wegIndex(paths);
  for (let id = 0; id < P.x.length; id++) {
    if (P.aus[id]) continue;
    // Wem der Punkt gehoert: bei einem Randpunkt der Weg seines Mittelpunkts,
    // bei einem Mittelpunkt er selbst, beim Raster niemand.
    const eigen = P.ref[id] >= 0 ? P.weg[P.ref[id]] : P.weg[id];
    const pi = welcher(P.x[id], P.z[id]);
    if (pi < 0) continue;
    if (paths[pi].index === eigen) continue;                // eigene Flaeche
    if (P.ref[id] >= 0 && P.weg[P.ref[id]] === paths[pi].index) continue;
    if (eigen < 0 || (WEG_RANG[paths[pi].p ? paths[pi].p.art : paths[pi].art] ?? 0) > 0) {
      P.aus[id] = true;
    }
  }

  // Zwangskanten. Der Rundweg und der Gartenrand geben ihre Linien direkt her;
  // ein offener Weg dagegen wird als GESCHLOSSENER RING gefuehrt: eigene
  // Randlinie hin, Stirnseite, andere Randlinie zurueck, Stirnseite. Die
  // Stirnseiten bestehen aus Punkten des Rundwegs - dadurch stossen die beiden
  // Flaechen laengs derselben Kanten aneinander.
  const zwang = [];
  const kante = (a, b) => { if (a !== b) zwang.push([a, b]); };
  const kette = (liste) => {
    for (let k = 0; k + 1 < liste.length; k++) kante(liste[k], liste[k + 1]);
  };
  for (const w of wege) {
    if (w.p.closed) {
      kette([...w.links, w.links[0]]);
      kette([...w.rechts, w.rechts[0]]);
      continue;
    }
    if (!w.links.length || !w.rechts.length) continue;
    const umlauf = [
      ...w.links,
      ...(w.stirn[1] || []),
      ...w.rechts.slice().reverse(),
      ...(w.stirn[0] || []),
      w.links[0],
    ];
    kette(umlauf);
  }
  // DER WIESENRAND, UM DIE AUSGESCHIEDENEN PUNKTE VERKUERZT.
  //
  // Wo der Zugang zum Tor hinauslaeuft, kreuzt er den Ring zweimal; die
  // Ringpunkte dazwischen liegen in seiner Flaeche und sind eben ausgeschieden
  // worden. Bliebe die Kette ueber sie hinweg bestehen, kreuzten sich zwei
  // Zwangskanten - und genau das kann die Triangulierung nicht. Die verkuerzte
  // Kette laeuft stattdessen als Sehne von einem Kreuzungspunkt zum anderen,
  // quer ueber das Wegende. Bei einem Weg von anderthalb Metern Breite weicht
  // sie einen halben Zentimeter von der Rundung ab.
  const ringKette = rand.ring.filter((id) => !P.aus[id]);
  if (ringKette.length > 2) kette([...ringKette, ringKette[0]]);

  // Nur Rand- und Rasterpunkte werden vernetzt (siehe `netzPunkte`).
  const NP = netzPunkte(P);
  const zwangN = [];
  for (const [a, b] of zwang) {
    const u = NP.nach[a], v = NP.nach[b];
    if (u >= 0 && v >= 0 && u !== v) zwangN.push([u, v]);
  }
  const roh = triangulate(NP.x, NP.z, zwangN);
  const tri = new Array(roh.length);
  for (let i = 0; i < roh.length; i++) tri[i] = NP.zurueck[roh[i]];

  const { wiese, baender } = sortiereDreiecke(P, tri, paths, cfg);
  hoehen(P, base);
  // ERST JETZT, nach dem Hoehenausgleich der Wege - vorher gibt es den
  // Aufwuchs der Wegkanten ueber dem Gelaende noch gar nicht, an dem sich die
  // Boeschung ausrichtet. Dass die Triangulierung schon gelaufen ist, stoert
  // nicht: sie ist reine Ebene, und hier wird nur senkrecht verschoben.
  boeschung(P, wege, cfg, base);
  return { P, wege, wiese, baender, seg: rand.seg };
}

/** Ein Netz aus einer Dreiecksliste. `uv` liefert je Punkt die Kachelung. */
function netzAus(P, tri, uvFn, name, material) {
  // Nur die benutzten Punkte uebernehmen - das haelt die Puffer klein.
  const nach = new Map();
  const pos = [], uv = [], idx = [];
  for (const i of tri) {
    let n = nach.get(i);
    if (n === undefined) {
      n = pos.length / 3;
      nach.set(i, n);
      pos.push(P.x[i], P.y[i], P.z[i]);
      const [u, v] = uvFn(i);
      uv.push(u, v);
    }
    idx.push(n);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  return mesh;
}

/** Die Wiese - Kachelung ueber die Weltkoordinaten. */
export function baueWiese(P, wiese, cfg, material) {
  const t = cfg.kachelWiese;
  return netzAus(P, wiese, (i) => [P.x[i] / t, P.z[i] / t], 'boden', material);
}

/**
 * Bogenlaenge und seitlicher Versatz eines Punktes bezueglich EINES Weges.
 *
 * Gerechnet, nicht nachgeschlagen. Die gespeicherte Bogenlaenge eines Punktes
 * gilt fuer den Weg, an dem er entstanden ist - und in der Flaeche des
 * Rundwegs liegen reichlich Punkte anderer Herkunft: die Stummel der
 * Abkuerzungen, die bis zur Mittellinie hineinreichen. Wer deren Bogenlaenge
 * nimmt (oder, schlimmer, ersatzweise null), zieht die Kachelung ueber ein
 * ganzes Dreieck auseinander. Genau so entstanden die grauen Schlieren.
 */
function projiziere(path, x, z) {
  const sm = path.samples;
  const n = path.closed ? sm.length : sm.length - 1;
  let best = Infinity, s = 0, q = 0;
  for (let i = 0; i < n; i++) {
    const a = sm[i], b = sm[(i + 1) % sm.length];
    const vx = b.x - a.x, vz = b.z - a.z;
    const wx = x - a.x, wz = z - a.z;
    const l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? (wx * vx + wz * vz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * vx, dz = wz - t * vz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      const laenge = Math.sqrt(l2) || 1;
      s = a.s + laenge * t;
      q = (vx * wz - vz * wx) / laenge;
    }
  }
  return { s, q };
}

/**
 * Ein Wegband.
 *
 * OHNE INDEX, also drei eigene Ecken je Dreieck. Das kostet bei gut tausend
 * Dreiecken nichts und loest die NAHT des Rundwegs: dort springt die
 * Bogenlaenge von der Gesamtlaenge zurueck auf null, und ein Dreieck, das
 * darueber hinweggeht, presst die Kachelung des ganzen Weges auf seine Breite
 * zusammen - der graue Strichcode quer ueber den Weg. Mit eigenen Ecken je
 * Dreieck laesst sich das je Dreieck geradebiegen, ohne den Nachbarn zu
 * stoeren.
 */
export function baueWegband(P, tri, path, cfg, material) {
  const kachel = path.kachel;
  const halb = path.width / 2;
  const gesamt = path.total;

  const pos = new Float32Array(tri.length * 3);
  const uv = new Float32Array(tri.length * 2);
  for (let t = 0; t < tri.length; t += 3) {
    const s = [0, 0, 0], q = [0, 0, 0];
    for (let e = 0; e < 3; e++) {
      const pr = projiziere(path, P.x[tri[t + e]], P.z[tri[t + e]]);
      s[e] = pr.s; q[e] = pr.q;
    }
    if (path.closed) {
      // Ueber die Naht hinweg: was auf der kleinen Seite liegt, bekommt die
      // Gesamtlaenge dazu. Danach liegen alle drei wieder beieinander.
      const min = Math.min(s[0], s[1], s[2]);
      const max = Math.max(s[0], s[1], s[2]);
      if (max - min > gesamt / 2) {
        for (let e = 0; e < 3; e++) if (s[e] < gesamt / 2) s[e] += gesamt;
      }
    }
    for (let e = 0; e < 3; e++) {
      const i = tri[t + e];
      const o = (t + e) * 3;
      pos[o] = P.x[i]; pos[o + 1] = P.y[i]; pos[o + 2] = P.z[i];
      const u = (t + e) * 2;
      // Der Versatz wird auf die halbe Breite begrenzt: ein Punkt, der aus
      // einem anderen Weg stammt, kann seitlich weiter draussen liegen, und
      // die Kachel soll deshalb nicht ueber den Rand hinauslaufen.
      const qq = Math.max(-halb, Math.min(halb, q[e]));
      uv[u] = qq / kachel + 0.5;
      uv[u + 1] = s[e] / kachel;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = `weg_${path.index}`;
  return mesh;
}

/* ---------------- Das Hoehenfeld aus dem Netz ---------------- */

/**
 * Ab hier ist DAS NETZ die Hoehenquelle, nicht mehr eine Formel.
 *
 * Das ist keine Formsache: die Wege liegen quer waagerecht und die Wiese
 * schliesst an ihren Kanten an - das beschreibt keine geschlossene Funktion
 * mehr. Wer weiter die Gelaendeformel fragte, bekaeme neben den Wegen eine
 * andere Antwort als das, was man dort sieht, und Felsen, Baeume, Grasbueschel
 * und die Kamera saessen um Zentimeter daneben.
 *
 * Die Signatur bleibt gleich, kein Aufrufer merkt etwas. Ausserhalb des
 * Gartenkreises antwortet weiterhin das Rauschgelaende; dort ist es auf null
 * ausgelaufen.
 */
export function hoehenfeldAusNetz(P, dreiecke, base, cfg) {
  const R = cfg.durchmesser / 2;
  const zelle = Math.max(1, cfg.gitter * 2);
  const eimer = new Map();
  const K = (i, j) => i * 100000 + j;
  const zu = (v) => Math.floor(v / zelle);

  for (let t = 0; t < dreiecke.length; t += 3) {
    const a = dreiecke[t], b = dreiecke[t + 1], c = dreiecke[t + 2];
    const i0 = zu(Math.min(P.x[a], P.x[b], P.x[c])), i1 = zu(Math.max(P.x[a], P.x[b], P.x[c]));
    const j0 = zu(Math.min(P.z[a], P.z[b], P.z[c])), j1 = zu(Math.max(P.z[a], P.z[b], P.z[c]));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = K(i, j);
        if (!eimer.has(k)) eimer.set(k, []);
        eimer.get(k).push(t);
      }
    }
  }

  function heightAt(x, z) {
    if (x * x + z * z > R * R) return base.heightAt(x, z);
    const liste = eimer.get(K(zu(x), zu(z)));
    if (liste) {
      for (const t of liste) {
        const a = dreiecke[t], b = dreiecke[t + 1], c = dreiecke[t + 2];
        const ax = P.x[a], az = P.z[a], bx = P.x[b], bz = P.z[b], cx = P.x[c], cz = P.z[c];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        if (u < -1e-7) continue;
        const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        if (v < -1e-7 || u + v > 1 + 1e-7) continue;
        return u * P.y[a] + v * P.y[b] + (1 - u - v) * P.y[c];
      }
    }
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

  return { ...base, heightAt, normalAt, neigung, base };
}
