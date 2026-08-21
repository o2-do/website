/**
 * Wegknoten: was passiert, wo ein Weg auf einen anderen trifft.
 *
 * Bis hierher folgt jeder Weg fuer sich dem Rohgelaende und ist quer zu seiner
 * Laufrichtung waagerecht. Das geht gut, solange die Wege einander nicht
 * beruehren - und schiefe, sobald sie es tun: der Rundweg planiert sich auf
 * einem Hang eine waagerechte Stufe, und die Abkuerzung, die dort einmuendet,
 * kommt mit der Hoehe des ungestoerten Gelaendes an. Gemessen am Spielgarten
 * (json/garten.json, 790/275 cm Verformung) klaffen an so einer Naht im Mittel
 * 10 cm, im Extremfall 68 cm; beim Zugang zum Tor bis zu 1,6 m. Das ist die
 * Quelle der Ausgleichswaelle, die quer durch die Wege schneiden.
 *
 * DIE ABHILFE IST EINE EINZIGE GEOMETRISCHE FORDERUNG: an der Naht muessen
 * beide Wegflaechen DIESELBE EBENE sein. Eine Wegflaeche ist an jeder Stelle
 * eben - waagerecht quer, mit dem Laengsgefaelle laengs -, ihre Ebene ist also
 * vollstaendig durch einen Punkt und den Gefaellevektor g beschrieben. Nimmt
 * die einmuendende Abkuerzung diesen Vektor in ihren eigenen Achsen auf
 *
 *     Laengsgefaelle = g · t      (t = ihre Tangente)
 *     Querneigung    = g · n      (n = ihre Normale)
 *
 * dann sind beide Ebenen identisch - unabhaengig vom Schnittwinkel. Deshalb
 * braucht es hier keine Fallunterscheidung nach Winkel und keinen Plateau-
 * Sonderfall fuer Kreuzungen: dieselben zwei Zeilen loesen den rechtwinkligen
 * wie den schleifenden Anschluss.
 *
 * Der Preis ist die Querneigung. Sie war bisher ueberall null, und ein Weg,
 * der auf einem Meter von waagerecht auf 40 Grad Schraeglage kippt, sieht aus
 * wie ein Fehler. Deshalb wird jede Forderung ueber eine Auslauflaenge
 * eingeblendet, die sich aus der Forderung selbst ergibt (siehe `auslauf`).
 *
 * Rangfolge: DER HAUPTWEG GEWINNT. Der Rundweg wird nicht angetastet, die
 * Abkuerzung traegt die Anpassung - bis auf den einen Fall, in dem der Garten
 * eine echte Schwelle verdient: am Tor (siehe `plateau`).
 */

const RANG = { rund: 2, tor: 1, abk: 0 };

// Wie weit ein Wegende von einer fremden Flaeche entfernt sein darf und noch
// als „muendet dort ein" gilt. Die Kuerzung in `buildPaths` setzt das Ende mit
// 12 cm Ueberstand auf die Kante, der Zugang zum Tor endet sogar innerhalb des
// Bandes - ein halber Meter Toleranz deckt beides und schliesst ein Ende aus,
// das zufaellig in der Naehe eines anderen Weges endet, ohne ihn zu treffen.
const ANSCHLUSS_TOLERANZ = 0.5;

const smoothstep = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Die naechstgelegene fremde Wegflaeche zu (x, z) - samt allem, was man
 * braucht, um sich an ihre Ebene anzuhaengen.
 *
 * Gesucht wird nicht der naechste Weg, sondern der RANGHOECHSTE unter denen,
 * die nah genug sind. Sonst haengt sich eine Abkuerzung, die dicht an einer
 * zweiten Abkuerzung in den Rundweg muendet, an die falsche Flaeche.
 */
function fremdeFlaeche(paths, exceptIdx, x, z) {
  let best = null;
  for (const p of paths) {
    if (p.index === exceptIdx) continue;
    const sm = p.samples;
    const segs = p.closed ? sm.length : sm.length - 1;
    const halb = p.width / 2;
    for (let i = 0; i < segs; i++) {
      const a = sm[i], b = sm[(i + 1) % sm.length];
      const vx = b.x - a.x, vz = b.z - a.z;
      const wx = x - a.x, wz = z - a.z;
      const len2 = vx * vx + vz * vz;
      let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = wx - t * vx, dz = wz - t * vz;
      const sd = Math.hypot(dx, dz) - halb;          // Abstand zur FLAECHE
      if (sd > ANSCHLUSS_TOLERANZ) continue;
      const rang = RANG[p.art] ?? 0;
      if (best && (rang < best.rang || (rang === best.rang && sd >= best.sd))) continue;
      const laenge = Math.sqrt(len2) || 1;
      // Beim Ringschluss laeuft b.s wieder auf 0 - dort ist die Bogenlaenge
      // des Segmentendes die Gesamtlaenge, nicht null.
      const bs = b.s < a.s ? p.total : b.s;
      best = {
        path: p, rang, sd, halb,
        h: a.y + (b.y - a.y) * t,                    // Flaechenhoehe (quer waagerecht)
        s: a.s + (bs - a.s) * t,                     // Bogenlaenge des Treffpunkts
        tx: vx / laenge, tz: vz / laenge,            // Laufrichtung
        grad: (b.y - a.y) / laenge,                  // Laengsgefaelle
      };
    }
  }
  return best;
}

/**
 * Wie weit ein Weg noch auf der Flaeche eines anderen liegt, von seinem Ende
 * aus gemessen.
 *
 * Ein Stichweg endet nicht an der Kante des Rundwegs, sondern ein Stueck
 * DARUNTER - er muss ueberlappen, sonst blitzt an der Naht ein Streifen Wiese
 * durch. Solange er ueberlappt, hat er in der Ebene des Rundwegs zu bleiben:
 * faengt er schon dort an, sich wegzuneigen, sinkt sein Belag unter die Wiese,
 * die ja auf Rundwegshoehe planiert ist - und die Wiese flackert durch den
 * Belag. Gemessen waren das 2,5 cm auf 50 cm Weg.
 *
 * Zurueck kommt die Bogenlaenge, ueber die die Forderung starr gilt.
 */
function ueberlappung(ziel, p, k) {
  const sm = p.samples;
  const m = sm.length;
  const schritt = k === 0 ? 1 : -1;
  const halb = p.width / 2;
  // Geprueft wird der GANZE QUERSCHNITT, nicht nur die Mittellinie: bei
  // schraegem Anschluss liegt eine Bandkante noch lange unter dem Rundweg,
  // waehrend die Mittellinie ihn laengst verlassen hat. Nach der Mittellinie
  // allein gemessen endete die Forderung zu frueh, und genau in dem Streifen
  // stach die Wiese durch.
  const drauf = (j) => {
    const s = sm[j];
    for (const sgn of [-1, 0, 1]) {
      if (flaechenAbstand(ziel, s.x + s.nx * halb * sgn, s.z + s.nz * halb * sgn) <= 0) return true;
    }
    return false;
  };
  let kern = 0;
  for (let i = 1; i < m; i++) {
    const j = k + schritt * i;
    if (j < 0 || j >= m) break;
    if (!drauf(j)) break;
    kern = Math.abs(sm[j].s - sm[k].s);
  }
  return kern;
}

/** Abstand zur Flaeche EINES bestimmten Weges; negativ heisst drauf. */
function flaechenAbstand(p, x, z) {
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

/**
 * Auslauflaenge einer Forderung: ueber welche Strecke sie eingeblendet wird.
 *
 * Zwei Anteile, beide auf dieselbe zulaessige Zusatzneigung bezogen
 * (`cfg.wegAnschluss`, in Grad):
 *
 *   Querneigung - die Regel „auf einer Wegbreite hoechstens so viel Grad mehr
 *   Schraeglage". Eine Forderung von 30 Grad bei 10 Grad je Breite und 1 m
 *   Breite ergibt 3 m Auslauf.
 *
 *   Hoehensprung - der Weg muss aus der planierten Stufe des Hauptwegs heraus
 *   auf sein eigenes Gelaendeniveau zurueck. Ueber welche Strecke, sagt
 *   dieselbe Neigung: 30 cm bei 10 Grad sind 1,7 m.
 *
 * Der groessere der beiden gewinnt; kuerzer als ein Abtastschritt wird es
 * nicht, sonst faellt die Ueberblendung zwischen die Stuetzstellen.
 */
function auslauf(dh, roll, breite, cfg, minSchritt) {
  const grenze = Math.tan((cfg.wegAnschluss * Math.PI) / 180);
  const lHoehe = Math.abs(dh) / Math.max(1e-6, grenze);
  const lQuer = (Math.abs(Math.atan(roll)) / ((cfg.wegAnschluss * Math.PI) / 180)) * breite;
  return Math.max(minSchritt, lHoehe, lQuer);
}

/**
 * Segment-Segment-Schnitt in der Draufsicht. Liefert die Laufparameter, damit
 * der Aufrufer beide Bogenlaengen interpolieren kann.
 */
function schnitt(a, b, c, d) {
  const rx = b.x - a.x, rz = b.z - a.z;
  const sx = d.x - c.x, sz = d.z - c.z;
  const nenner = rx * sz - rz * sx;
  if (Math.abs(nenner) < 1e-12) return null;         // parallel
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / nenner;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / nenner;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: a.x + rx * t, z: a.z + rz * t };
}

/**
 * Die Ueberblendung selbst - fuer jeden Weg dieselbe.
 *
 * Jede Forderung hat einen KERN, ueber den sie starr gilt, und einen AUSLAUF,
 * ueber den sie auf null faellt. Das Gewicht ist im Kern 1 und laeuft dann als
 * Smoothstep aus - an beiden Enden mit waagerechter Tangente. Dadurch trifft
 * der Weg die Forderung samt Gefaelle EXAKT und kehrt ohne Knick ins Gelaende
 * zurueck.
 *
 * Ueberlappen sich zwei Forderungen, werden die Gewichte normiert. Der
 * Uebergang wird dann zwar steiler als gewuenscht, aber beide Anschluesse
 * bleiben exakt - und darauf kommt es an. Eine saubere Rampe, die die Naht
 * verfehlt, nuetzt niemandem.
 */
function ueberblenden(p, forderungen, yGelaende) {
  if (!forderungen.length) return;
  const sm = p.samples;

  // Passt es der Laenge nach nicht nebeneinander, wird gestaucht - aber NUR
  // DER AUSLAUF. Eine Abkuerzung ist im Median 6 m lang und fordert an jedem
  // Ende bis zu 4 m, das geht regelmaessig nicht auf; welcher Weg dann etwas
  // steiler aus der Naht herauskommt, ist eine Frage des Aussehens.
  //
  // Der KERN dagegen ist keine: er ist die Strecke, auf der dieser Weg
  // nachweislich unter dem anderen liegt, und dort MUSS er in dessen Ebene
  // bleiben. Wurde er mitgestaucht, endete die Forderung mitten im Maul - der
  // Belag der Abkuerzung sackte noch unter dem Rundweg weg, und die auf
  // Rundwegshoehe planierte Wiese stand einen halben Meter darueber.
  const kernSumme = forderungen.reduce((a, c) => a + c.kern, 0);
  if (kernSumme >= p.total) {
    // Der Weg ist kuerzer als die Ueberlappungen zusammen - er liegt praktisch
    // ganz unter den anderen. Dann bleibt nur, ihn ganz starr zu halten.
    const f = p.total / kernSumme;
    for (const c of forderungen) { c.kern *= f; c.L = 0; }
  } else {
    const rest = p.total - kernSumme;
    const lSumme = forderungen.reduce((a, c) => a + c.L, 0);
    if (lSumme > rest) {
      const f = rest / lSumme;
      for (const c of forderungen) c.L *= f;
    }
  }

  for (let k = 0; k < sm.length; k++) {
    const s = sm[k];
    let W = 0, accY = 0, accR = 0;
    for (const c of forderungen) {
      // Auf dem Rundweg ist die Bogenlaenge zyklisch - sonst waere die Stelle
      // kurz vor der Naht unendlich weit von der Stelle kurz danach entfernt.
      let ds = s.s - c.s;
      if (p.closed) {
        if (ds > p.total / 2) ds -= p.total;
        else if (ds < -p.total / 2) ds += p.total;
      }
      const d = Math.abs(ds);
      if (d >= c.kern + c.L) continue;
      const w = d <= c.kern ? 1 : 1 - smoothstep((d - c.kern) / c.L);
      accY += w * (c.h + c.gl * ds);
      accR += w * c.roll;
      W += w;
    }
    if (W <= 0) { s.roll = 0; continue; }
    if (W > 1) { accY /= W; accR /= W; W = 1; }
    s.y = yGelaende[k] * (1 - W) + accY;
    s.roll = accR;
  }
}

/**
 * Das Plateau am Tor.
 *
 * Ueberall sonst gilt „der Hauptweg gewinnt" und die Abkuerzung kippt sich
 * zurecht. Der Zugang vom Tor ist aber kein Trampelpfad, sondern der angelegte
 * Eingang - dort soll man auf eine ebene Schwelle treten, nicht auf eine
 * Rampe. Also wird hier ausnahmsweise auch der Rundweg angefasst.
 *
 * WIE GROSS DAS PLATEAU SEIN MUSS, ist keine Geschmacksfrage, sondern folgt
 * aus der Ueberlappung: rings um den Treffpunkt decken beide Baender denselben
 * Boden, und zwar bis auf `halbe Rundwegbreite + halbe Zugangsbreite` hinaus.
 * Innerhalb dieser Zone muessen BEIDE Flaechen auf derselben Hoehe liegen,
 * sonst bleibt genau dort der Spalt, den das Plateau beseitigen soll. Der
 * Rundweg braucht seinen Kern noch um seine eigene halbe Breite groesser: die
 * Planie fragt fuer einen Punkt am Bandrand die Mittellinie, und die liegt
 * eine halbe Breite weiter.
 *
 * Der Rundweg bekommt dadurch an beiden Plateauraendern einen Knick im
 * Laengsprofil. Das ist bewusst hingenommen - eine Schwelle am Tor darf man
 * sehen. Eine STUFE waere es nicht: deshalb laeuft auch das Plateau ueber
 * `ueberblenden` aus und wird nicht hart geklemmt. Bei 22 Grad Laengsgefaelle
 * stuende sonst eine Kante von ueber einem Meter am Plateaurand.
 */
function plateau(paths, tor, cfg, gelaende) {
  const J = tor.samples[0];                          // inneres Ende (resample: innen -> aussen)
  const ziel = fremdeFlaeche(paths, tor.index, J.x, J.z);
  if (!ziel) return null;

  const H = ziel.h;
  const kernTor = ziel.halb + tor.width / 2;         // Radius der Ueberlappungszone
  const kernZiel = kernTor + ziel.halb;

  // Der Auslauf des getroffenen Weges bemisst sich NICHT am Hoehensprung - den
  // gibt es dort nicht, der Rundweg liegt ja auf seinem eigenen Gelaende. Er
  // bemisst sich daran, wie weit ihn das flache Plateau von seinem Gefaelle
  // wegzieht: ueber den Kern hinweg sind das Gefaelle mal Kernlaenge.
  const zY = gelaende.get(ziel.path);
  ueberblenden(ziel.path, [{
    s: ziel.s, h: H, gl: 0, roll: 0, kern: kernZiel,
    L: auslauf(ziel.grad * kernZiel, 0, ziel.path.width, cfg, cfg.wegSample),
  }], zY);

  return { H, kern: kernTor, grad: ziel.grad, ziel: ziel.path };
}

/**
 * Alle Wege aneinander anschliessen. Laeuft NACH `buildPaths` und `torWeg`
 * und VOR `makePathIndex` - denn der Index traegt die Hoehen und Neigungen
 * weiter ins Hoehenfeld, und ab dort haengt der ganze Garten daran.
 *
 * Veraendert die Stuetzstellen an Ort und Stelle (`y`, `roll`).
 */
export function verknuepfeWege(paths, base, cfg) {
  if (!paths.length) return;

  // Die ungestoerte Gelaendehoehe je Stuetzstelle, bevor irgendetwas daran
  // gezogen hat. Auf sie laeuft jede Forderung wieder zurueck.
  const gelaende = new Map();
  for (const p of paths) {
    gelaende.set(p, p.samples.map((s) => base.heightAt(s.x, s.z)));
  }

  // 1. Das Plateau zuerst: es verschiebt Hoehen am Rundweg, und alle folgenden
  //    Forderungen sollen schon die neuen sehen.
  const tor = paths.find((p) => p.art === 'tor');
  const pl = tor ? plateau(paths, tor, cfg, gelaende) : null;

  // 2. Je offenem Weg die Zwangspunkte sammeln.
  for (const p of paths) {
    if (p.closed) continue;
    const sm = p.samples;
    const m = sm.length;
    const yT = gelaende.get(p);
    const forderungen = [];

    // 2a. Die Enden. Der Zugang zum Tor hat nur innen einen Anschluss - sein
    //     aeusseres Ende laeuft in die Landschaft hinaus.
    const enden = p.art === 'tor' ? [0] : [0, m - 1];
    for (const k of enden) {
      const e = sm[k];
      const amPlateau = pl && p === tor && k === 0;
      const ziel = amPlateau ? null : fremdeFlaeche(paths, p.index, e.x, e.z);
      if (!amPlateau && !ziel) continue;

      const h = amPlateau ? pl.H : ziel.h;
      const gl = amPlateau ? 0 : ziel.grad * (e.tx * ziel.tx + e.tz * ziel.tz);
      const rl = amPlateau ? 0 : ziel.grad * (e.nx * ziel.tx + e.nz * ziel.tz);
      // Starr gilt die Forderung, solange der Weg noch unter dem anderen liegt -
      // und am Tor mindestens ueber das Plateau.
      const ueber = ueberlappung(amPlateau ? pl.ziel : ziel.path, p, k);
      const kern = Math.max(ueber, amPlateau ? pl.kern : 0);
      // Am Plateau kommt zum Hoehensprung dazu, wie weit der flache Kern den
      // Weg von seinem eigenen Gefaelle wegzieht - genau wie beim Rundweg.
      const zieht = amPlateau ? Math.abs(pl.grad) * kern : 0;
      // Das Laengsgefaelle der ANSCHLUSSEBENE an der Stuetzstelle hinterlassen.
      // `bandPunkt` braucht es fuer den Schraeganschnitt: der schiebt die Ecken
      // der Stirnkante um bis zu einen halben Meter laengs der Tangente, und
      // ohne das passende Gefaelle sitzen sie in der falschen Hoehe.
      //
      // Aus den Nachbarstuetzstellen laesst es sich NICHT ablesen: schon einen
      // halben Meter weiter ist der Weg in seiner Auslauframpe, und die ist,
      // wenn sie gestaucht werden musste, deutlich steiler als die Naht.
      // Gemessen: 16 Grad Rampe gegen 1,5 Grad Naht, und die Stirnkante kippte
      // entsprechend um das Achtfache zu viel.
      e.glon = gl;
      forderungen.push({
        s: e.s, h, gl, roll: rl, kern,
        L: auslauf(Math.abs(h - yT[k]) + zieht, rl, p.width, cfg, cfg.wegSample),
      });
    }

    // 2b. Echte Kreuzungen unterwegs. Beim Spielgarten kommen sie nicht vor
    //     (ueber 24 durchgerechnete Varianten: keine einzige), aber eine
    //     Abkuerzung ist eine Sehne ueber einen maeandernden Rundweg - bei
    //     kleinerem Glaettungsradius schneidet sie ihn. Dieselbe Forderung wie
    //     an den Enden, nur mitten im Weg statt am Rand.
    for (const q of paths) {
      if (q === p) continue;
      // Nur ranghoehere - und unter Gleichen der mit der kleineren Nummer.
      // Ohne die zweite Haelfte wich bei zwei sich kreuzenden Abkuerzungen
      // KEINE der beiden aus, und an der Kreuzung stand ein halber Meter
      // Hoehenunterschied.
      const rq = RANG[q.art] ?? 0, rp = RANG[p.art] ?? 0;
      if (rq < rp || (rq === rp && q.index > p.index)) continue;
      const qs = q.samples;
      const qn = q.closed ? qs.length : qs.length - 1;
      for (let i = 0; i < m - 1; i++) {
        for (let j = 0; j < qn; j++) {
          const x = schnitt(sm[i], sm[i + 1], qs[j], qs[(j + 1) % qs.length]);
          if (!x) continue;
          const a = qs[j], b = qs[(j + 1) % qs.length];
          const laenge = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const grad = (b.y - a.y) / laenge;
          const tx = (b.x - a.x) / laenge, tz = (b.z - a.z) / laenge;
          const e = sm[i];
          const s = e.s + (sm[i + 1].s - e.s) * x.t;
          const h = a.y + (b.y - a.y) * x.u;
          const rl = grad * (e.nx * tx + e.nz * tz);
          const yq = base.heightAt(x.x, x.z);
          forderungen.push({
            s, h, gl: grad * (e.tx * tx + e.tz * tz), roll: rl,
            kern: q.width / 2,                       // ueber die Kreuzung hinweg starr
            L: auslauf(h - yq, rl, p.width, cfg, cfg.wegSample),
          });
        }
      }
    }

    ueberblenden(p, forderungen, yT);
  }
}
