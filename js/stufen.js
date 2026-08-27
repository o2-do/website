import * as THREE from 'three';
import { atArcLength } from './paths.js';

/**
 * Treppenstufen im Rundweg.
 *
 * NUR IM RUNDWEG. Er ist der angelegte Weg; eine Abkuerzung ist ein
 * Trampelpfad, und wo Leute quer den Hang hinuntergehen, baut niemand eine
 * Treppe. Der Zugang zum Tor ist kurz und liegt am flachen Rand.
 *
 * DER WEG WIRD NICHT ANGERUEHRT. Er behaelt seine Hoehe, seine Rampe, sein
 * Netz; die Treppe wird oben daraufgesetzt wie etwas, das jemand nachtraeglich
 * hineingebaut hat. Hier wird `hf` nur GELESEN.
 *
 * DIE MASSE FOLGEN EINER REGEL, NICHT EINER TABELLE. Bequem ist eine Stufe von
 * 15 cm Hoehe und 28 cm Tiefe. Das laesst sich aber nicht ueberall einhalten:
 * die Treppe muss genau den Hoehenunterschied ueberwinden, den der Weg an
 * dieser Stelle hat, und genau die Laenge einnehmen, die er dafuer hat.
 *
 *   flacher   Die Stufenzahl folgt der Hoehe, die Tiefe waechst. Eine lange
 *             flache Treppe mit tiefen Auftritten - so baut man am Hang.
 *   steiler   Unter 20 cm Tiefe wird kein Auftritt mehr gebaut; stattdessen
 *             werden es weniger und dafuer hoehere Stufen.
 */

/**
 * LIEGT DIESE STELLE SCHON AUF EINEM FREMDEN WEG?
 *
 * Gemessen wird ueber die ganze Wegbreite, nicht nur auf der Mittellinie: eine
 * Abkuerzung muendet schraeg ein, und ihr Belag erreicht die eine Wegkante
 * lange vor der anderen. Wer nur die Mitte prueft, laesst die halbe Stufe in
 * der Kreuzung stehen.
 *
 * Der Zuschlag ist kein Sicherheitsabstand aus Vorsicht, sondern aus Rasterung:
 * geprueft wird an den Stuetzstellen des Weges, die einen halben Meter
 * auseinanderliegen, waehrend eine Stufe nur gut zwanzig Zentimeter tief ist.
 * Ohne ihn faende die naechste Stufe zwischen zwei Proben Platz und stuende
 * doch in der Kreuzung.
 */
const KREUZ_FREI = 0.35;

function kreuztFremdenWeg(paths, p, s, zuschlag = KREUZ_FREI) {
  const c = atArcLength(p, s);
  const halb = p.width / 2;
  for (const seite of [-1, -0.5, 0, 0.5, 1]) {
    const x = c.x + c.nx * halb * seite;
    const z = c.z + c.nz * halb * seite;
    for (const q of paths) {
      if (q === p) continue;
      const halbQ = q.width / 2 + zuschlag;
      const sm = q.samples;
      const bis = q.closed ? sm.length : sm.length - 1;
      for (let i = 0; i < bis; i++) {
        const a = sm[i], b = sm[(i + 1) % sm.length];
        const ex = b.x - a.x, ez = b.z - a.z;
        const l2 = ex * ex + ez * ez || 1e-9;
        let t = ((x - a.x) * ex + (z - a.z) * ez) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (a.x + ex * t), dz = z - (a.z + ez * t);
        if (dx * dx + dz * dz < halbQ * halbQ) return true;
      }
    }
  }
  return false;
}

const HOEHE_SOLL = 0.15;          // bequeme Steigung
const TIEFE_SOLL = 0.28;          // bequemer Auftritt
const TIEFE_MIN = 0.20;           // darunter wird die Stufe lieber hoeher
// Wie tief der Block unter den Auftritt reicht. Er muss die Rampe darunter
// sicher schneiden, sonst schwebt die Stufe.
const FUSS = 0.25;
// Luft zwischen Auftritt und Rampe. Ein Zentimeter genuegt und ist von oben
// nicht zu sehen.
const LUFT = 0.01;
// Wie weit die unterste und die oberste Stufe hoechstens auslaufen duerfen.
const AUSLAUF_MAX = 5.0;
// Kantenlaenge der Texturkachel in Metern - der Granit ist auf 1 m gerechnet.
const KACHEL = 1.0;
// Wie weit die Stufe hinter der Wegkante bleibt. Null: die Stufe geht ueber die
// ganze Wegbreite. Ein Einzug liess einen schmalen Streifen des regulaeren
// Belags neben jeder Stufe stehen - der sah nicht nach Absicht aus, sondern
// nach einer Treppe, die nicht passt.
const EINZUG = 0;

/**
 * Die steilen Stuecke des Rundwegs suchen und in Treppen aufteilen.
 *
 * Gemessen wird die Steigung LAENGS der Mittellinie auf der fertigen Flaeche
 * (`hf`), nicht auf dem Rauschgelaende: der Weg liegt quer waagerecht und ist
 * damit ein anderes Profil als der Boden neben ihm.
 */
export function planeStufen(paths, hf, cfg) {
  if (!cfg.stufen) return [];
  const grenze = Math.tan((cfg.stufenAb * Math.PI) / 180);
  const treppen = [];

  for (const p of paths) {
    if (p.art !== 'rund') continue;
    const sm = p.samples;
    const n = p.closed ? sm.length : sm.length - 1;

    let lauf = null;
    const schliesse = () => {
      if (lauf) treppen.push(...teileTreppe(lauf, hf, paths));
      lauf = null;
    };
    for (let i = 0; i < n; i++) {
      const a = sm[i], b = sm[(i + 1) % sm.length];
      const weite = Math.hypot(b.x - a.x, b.z - a.z);
      if (weite < 1e-6) continue;
      // EINE TREPPE ENDET AM WEG, NICHT MITTEN DARIN. Wo eine Abkuerzung
      // einmuendet, wird getrennt: die Kreuzung bleibt eine Flaeche, ueber die
      // man abbiegen kann, statt eine Kante, gegen die man tritt.
      if (kreuztFremdenWeg(paths, p, a.s)) { schliesse(); continue; }
      const ya = hf.heightAt(a.x, a.z), yb = hf.heightAt(b.x, b.z);
      if (Math.abs(yb - ya) / weite < grenze) { schliesse(); continue; }
      if (!lauf) lauf = { p, sVon: a.s, sBis: b.s, yVon: ya, yBis: yb };
      else { lauf.sBis = b.s; lauf.yBis = yb; }
    }
    schliesse();
  }
  return treppen;
}

/**
 * Aus einem steilen Stueck die einzelnen Stufen rechnen.
 *
 * Erst die Zahl aus der Hoehe, dann die Tiefe aus der Laenge. Wird die Tiefe zu
 * klein, entscheidet stattdessen die Laenge ueber die Zahl, und die Hoehe folgt
 * - so bleibt der Auftritt immer begehbar, gleichgueltig wie steil es ist.
 *
 * DANN WIRD DIE GANZE TREPPE ANGEHOBEN, BIS NICHTS MEHR DURCHSTOESST.
 *
 * Eine Treppe steigt in Sprüngen, die Rampe darunter steigt stetig - und zwar
 * nicht geradlinig, sondern so, wie das Gelaende laeuft. Zwischen zwei
 * Auftritten kann die Rampe deshalb ueber dem Auftritt liegen, und dann sieht
 * man zwischen den Granitplatten das Pflaster durchblitzen. Gesucht wird also
 * der groesste Ueberstand der Rampe, und um genau den wird die ganze Treppe
 * gehoben - alle Stufen gleich, damit die Steigung gleichmaessig bleibt.
 *
 * DIE UNTERSTE UND DIE OBERSTE STUFE LAUFEN DAFUER AUS. Die Anhebung macht
 * unten die erste Setzstufe zu hoch und laesst oben die letzte ueber der Rampe
 * stehen. Statt das Gelaende zu verbiegen, werden die beiden Endstufen einfach
 * so weit verlaengert, bis die Rampe den Unterschied von selbst aufgeholt hat.
 * Eine lange unterste Stufe ist ein Podest, und das ist am Fuss einer Treppe
 * das Natuerlichste der Welt.
 */
function teileTreppe(lauf, hf, paths = []) {
  const laenge = lauf.sBis - lauf.sVon;
  const hub = Math.abs(lauf.yBis - lauf.yVon);
  if (laenge < TIEFE_MIN || hub < HOEHE_SOLL) return [];

  let n = Math.max(1, Math.round(hub / HOEHE_SOLL));
  let tiefe = laenge / n;
  if (tiefe < TIEFE_MIN) {
    n = Math.max(1, Math.floor(laenge / TIEFE_MIN));
    tiefe = laenge / n;
  }
  const hoehe = hub / n;

  const p = lauf.p;
  const rampe = (s) => { const c = atArcLength(p, s); return hf.heightAt(c.x, c.z); };
  // Bergauf laeuft die Bogenlaenge mit der Hoehe, bergab dagegen. Gerechnet
  // wird immer vom Fuss aus.
  const bergauf = lauf.yBis > lauf.yVon;
  const richtung = bergauf ? 1 : -1;
  const sFuss = bergauf ? lauf.sVon : lauf.sBis;
  const yFuss = Math.min(lauf.yVon, lauf.yBis);

  // DER GROESSTE UEBERSTAND DER RAMPE, ueber die ganze Stufenbreite gemessen
  // und nicht nur an ihrer Oberkante. Die Rampe steigt zwar im Mittel, aber
  // nicht gleichmaessig - dazwischen kann sie eine Kuppe haben, und genau die
  // stiesse sonst durch den Auftritt.
  let anhebung = 0;
  for (let k = 0; k < n; k++) {
    const auftritt = yFuss + (k + 1) * hoehe;
    for (let f = 0; f <= 1.0001; f += 0.2) {
      const sP = sFuss + richtung * (k + f) * tiefe;
      anhebung = Math.max(anhebung, rampe(sP) - auftritt);
    }
  }
  anhebung = Math.max(0, anhebung) + LUFT;
  // Ab hier darf `anhebung` noch wachsen (siehe die Kreuzung weiter unten).

  /**
   * DIE ENDSTUFEN LAUFEN AUS, SOLANGE ES ETWAS BRINGT.
   *
   * Die Anhebung macht unten die erste Setzstufe zu hoch und laesst oben die
   * letzte ueber der Rampe stehen. Beides gleicht sich von selbst aus, wenn man
   * die Endstufe so weit verlaengert, bis die Rampe den Unterschied aufgeholt
   * hat - eine lange unterste Stufe ist ein Podest, und das ist am Fuss einer
   * Treppe das Natuerlichste der Welt.
   *
   * Aufgeholt wird aber nur, solange die Rampe ueberhaupt in die richtige
   * Richtung laeuft. Endete das steile Stueck, weil es flacher wurde, holt sie
   * nichts mehr auf; dann waere eine lange Platte nur eine Platte, die immer
   * weiter ueber dem Boden schwebt. Deshalb bricht der Auslauf ab, sobald die
   * Rampe umkehrt - und in jedem Fall, bevor sie den Auftritt erreicht.
   */
  const auslauf = (start, schritt, passt) => {
    let gut = 0, vorher = rampe(start);
    for (let d = 0.25; d <= AUSLAUF_MAX; d += 0.25) {
      const jetzt = rampe(start + schritt * d);
      if (!passt(jetzt, vorher)) break;
      gut = d;
      vorher = jetzt;
    }
    return gut;
  };

  /**
   * EINE TREPPE ENDET AM WEG, NICHT MITTEN DARIN.
   *
   * Muendet dort, wo die oberste Stufe ausliefe, eine Abkuerzung, so stuende
   * ihre Setzstufe quer in der Kreuzung - man traete beim Abbiegen gegen eine
   * Kante, und jenseits des Weges finge eine neue Stufe an. Statt dessen wird
   * die oberste Stufe genau bis an die Kante des kreuzenden Weges gezogen: dort
   * hoert die Treppe auf, und die Kreuzung bleibt eine Flaeche.
   *
   * Gesucht wird die erste Stelle laengs des eigenen Weges, die schon auf einem
   * fremden Belag liegt.
   */
  const bisKreuzung = (start, schritt) => {
    for (let d = 0.05; d <= AUSLAUF_MAX; d += 0.05) {
      if (kreuztFremdenWeg(paths, p, start + schritt * d)) return d - 0.05;
    }
    return Infinity;
  };

  const sOben = sFuss + richtung * n * tiefe;
  const kreuzOben = bisKreuzung(sOben, richtung);
  let ausOben;
  if (Number.isFinite(kreuzOben)) {
    // Bis an die Kante - und die ganze Treppe so weit heben, dass die Rampe
    // auch unter der verlaengerten Stufe bleibt.
    ausOben = kreuzOben;
    const auftritt = yFuss + n * hoehe;
    for (let d = 0; d <= kreuzOben + 1e-6; d += 0.1) {
      anhebung = Math.max(anhebung, rampe(sOben + richtung * d) - auftritt + LUFT);
    }
  } else {
    const obersterAuftritt = yFuss + n * hoehe + anhebung;
    // Oben: weiter, solange die Rampe steigt und noch unter dem Auftritt bleibt.
    ausOben = auslauf(sOben, richtung,
      (jetzt, vorher) => jetzt < obersterAuftritt - LUFT && jetzt >= vorher);
  }
  // Unten: weiter, solange die Rampe faellt und die Anhebung noch nicht
  // eingeholt ist - und ebenfalls hoechstens bis an einen kreuzenden Weg.
  const kreuzUnten = bisKreuzung(sFuss, -richtung);
  const ausUnten = Math.min(kreuzUnten, auslauf(sFuss, -richtung,
    (jetzt, vorher) => jetzt > yFuss - anhebung && jetzt <= vorher));

  const stufen = [];
  for (let k = 0; k < n; k++) {
    // Bogenlaenge der Vorder- und Rueckkante, in Laufrichtung gemessen.
    let a = sFuss + richtung * k * tiefe;
    let b = sFuss + richtung * (k + 1) * tiefe;
    if (k === 0) a -= richtung * ausUnten;
    if (k === n - 1) b += richtung * ausOben;
    stufen.push({
      p,
      sVon: Math.min(a, b),
      sBis: Math.max(a, b),
      oben: yFuss + (k + 1) * hoehe + anhebung,
      hoehe,
    });
  }
  return [{ p, stufen, hoehe, tiefe, n, anhebung, ausUnten, ausOben }];
}

/* ---------------- Die Netze ---------------- */

/**
 * Jede Stufe ist ein Block mit FUENF Flaechen: Auftritt, Vorderseite,
 * Rueckseite und die beiden Wangen. Der Boden fehlt, er steckt in der Rampe.
 *
 * Die Texturkoordinaten sind Meter: quer die Lage auf der Stufe, laengs die
 * Bogenlaenge, senkrecht die Hoehe. Damit sitzt die Maserung auf allen fuenf
 * Flaechen im selben Massstab, und ueber die Kanten laeuft sie durch.
 */
export function baueStufen(treppen, cfg, textur, sektoren) {
  if (!treppen.length) return [];
  const alle = [];
  for (const t of treppen) for (const s of t.stufen) alle.push(s);
  if (!alle.length) return [];

  for (const s of alle) {
    const c = atArcLength(s.p, (s.sVon + s.sBis) / 2);
    s.x = c.x; s.z = c.z;
  }

  const material = new THREE.MeshStandardMaterial({
    map: textur, roughness: 0.85, metalness: 0,
    wireframe: cfg.drahtgitter,
  });

  const meshes = [];
  for (const [feld, teil] of sektoren.teile(alle)) {
    const pos = [], uv = [], idx = [];
    for (const s of teil) {
      const halb = Math.max(0.05, s.p.width / 2 - EINZUG);
      const a = atArcLength(s.p, s.sVon);
      const b = atArcLength(s.p, s.sBis);
      const oben = s.oben;
      const unten = oben - s.hoehe - FUSS;

      const ecke = (c, seite) => [c.x + c.nx * halb * seite, c.z + c.nz * halb * seite];
      const [avx, avz] = ecke(a, -1), [ahx, ahz] = ecke(a, 1);
      const [bvx, bvz] = ecke(b, -1), [bhx, bhz] = ecke(b, 1);

      const punkt = (x, y, z, u, v) => {
        pos.push(x, y, z); uv.push(u / KACHEL, v / KACHEL);
        return pos.length / 3 - 1;
      };
      const flaeche = (p1, p2, p3, p4) => idx.push(p1, p2, p3, p1, p3, p4);

      const t1 = punkt(avx, oben, avz, -halb, s.sVon);
      const t2 = punkt(ahx, oben, ahz, halb, s.sVon);
      const t3 = punkt(bhx, oben, bhz, halb, s.sBis);
      const t4 = punkt(bvx, oben, bvz, -halb, s.sBis);
      flaeche(t1, t2, t3, t4);

      const va = punkt(avx, unten, avz, -halb, unten);
      const vb = punkt(ahx, unten, ahz, halb, unten);
      const vc = punkt(ahx, oben, ahz, halb, oben);
      const vd = punkt(avx, oben, avz, -halb, oben);
      flaeche(va, vb, vc, vd);

      const ha = punkt(bhx, unten, bhz, halb, unten);
      const hb = punkt(bvx, unten, bvz, -halb, unten);
      const hc = punkt(bvx, oben, bvz, -halb, oben);
      const hd = punkt(bhx, oben, bhz, halb, oben);
      flaeche(ha, hb, hc, hd);

      const la = punkt(avx, unten, avz, s.sVon, unten);
      const lb = punkt(avx, oben, avz, s.sVon, oben);
      const lc = punkt(bvx, oben, bvz, s.sBis, oben);
      const ld = punkt(bvx, unten, bvz, s.sBis, unten);
      flaeche(la, lb, lc, ld);

      const ra = punkt(bhx, unten, bhz, s.sBis, unten);
      const rb = punkt(bhx, oben, bhz, s.sBis, oben);
      const rc = punkt(ahx, oben, ahz, s.sVon, oben);
      const rd = punkt(ahx, unten, ahz, s.sVon, unten);
      flaeche(ra, rb, rc, rd);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `stufen_${feld}`;
    meshes.push(mesh);
  }

  meshes.stats = {
    treppen: treppen.length,
    stufen: alle.length,
    hoehe: +(treppen.reduce((a, t) => a + t.hoehe, 0) / treppen.length).toFixed(3),
    tiefe: +(treppen.reduce((a, t) => a + t.tiefe, 0) / treppen.length).toFixed(3),
    anhebung: +(Math.max(...treppen.map((t) => t.anhebung))).toFixed(3),
  };
  return meshes;
}
