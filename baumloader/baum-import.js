// =============================================================================
//  baum-import.js — Baum aus einer Konfiguration erzeugen
//
//  Diese Datei ist der Kern. Sie kennt keine Regler, keine Oberfläche und kein
//  Speichern — sie liest eine Konfiguration und gibt einen THREE.Group zurück,
//  der in eine Szene gehängt werden kann. Genau das braucht das Spiel später:
//
//      import { ladeBaum } from './baum-import.js';
//      const eiche = await ladeBaum('json/eiche.json');
//      scene.add(eiche);
//
//  Aufbau des fertigen Baums — bewusst genau zwei Zeichenaufrufe:
//
//    1 Netz  Holz       — ein einziges BufferGeometry, Stamm achteckig,
//                         Zweige fünfeckig, Rinde als gekachelte Textur
//    1 Netz  Billboards — alle Blattbilder in einem Netz, ausgerichtet im
//                         Vertexshader, die Bilder als Textur-Array (eine
//                         Schicht je PNG). Kein Sortieren, kein Sprite-Wildwuchs.
//
//  Schattenwurf gibt es nicht. Er kostete einen zweiten Durchgang über die
//  ganze Krone und dafür ein eigenes Tiefenmaterial — der teuerste Posten am
//  Baum, und die Krone verdeckt ohnehin fast alles, was er zeichnen würde.
//
//  Der Weg dahin, in dieser Reihenfolge:
//
//    Hülle      Die Eckpunkte als Kugel aus konzentrischen Fibonacci-Schalen.
//               Diese Punkte sind zugleich die Knoten des Astwerks UND die
//               Ankerpunkte der Billboards. Es gibt keine zweite Punktwolke.
//    Stamm      Ein gerader Schaft von 10 cm unter Null bis zum unteren Ende
//               des Zentrums, darüber das Hilfssegment bis zu dessen oberem
//               Ende. Das Zentrum ist eine senkrechte Strecke, keine Mitte —
//               die Äste setzen über ihre ganze Länge verteilt an.
//    Astwerk    Von der Hülle zum Stamm, nicht mehr umgekehrt: zwei oder drei
//               benachbarte Punkte der äußersten Schale suchen sich den
//               gemeinsam nächsten Punkt weiter innen und verbinden sich mit
//               ihm; die so erreichten Punkte tun dasselbe, bis das Zentrum
//               erreicht ist. Damit bekommt jeder Kronenpunkt Holz — das
//               Wachstum kann keinen mehr verfehlen, weil es bei ihm anfängt.
//    Stärke     Pipe-Modell. Weil der Baum von außen nach innen entsteht,
//               nimmt die Dicke nach innen zu, und der Hauptstamm bekommt
//               die größte.
//    Geometrie  Röhren mit Paralleltransport-Rahmen, Stamm achteckig,
//               Zweige fünfeckig.
//
//  Voraussetzung: three.js als ES-Modul unter dem Namen "three".
// =============================================================================

import * as THREE from 'three';

// --- Feste Maße --------------------------------------------------------------
// Voreingestellte Motivbreite eines Billboards in Weltmetern; einstellbar als
// „Realgröße“. Sie ist der Maßstab des ganzen Baums: der Abstand zweier
// Hüllenpunkte ist Motivbreite mal (100 % − Überschneidung), und daran hängen
// Kronenhalbmesser und alles Weitere. Sie steht fest, noch ehe ein einziges
// PNG geladen ist — welches Bild darin liegt, ändert am Astwerk nichts.
export const MOTIV = 2.0;

// Der Stamm reicht so weit unter die Null-Ebene. Damit steht der Baum im Boden,
// statt auf ihm aufzusitzen — auf unebenem Gelände ist das der Unterschied
// zwischen einem Baum und einem schwebenden Modell.
export const STAMM_UNTER_NULL = 0.10;

const STAMM_ANLAUF = 1.12;              // Wurzelanlauf gegenüber dem Schaft

// Kantenzahl der Röhren. Der Stamm bekommt acht, alles andere fünf.
const KANTEN_STAMM = 8;
const KANTEN_ZWEIG = 5;

// Halbmesser eines Zweigendes in Metern. Grundmaß des Pipe-Modells.
const R_SPITZE = 0.020;

// --- Maßstäbe der Verzerrungen -----------------------------------------------
// Kippbetrag der Schwerkraft je Eckpunktabstand Weglänge, bei ±100 und dünnstem
// Trieb. Weil sich die Kippungen über den Ast aufsummieren, zählt hier die
// ganze Länge vom Stamm nach außen und nicht das einzelne Segment: 0,6 ergibt
// über eine übliche Astlänge rund einen rechten Winkel.
const GRAV = 0.60;
// Größter Versatz der Knorrigkeit, als Vielfaches des Halbmessers an dieser
// Stelle. Bei 100 weicht ein Stamm also um anderthalb Halbmesser aus.
const KNORRIG = 1.50;
// Anteil der Segmentlänge. Das Maß hat zwei Aufgaben, und beide hängen
// zusammen: an der Zweigspitze ist es das Maß des Versatzes, überall sonst ist
// es seine Schranke. Weiter als so weicht kein Punkt aus — sonst legt sich ein
// Strang dort um, wo dickes Holz kurze Segmente hat.
const KNORRIG_SCHRITT = 0.30;
// Und die Schranke: so weit darf ein Punkt höchstens ausweichen, gemessen am
// kürzesten Segment, das an ihm hängt. Sie zieht sich zusätzlich zusammen, wo
// das Holz dicker ist als der Schritt — dort und nur dort war etwas zu retten.
const KNORRIG_SCHRANKE = 0.45;

const V = THREE.Vector3;
const Q = THREE.Quaternion;

const cl  = (v, a, b) => (v < a ? a : (v > b ? b : v));
const num = (v, d) => (v == null || isNaN(+v) ? d : +v);

// --- Deterministischer Zufall (Mulberry32) -----------------------------------
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function perpendicular(v, out){
  if (Math.abs(v.y) < 0.9) out.set(0, 1, 0); else out.set(1, 0, 0);
  return out.cross(v).normalize();
}

// =============================================================================
//  Konfiguration
// =============================================================================

// 2: Die Hülle ist eine reine Kugelfläche. „anzahl“ zählt nur noch die Punkte
//    darauf — eine Datei der Fassung 1 ergibt damit eine kleinere Krone als
//    früher, weil dort dieselbe Zahl das ganze Volumen füllte. Dazu kommt
//    „schalen“. Gelesen werden beide Fassungen; normiere() ergänzt, was fehlt.
export const VERSION = 2;

export const STANDARD = {
  v: VERSION,
  name: 'baum',
  seed: 1,
  // Änderungen von Hand, je Eckpunkt: Versatz in Metern, Löschmerker und die
  // festgesetzte Bildnummer (tex, 1-basiert innerhalb der Lage, 0 = gewürfelt).
  // Sie betreffen allein das Billboard — der Punkt bleibt als Attraktor stehen,
  // sonst ändert ein verschobenes Blatt das ganze Astwerk.
  aenderungen: {},
  // Von Hand eingefügte Billboards, siehe normZusatz().
  zusatz: [],
  // Fünf Farbvarianten für das Laub, siehe normLaubfarben(). Alle stehen auf
  // eins, färben also nicht.
  laubfarben: [[1,1,1], [1,1,1], [1,1,1], [1,1,1], [1,1,1]],
  huelle: {
    anzahl:          40,     // Punkte auf der Hülle = Ankerpunkte der Billboards
    schalen:          3,     // gerechnete Knotenlagen zwischen Hülle und Zentrum
    nachbarn:       2.5,     // wie viele Punkte sich je Knoten zusammenfassen
    zentrumUnten:     0,     // unteres Ende der Achse, % eines Hüllendurchmessers
    zentrumOben:      0,     // oberes Ende, dito; beide von der Kronenmitte aus
    ueberschneidung: 40,     // in Prozent der Motivbreite
    innenLeer:       true,   // nur die Hüllenpunkte tragen Billboards
    unrundheit:      35,     // 0 = Kugel, 100 = stark gelappt und geklumpt
    streckung:       1.0,    // Höhenmultiplikator ab Stammoberkante, 0.5 … 4
    blaehung:         0,     // 0 … 50 %, drängt die inneren Attraktoren nach außen
    billboards: {
      unten: 2, mitte: 3, oben: 1,   // Anzahl der Bildvarianten je Lage
      aufloesung: 256,               // Kantenlänge einer Schicht in Bildpunkten
      groesse:    2.0                // Motivbreite in Metern
    }
  },
  holz: {
    unterteilung:   1,        // zusätzliche Punkte je Segment, 0 … 5
    stammDicke:   100,        // 100 … 200 %, verstärkt das Holz zum Stamm hin
    stammLaenge:    2.0,      // Meter über Null bis zur Kronenunterseite
    stammSegmente:  6,        // Stufen des Schafts, Auflösung der Knorrigkeit
    staemme:        1,        // durchgehende Stammpfade, 1 … 6
    teilungen:    100,        // Anteil der Teilungen in Prozent, 10 … 100
    schwerkraft:    0,        // −100 (Drall nach oben) … +100 (nach unten)
    knorrigSchaft:  14,       // 0 … 100, der Hauptstamm für sich
    knorrigStamm:   14,       // 0 … 100, am Astansatz
    knorrigHuelle:  45,       // 0 … 100, am Zweigende; dazwischen linear
    farbe:          '#3a2d20',
    textur:         '',       // Pfad oder Datenadresse, leer = keine
    kachel:         2.0       // Wiederholungen je Astumfang
  }
};

// Die Änderungen von Hand prüfen. Der Schlüssel ist die Nummer des Eckpunkts;
// er gilt nur, solange die Wolke dieselbe ist — an Startwert, Anzahl,
// Überschneidung, Unrundheit oder Stammlänge zu drehen würfelt die Punkte neu,
// und die Nummern zeigen dann auf andere Stellen.
function normAenderungen(src){
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(src)){
    const i = Math.round(+k);
    if (!isFinite(i) || i < 0 || i > 100000) continue;
    const a = src[k] || {};
    // tex ist die von Hand festgesetzte Bildnummer innerhalb der Lage. Sie
    // zählt ab 1; 0 heißt „wie gewürfelt“. Die Obergrenze ist die größte
    // erlaubte Variantenzahl — welche Nummern es wirklich gibt, weiß erst der
    // geladene Billboardsatz, und dort wird umgebrochen statt abgeschnitten.
    const e = { x: cl(num(a.x, 0), -50, 50), y: cl(num(a.y, 0), -50, 50),
                z: cl(num(a.z, 0), -50, 50), weg: !!a.weg,
                tex: Math.round(cl(num(a.tex, 0), 0, 9)),
                // 0 = nach der Höhe in der Krone, 1 unten, 2 mitte, 3 oben
                lage: Math.round(cl(num(a.lage, 0), 0, 3)),
                dreh:  cl(num(a.dreh, 0), -180, 180),
                spieg: !!a.spieg,
                skal:  cl(num(a.skal, 100), 10, 1000) };
    if (e.x || e.y || e.z || e.weg || e.tex || e.lage || e.dreh || e.spieg
        || e.skal !== 100) out[i] = e;
  }
  return out;
}

// Eine gelesene Konfiguration auf Vollständigkeit und Wertebereiche bringen.
// Alles, was fehlt, kommt aus STANDARD; alles, was daneben liegt, wird
// beschnitten. Damit lädt auch eine von Hand geschriebene Datei.
// Von Hand eingefügte Billboards. Sie hängen an einem Hüllenpunkt als Vorlage
// — von ihm kommt der Ort — und tragen ihren eigenen Versatz und ihre eigene
// Textur. Anders als die Änderungen sind sie eine Liste: es können mehrere an
// demselben Punkt sitzen.
function normZusatz(src){
  const out = [];
  if (!Array.isArray(src)) return out;
  for (const q of src){
    const a = q || {};
    const von = Math.round(num(a.von, -1));
    if (!isFinite(von) || von < 0 || von > 100000) continue;
    out.push({
      von: von,
      x: cl(num(a.x, 0), -50, 50), y: cl(num(a.y, 0), -50, 50),
      z: cl(num(a.z, 0), -50, 50),
      tex:  Math.round(cl(num(a.tex, 0), 0, 9)),
      lage: Math.round(cl(num(a.lage, 0), 0, 3)),
      dreh:  cl(num(a.dreh, 0), -180, 180),
      spieg: !!a.spieg,
      skal:  cl(num(a.skal, 100), 10, 1000)
    });
    if (out.length >= 2000) break;
  }
  return out;
}

// Wie viele Farbvarianten ein Baum mitbringt. Die Zahl steht fest: sie ist
// zugleich der Nenner der Verteilung im Spiel — sechs Möglichkeiten, die fünf
// Varianten und ungefärbt.
export const LAUBFARBEN = 5;

// Die Farbvarianten prüfen. Jede ist ein Dreisatz von Multiplikatoren auf das
// Blattbild, keine Farbe im gewöhnlichen Sinn: 1 lässt den Kanal, wie er ist,
// darunter dunkelt er, darüber hellt er auf. Deshalb reicht der Bereich über
// eins hinaus — ein Wald aus einer einzigen Vorlage hätte sonst nie einen
// Baum, der heller steht als seine Bilder.
//
// Es sind immer genau LAUBFARBEN Einträge. Was fehlt, steht auf eins und färbt
// damit nicht; die Zeile bleibt aber erhalten, denn sie hat im Spiel ihren
// festen Anteil an der Verteilung.
function normLaubfarben(src){
  const out = [];
  for (let i = 0; i < LAUBFARBEN; i++){
    const q = (Array.isArray(src) && Array.isArray(src[i])) ? src[i] : null;
    out.push(q ? [cl(num(q[0], 1), 0, 4), cl(num(q[1], 1), 0, 4), cl(num(q[2], 1), 0, 4)]
               : [1, 1, 1]);
  }
  return out;
}

export function normiere(src){
  const s = src || {};
  const h = s.huelle || {};
  const b = h.billboards || {};
  const z = s.holz || {};
  // Das Zentrum ist eine Strecke; ihr oberes Ende darf nicht unter das untere.
  const zUnten = cl(num(h.zentrumUnten, 0), -100, 100);
  const zOben  = Math.max(zUnten, cl(num(h.zentrumOben, 0), -100, 100));
  const name = String(s.name || STANDARD.name).toLowerCase().replace(/[^a-z_\-]/g, '');
  return {
    v: VERSION,
    name: name || STANDARD.name,
    seed: Math.round(num(s.seed, STANDARD.seed)),
    aenderungen: normAenderungen(s.aenderungen),
    zusatz:      normZusatz(s.zusatz),
    laubfarben:  normLaubfarben(s.laubfarben),
    // Das Paket wird nicht geprüft, nur durchgereicht: es enthält Bilddaten
    // und keine Einstellungen, und was darin steht, hat der Export erzeugt.
    paket:       (s.paket && typeof s.paket === 'object') ? s.paket : null,
    huelle: {
      anzahl:          Math.round(cl(num(h.anzahl,          40),  1, 400)),
      schalen:         Math.round(cl(num(h.schalen,          3),  0,   8)),
      nachbarn:        cl(num(h.nachbarn,        2.5),  2,   4),
      zentrumUnten:    zUnten,
      zentrumOben:     zOben,
      ueberschneidung: cl(num(h.ueberschneidung, 40), 10, 90),
      innenLeer:       h.innenLeer === undefined ? true : !!h.innenLeer,
      unrundheit:      cl(num(h.unrundheit, 35), 0, 100),
      streckung:       cl(num(h.streckung, 1), 0.5, 4),
      blaehung:        cl(num(h.blaehung, 0), 0, 50),
      billboards: {
        unten: Math.round(cl(num(b.unten, 2), 1, 9)),
        mitte: Math.round(cl(num(b.mitte, 3), 1, 9)),
        oben:  Math.round(cl(num(b.oben,  1), 1, 9)),
        // Nur Zweierpotenzen, sonst kostet die Textur unnötig Speicher.
        aufloesung: num(b.aufloesung, 256) >= 384 ? 512 : 256,
        groesse:    cl(num(b.groesse, MOTIV), 0.2, 12)
      }
    },
    holz: {
      unterteilung:  Math.round(cl(num(z.unterteilung, 1), 0, 5)),
      stammDicke:    cl(num(z.stammDicke, 100), 100, 200),
      stammLaenge:   cl(num(z.stammLaenge, 2), 0.3, 8),
      stammSegmente: Math.round(cl(num(z.stammSegmente, 6), 1, 24)),
      staemme:       Math.round(cl(num(z.staemme, 1), 1, 6)),
      teilungen:     cl(num(z.teilungen, 100), 10, 100),
      schwerkraft:   cl(num(z.schwerkraft, 0), -100, 100),
      // Der Schaft hatte früher keinen eigenen Regler, sondern lief unter
      // „Stamm“ mit. Fehlt er in der Datei, erbt er von dort — eine alte Datei
      // behält damit ihren Stamm, so wie er war.
      knorrigSchaft: cl(num(z.knorrigSchaft, cl(num(z.knorrigStamm, 14), 0, 100)), 0, 100),
      knorrigStamm:  cl(num(z.knorrigStamm, 14), 0, 100),
      knorrigHuelle: cl(num(z.knorrigHuelle, 45), 0, 100),
      farbe:         /^#[0-9a-f]{6}$/i.test(z.farbe || '') ? z.farbe : STANDARD.holz.farbe,
      textur:        typeof z.textur === 'string' ? z.textur.trim() : STANDARD.holz.textur,
      kachel:        cl(num(z.kachel, 2), 0.25, 12)
    }
  };
}

// =============================================================================
//  Hülle — die Eckpunkte, an denen später die Billboards sitzen
// =============================================================================

// Die Hülle ist eine einzige Kugelfläche: alle Punkte liegen darauf, innere
// gibt es nicht mehr. Der Regler „Anzahl Hüllenpunkte“ ist damit wörtlich zu
// nehmen — er zählt die Ankerpunkte der Billboards, und sonst nichts. Die
// Knoten, über die das Astwerk nach innen zusammenläuft, werden gerechnet;
// wie viele Lagen es davon gibt, sagt „Anzahl Schalen“.
//
// Verteilt wird nach Fibonacci. Das Verfahren streut auf einer Kugelfläche bei
// jeder Punktzahl gleichmäßig und kennt keine Vorzugsrichtung — anders als eine
// Kugelpackung, aus der ein Kuboktaeder mit ebenen Flächen würde.
const GOLD = Math.PI * (3 - Math.sqrt(5));
// Flächenbedarf eines Punktes gegenüber dem Quadrat des Sollabstands. Bei
// dichtester Lage in der Ebene sind es √3/2 ≈ 0,866, und 1/√0,866 ist 1,075.
// Über diesen Faktor hängen Punktzahl und Kronenhalbmesser zusammen.
const PACKUNG = 1.075;

// Halbmesser der Kugel, auf der n Punkte im Sollabstand nebeneinander liegen.
// Umgestellt aus 4πR² = n · (Abstand/PACKUNG)².
function huellenRadius(n, abstand){
  return Math.max(abstand * 0.5,
                  abstand / PACKUNG * Math.sqrt(Math.max(1, n) / (4 * Math.PI)));
}

// Die Punkte auf der Kugelfläche — mit einer Lücke genau unten.
//
// Gerechnet wird für n + 1 Punkte, ausgegeben werden die ersten n: der letzte
// säße genau am Südpol und fällt weg. Das ist Absicht. Er stünde senkrecht
// unter dem Kronenmittelpunkt und damit auf der Stammachse, und weil er wie
// jeder Hüllenpunkt einen Pfad nach innen anfängt, zöge er einen Ast von außen
// die Achse entlang zu sich herunter. Dort, wo der Stamm in die Krone tritt,
// hat ein Baum ohnehin kein Laub.
//
// Der unterste verbleibende Punkt liegt damit bei y = −1 + 3/(n+1) statt am
// Pol; die Lücke ist genau einen Punktabstand breit.
function kugelSchale(n, r, ph){
  const pts = [];
  const m = n + 1;                  // die Lücke unten zählt mit
  for (let i = 0; i < n; i++){
    const y = 1 - (i + 0.5) / m * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y*y));
    const th = GOLD * i + ph;
    pts.push(new V(Math.cos(th)*rad*r, y*r, Math.sin(th)*rad*r));
  }
  return pts;
}

// Unrundheit. Dasselbe Sinusfeld wirkt zweifach:
//
//   Radialstauchung — schiebt jeden Punkt vom Mittelpunkt weg oder zu ihm hin.
//   Das formt den Rand: aus der Kugel werden Buchten und Ballen.
//
//   Verschiebung entlang des Feldgradienten — wo das Feld ein Maximum hat,
//   laufen die Punkte zusammen, in den Senken auseinander. Erst das gibt
//   Klumpen und Löcher statt einer nur unrunden, aber gleichmäßig gefüllten
//   Wolke. Ohne sie sitzen die Billboards trotz gelappter Hülle in Reih und
//   Glied.
function verforme(pts, mitte, R0, staerke, rnd){
  if (staerke <= 0 || R0 <= 0) return;
  const ph = [];
  for (let n=0;n<9;n++) ph.push(rnd() * Math.PI * 2);
  const F = [1.15, 2.40, 4.90], W = [1, 0.52, 0.26];
  const wSum = W[0] + W[1] + W[2];

  const feld = (x, y, z) => {
    let v = 0;
    for (let o=0;o<3;o++){
      const k = F[o] * Math.PI / R0;
      v += W[o] * Math.sin(k*x+ph[o*3]) * Math.sin(k*y+ph[o*3+1]) * Math.sin(k*z+ph[o*3+2]);
    }
    return v / wSum;
  };
  const grad = (x, y, z, out) => {
    out.set(0,0,0);
    for (let o=0;o<3;o++){
      const k = F[o] * Math.PI / R0;
      const sx=Math.sin(k*x+ph[o*3]),   cx =Math.cos(k*x+ph[o*3]);
      const sy=Math.sin(k*y+ph[o*3+1]), cy =Math.cos(k*y+ph[o*3+1]);
      const sz=Math.sin(k*z+ph[o*3+2]), cz =Math.cos(k*z+ph[o*3+2]);
      const w = W[o] / wSum;
      out.x += w*cx*sy*sz; out.y += w*sx*cy*sz; out.z += w*sx*sy*cz;
    }
    return out;
  };

  // Der Gradient ist ohne Wellenzahl gerechnet und damit maßstabslos; sein
  // Beitrag muss deshalb mit der Wolkengröße wachsen, sonst verpufft die
  // Klumpung bei kleinen und zerreißt die Wolke bei großen Bäumen.
  const amp  = 0.40 * staerke;
  const cAmp = 0.22 * staerke * R0;
  const gv = new V();
  for (const p of pts){
    // Gerechnet wird um den Kronenmittelpunkt, nicht um den Ursprung: das
    // Gerüst steht in Weltkoordinaten, und das Feld soll die Krone verformen
    // und nicht mit der Stammlänge durch sie hindurchwandern.
    const x = p.x, y = p.y - mitte, z = p.z;
    grad(x, y, z, gv);
    const nx = (x + gv.x * cAmp), ny = (y + gv.y * cAmp), nz = (z + gv.z * cAmp);
    const f = 1 + amp * feld(nx, ny, nz);
    p.set(nx * f, mitte + ny * f, nz * f);
  }
}

// Die fertige Hülle in Weltkoordinaten.
//
//   abstand    Sollabstand zweier Eckpunkte
//   R0         Radius der ungestreckten Wolke
//   basis      Stammoberkante — die Kugel sitzt mit ihrem Fuß darauf
//   mitte      Höhe des Kronenmittelpunkts nach der Streckung
//   radiusY    senkrechter Halbmesser nach der Streckung
export function baueHuelle(cfg){
  const h = cfg.huelle;
  const abstand = h.billboards.groesse * (1 - h.ueberschneidung / 100);
  const rnd = mulberry32(((cfg.seed | 0) * 2654435761) >>> 0);
  const R0 = huellenRadius(h.anzahl, abstand);
  const pts = kugelSchale(h.anzahl, R0, rnd() * Math.PI * 2);

  // Welche Punkte ein Billboard tragen. Die Unrundheit greift erst später, im
  // fertigen Gerüst; hier steht noch die reine Kugel.
  const ae = cfg.aenderungen || {};
  const aussen = new Array(pts.length).fill(true);
  const sichtbar = aussen.slice();
  let sichtbarAnzahl = 0;
  for (let i = 0; i < sichtbar.length; i++){
    if (ae[i] && ae[i].weg) sichtbar[i] = false;
    if (sichtbar[i]) sichtbarAnzahl++;
  }

  // Anheben: die Hauptstammlänge schiebt die Kugel nach oben, ihr tiefster
  // Punkt liegt auf der Stammoberkante. Weil dort jetzt ein Punkt genau am
  // Südpol sitzt, fällt er mit der Stammoberkante zusammen — der unterste
  // Zweig setzt also genau da an, wo der Schaft aufhört.
  const basis = cfg.holz.stammLaenge;
  for (const p of pts) p.y += basis + R0;

  return {
    punkte:  pts,
    aussen:  aussen,
    sichtbar: sichtbar,
    sichtbarAnzahl: sichtbarAnzahl,
    abstand: abstand,
    R0:      R0,
    basis:   basis,
    mitte:   basis + R0,
    radiusY: R0,
    gestreckt: false
  };
}

// =============================================================================
//  Astwerk — von der Hülle zum Stamm
//
//  Umgekehrt zur Space Colonization, die hier vorher stand. Dort wuchsen die
//  Triebe vom Stamm nach außen und suchten sich Attraktoren; was sie nicht
//  fanden, blieb leer. Je weniger Kronenpunkte, desto löchriger wurde der Baum
//  — und wenige Punkte sind gerade das Ziel.
//
//  Jetzt läuft es andersherum, und damit steht das Ergebnis von vornherein
//  fest: jeder Kronenpunkt bekommt Holz, weil das Holz bei ihm anfängt.
//
//    1  Die äußerste Schale ist die Front. Zwei oder drei nebeneinander-
//       liegende Punkte suchen sich den gemeinsam nächsten Kronenpunkt weiter
//       innen und werden mit ihm durch je ein Segment verbunden.
//    2  Die so erreichten Punkte sind die neue Front. Sie tun dasselbe.
//    3  Das wiederholt sich, bis das Zentrum der Krone erreicht ist.
//
//  Vom Zentrum führt ein Hilfssegment hinunter zur Oberkante des Hauptstamms;
//  der reicht von dort bis unter den Boden.
//
//  Aufgebaut wird der Baum in dieser Richtung, gespeichert aber in der
//  umgekehrten: Elternknoten ist immer der weiter innen liegende. Damit
//  bleiben Pipe-Modell und Röhrengeometrie unverändert — beide laufen von der
//  Wurzel nach außen, und die Stärke nimmt von selbst nach innen zu.
// =============================================================================

// Größter Nachbarabstand innerhalb einer Gruppe, gemessen am mittleren Abstand
// der Front selbst. Ein festes Maß taugt hier nicht: die Front dünnt mit jeder
// Schale um das Zweieinhalbfache aus, ihre Punkte rücken also entsprechend
// auseinander, und ein Maß in Eckpunktabständen wäre nach zwei Schalen zu eng.
const GRUPPE_MAX = 2.20;
// --- Das Zentrum als senkrechte Achse ----------------------------------------
// Bisher war das Zentrum ein Punkt, und alle Pfade liefen dort zusammen. Jetzt
// ist es eine Strecke auf der Stammachse: ein Knoten sucht sich nicht mehr die
// Mitte, sondern den nächstgelegenen Punkt dieser Strecke. Wer oben in der
// Krone sitzt, zielt also weiter oben, wer unten sitzt, weiter unten — und
// reicht die Strecke von der Kronenunterseite bis zum Kronendach, laufen die
// Äste waagerecht auf sie zu.
//
// Beide Enden zählen in Hüllendurchmessern von der Kronenmitte aus: −100 % ist
// einen ganzen Durchmesser darunter, +100 % einen darüber. Beide Enden dürfen
// dabei unter der Mitte liegen.
//
// Die Achse ist eine Kette und kein einzelnes Segment — sonst könnten die Äste
// nicht auf ihrer jeweils eigenen Höhe ansetzen. Ihre Knoten stehen deshalb
// genau dort, wo ein Ast ankommt, und werden erst gesetzt, wenn alle
// Ansatzhöhen feststehen. Zwei Ansätze, die enger beieinander liegen als das,
// teilen sich einen Knoten.
//
// Das Maß ist nicht fest, sondern ein Anteil des Kronenhalbmessers: an einem
// großen Baum ist auch der Stamm dick, und Ringe im Zentimeterabstand auf
// zwanzig Zentimeter dickem Holz sind keine Kette mehr, sondern eine
// Ziehharmonika — jeder Versatz wird dort zum Knick, und gerechnet wird an
// ihnen ohnehin umsonst. Bei tief gezogenem Zentrum drängen sich viele Ansätze
// auf wenigen Zentimetern; genau dort fiel es auf.
const ACHSE_ENG = 0.01;
const ACHSE_ENG_R = 0.03;
// Tiefster erlaubter Punkt des unteren Achsenendes. Ohne diese Schranke kippte
// der Hauptstamm um, sobald das Ende unter den Boden gezogen wird.
const ACHSE_MIN = 0.30;

export function baueSkelett(cfg, huelle){
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const H  = huelle || baueHuelle(cfg);
  const P  = H.punkte;
  const nP = P.length;
  const schalen  = Math.round(cl(num(cfg.huelle.schalen, 3), 0, 8));
  const nachbarn = cl(num(cfg.huelle.nachbarn, 2.5), 2, 4);
  // Derselbe Startwert ergibt denselben Baum. Gewürfelt wird zweierlei: in
  // welcher Reihenfolge die Punkte sich ihre Nachbarn greifen, und wie viele
  // es jeweils werden.
  const rnd = mulberry32((((cfg.seed | 0) * 1103515245) ^ 0x9e3779b9) >>> 0);

  // --- Knoten ----------------------------------------------------------------
  // Ein Knoten trägt nur, was Holz und Kennzahlen brauchen: Ort, Stärke,
  // Verwandtschaft und die Frage, ob er zum Stamm gehört (achtkantige Röhre).
  // `punkt` ist die Nummer des Hüllenpunkts, auf dem er sitzt, oder −1 für
  // einen gerechneten Knoten im Inneren.
  const nd = [];
  function knoten(x, y, z, stammPfad, punkt, schale){
    nd.push({
      parent: -1, children: [], pos: new V(x, y, z), r: R_SPITZE,
      stamm: false, stammPfad: !!stammPfad,
      punkt: punkt === undefined ? -1 : punkt,
      // 0 = Hüllenpunkt, 1…n = gerechnete Schale, −1 = Stamm oder Achse
      schale: schale === undefined ? -1 : schale
    });
    return nd.length - 1;
  }
  function verbinde(kind, elter){
    nd[kind].parent = elter;
    nd[elter].children.push(kind);
  }

  // --- Das Zentrum ------------------------------------------------------------
  // Die beiden Enden, in Hüllendurchmessern von der Kronenmitte aus. Das obere
  // darf nicht unter das untere rutschen; das untere nicht unter den Boden.
  const D = 2 * H.R0;
  const zu = cl(num(cfg.huelle.zentrumUnten, 0), -100, 100);
  const zo = Math.max(zu, cl(num(cfg.huelle.zentrumOben, 0), -100, 100));
  const yUnten = Math.max(ACHSE_MIN, H.mitte + zu / 100 * D);
  const yOben  = Math.max(yUnten,    H.mitte + zo / 100 * D);

  // --- Hauptstamm bis zum unteren Ende des Zentrums --------------------------
  const nWurzel = knoten(0, -STAMM_UNTER_NULL, 0, true);
  nd[nWurzel].stamm = true;
  const achsLaenge = yOben - yUnten;
  const zentrum = new V(0, H.mitte, 0);

  // --- Die Front: die Hüllenpunkte -------------------------------------------
  let front = [];
  for (let i = 0; i < nP; i++) front.push(knoten(P[i].x, P[i].y, P[i].z, false, i, 0));

  // --- Gruppen ---------------------------------------------------------------
  // Der Reihe nach greift sich jeder noch freie Punkt der Front seine nächsten
  // freien Nachbarn; wer schon vergeben ist, bleibt es.
  //
  // Wie viele es werden, sagt „Nachbarn“. Der Nachkommaanteil ist die
  // Wahrscheinlichkeit, dass es einer mehr wird: 2,5 heißt also etwa gleich
  // oft zwei und drei, 2,8 überwiegend drei. Ganze Zahlen ergeben eine feste
  // Größe. Gewürfelt wird je Gruppe, mit dem Startwert des Baums.
  //
  // Auch die Reihenfolge wird gewürfelt. Ohne das hinge sie an der Nummerierung
  // der Fibonacci-Punkte, und ein anderer Startwert drehte die Krone nur um
  // ihre Achse, statt das Astwerk umzubauen.
  //
  // Die Abstandsschranke wird an der Front selbst gemessen und nicht am
  // Eckpunktabstand: mit jeder Schale wird die Front dünner und ihre Punkte
  // stehen weiter auseinander. Als Maß dient der mittlere Abstand zum nächsten
  // Nachbarn — was deutlich darüber liegt, ist kein Nachbar mehr. Findet ein
  // Punkt darin nicht genug, bleibt seine Gruppe eben kleiner.
  function gruppiere(f){
    const n = f.length;
    if (n <= 1) return n ? [[f[0]]] : [];
    // Mittlerer Abstand zum nächsten Nachbarn
    let summe = 0;
    for (let a = 0; a < n; a++){
      let d1 = Infinity;
      for (let b = 0; b < n; b++){
        if (a === b) continue;
        const d = nd[f[a]].pos.distanceTo(nd[f[b]].pos);
        if (d < d1) d1 = d;
      }
      summe += d1;
    }
    const weit = GRUPPE_MAX * summe / n;

    const folge = f.slice();
    for (let i = folge.length - 1; i > 0; i--){
      const j = Math.floor(rnd() * (i + 1));
      const t = folge[i]; folge[i] = folge[j]; folge[j] = t;
    }

    const ganz = Math.floor(nachbarn), teil = nachbarn - ganz;
    const frei = new Set(f);
    const gruppen = [];
    for (const k of folge){
      if (!frei.has(k)) continue;
      frei.delete(k);
      const g = [k];
      const soll = ganz + (rnd() < teil ? 1 : 0);
      while (g.length < soll){
        let bd = Infinity, best = -1;
        for (const m of frei){
          const d = nd[k].pos.distanceTo(nd[m].pos);
          if (d < bd){ bd = d; best = m; }
        }
        // Die Schranke wächst mit der Gruppe. Wer vier Punkte einsammeln will,
        // muss die doppelte Fläche absuchen wie für zwei — also den √2-fachen
        // Halbmesser. Stand sie fest, blieben die großen Gruppen unter ihrer
        // Sollgröße: bei 3,5 kamen im Mittel nur 3,0 Punkte zusammen.
        if (best < 0 || bd > weit * Math.sqrt((g.length + 1) / 2)) break;
        g.push(best); frei.delete(best);
      }
      gruppen.push(g);
    }
    return gruppen;
  }

  // --- Die Schalen nach innen ------------------------------------------------
  // Erste Rechnung, und sie kennt die Achse noch nicht: alles läuft auf den
  // einen Punkt in der Kronenmitte zu. Je Schale wird jede Gruppe zu einem
  // Knoten zusammengefasst, der auf dem Halbmesser dieser Schale liegt, in der
  // Richtung, in der der Schwerpunkt der Gruppe von der Mitte aus steht — also
  // in dem Sektor, den diese Gruppe bedient. Die Schalen liegen in gleichen
  // Abständen zwischen Hülle und Mitte: bei drei Schalen auf drei Vierteln,
  // der Hälfte und einem Viertel des Kronenhalbmessers.
  //
  // Erst danach werden die Äste senkrecht auseinandergezogen. Das ist der
  // Grund, warum diese Rechnung nichts von der Achse wissen muss.
  //
  // Weil sich die Front je Schale auf etwa ein Drittel verkleinert, entscheidet
  // die Schalenzahl zugleich, wie viele Hauptäste am Stamm ankommen. Zu wenige
  // Schalen, und dort laufen zwanzig Segmente in einem Punkt zusammen — ein
  // Speichenrad. Wie viele es geworden sind, steht in den Kennzahlen.
  // --- Blähung ---------------------------------------------------------------
  // Als säße im Zentrum etwas Abstoßendes: jede Schale rückt um denselben
  // Anteil ihres Abstands zur Hülle nach außen. Bei 50 % legt eine Schale den
  // halben Weg zur Hülle zurück — die innerste also weit, die äußerste kaum,
  // und die Hülle selbst gar nicht, denn sie ist keine Schale. Das Astwerk wird
  // dadurch nach außen gedrängt und die Krone innen offener, ohne dass sich am
  // Umriss oder an einem einzigen Billboard etwas ändert.
  const blaehung = cl(num(cfg.huelle.blaehung, 0), 0, 50) / 100;

  const mitte = new V(), _u = new V();
  const innenKnoten = [];
  let innen = 0, inGruppen = 0;
  for (let j = 1; j <= schalen && front.length; j++){
    const rSchale = H.R0 * (schalen + 1 - j) / (schalen + 1);
    const rZiel = rSchale + blaehung * (H.R0 - rSchale);
    const naechste = [];
    for (const g of gruppiere(front)){
      mitte.set(0, 0, 0);
      for (const k of g) mitte.add(nd[k].pos);
      mitte.multiplyScalar(1 / g.length);
      _u.subVectors(mitte, zentrum);
      // Eine Gruppe, die rings um die Mitte steht, hat keine Richtung mehr.
      // Dann tut es die ihres ersten Punktes.
      if (_u.lengthSq() < 1e-8) _u.subVectors(nd[g[0]].pos, zentrum);
      if (_u.lengthSq() < 1e-8) _u.set(0, 1, 0);
      _u.normalize();
      const ziel = knoten(_u.x * rZiel, zentrum.y + _u.y * rZiel, _u.z * rZiel,
                          false, -1, j);
      innen++; inGruppen += g.length;
      innenKnoten.push(ziel);
      for (const k of g) verbinde(k, ziel);
      naechste.push(ziel);
    }
    front = naechste;
  }
  // Was nach der letzten Schale übrig ist, sind die Gesamt-Äste: die Stränge,
  // die am Stamm ansetzen. Angeschlossen werden sie erst, wenn ihre Höhe
  // feststeht.
  const aeste = front;

  // --- Wohin jeder Gesamt-Ast am Stamm gehört --------------------------------
  // Das Gewicht eines Astes ist die mittlere Höhe seiner Hüllenpunkte über der
  // Kronenmitte. Ein Ast, der die Krone oben bedient, bekommt damit ein großes
  // positives, einer aus dem unteren Teil ein negatives Gewicht — und die
  // Gewichte werden linear auf die Strecke zwischen den beiden Achsenenden
  // abgebildet: das größte kommt an das obere Ende, das kleinste an das untere.
  function gewicht(wurzel){
    let summe = 0, zahl = 0;
    const st = [wurzel];
    while (st.length){
      const i = st.pop();
      if (nd[i].punkt >= 0){ summe += nd[i].pos.y - H.mitte; zahl++; }
      for (const c of nd[i].children) st.push(c);
    }
    return zahl ? summe / zahl : 0;
  }
  const gew = aeste.map(gewicht);
  let gMin = Infinity, gMax = -Infinity;
  for (const w of gew){ if (w < gMin) gMin = w; if (w > gMax) gMax = w; }
  const spanne = gMax - gMin;
  // Bleibt nur ein Ast übrig oder liegen alle gleich, gibt es kein Oben und
  // Unten mehr. Dann setzt alles am oberen Ende an — dort setzt sich der Stamm
  // geradewegs fort.
  const yAst = gew.map(w => spanne > 1e-9
    ? yUnten + (w - gMin) / spanne * (yOben - yUnten)
    : yOben);

  // --- Die Achse ------------------------------------------------------------
  // Sie bekommt an jeder Ansatzhöhe einen Knoten, dazu die beiden Enden. Eine
  // feste Stufung täte es nicht: läge der nächste Knoten daneben, säße der
  // Astansatz nicht auf seiner gerechneten Höhe.
  const hoehen = [yUnten, yOben].concat(yAst).sort((a, b) => a - b);
  const eng = Math.max(ACHSE_ENG, H.R0 * ACHSE_ENG_R);
  const achse = [];
  for (const y of hoehen){
    if (achse.length && y - nd[achse[achse.length-1]].pos.y < eng) continue;
    const k = knoten(0, y, 0, true);
    if (achse.length) verbinde(k, achse[achse.length-1]);
    else { nd[k].stamm = true; verbinde(k, nWurzel); }
    achse.push(k);
  }
  function anDerAchse(y){
    let best = achse[0], bd = Infinity;
    for (const k of achse){
      const d = Math.abs(nd[k].pos.y - y);
      if (d < bd){ bd = d; best = k; }
    }
    return best;
  }

  // --- Die Äste senkrecht auseinanderziehen ----------------------------------
  // Der Ansatz wandert um die volle Strecke, die Hülle bleibt stehen, und
  // dazwischen läuft es linear aus. Maß ist der Abstand von der Kronenmitte:
  // ein Hüllenpunkt liegt genau auf dem Kronenhalbmesser und rührt sich
  // deshalb nicht — die Billboards bleiben, wo sie sind, und der Umriss der
  // Krone bleibt die Kugel, die er sein soll.
  for (let a = 0; a < aeste.length; a++){
    verbinde(aeste[a], anDerAchse(yAst[a]));
    const delta = yAst[a] - H.mitte;
    if (Math.abs(delta) < 1e-9) continue;
    const st = [aeste[a]];
    while (st.length){
      const i = st.pop(), p = nd[i].pos;
      const r = Math.hypot(p.x, p.y - H.mitte, p.z);
      p.y += delta * cl(1 - r / H.R0, 0, 1);
      for (const c of nd[i].children) st.push(c);
    }
  }

  // --- Stärke: Pipe-Modell ---------------------------------------------------
  // Flächenerhaltung: der Querschnitt eines Astes ist die Summe der
  // Querschnitte seiner Kinder. Weil der Baum von außen nach innen gebaut ist,
  // nimmt die Dicke damit von selbst nach innen zu, und der Hauptstamm bekommt
  // die größte — er ist die Wurzel des ganzen Baums.
  const reihe = [];
  {
    const st = [0];
    while (st.length){
      const i = st.pop(); reihe.push(i);
      for (const c of nd[i].children) st.push(c);
    }
    for (let m = reihe.length - 1; m >= 0; m--){
      const i = reihe[m];
      if (!nd[i].children.length){ nd[i].r = R_SPITZE; continue; }
      let sum = 0;
      for (const c of nd[i].children) sum += nd[c].r * nd[c].r;
      nd[i].r = Math.sqrt(sum);
    }
  }
  // --- Stammdicke ------------------------------------------------------------
  // Ein Aufschlag auf das, was das Pipe-Modell gerechnet hat, und er wächst mit
  // der Stärke selbst: ganz unten voll, an den Zweigen nicht mehr messbar. Ein
  // gleichmäßiger Faktor täte es nicht — der machte aus jedem Zweig einen
  // Knüppel und ließe das Verhältnis, in dem der Baum steht, unverändert.
  //
  // Maß ist der Halbmesser der Wurzel, also der dickste im Baum. Er wird
  // deshalb vor dem Aufschlag gemerkt und danach neu genommen.
  {
    const dicke = cl(num(cfg.holz.stammDicke, 100), 100, 200) / 100;
    if (dicke > 1.0001){
      const R = Math.max(nd[0].r, 1e-6);
      for (const k of nd) k.r *= 1 + (dicke - 1) * cl(k.r / R, 0, 1);
    }
  }
  const wurzelR = Math.max(nd[0].r, 1e-6);

  // --- Verjüngung des Hilfssegments ------------------------------------------
  // Sie steht schon da: das Pipe-Modell oben hat sie mitgerechnet.
  //
  // Vorher lag hier eine vorgeschriebene lineare Rampe vom Hauptstammdurch-
  // messer unten auf eine aus den Schalen gemittelte Aststärke oben. Die konnte
  // nicht passen, weil sie nicht wusste, was tatsächlich an der Achse hängt.
  // Nachgemessen lag sie zwischen dem 0,11-fachen und dem 1,26-fachen dessen,
  // was das Holz darüber verlangt — bei 110 Punkten und −50/+50 war die
  // Achsenspitze 4,0 cm dick und der Ast, der dort weiterläuft, 34,9 cm. Genau
  // das war der Absatz, den man dem Stamm oben ansah.
  //
  // Seit die Äste über die ganze Länge der Achse verteilt ansetzen, braucht es
  // die Vorschrift nicht mehr: die Achse ist ein Strang wie jeder andere, und
  // die Flächenerhaltung verjüngt sie von selbst — unter jedem Ansatz ein Stück
  // dicker, oben genau so dick wie das, was weitergeht. Beide Forderungen sind
  // damit erfüllt, ohne dass eine davon aufgeschrieben werden muss: unten steht
  // der volle Hauptstammdurchmesser, denn dort läuft alles zusammen, und oben
  // die Stärke der Äste, die dort ankommen.

  // Kinder ordnen. Die Achse geht vor, danach entscheidet die Stärke. Ohne den
  // Vorrang risse ein gleich dicker Ast den Strang an sich, und der Stamm
  // bekäme dort fünf Kanten statt acht.
  const vorn = k => (nd[k].stammPfad ? 1 : 0);
  for (let i = 0; i < nd.length; i++)
    if (nd[i].children.length > 1)
      nd[i].children.sort((a, b) => (vorn(b) - vorn(a)) || (nd[b].r - nd[a].r));


  // ===========================================================================
  //  Verzerrungen
  //
  //  Bis hierher steht ein gerades Gerüst in einer runden Krone. Was jetzt
  //  folgt, verschiebt nur noch Punkte: die Verwandtschaft ändert sich nicht
  //  mehr, keine Verzerrung erzeugt eine Gabelung, und keine ändert eine
  //  Stärke. Die Röhren entstehen erst danach, senkrecht zum verzerrten
  //  Verlauf — deshalb bleiben die Äste in sich rund, wie krumm sie auch
  //  laufen.
  //
  //  Die Reihenfolge ist nicht beliebig. Die Streckung geht voran, weil sie
  //  den Maßstab setzt; die Unterteilung folgt, damit alles Weitere auch die
  //  neuen Punkte trifft; danach die drei Verschiebungen, von der großen Form
  //  (Unrundheit) über die mittlere (Schwerkraft) zur kleinen (Knorrigkeit).
  // ===========================================================================
  const rv = mulberry32((((cfg.seed | 0) * 22695477) ^ 0x2545f491) >>> 0);

  // --- Streckung vertikal ----------------------------------------------------
  // Alle Höhen über der Kronenunterseite werden mit dem Faktor multipliziert.
  // Der Schaft darunter bleibt, wie er ist — gestreckt wird die Krone.
  const streck = cfg.huelle.streckung;
  if (Math.abs(streck - 1) > 1e-6){
    const b = H.basis;
    for (const k of nd) if (k.pos.y > b) k.pos.y = b + (k.pos.y - b) * streck;
    for (const p of H.punkte) if (p.y > b) p.y = b + (p.y - b) * streck;
    H.mitte   = b + (H.mitte - b) * streck;
    H.radiusY = H.R0 * streck;
    H.gestreckt = true;
  }

  // --- Segmentunterteilung ---------------------------------------------------
  // Zusätzliche Punkte auf der Geraden zwischen zwei Knoten. Sie teilen kein
  // Segment im Sinne einer Gabelung — es kommt kein Ast dazu, nur Stützstellen,
  // an denen die folgenden Verzerrungen angreifen können. Ohne sie bliebe ein
  // Ast zwischen zwei Gabeln kerzengerade, wie stark man auch an Knorrigkeit
  // oder Schwerkraft dreht.
  //
  //   0   nichts
  //   1   ein Punkt je Segment, also zwei Segmente daraus
  //   2   zwei Punkte, drei Segmente
  //
  // Zwei Ausnahmen, beide der Länge wegen:
  //
  //   Der Schaft vom Boden bis zum unteren Ende des Zentrums ist ein einziges
  //   langes Segment. Er hat seinen eigenen Regler, „Stammsegmente“.
  //
  //   Das Hilfssegment hat an jedem Astansatz ohnehin schon einen Punkt — der
  //   muss dort stehen, sonst hinge der Ansatzring des Astes in der Luft. Diese
  //   Punkte sind seine erste Unterteilung; ein weiterer kommt deshalb erst ab
  //   Stufe 2 zwischen je zwei Ansätze.
  const unter    = Math.round(cl(num(cfg.holz.unterteilung, 1), 0, 5));
  const stammSeg = Math.round(cl(num(cfg.holz.stammSegmente, 6), 1, 24));

  function unterteile(c, anz){
    if (anz <= 0) return;
    const p = nd[c].parent;
    if (p < 0) return;
    const a = nd[p].pos, b = nd[c].pos, rA = nd[p].r, rB = nd[c].r;
    let vor = p;
    for (let i = 1; i <= anz; i++){
      const t = i / (anz + 1);
      const j = knoten(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
                       a.z + (b.z - a.z) * t,
                       nd[c].stammPfad, -1, nd[c].schale);
      // Der Halbmesser läuft mit: das Pipe-Modell hat die Enden bestimmt,
      // dazwischen wird linear gemittelt. Würde stattdessen nachgerechnet,
      // bekäme jeder Zwischenpunkt die Stärke seines Kindes, und aus der
      // gleichmäßigen Verjüngung würde eine Treppe.
      nd[j].r = rA + (rB - rA) * t;
      nd[j].parent = vor;
      if (vor === p) nd[p].children[nd[p].children.indexOf(c)] = j;
      else nd[vor].children.push(j);
      vor = j;
    }
    nd[vor].children.push(c);
    nd[c].parent = vor;
  }
  {
    // Erst sammeln, dann teilen — unterteile() hängt selbst Knoten an.
    const liste = [];
    for (let i = 1; i < nd.length; i++) liste.push(i);
    for (const c of liste){
      const p = nd[c].parent;
      unterteile(c, p === nWurzel ? stammSeg - 1
                                  : (nd[c].stammPfad ? unter - 1 : unter));
    }
  }

  // --- Unrundheit der Hülle --------------------------------------------------
  // Dasselbe mehrstufige Sinusfeld wie früher, jetzt aber auf das ganze
  // Astwerk statt nur auf die Punktwolke: sonst zöge es die Hülle in Buchten
  // und Ballen, während das Holz darunter in der Kugel stehen bliebe.
  // Ausgenommen sind Schaft und Hilfssegment — die Stammachse soll senkrecht
  // bleiben, dafür ist die Knorrigkeit zuständig.
  if (cfg.huelle.unrundheit > 0){
    const ziele = [];
    for (const k of nd) if (!k.stammPfad) ziele.push(k.pos);
    verforme(ziele, H.mitte, H.R0, cfg.huelle.unrundheit / 100, rv);
  }

  // --- Schwerkraft -----------------------------------------------------------
  // Jedes Segment kippt nach unten (positiv) oder oben (negativ), und zwar um
  // seinen Ansatz: die Länge bleibt, allein die Richtung dreht sich. Weil das
  // vom Stamm nach außen läuft und jedes Segment auf dem schon gekippten
  // vorigen sitzt, summiert es sich zum Bogen — dünne Zweige hängen durch,
  // starke Äste kaum.
  //
  // Der Betrag hängt an der Segmentlänge, nicht am Segment. Sonst wäre die
  // Schwerkraft insgeheim ein zweiter Unterteilungsregler: wer feiner
  // unterteilt, bekäme mehr Kippstellen und damit einen stärkeren Bogen aus
  // demselben Reglerwert.
  //
  // Schaft und Hilfssegment kippen nicht — sie werden nur mitgenommen, wenn
  // etwas unter ihnen sich bewegt, und das tut hier nichts.
  const grav = cl(num(cfg.holz.schwerkraft, 0), -100, 200) / 100 * GRAV;
  if (Math.abs(grav) > 1e-6){
    const alt  = nd.map(k => new V(k.pos.x, k.pos.y, k.pos.z));
    // Die aufgelaufene Drehung je Knoten. Ohne sie kippte jedes Segment aus
    // seiner ursprünglichen Richtung statt aus der schon gekippten des
    // Vorgängers — die Drehungen summierten sich dann nicht, und von n
    // Unterteilungen bliebe nur ein n-tel der Wirkung übrig.
    const dreh = new Array(nd.length);
    dreh[0] = new Q();
    const v = new V(), u = new V(), nu = new V(), r = new Q();
    const st = [0];
    while (st.length){
      const i = st.pop();
      for (const c of nd[i].children){
        st.push(c);
        v.set(alt[c].x - alt[i].x, alt[c].y - alt[i].y, alt[c].z - alt[i].z);
        const len = v.length();
        if (len < 1e-9){ nd[c].pos.copy(nd[i].pos); dreh[c] = dreh[i]; continue; }
        v.applyQuaternion(dreh[i]);          // vom Vorgänger mitgedreht
        if (nd[c].stammPfad){
          // Nicht kippen, nur mitgenommen.
          nd[c].pos.set(nd[i].pos.x + v.x, nd[i].pos.y + v.y, nd[i].pos.z + v.z);
          dreh[c] = dreh[i];
          continue;
        }
        u.copy(v).multiplyScalar(1 / len);
        const a = grav * cl(1 - nd[c].r / wurzelR, 0, 1) * (len / H.abstand);
        nu.set(u.x, u.y - a, u.z).normalize();
        r.setFromUnitVectors(u, nu);
        dreh[c] = r.clone().multiply(dreh[i]);
        nd[c].pos.set(nd[i].pos.x + nu.x * len,
                      nd[i].pos.y + nu.y * len,
                      nd[i].pos.z + nu.z * len);
      }
    }
  }

  // --- Knorrigkeit -----------------------------------------------------------
  // Dreidimensionaler Versatz jedes einzelnen Punktes um den glatten Kurs.
  // Drei Regler teilen sich den Baum, und zwar nach dem Weg, den das Holz vom
  // Boden bis in die Spitze nimmt:
  //
  //   Schaft   der Hauptstamm mit seinem Hilfssegment, für sich allein.
  //   Stamm    dort, wo ein Ast den Stamm verlässt.
  //   Hülle    ganz außen, an den Zweigenden — dort sitzt die Hülle.
  //
  // Zwischen Stamm und Hülle läuft es linear. Gemessen wird dabei nicht die
  // Entfernung vom Stamm in Metern, sondern der Anteil am Weg: wie weit ist
  // dieser Knoten schon draußen, verglichen mit dem längsten Weg, der von hier
  // aus noch bis zu einer Spitze führt. Ein kurzer Ast wird dadurch auf seiner
  // Länge ebenso ganz durchlaufen wie ein langer, und beide sind an ihrem Ende
  // gleich knorrig.
  //
  // Und ebenso wandert das Maß mit, an dem der Versatz gemessen wird:
  //
  //   Am Stamm ist es die Holzstärke. Ein Schaft, der um mehr als seine eigene
  //   Dicke ausweicht, ist kein Baum mehr, sondern ein Seil.
  //
  //   An der Spitze ist es die Segmentlänge. Ein Zweig von zwei Zentimetern,
  //   der nur um zwei Zentimeter ausweichen darf, bleibt wie mit dem Lineal
  //   gezogen — dort ist nicht die Stärke das Maß, sondern der Schritt.
  //
  // Der zweite Punkt ist der eigentliche: gerechnet wurde früher überall mit
  // der Holzstärke, und die ist innen am größten. Deshalb saß die Knorrigkeit
  // am Stamm, obwohl der Regler „Hülle“ hieß.
  //
  // Der Wurzelknoten bleibt stehen; er steckt im Boden.
  const knrF = cl(num(cfg.holz.knorrigSchaft, 14), 0, 100) / 100 * KNORRIG;
  const knrS = cl(num(cfg.holz.knorrigStamm,  14), 0, 100) / 100 * KNORRIG;
  const knrH = cl(num(cfg.holz.knorrigHuelle, 45), 0, 100) / 100 * KNORRIG;
  if (knrF > 0 || knrS > 0 || knrH > 0){
    // Zwei Wege je Knoten: der zurückgelegte vom Astansatz hierher und der
    // längste, der von hier aus noch bevorsteht. Ihr Verhältnis ist das t des
    // Verlaufs.
    const vom = new Float64Array(nd.length);
    const bis = new Float64Array(nd.length);
    const folge = [];
    {
      const st = [0];
      while (st.length){
        const i = st.pop();
        folge.push(i);
        for (const c of nd[i].children){
          // Der Weg beginnt erst da, wo ein Ast den Stamm verlässt.
          vom[c] = nd[c].stammPfad ? 0 : vom[i] + nd[c].pos.distanceTo(nd[i].pos);
          st.push(c);
        }
      }
    }
    // Rückwärts durch dieselbe Reihenfolge. In einer Tiefensuche steht ein Kind
    // immer hinter seinem Elter, rückwärts ist es also fertig, ehe der Elter
    // an die Reihe kommt — eine zweite Suche braucht es dafür nicht.
    for (let q = folge.length - 1; q >= 0; q--){
      const i = folge[q], e = nd[i].parent;
      if (e < 0) continue;
      const w = bis[i] + nd[i].pos.distanceTo(nd[e].pos);
      if (w > bis[e]) bis[e] = w;
    }

    // Der kürzeste Schritt, der an einem Knoten hängt — nach unten zum Elter
    // wie nach oben zu jedem Kind. Er allein taugt als Schranke: ein
    // Achsenknoten, der einen halben Meter unter sich hat und einen Zentimeter
    // über sich, darf sich nach dem halben Meter nicht bemessen. Genau daran
    // klappte der Stamm oben um.
    const nah = new Float64Array(nd.length).fill(Infinity);
    for (let i = 1; i < nd.length; i++){
      const e = nd[i].parent;
      if (e < 0) continue;
      const l = nd[i].pos.distanceTo(nd[e].pos);
      if (l < nah[i]) nah[i] = l;
      if (l < nah[e]) nah[e] = l;
    }

    for (let i = 1; i < nd.length; i++){
      const k = nd[i];
      const e = k.parent;
      if (e < 0) continue;
      const schritt = isFinite(nah[i]) ? nah[i] : k.pos.distanceTo(nd[e].pos);
      let w;
      if (k.stammPfad){
        w = knrF * k.r;
      } else {
        const ganz = vom[i] + bis[i];
        // Ein Knoten ohne Weg vor und hinter sich ist selbst die Spitze.
        const t = ganz > 1e-6 ? cl(vom[i] / ganz, 0, 1) : 1;
        const zweig = schritt * KNORRIG_SCHRITT;
        w = (knrS + (knrH - knrS) * t) * (k.r + (zweig - k.r) * t);
      }
      // Die Schranke, und sie ist der Grund für den Knick oben an der Achse.
      // Dort misst sich der Versatz an der Holzstärke, und die kann ein
      // Vielfaches des Schritts sein: die Achsenknoten stehen da, wo ein Ast
      // ansetzt, und bei tief gezogenem Zentrum drängen sich viele Ansätze auf
      // wenigen Zentimetern. An zwanzig Zentimeter dickem Holz wurden aus
      // Segmenten von einem Zentimeter Knicke von 136°, 148°, 158° — der Stamm
      // klappte oben mehrfach um sich selbst.
      //
      // `eng` ist das Verhältnis von Schritt zu Durchmesser. Ist der Schritt
      // der längere — der Normalfall, ein Zweig ist zehnmal so lang wie dick —,
      // steht es auf eins und die Schranke ist die gewöhnliche. Wird das Holz
      // dicker als der halbe Schritt, zieht sie sich mit an: eine Röhre kann
      // nur so scharf abknicken, wie ihr Durchmesser es zulässt, sonst
      // durchdringt sie sich selbst.
      const eng = Math.min(1, schritt / Math.max(1e-6, 2 * k.r));
      w = Math.min(w, schritt * KNORRIG_SCHRANKE * eng);
      if (w <= 0) continue;
      // Gleichverteilte Richtung auf der Kugel, damit der Versatz keine
      // Vorzugsachse bekommt.
      const cz = rv() * 2 - 1, ph = rv() * Math.PI * 2;
      const sr = Math.sqrt(Math.max(0, 1 - cz * cz)) * w * (0.4 + 0.6 * rv());
      k.pos.x += Math.cos(ph) * sr;
      k.pos.z += Math.sin(ph) * sr;
      k.pos.y += cz * w;
    }
  }

  // --- Die Hüllenpunkte nachziehen -------------------------------------------
  // Jeder Hüllenpunkt sitzt auf einem Knoten. Verzerrt wurde das Gerüst, und
  // die Punktwolke muss mit — sonst hingen die Billboards neben ihren Zweigen.
  for (const k of nd) if (k.punkt >= 0) H.punkte[k.punkt].copy(k.pos);

  // --- Innen leer ------------------------------------------------------------
  // Angehakt trägt allein die Hülle Billboards, und die Krone ist eine Schale.
  // Abgehakt bekommen auch die gerechneten Knoten im Inneren eines — die Krone
  // wird dichter und blickdichter, kostet aber je Knoten ein weiteres Rechteck.
  //
  // Genommen werden nur die Knoten der Schalen, nicht die Punkte der
  // Segmentunterteilung: die sitzen auf demselben Ast wie ihre Nachbarn und
  // brächten nichts als doppeltes Laub an derselben Stelle. Die Nummern der
  // Hüllenpunkte bleiben dabei unverändert, damit von Hand versetzte oder
  // gelöschte Billboards weiter auf denselben Punkt zeigen.
  if (!cfg.huelle.innenLeer){
    const ae = cfg.aenderungen || {};
    for (const i of innenKnoten){
      const nr = H.punkte.length;
      H.punkte.push(new V(nd[i].pos.x, nd[i].pos.y, nd[i].pos.z));
      H.aussen.push(false);
      const weg = !!(ae[nr] && ae[nr].weg);
      H.sichtbar.push(!weg);
      if (!weg) H.sichtbarAnzahl++;
    }
  }

  let hoehe = 0, spitzen = 0;
  for (const k of nd){
    if (k.pos.y > hoehe) hoehe = k.pos.y;
    if (!k.children.length) spitzen++;
  }
  // Hauptäste: was über die ganze Länge der Achse an ihr ansetzt.
  let hauptaeste = 0;
  for (const k of achse)
    for (const c of nd[k].children) if (!nd[c].stammPfad) hauptaeste++;
  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  return {
    knoten: nd, huelle: H, wurzelR: wurzelR, segLen: H.abstand,
    stats: {
      knoten: nd.length, spitzen: spitzen, innen: innen,
      // Wie viele Punkte tatsächlich je Knoten zusammengekommen sind. Das ist
      // stets etwas weniger als eingestellt: gegen Ende einer Schale findet
      // nicht mehr jeder Punkt genug Nachbarn in Reichweite.
      gruppe: innen ? inGruppen / innen : 0,
      hauptaeste: hauptaeste,
      zentrumLaenge: achsLaenge,
      zentrumR: nd[achse[achse.length - 1]].r,
      triebe: nd.length - 1, gabeln: innen,
      hoehe: hoehe, stammD: nd[0].r * 2,
      huellenpunkte: nP, schalen: schalen, billboards: H.sichtbarAnzahl,
      kronenR: H.R0, kronenY: H.mitte, ms: t1 - t0
    }
  };
}

// =============================================================================
//  Holz — Röhren mit Paralleltransport-Rahmen
//
//  Ein Strang beginnt an der Wurzel und folgt jeweils dem dicksten Kind; jedes
//  weitere Kind eröffnet einen neuen Strang, der im Elternknoten ansetzt. So
//  steckt der Ansatzring im Elternast, statt als Kragen herauszustehen.
// =============================================================================

export function baueHolz(skel){
  const nodes = skel.knoten;
  const wurzelR = skel.wurzelR;

  const straenge = [];
  {
    const st = [{ start: 0, vor: -1 }];
    while (st.length){
      const s = st.pop();
      const kette = [];
      if (s.vor >= 0) kette.push(s.vor);
      let cur = s.start;
      for(;;){
        kette.push(cur);
        const ch = nodes[cur].children;
        if (!ch.length) break;
        for (let k=1;k<ch.length;k++) st.push({ start: ch[k], vor: cur });
        // Am Ende des Stammpfads endet der Strang, auch wenn der Leittrieb
        // geradewegs weiterläuft. Sonst zöge der Stamm seine acht Kanten bis
        // in die feinsten Zweige hinauf — die Ringzahl steht je Strang fest.
        if (nodes[cur].stammPfad && !nodes[ch[0]].stammPfad){
          // Der Leittrieb ist kein Ansatz, sondern eine Fortsetzung: dort läuft
          // dasselbe Holz weiter, nur mit weniger Kanten. Er wird als solche
          // vermerkt, damit der erste Ring passt.
          st.push({ start: ch[0], vor: cur, weiter: true });
          break;
        }
        cur = ch[0];
      }
      if (kette.length >= 2)
        straenge.push({ kette: kette, vor: s.vor >= 0, weiter: !!s.weiter });
    }
  }

  const pos = [], nrm = [], col = [], uvs = [], idx = [];
  // Die Vertexfarbe trägt nur den Hell-dunkel-Verlauf: Zweig heller als Stamm.
  // Der Farbton selbst sitzt im Material und ist damit ohne Neuaufbau des
  // Baums umstellbar — genau wie die Rindentextur.
  const schatten = r => 1 + 0.85 * (1 - Math.min(1, Math.sqrt(r / wurzelR)));
  const nVec = new V(), bVec = new V(), tVec = new V(), pVec = new V();
  const t0 = new V(), tL = new V(), eVec = new V();

  for (const strang of straenge){
    const kette = strang.kette;
    const letzterK = kette[kette.length-1];
    const seg = nodes[letzterK].stammPfad ? KANTEN_STAMM : KANTEN_ZWEIG;
    // Ein gewachsenes Zweigende läuft aus und bekommt eine Kegelspitze. Das
    // obere Ende des Schafts ist kein Ende — dort setzt der Leittrieb an, und
    // ein Kegel stäke als Dorn in ihm.
    const auslauf = !nodes[letzterK].children.length;

    const pts = kette.map(i => nodes[i].pos);
    const rad = kette.map(i => nodes[i].r);

    // Der Fuß unter die Null-Ebene. Knoten 0 sitzt genau auf −STAMM_UNTER_NULL;
    // angehängt wird ein zusätzlicher, etwas breiterer Ring darunter — das gibt
    // zugleich den Wurzelanlauf und schließt den Stamm gegen den Boden ab.
    if (kette[0] === 0){
      const t = new V().subVectors(pts[1], pts[0]);
      if (t.lengthSq() > 1e-12){
        const dn = t.normalize().clone();
        dn.y = Math.max(dn.y, 0.5); dn.normalize();
        pts.unshift(new V().copy(pts[0]).addScaledVector(dn, -STAMM_UNTER_NULL / dn.y));
        rad.unshift(rad[0] * STAMM_ANLAUF);
      }
    }

    const L = pts.length;
    // Der Ansatzring darf nicht auf Elternstärke aufblähen — sonst steht er als
    // offener Kragen aus der Rinde, und man sieht durch das Loch in den Ast.
    //
    // Für die Fortsetzung gilt das Gegenteil: sie ist der Strang selbst, nur
    // mit anderer Kantenzahl. Dort gehört der volle Halbmesser hin, sonst
    // klafft am oberen Ende der Achse eine Stufe von zwölf Prozent — und weil
    // dort ein Ast von der Stärke des Stamms weitergeht, ist sie zu sehen.
    if (strang.weiter) rad[0] = nodes[kette[0]].r;
    else if (strang.vor)
      rad[0] = Math.min(rad[1] * 1.3, Math.max(rad[1], nodes[kette[0]].r * 0.88));

    // Und ebenso der erste Ring: bei einer Fortsetzung steht er nicht senkrecht
    // auf dem neuen Segment, sondern auf der Winkelhalbierenden zwischen dem
    // ankommenden und dem weiterführenden — genau wie an jedem Knoten mitten im
    // Strang. Ohne das stoßen zwei Röhren gleicher Stärke stumpf aufeinander,
    // und der Grat steht quer über den Stamm. Das ist der Knick am Ende des
    // Hilfssegments.
    let ein = false;
    if (strang.weiter){
      const e = nodes[kette[0]].parent;
      if (e >= 0){
        eVec.subVectors(nodes[kette[0]].pos, nodes[e].pos);
        if (eVec.lengthSq() > 1e-12){ eVec.normalize(); ein = true; }
      }
    }
    if (auslauf) rad[L-1] = Math.max(rad[L-1] * 0.45, R_SPITZE * 0.3);

    tVec.copy(pts[1]).sub(pts[0]);
    if (tVec.lengthSq() < 1e-12) tVec.set(0,1,0);
    tVec.normalize();
    perpendicular(tVec, nVec);

    const basis = pos.length / 3;
    const stride = seg + 1;      // ein Vertex mehr je Ring: die Naht liegt
                                 // doppelt vor, mit u=0 und u=1
    let vAcc = 0;

    for (let i=0;i<L;i++){
      const p = pts[i];
      if (i > 0) vAcc += p.distanceTo(pts[i-1]) / Math.max(1e-4, 2 * Math.PI * rad[i]);
      if (i === 0){
        tVec.copy(pts[1]).sub(p);
        if (ein && tVec.lengthSq() > 1e-12) tVec.normalize().add(eVec);
      }
      else if (i === L-1)  tVec.copy(p).sub(pts[L-2]);
      else                 tVec.copy(pts[i+1]).sub(pts[i-1]);
      if (tVec.lengthSq() < 1e-12) tVec.set(0,1,0);
      tVec.normalize();
      if (i === 0)   t0.copy(tVec);
      if (i === L-1) tL.copy(tVec);

      // Paralleltransport: die Normale bleibt drehungsfrei
      nVec.addScaledVector(tVec, -nVec.dot(tVec));
      if (nVec.lengthSq() < 1e-10) perpendicular(tVec, nVec); else nVec.normalize();
      bVec.crossVectors(tVec, nVec).normalize();

      const r = rad[i], f = schatten(r);
      for (let k=0;k<=seg;k++){
        const ang = (k / seg) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        pVec.set(nVec.x*ca + bVec.x*sa, nVec.y*ca + bVec.y*sa, nVec.z*ca + bVec.z*sa);
        pos.push(p.x + pVec.x*r, p.y + pVec.y*r, p.z + pVec.z*r);
        nrm.push(pVec.x, pVec.y, pVec.z);
        col.push(f, f, f);
        uvs.push(k / seg, vAcc);
      }
    }
    for (let i=0;i<L-1;i++){
      const a = basis + i*stride, b = basis + (i+1)*stride;
      // Umlaufsinn gegen den Uhrzeigersinn von außen gesehen
      for (let k=0;k<seg;k++) idx.push(a+k, a+k+1, b+k,  a+k+1, b+k+1, b+k);
    }

    // Enden schließen. Eine Röhre ohne Deckel ist eine offene Hülse: die
    // Rückseiten werden nicht gezeichnet, man blickt von außen hindurch.
    const pA = pts[0], rA = rad[0], fA = schatten(rA);
    const cA = pos.length / 3;
    pos.push(pA.x - t0.x*rA*0.25, pA.y - t0.y*rA*0.25, pA.z - t0.z*rA*0.25);
    nrm.push(-t0.x, -t0.y, -t0.z); col.push(fA, fA, fA); uvs.push(0.5, 0);
    for (let k=0;k<seg;k++) idx.push(cA, basis+k+1, basis+k);

    const pB = pts[L-1], rB = rad[L-1], fB = schatten(rB);
    const letzter = basis + (L-1)*stride;
    const cB = pos.length / 3;
    const kappe = auslauf ? 1.4 : 0;
    pos.push(pB.x + tL.x*rB*kappe, pB.y + tL.y*rB*kappe, pB.z + tL.z*rB*kappe);
    nrm.push(tL.x, tL.y, tL.z); col.push(fB, fB, fB); uvs.push(0.5, vAcc);
    for (let k=0;k<seg;k++) idx.push(cB, letzter+k, letzter+k+1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// =============================================================================
//  Billboards
//
//  Alle Blattbilder eines Baums liegen in einem Textur-Array — eine Schicht je
//  PNG. Damit kommt die ganze Krone mit einem Zeichenaufruf aus, ohne Atlas und
//  damit ohne die Farbränder, die ein Atlas beim Verkleinern bekommt.
//
//  Jedes Bild wird beim Laden auf seine Alpha-Bounding-Box beschnitten und
//  mittig in eine quadratische Schicht gesetzt. Dadurch sitzt das Motiv exakt
//  auf seinem Eckpunkt — die Bilder dürfen also ruhig einen breiten leeren Rand
//  haben und müssen nicht zentriert sein.
// =============================================================================

// Freier Rand einer Schicht, damit die Mipmaps das Motiv nicht anschneiden —
// als Anteil der Kantenlänge, damit er bei 512 nicht zur Haarlinie wird.
const RAND_ANTEIL = 6 / 256;
const LAGEN   = ['unten', 'mitte', 'oben'];

// Ersatzbilder aus der Zeit vor der Namenskonvention. Sie greifen nur, wenn
// {name}-{lage}-{nr}.png nicht ladbar ist — dann steht wenigstens etwas da,
// statt dass der Baum kahl bleibt.
const ERSATZ = {
  unten: ['img/unten1.png', 'img/unten2.png'],
  mitte: ['img/seite1.png', 'img/seite2.png', 'img/seite3.png'],
  oben:  ['img/oben.png']
};

function ladeBild(url){
  return new Promise((ok, fehl) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload  = () => ok(im);
    im.onerror = () => fehl(new Error(url));
    im.src = url;
  });
}

// Alpha-Bounding-Box messen und das Motiv freigestellt in eine Schicht setzen.
// Zurück kommen die Bildpunkte der Schicht und das Seitenverhältnis des Motivs.
function inSchicht(img, SCHICHT, MASS){
  const RAND = Math.round(SCHICHT * RAND_ANTEIL);
  const mess = document.createElement('canvas');
  const S = 96;
  mess.width  = S;
  mess.height = Math.max(1, Math.round(S * img.height / img.width));
  const mc = mess.getContext('2d', { willReadFrequently: true });
  mc.drawImage(img, 0, 0, mess.width, mess.height);
  const d = mc.getImageData(0, 0, mess.width, mess.height).data;

  let x0 = mess.width, y0 = mess.height, x1 = -1, y1 = -1;
  for (let y=0;y<mess.height;y++)
    for (let x=0;x<mess.width;x++)
      if (d[(y*mess.width + x)*4 + 3] > 25){
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (x1 < 0){ x0 = 0; y0 = 0; x1 = mess.width-1; y1 = mess.height-1; }

  // Zurück in die Maße des Originals
  const sx = img.width / mess.width, sy = img.height / mess.height;
  const bx = x0 * sx, by = y0 * sy;
  const bw = Math.max(1, (x1 - x0 + 1) * sx), bh = Math.max(1, (y1 - y0 + 1) * sy);

  const c = document.createElement('canvas');
  c.width = c.height = SCHICHT;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const platz = SCHICHT - 2*RAND;
  const f = platz / Math.max(bw, bh);
  const dw = bw * f, dh = bh * f;
  ctx.drawImage(img, bx, by, bw, bh, (SCHICHT-dw)/2, (SCHICHT-dh)/2, dw, dh);

  return {
    daten:  ctx.getImageData(0, 0, SCHICHT, SCHICHT).data,
    // Die Schicht ist quadratisch, also ist auch das Rechteck quadratisch.
    // Seine Weltkantenlänge folgt daraus, dass die Motivbreite MOTIV messen
    // soll: bei einem hohen Motiv wird das Quadrat entsprechend größer.
    kante:  MASS * (SCHICHT / platz) * Math.max(1, bh / bw),
    hoch:   bh / bw
  };
}

// Der Satz gehört zum Baumnamen, nicht zum einzelnen Baum: ein Wald aus
// hundert Eichen teilt sich eine Textur und ein Material.
const satzCache = new Map();

export function leereBillboardCache(){
  for (const p of satzCache.values())
    p.then(s => { if (s){ s.textur.dispose(); s.material.dispose(); } })
     .catch(() => {});
  satzCache.clear();
}

export function ladeBillboardSatz(cfg, basis){
  const b = cfg.huelle.billboards;
  // Das Paket gehört in den Schlüssel: zwei Bäume gleichen Namens, einer mit
  // eingebetteten Schichten und einer ohne, sind nicht derselbe Satz.
  const eingebettet = cfg.paket && cfg.paket.billboards;
  const key = (basis || './') + '|' + cfg.name + '|' + b.unten + '|' + b.mitte
            + '|' + b.oben + '|' + b.aufloesung + '|' + b.groesse
            + '|' + (eingebettet
                     ? 'paket' + eingebettet.schichten.length + ':'
                       + (eingebettet.schichten[0] || '').length
                     : 'ordner');
  let p = satzCache.get(key);
  if (!p){ p = baueBillboardSatz(cfg, basis || './'); satzCache.set(key, p); }
  return p;
}

async function baueBillboardSatz(cfg, basis){
  const anz = cfg.huelle.billboards;
  // Liegen die fertigen Schichten im Paket, werden sie von dort genommen und
  // kein einziges PNG geladen. Der Baum bringt seine Bilder dann selbst mit.
  if (cfg.paket && cfg.paket.billboards) return ausPaket(cfg.paket.billboards);
  const SCHICHT = anz.aufloesung;      // Kantenlänge einer Schicht
  const MASS    = anz.groesse;         // Motivbreite in Metern
  const jobs = [];
  for (const lage of LAGEN)
    for (let n=1; n<=anz[lage]; n++){
      const pfad = basis + 'img/' + cfg.name + '-' + lage + '-' + n + '.png';
      const alt  = ERSATZ[lage];
      jobs.push(
        ladeBild(pfad).then(im => ({ lage, im, ersatz: false }))
          .catch(() => ladeBild(basis + alt[(n-1) % alt.length])
                        .then(im => ({ lage, im, ersatz: true })))
          .catch(() => ({ lage, im: null, ersatz: false }))
      );
    }
  const geladen = (await Promise.all(jobs)).filter(x => x.im);
  if (!geladen.length) return null;

  const tiefe = geladen.length;
  const daten = new Uint8Array(SCHICHT * SCHICHT * 4 * tiefe);
  const sorten = { unten: [], mitte: [], oben: [] };
  const rechteck = [];
  for (let i=0;i<geladen.length;i++){
    const s = inSchicht(geladen[i].im, SCHICHT, MASS);
    daten.set(s.daten, i * SCHICHT * SCHICHT * 4);
    sorten[geladen[i].lage].push(i);
    rechteck.push(s.kante);
  }
  // Eine Lage ohne eigenes Bild leiht sich die Nachbarlage, sonst fehlten dort
  // die Billboards ganz.
  if (!sorten.mitte.length) sorten.mitte = sorten.unten.concat(sorten.oben);
  if (!sorten.unten.length) sorten.unten = sorten.mitte.slice();
  if (!sorten.oben.length)  sorten.oben  = sorten.mitte.slice();

  const tex = machArrayTextur(daten, SCHICHT, tiefe);

  return { textur: tex, sorten: sorten, rechteck: rechteck,
           ersatz: geladen.filter(x => x.ersatz).length,
           material: billboardMaterial(tex, false),
           materialInstanz: billboardMaterial(tex, true),
           aufloesung: SCHICHT, groesse: MASS };
}

// --- Material ----------------------------------------------------------------
// Ausgerichtet wird im Vertexshader: der Ankerpunkt wandert in den Sichtraum,
// dort kommt der Eckversatz flach dazu. Damit steht jedes Rechteck immer zur
// Kamera, ohne dass die CPU je ein Sprite anfassen müsste.
//
// Gezeichnet wird mit hartem Alphaschnitt statt echter Transparenz: die Tiefe
// bleibt korrekt, es muss nichts sortiert werden, und beim Umkreisen des Baums
// flimmert nichts.
// Der Vertexteil steht nur einmal da: Farb- und Tiefendurchgang müssen die
// Rechtecke Punkt für Punkt gleich ausrichten, sonst wandert der Schatten
// gegenüber dem Blatt, das ihn wirft.
// Der Vertexshader gibt es in zwei Fassungen. Sie unterscheiden sich in genau
// zwei Zeilen, und beide müssen es sein: ein `in mat4 instanceMatrix`, das bei
// einem gewöhnlichen Netz gar nicht geliefert wird, liest sich als Nullmatrix
// und ließe die Krone verschwinden. Deshalb wird der Baustein zusammengesetzt
// statt verzweigt — im Shader selbst gibt es keine Bedingung.
function bbVertex(instanziert){ return /* glsl */`
  precision highp float;
  uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix;
  in vec3  position;
  in vec3  normal;
  in vec2  uv;
  in vec2  versatz;
  in float schicht;
  ${instanziert ? 'in mat4 instanceMatrix;\n  in vec3 instanceColor;' : ''}
  out vec2  vUv;
  out float vSchicht;
  out float vLicht;
  out vec3  vTon;
  void main(){
    ${instanziert
      ? 'mat4 platz = instanceMatrix;\n    vTon = instanceColor;'
      : 'mat4 platz = mat4(1.0);\n    vTon = vec3(1.0);'}
    vec4 mv = modelViewMatrix * platz * vec4(position, 1.0);
    float s = length(modelMatrix[0].xyz) * length(platz[0].xyz);

    // Wohin "oben" auf dem Bild zeigt — nicht für die Kamera, sondern für
    // dieses eine Rechteck. Die Welt-Hochachse steht als zweite Spalte in der
    // Blickmatrix; davon bleibt der Anteil quer zum Sehstrahl. Bei waagerechtem
    // Blick ist das die Bildschirm-Senkrechte wie bisher; schaue ich in die
    // Krone hinauf, kippt jedes Billboard für sich, und "unten" zeigt vom
    // Zenit nach außen. Drehe ich mich dabei, wandert es mit.
    vec3 blick = normalize(mv.xyz);
    vec3 h3 = viewMatrix[1].xyz;
    h3 -= blick * dot(h3, blick);
    vec2 hoch = h3.xy;
    float l = length(hoch);
    // Genau im Zenit hat "unten" keine Bildrichtung mehr. Das trifft nur das
    // eine Blatt in der Bildmitte, und für das gibt es keine richtige Antwort.
    hoch = l > 1e-5 ? hoch / l : vec2(0.0, 1.0);
    vec2 quer = vec2(hoch.y, -hoch.x);

    mv.xy += (versatz.x * quer + versatz.y * hoch) * s;
    vUv = uv;
    vSchicht = schicht;
    vLicht = 0.78 + 0.22 * clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
    vLicht *= vLicht; vLicht *= vLicht; vLicht *= vLicht +0.3; 
    gl_Position = projectionMatrix * mv;
  }`; }

function billboardMaterial(tex, instanziert){
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uKarte:   { value: tex },
      uFarbe:   { value: new THREE.Color(1, 1, 1) },
      uSchnitt: { value: 0.5 },
      // Ob am Ende nach sRGB umgerechnet wird - siehe unten bei onBeforeRender.
      uSRGB:    { value: 1 }
    },
    vertexShader: bbVertex(instanziert),
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp sampler2DArray;
      uniform sampler2DArray uKarte;
      uniform vec3  uFarbe;
      uniform float uSchnitt;
      uniform float uSRGB;
      in vec2  vUv;
      in float vSchicht;
      in float vLicht;
      in vec3  vTon;
      out vec4 ausgabe;
      void main(){
        vec4 t = texture(uKarte, vec3(vUv, vSchicht));
        if (t.a < uSchnitt) discard;
        // Gerechnet wird linear, ausgegeben wieder in sRGB. Der Renderer
        // bekommt hier ein fertiges Bild — three mischt sich bei einem
        // RawShaderMaterial nicht ein.
        //
        // uFarbe gilt für das ganze Netz, vTon für die einzelne Instanz.
        //
        // Beide zusammen wirken um 1.0 herum in zwei Richtungen, und das ist
        // der Punkt: ein bloßer Multiplikator kann nur dunkeln, ein Wald aus
        // einer Vorlage hätte also nie einen Baum, der heller steht als seine
        // Bilder. Unter 1 wird deshalb multipliziert wie bisher, über 1 wird
        // aufgehellt — und zwar mit Screen und nicht mit noch mehr Faktor.
        // Screen hebt die dunklen Stellen mit an und läuft bei Weiß sauber
        // aus, statt die hellen wegzubrennen und die Schatten stehen zu lassen.
        //
        //   0.0  schwarz      1.0  wie das Bild      2.0  weiß
        //
        // Weil 1.0 genau das Bild ergibt, ändert sich an allem nichts, was
        // bisher eine Farbe im Bereich 0…1 gesetzt hat.


        /* Angepasst von Dirk -> knackigere Farben */
        // Textur-Sample in den linearen Farbraum holen
        vec3 texLinear = pow(t.rgb, vec3(2.2));
        // Farbfilter anwenden (1 Taktzyklus auf der GPU)
        vec3 lin = texLinear * (uFarbe * vTon);
        // Gamma-Korrektur für die Ausgabe
        // lin *= vLicht * vLicht * vLicht * vLicht;
        lin *= vLicht;
        // NUR AUF DEN BILDSCHIRM WIRD UMGERECHNET, NICHT IN EIN RENDERZIEL.
        // Warum, steht unten beim Aufruf onBeforeRender.
        ausgabe = vec4(uSRGB > 0.5 ? pow(lin, vec3(1.0 / 2.2)) : lin, 1.0);
/*
        vec3 ton = uFarbe * vTon;
        vec3 lin = pow(t.rgb, vec3(2.2));
        lin *= min(ton, vec3(1.0));
        vec3 heben = clamp(ton - 1.0, 0.0, 1.0);
        lin = 1.0 - (1.0 - lin) * (1.0 - heben);
        lin *= vLicht;
        ausgabe = vec4(pow(lin, vec3(1.0/2.2)), 1.0);
*/
      }`,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true
  });

  // DAS MATERIAL FRAGT SELBST, WOHIN GEZEICHNET WIRD.
  //
  // Ein RawShaderMaterial bekommt von three nichts angehaengt - es gibt ein
  // fertiges Bild ab, und deshalb rechnet der Fragmentshader oben selbst nach
  // sRGB um. Auf den Bildschirm ist das richtig.
  //
  // In ein RENDERZIEL ist es falsch. Dorthin schreiben alle gewoehnlichen
  // Materialien LINEAR - three haengt die Umrechnung nur an, wenn wirklich auf
  // den Bildschirm gezeichnet wird. Ein Ziel, in dem die Krone schon in sRGB
  // steht und alles andere linear, ist in sich widerspruechlich; wer es
  // hinterher als Ganzes umrechnet - der Wasserspiegel tut das -, jagt das Laub
  // ZWEIMAL durch die Kurve.
  //
  // Was das anrichtet, sieht man genau an der Kontrastspreizung im
  // Vertexshader (`vLicht` hoch acht): ein dunkles Blatt bei linear 0,25 wird
  // einmal umgerechnet zu 0,53 und ein zweites Mal zu 0,75, waehrend ein helles
  // bei 1,0 stehen bleibt. Aus einem Verhaeltnis von 4:1 wird eines von 1,3:1 -
  // die Krone verliert im Spiegelbild ihre Tiefe und wirkt ausgewaschen. Die
  // Tafeln in der Ferne zeigten den Fehler nicht: sie sind ein gewoehnliches
  // MeshBasicMaterial und werden von three richtig behandelt.
  //
  // three ruft `onBeforeRender` je Zeichenaufruf auf, und zwar VOR dem
  // Hochladen der Uniformen. Das Material entscheidet also selbst und braucht
  // von niemandem gesagt zu bekommen, dass gerade gespiegelt wird.
  m.onBeforeRender = (renderer) => {
    m.uniforms.uSRGB.value = renderer.getRenderTarget() === null ? 1 : 0;
  };
  return m;
}

// Tiefenmaterial für den Schattendurchgang. Ohne es rechnet three mit seinem
// eigenen Tiefenmaterial, das von `versatz` nichts weiß — die Rechtecke fielen
// dabei auf ihren Ankerpunkt zusammen, und die Krone würfe gar keinen Schatten.
//
// three legt die Tiefe als RGBA ab; die Packung muss deshalb hier nachgebaut
// werden. Sie steht so in three/src/renderers/shaders/ShaderChunk/packing.glsl.
function machArrayTextur(daten, S, tiefe){
  const tex = new THREE.DataArrayTexture(daten, S, S, tiefe);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// Denselben Satz aus einem Paket. Die Schichten liegen dort als einzelne PNGs
// — fertig freigestellt und quadratisch, so wie inSchicht() sie hinterlassen
// hat. Zu tun bleibt, sie wieder in ein Array zu stapeln.
async function ausPaket(p){
  const bilder = await Promise.all(p.schichten.map(ladeBild));
  const S = p.aufloesung;
  const daten = new Uint8Array(S * S * 4 * bilder.length);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < bilder.length; i++){
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(bilder[i], 0, 0, S, S);
    daten.set(ctx.getImageData(0, 0, S, S).data, i * S * S * 4);
  }
  const tex = machArrayTextur(daten, S, bilder.length);
  return { sorten: JSON.parse(JSON.stringify(p.sorten)),
           rechteck: p.rechteck.slice(), textur: tex, ersatz: 0,
           material: billboardMaterial(tex, false),
           materialInstanz: billboardMaterial(tex, true),
           aufloesung: S, groesse: p.groesse };
}

// Ein Paket schnüren: Konfiguration, die fertigen Schichten, die Rinde und die
// beiden Schattenrisse in einer Datei. Damit läuft ein Baum in einer fremden
// Anwendung ohne img/-Ordner und ohne zweiten Ladeweg.
//
//   schatten  Grundriss zum Brennen in den Boden (baueSchatten)
//   karte     Silhouette zur Sonne für den echten Wurf (baueSchattenkarte)
//   ansicht   Seitenansicht als Tafel für die Ferne (baueAnsicht)
//
// Die beiden Schattenrisse sind nicht dasselbe und schließen einander nicht
// aus: der eine kostet im Spiel nichts und kann keinen Hang, der andere kostet
// einen Schattendurchgang und kann alles. Die Ansicht steht daneben und
// ersetzt in der Ferne den Baum selbst.
export async function packe(cfg, satz, schatten, karte, ansicht){
  const c = normiere(cfg);
  const paket = { v: VERSION };
  if (satz){
    const S = satz.textur.image.width;
    const n = satz.textur.image.depth;
    const daten = satz.textur.image.data;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d');
    const schichten = [];
    for (let i = 0; i < n; i++){
      const bild = ctx.createImageData(S, S);
      bild.data.set(daten.subarray(i * S * S * 4, (i + 1) * S * S * 4));
      ctx.putImageData(bild, 0, 0);
      schichten.push(cv.toDataURL('image/png'));
    }
    paket.billboards = {
      aufloesung: S, groesse: satz.groesse,
      sorten: satz.sorten, rechteck: satz.rechteck, schichten: schichten
    };
  }
  // Die Rinde als Datenadresse. Steht schon eine darin, wird sie übernommen;
  // ein Pfad wird nachgeladen und eingebettet, damit das Paket vollständig ist.
  if (c.holz.textur){
    paket.rinde = /^data:/.test(c.holz.textur)
      ? c.holz.textur
      : await alsDatenadresse(c.holz.textur);
  }
  if (schatten) paket.schatten = schatten;
  if (karte)    paket.schattenkarte = karte;
  if (ansicht)  paket.ansicht = ansicht;
  c.paket = paket;
  return c;
}

async function alsDatenadresse(url){
  try {
    const a = await fetch(url);
    if (!a.ok) return '';
    const b = await a.blob();
    return await new Promise(ok => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.readAsDataURL(b);
    });
  } catch(e){ return ''; }
}

// --- Netz --------------------------------------------------------------------
// Vier Vertices je Eckpunkt der Hülle. Welche Lage ein Punkt bekommt, hängt
// allein an seiner Höhe in der Krone — dieselbe Einteilung wie in index.html.
const OBEN_AB  =  0.5;
const UNTEN_AB = -0.5;
const ZITTER   = 0.04;      // leichte Unregelmäßigkeit, Anteil vom Abstand

// opt.schatten schaltet den Schattenwurf der Krone an. Er kostet einen zweiten
// Durchgang über alle Rechtecke und ist deshalb standardmäßig aus — im Spiel
// zahlt sich das aus, im Konfigurator will man ihn sehen.
export function baueBillboards(skel, cfg, satz, opt){
  const H = skel.huelle;
  const pts = H.punkte;
  const sicht = H.sichtbar;
  const rnd = mulberry32((((cfg.seed | 0) * 7919) ^ 0x5bf03635) >>> 0);

  const ae = cfg.aenderungen || {};
  const zus = cfg.zusatz || [];

  // Welche Lage ein Billboard bekommt: nach der Höhe in der Krone, es sei
  // denn, sie steht von Hand fest.
  const lageVon = (y, e) => (e && e.lage) ? LAGEN[e.lage - 1]
    : (((y - H.mitte) / Math.max(1e-6, H.radiusY)) >= OBEN_AB ? 'oben'
      : (((y - H.mitte) / Math.max(1e-6, H.radiusY)) <= UNTEN_AB ? 'unten' : 'mitte'));

  // Erst die Liste, dann die Puffer. Zwei Quellen laufen darin zusammen: die
  // Hüllenpunkte und die von Hand eingefügten Billboards. Die Kennung ist für
  // die ersten die Punktnummer und für die zweiten −(Platz + 1) — daran
  // erkennt der Editor, was er vor sich hat, und beides passt in eine Zahl.
  const liste = [];
  for (let q = 0; q < pts.length; q++){
    // Die Zufallszahlen werden für jeden Punkt gezogen, auch für die
    // ausgelassenen. Sonst würfelte ein Baum bei „innen leer“ andere Motive
    // und einen anderen Versatz als derselbe Baum ohne — bei gleichem
    // Startwert soll aber nur etwas fehlen, nicht etwas anderes dastehen.
    const w = rnd(), jx = rnd()-0.5, jy = rnd()-0.5, jz = rnd()-0.5;
    if (!sicht[q]) continue;
    const p = pts[q], a = ae[q];
    const lage = lageVon(p.y, a);
    const menge = satz.sorten[lage];
    // Die Bildnummer wird gewürfelt, es sei denn, sie steht von Hand fest.
    // Von Hand zählt sie ab 1 und wird umgebrochen: dreht man die Zahl der
    // Varianten später herunter, zeigt die Wahl dann wieder auf ein Bild, das
    // es gibt, statt das Billboard verschwinden zu lassen.
    const nr = (a && a.tex) ? (a.tex - 1) % menge.length
                            : Math.floor(w * menge.length) % menge.length;
    // Versatz von Hand kommt zuletzt dazu — er verschiebt allein das Bild,
    // nicht den Knoten, an dem der Ast endet.
    liste.push({ id: q, punkt: q, lage: lage, nr: nr, anz: menge.length,
                 schicht: menge[nr],
                 x: p.x + jx * H.abstand * ZITTER + (a ? a.x : 0),
                 y: p.y + jy * H.abstand * ZITTER + (a ? a.y : 0),
                 z: p.z + jz * H.abstand * ZITTER + (a ? a.z : 0),
                 dreh: a ? a.dreh : 0, spieg: a ? !!a.spieg : false,
                 skal: a ? (a.skal || 100) / 100 : 1 });
  }
  for (let m = 0; m < zus.length; m++){
    const e = zus[m];
    if (e.von >= pts.length) continue;      // Vorlage gibt es nicht mehr
    const p = pts[e.von];
    const y = p.y + e.y;
    const lage = lageVon(y, e);
    const menge = satz.sorten[lage];
    const nr = (e.tex ? (e.tex - 1) : 0) % menge.length;
    liste.push({ id: -(m + 1), punkt: e.von, lage: lage, nr: nr,
                 anz: menge.length, schicht: menge[nr],
                 x: p.x + e.x, y: y, z: p.z + e.z,
                 dreh: e.dreh, spieg: !!e.spieg, skal: (e.skal || 100) / 100 });
  }

  // Für den Editor: zu jedem gezeichneten Rechteck seine Kennung, sein Mittel-
  // punkt und seine halbe Kantenlänge. Damit trifft ein Mausklick genau das,
  // was der Vertexshader aufspannt — ohne dass die Geometrie es verraten
  // könnte, denn dort stehen alle vier Ecken auf dem Ankerpunkt. Dazu die
  // Lage und die gezeigte Bildnummer samt ihrer Obergrenze, damit der Editor
  // ohne eigene Kenntnis des Satzes anzeigen kann, was dort hängt.
  const anker = [];

  const n = liste.length;
  const pos = new Float32Array(n * 4 * 3);
  const nor = new Float32Array(n * 4 * 3);
  const ver = new Float32Array(n * 4 * 2);
  const uvs = new Float32Array(n * 4 * 2);
  const sch = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);

  let maxKante = 0;
  for (let i = 0; i < n; i++){
    const b = liste[i];
    const kante = satz.rechteck[b.schicht] * b.skal;
    if (kante > maxKante) maxKante = kante;
    // Ersatznormale für die Beleuchtung: Richtung vom Kronenmittelpunkt nach
    // außen. Das Blattwerk oben außen bekommt dadurch mehr Licht als das im
    // Inneren — mehr Aufwand lohnt bei Billboards nicht.
    const nx = b.x, ny = b.y - H.mitte, nz = b.z;
    const nl = Math.max(1e-6, Math.hypot(nx, ny, nz));

    // Skalierung, Drehung und Spiegelung kosten nichts: das Rechteck wird im
    // Shader ohnehin aus vier Eckversätzen aufgespannt, und die stehen hier
    // schon fertig gedreht und skaliert im Puffer. Die Drehung wirkt in der
    // Bildebene, also um die Blickachse — das Billboard steht ja immer zur
    // Kamera. Gespiegelt wird durch Tauschen der u-Koordinate.
    const h = kante * 0.5 * b.skal;
    const w = b.dreh * Math.PI / 180, cw = Math.cos(w), sw = Math.sin(w);
    const u0 = b.spieg ? 1 : 0, u1 = b.spieg ? 0 : 1;
    anker.push({ i: b.id, punkt: b.punkt, x: b.x, y: b.y, z: b.z, h: h,
                 lage: b.lage, nr: b.nr + 1, anz: b.anz });
    // v ist umgedreht: die Schichtdaten beginnen bei der obersten Bildzeile,
    // die Texturkoordinate v = 0 zeigt aber auf genau diese Zeile.
    const eck = [[-h,-h,u0,1], [h,-h,u1,1], [h,h,u1,0], [-h,h,u0,0]];
    for (let k=0;k<4;k++){
      const v = (i*4 + k);
      const ex = eck[k][0], ey = eck[k][1];
      pos[v*3]   = b.x; pos[v*3+1] = b.y; pos[v*3+2] = b.z;
      nor[v*3]   = nx/nl; nor[v*3+1] = ny/nl; nor[v*3+2] = nz/nl;
      ver[v*2]   = ex * cw - ey * sw; ver[v*2+1] = ex * sw + ey * cw;
      uvs[v*2]   = eck[k][2]; uvs[v*2+1] = eck[k][3];
      sch[v]     = b.schicht;
    }
    const o = i*4;
    idx[i*6]   = o;   idx[i*6+1] = o+1; idx[i*6+2] = o+2;
    idx[i*6+3] = o;   idx[i*6+4] = o+2; idx[i*6+5] = o+3;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('versatz',  new THREE.BufferAttribute(ver, 2));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('schicht',  new THREE.BufferAttribute(sch, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // Die Rechtecke wachsen erst im Shader aus ihrem Ankerpunkt heraus. Die
  // Hüllkugel muss das vorwegnehmen, sonst schneidet das Sichtvolumen die
  // Krone am Bildrand weg.
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += maxKante * 0.75;

  const netz = new THREE.Mesh(geo, satz.material);
  netz.name = 'billboards';
  netz.userData.anker = anker;
  return netz;
}

// =============================================================================
//  Rindenmaterial
// =============================================================================

const holzCache = new Map();

export function leereHolzCache(){
  for (const m of holzCache.values()){
    if (m.map) m.map.dispose();
    m.dispose();
  }
  holzCache.clear();
}

export function holzMaterial(cfg, basis){
  const z = cfg.holz;
  // Liegt die Rinde im Paket, gilt sie — dann braucht es die Datei nicht mehr.
  const bild = (cfg.paket && cfg.paket.rinde) || z.textur;
  const key = z.farbe + '|' + bild + '|' + z.kachel + '|' + (basis || './');
  let m = holzCache.get(key);
  if (m) return m;

  m = new THREE.MeshLambertMaterial({ color: new THREE.Color(z.farbe), vertexColors: true });
  if (bild){
    const url = /^(data:|https?:|\/)/.test(bild) ? bild : (basis || './') + bild;
    new THREE.TextureLoader().load(url, tex => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.repeat.set(z.kachel, z.kachel);
      m.map = tex;
      m.needsUpdate = true;
    }, undefined, () => {});
  }
  holzCache.set(key, m);
  return m;
}


// =============================================================================
//  Schatten
//
//  Ein Bild des Schattens, das später auf die Landschaft gebrannt wird. Es
//  entsteht nicht beim Zeichnen, sondern einmal beim Export, und liegt danach
//  als graues PNG im Paket. Das Spiel bekommt damit den Schatten geschenkt —
//  ohne Schattenkarte, ohne zweiten Durchgang, ohne Lichtquelle.
//
//  Gerechnet wird auf einer 2D-Leinwand und nicht mit dem Renderer: der
//  Schattenriss ist eine ebene Sache, und ein WebGL-Kontext wäre dafür nur
//  Umstand. Zwei Dinge kommen hinein:
//
//    Die Billboards, alle waagerecht gelegt. Aufrecht stünden sie von oben
//    gesehen auf der Kante und würfen fast nichts. Gezeichnet wird ihre
//    Alphamaske — der Schatten bekommt dadurch die Löcher des Laubs und wird
//    nicht zur Scheibe.
//
//    Das Holz, Segment für Segment als Strich in seiner Stärke.
//
//  Geworfen wird dabei senkrecht nach unten, nicht längs des Sonnenstrahls.
//  Das ist Absicht und der einzige Punkt, an dem hier etwas zu überlegen war.
//
//  Der Riss ist ein Bild, und ein Bild dreht sich mit seiner Instanz — es muss
//  das auch, denn die Krone dreht sich ja mit. Die Sonne dreht sich aber nicht
//  mit. Steckte der Sonnenversatz im Bild, käme er bei einem um 120° gedrehten
//  Baum um 120° verdreht wieder heraus, und der Schatten läge im Südwesten
//  statt im Nordwesten. Genau das passiert, wenn man beides in einen Topf wirft.
//
//  Deshalb sind es zwei Dinge: das Bild trägt den Grundriss des Baums, in
//  seinem eigenen Koordinatensystem und damit drehbar. Der Sonnenversatz kommt
//  als `versatzX`/`versatzZ` daneben — in Weltkoordinaten, unabhängig von der
//  Drehung. Der Aufrufer verschiebt erst um den Versatz und dreht dann das
//  Bild.
//
//  Der Versatz ist für eine mittlere Kronenhöhe gerechnet, gewichtet nach
//  Deckung. Die Neigung des Schattens geht dabei verloren; bei 20° aus der
//  Senkrechten ist das keine sichtbare Größe, und ein Bild kann nicht für jede
//  Drehung anders geschert sein.
// =============================================================================

// Sonnenstand. Aus Südost, 20° aus der Senkrechten — das Licht fällt also nach
// Nordwesten. In three-Koordinaten ist +x Osten und +z Süden.
export const SONNE_AZIMUT  = 135;      // Grad, von Norden über Osten gezählt
export const SONNE_NEIGUNG = 20;       // Grad aus der Senkrechten

// Womit Laub und Holz in die mittlere Kronenhöhe eingehen, aus der der
// Sonnenversatz gerechnet wird. Für die Deckung selbst zählen sie nicht: die
// steht voll im Riss und wird erst in der Anwendung abgeschwächt.
const GEWICHT_BLATT = 0.55;
const GEWICHT_HOLZ  = 0.80;
// Weichzeichnung in Bildpunkten, bezogen auf 256. Ein Schlagschatten hat auch
// in der Natur keine harte Kante.
const SCHATTEN_WEICH = 2.0;
// Rand um den Schattenriss, Anteil seiner Kantenlänge.
const SCHATTEN_RAND  = 0.06;

// Die Verschiebung, die ein Punkt der Höhe 1 auf dem Boden erfährt.
function sonnenVersatz(){
  const az = SONNE_AZIMUT * Math.PI / 180;
  const t  = Math.tan(SONNE_NEIGUNG * Math.PI / 180);
  // Das Licht fällt der Sonne entgegen, also in die Gegenrichtung des Azimuts.
  return { x: -Math.sin(az) * t, z: Math.cos(az) * t };
}

// Eine Schicht des Texturarrays als Silhouette auf einer eigenen Leinwand. Die
// Farbe des Laubs spielt für einen Schatten keine Rolle; übrig bleibt allein
// seine Deckung — und die wandert hier aus dem Alphakanal in den Grauwert:
// undurchsichtig wird weiß, durchsichtig schwarz, und die Leinwand selbst ist
// überall undurchsichtig.
//
// Das ist die Vorbedingung dafür, dass sich zwei Blätter übereinander nicht
// aufaddieren. Deckung im Alphakanal kann nur zusammengeblendet werden, und
// Blenden heißt Aufsummieren; Deckung als Grauwert lässt sich vergleichen, und
// „der hellere gewinnt“ ist genau die gesuchte Regel.
function silhouette(satz, k){
  const S = satz.textur.image.width;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const bild = ctx.createImageData(S, S);
  const quelle = satz.textur.image.data;
  const d = bild.data;
  for (let i = 0; i < S * S; i++){
    const a = quelle[k * S * S * 4 + i * 4 + 3];
    d[i*4] = d[i*4+1] = d[i*4+2] = a;
    d[i*4+3] = 255;
  }
  ctx.putImageData(bild, 0, 0);
  return c;
}

// --- Der gemeinsame Kern -----------------------------------------------------
// Beide Risse entstehen gleich: Baum auf eine Ebene werfen, Alphamasken der
// Billboards und Striche für das Holz zeichnen, als graues PNG ausgeben. Sie
// unterscheiden sich allein in der Ebene, auf die geworfen wird — und die
// steckt in `rahmen`: ein Ursprung und zwei Achsen u und v, die sie aufspannen.
async function risse(skel, cfg, satz, px, rahmen){
  const nd = skel.knoten;
  const { o, u, v } = rahmen;
  // Ein Weltpunkt in die Ebene. Weil u und v senkrecht aufeinander stehen und
  // die Länge eins haben, ist das schlicht zweimal Skalarprodukt.
  const wirf = (x, y, z) => {
    const ax = x - o.x, ay = y - o.y, az = z - o.z;
    return { x: ax*u.x + ay*u.y + az*u.z, z: ax*v.x + ay*v.y + az*v.z };
  };

  // --- Ausdehnung bestimmen -------------------------------------------------
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const fasse = (p, r) => {
    if (p.x - r < x0) x0 = p.x - r;   if (p.x + r > x1) x1 = p.x + r;
    if (p.z - r < z0) z0 = p.z - r;   if (p.z + r > z1) z1 = p.z + r;
  };
  const blatt = [];
  let hSumme = 0, hGewicht = 0;      // deckungsgewichtete Höhe über Null
  if (satz){
    // baueBillboards liefert die Anker mit Ort und halber Kantenlänge; die
    // Schicht steht im Puffer daneben. Beides brauchen wir hier noch einmal.
    const netz = baueBillboards(skel, cfg, satz);
    const sch = netz.geometry.getAttribute('schicht').array;
    const anker = netz.userData.anker;
    for (let i = 0; i < anker.length; i++){
      const a = anker[i];
      const p = wirf(a.x, a.y, a.z);
      blatt.push({ x: p.x, z: p.z, h: a.h, k: sch[i * 4] });
      const g = a.h * a.h * GEWICHT_BLATT;
      hSumme += a.y * g; hGewicht += g;
      // Zur Ebene gedreht und beliebig gerollt reicht das Quadrat bis zu
      // seiner halben Diagonale.
      fasse(p, a.h * Math.SQRT2);
    }
    netz.geometry.dispose();
  }
  const holz = [];
  for (let i = 1; i < nd.length; i++){
    const k = nd[i], e = nd[k.parent];
    if (!e) continue;
    const a = wirf(k.pos.x, Math.max(0, k.pos.y), k.pos.z);
    const b = wirf(e.pos.x, Math.max(0, e.pos.y), e.pos.z);
    holz.push({ a: a, b: b, r: k.r });
    fasse(a, k.r); fasse(b, k.r);
    const laenge = Math.hypot(k.pos.x - e.pos.x, k.pos.y - e.pos.y, k.pos.z - e.pos.z);
    const g = laenge * 2 * k.r * GEWICHT_HOLZ;
    hSumme += (k.pos.y + e.pos.y) / 2 * g; hGewicht += g;
  }
  if (!isFinite(x0)) return null;

  // Auf ein Quadrat bringen, damit die Textur in beiden Richtungen denselben
  // Maßstab hat — sonst müsste der Aufrufer zwei Maße mitführen.
  const mitteX = (x0 + x1) / 2, mitteZ = (z0 + z1) / 2;
  let breite = Math.max(x1 - x0, z1 - z0);
  breite *= 1 + 2 * SCHATTEN_RAND;
  if (!(breite > 0.01)) breite = 1;
  const proMeter = px / breite;

  // --- Zeichnen -------------------------------------------------------------
  // Gezeichnet wird in Weiß auf Schwarz und mit `lighten`: von zwei Werten
  // bleibt der hellere stehen. Was ein Blatt deckt, deckt es damit ganz, und
  // zwei Blätter übereinander decken genau so viel wie eines.
  //
  // Vorher wurde mit Deckkraft übereinandergeblendet, und Blenden summiert:
  // jede weitere Lage schob den Wert wieder ein Stück Richtung Schwarz. In
  // einer dichten Krone liegen leicht ein Dutzend Rechtecke übereinander —
  // dort lief der Riss in die Sättigung, während er am dünn besetzten Rand
  // blass blieb. Der Schatten bekam dadurch eine harte, viel zu runde Mitte
  // und einen ausgefransten Saum, und wie kräftig er insgesamt ausfiel, hing
  // an der Zahl der Billboards statt an der Gestalt des Baums.
  //
  // Jetzt steht im Riss die Deckung selbst und sonst nichts: 255, wo etwas im
  // Weg ist, weniger nur da, wo das Blattbild selbst durchscheinend ist.
  // Abgeschwächt wird in der Anwendung, die den Riss auf den Boden bringt.
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';                        // schwarz = freier Boden
  ctx.fillRect(0, 0, px, px);
  ctx.globalCompositeOperation = 'lighten';
  ctx.filter = 'blur(' + (SCHATTEN_WEICH * px / 256).toFixed(2) + 'px)';
  const bx = x => (x - mitteX) * proMeter + px / 2;
  const bz = z => (z - mitteZ) * proMeter + px / 2;

  // Das Holz ist undurchsichtig und deckt deshalb voll.
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  for (const s of holz){
    ctx.lineWidth = Math.max(1, s.r * 2 * proMeter);
    ctx.beginPath();
    ctx.moveTo(bx(s.a.x), bz(s.a.z));
    ctx.lineTo(bx(s.b.x), bz(s.b.z));
    ctx.stroke();
  }

  const masken = new Map();
  for (const b of blatt){
    let m = masken.get(b.k);
    if (!m) masken.set(b.k, m = silhouette(satz, b.k));
    const s = b.h * 2 * proMeter;
    ctx.drawImage(m, bx(b.x) - s / 2, bz(b.z) - s / 2, s, s);
  }

  // Die Deckung steht jetzt im Grauwert und nicht mehr im Alphakanal — die
  // Leinwand ist überall undurchsichtig. Ausgegeben wird wie bisher: 0 heißt
  // frei, 255 voller Schatten.
  const roh = ctx.getImageData(0, 0, px, px).data;
  const grau = new Uint8Array(px * px);
  for (let i = 0; i < px * px; i++) grau[i] = roh[i * 4];

  return {
    bild:   'data:image/png;base64,' + await grauPNG(grau, px, px),
    breite: breite, mitteX: mitteX, mitteZ: mitteZ, px: px,
    hoehe:  hGewicht > 0 ? Math.max(0, hSumme / hGewicht) : 0
  };
}

// --- Grundriss für das Brennen in den Boden ----------------------------------
// Senkrecht nach unten geworfen, im Koordinatensystem des Baums. Er dreht mit
// der Instanz; der Sonnenversatz kommt als `versatzX`/`versatzZ` daneben und
// dreht nicht mit.
//
//   px   Kantenlänge des Bildes in Bildpunkten, Vorgabe 512
export async function baueSchatten(skel, cfg, satz, opt){
  const px = Math.max(64, Math.min(2048, Math.round((opt && opt.px) || 512)));
  const r = await risse(skel, cfg, satz, px, {
    o: { x: 0, y: 0, z: 0 },
    u: { x: 1, y: 0, z: 0 },
    v: { x: 0, y: 0, z: 1 }
  });
  if (!r) return null;
  const s = sonnenVersatz();
  r.versatzX = s.x * r.hoehe;
  r.versatzZ = s.z * r.hoehe;
  r.azimut = SONNE_AZIMUT; r.neigung = SONNE_NEIGUNG;
  return r;
}

// --- Schattenkarte für den echten Wurf ---------------------------------------
// Dasselbe Verfahren, aber auf eine Leinwand geworfen, die senkrecht auf dem
// Sonnenstrahl steht. Darauf liegt die reine Silhouette — nichts ist in die
// Länge gezogen, denn Blickrichtung und Ebene stehen im rechten Winkel
// zueinander.
//
// Das ist der Unterschied zum Grundriss, und er ist der ganze Witz: gestreckt
// wird der Schatten erst in der Szene, wenn das Licht diese Karte auf den
// Boden wirft. Am Hang wird er dadurch von selbst länger oder kürzer — ein
// gebackener Grundriss ist ein starrer Stempel und kann das nicht.
//
// Eingebaut wird sie als unsichtbarer Schattenwerfer im Baum:
//
//   const k = new THREE.Mesh(
//     new THREE.PlaneGeometry(karte.breite, karte.breite),
//     new THREE.MeshBasicMaterial({
//       map: bild, alphaTest: 0.5,          // Löcher im Laub
//       side: THREE.DoubleSide,             // sonst wirft sie nichts
//       colorWrite: false, depthWrite: false // unsichtbar für die Kamera
//     }));
//   k.castShadow = true;
//   k.quaternion.copy(karte.drehung);       // dreht NICHT mit dem Baum mit
//   k.position.set(0, karte.mitte, 0);
//
// Zwei Fallen stecken darin, beide gemessen und nicht geraten:
//
//   `visible = false` taugt nicht. three prüft das ganz vorn im
//   Schattendurchgang und überspringt das Objekt auch dort; dasselbe gilt für
//   Layer, deren Test gegen die Hauptkamera läuft. Es braucht `colorWrite`.
//
//   Eine einseitige Fläche wirft nichts. three rendert Schattenwerfer mit der
//   Rückseite, und die zeigt bei einer zur Sonne gedrehten Karte von ihr weg.
export async function baueSchattenkarte(skel, cfg, satz, opt){
  const px = Math.max(64, Math.min(2048, Math.round((opt && opt.px) || 512)));
  const H = skel.huelle;
  const s = zurSonne();                       // Einheitsvektor zur Sonne
  // Zwei Achsen, die die Leinwand aufspannen. u liegt waagerecht und quer zur
  // Sonnenrichtung, v ergänzt zum Rechtssystem und zeigt in der Ebene nach
  // oben. Bei senkrechter Sonne wäre u entartet — bei 20° ist davon keine Rede.
  const ul = Math.hypot(s.z, s.x) || 1;
  const u = { x: s.z / ul, y: 0, z: -s.x / ul };
  const v = { x: s.y*u.z - s.z*u.y, y: s.z*u.x - s.x*u.z, z: s.x*u.y - s.y*u.x };
  const mitte = { x: 0, y: H.mitte, z: 0 };   // Kronenmitte

  const r = await risse(skel, cfg, satz, px, { o: mitte, u: u, v: v });
  if (!r) return null;
  r.azimut = SONNE_AZIMUT; r.neigung = SONNE_NEIGUNG;
  // Wo die Karte hängt und wie sie steht. Der Mittelpunkt des Risses liegt in
  // der Ebene, also wird er über u und v zurück in die Welt gerechnet.
  r.mitte = { x: mitte.x + u.x * r.mitteX + v.x * r.mitteZ,
              y: mitte.y + u.y * r.mitteX + v.y * r.mitteZ,
              z: mitte.z + u.z * r.mitteX + v.z * r.mitteZ };
  r.normale = s;                              // Flächennormale = zur Sonne
  r.achseU = u; r.achseV = v;
  return r;
}

// Einheitsvektor vom Baum zur Sonne.
function zurSonne(){
  const az = SONNE_AZIMUT * Math.PI / 180;
  const n  = SONNE_NEIGUNG * Math.PI / 180;
  return { x: Math.sin(az) * Math.sin(n),
           y: Math.cos(n),
           z: -Math.cos(az) * Math.sin(n) };
}

// --- PNG mit acht Bit Graustufen ---------------------------------------------
// Farbtyp 0, ein Byte je Bildpunkt. Ein Viertel dessen, was die Leinwand mit
// toDataURL() ausgäbe — die kann nur RGBA. Gepackt wird mit CompressionStream,
// das genau den zlib-Strom liefert, den ein IDAT-Block erwartet; wo es das
// nicht gibt, werden ungepackte Blöcke geschrieben, was ebenso gültig und nur
// größer ist.
async function grauPNG(grau, w, h){
  // Zeilen mit Filterbyte 0 davor
  const roh = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++){
    roh[y * (w + 1)] = 0;
    roh.set(grau.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const packe = typeof CompressionStream === 'function'
    ? new Uint8Array(await new Response(
        new Blob([roh]).stream().pipeThrough(new CompressionStream('deflate'))
      ).arrayBuffer())
    : zlibRoh(roh);

  const kopf = new Uint8Array(13);
  const dv = new DataView(kopf.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  kopf[8] = 8;    // Bittiefe
  kopf[9] = 0;    // Farbtyp 0 = Graustufen
  const teile = [new Uint8Array([137,80,78,71,13,10,26,10]),
                 stueck('IHDR', kopf), stueck('IDAT', packe),
                 stueck('IEND', new Uint8Array(0))];
  let n = 0; for (const t of teile) n += t.length;
  const alles = new Uint8Array(n);
  let o = 0; for (const t of teile){ alles.set(t, o); o += t.length; }
  let s = '';
  for (let i = 0; i < alles.length; i++) s += String.fromCharCode(alles[i]);
  return btoa(s);
}

function stueck(name, daten){
  const out = new Uint8Array(12 + daten.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, daten.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(daten, 8);
  dv.setUint32(8 + daten.length, crc32(out.subarray(4, 8 + daten.length)));
  return out;
}

let crcTab = null;
function crc32(d){
  if (!crcTab){
    crcTab = new Uint32Array(256);
    for (let n = 0; n < 256; n++){
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTab[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = crcTab[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// zlib-Strom aus ungepackten Deflate-Blöcken. Notnagel für Umgebungen ohne
// CompressionStream.
function zlibRoh(d){
  const bloecke = Math.ceil(d.length / 65535) || 1;
  const out = new Uint8Array(2 + d.length + bloecke * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2, p = 0;
  for (let b = 0; b < bloecke; b++){
    const n = Math.min(65535, d.length - p);
    out[o++] = (b === bloecke - 1) ? 1 : 0;
    out[o++] = n & 255; out[o++] = n >> 8;
    out[o++] = (~n) & 255; out[o++] = ((~n) >> 8) & 255;
    out.set(d.subarray(p, p + n), o); o += n; p += n;
  }
  // Adler-32
  let a = 1, bsum = 0;
  for (let i = 0; i < d.length; i++){ a = (a + d[i]) % 65521; bsum = (bsum + a) % 65521; }
  const dv = new DataView(out.buffer);
  dv.setUint32(o, ((bsum << 16) | a) >>> 0);
  return out.subarray(0, o + 4);
}

// Den Schattenriss aus einem Paket als Textur. Die Maße kommen mit zurück —
// ohne sie weiß niemand, wie groß das Bild in der Welt ist.
//
//   textur   THREE.Texture, Deckung im Rot-Kanal wie im Alpha
//   breite   Kantenlänge in Metern
//   mitteX   Mittelpunkt des Bildes im Koordinatensystem des Baums
//   mitteZ
export function schattenTextur(cfg){
  const s = cfg && cfg.paket && cfg.paket.schatten;
  if (!s) return null;
  const tex = new THREE.TextureLoader().load(s.bild);
  tex.colorSpace = THREE.NoColorSpace;      // eine Maske, kein Bild
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return { textur: tex, breite: s.breite, mitteX: s.mitteX, mitteZ: s.mitteZ,
           versatzX: s.versatzX || 0, versatzZ: s.versatzZ || 0,
           hoehe: s.hoehe || 0, px: s.px,
           azimut: s.azimut, neigung: s.neigung, bild: s.bild };
}

// Die Schattenkarte aus einem Paket, fertig als unsichtbarer Werfer. Zurück
// kommt ein THREE.Mesh, das nur noch in den Baum gehängt werden muss — an den
// Ort, den `position` nennt, und ohne es mit dem Baum mitzudrehen.
export function schattenkarteWerfer(cfg){
  const s = cfg && cfg.paket && cfg.paket.schattenkarte;
  if (!s) return null;
  const tex = new THREE.TextureLoader().load(s.bild);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

  const netz = new THREE.Mesh(
    new THREE.PlaneGeometry(s.breite, s.breite),
    new THREE.MeshBasicMaterial({
      // Der Riss steht als Deckung im Bild: hell heißt Schatten. Für den
      // Alphatest wird er darum umgedreht — die Textur liefert das Alpha, und
      // gezeichnet wird ohnehin nichts.
      alphaMap: tex, alphaTest: 0.35, transparent: false,
      side: THREE.DoubleSide,          // sonst wirft sie nichts
      colorWrite: false, depthWrite: false
    })
  );
  netz.name = 'schattenkarte';
  netz.castShadow = true;
  netz.receiveShadow = false;
  // Die Ebene liegt in xy und schaut nach +z; sie muss auf die Sonne zeigen.
  netz.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(s.normale.x, s.normale.y, s.normale.z));
  netz.position.set(s.mitte.x, s.mitte.y, s.mitte.z);
  netz.userData.karte = s;
  return netz;
}

// =============================================================================
//  Seitenansicht
//
//  Ein einziges Bild des ganzen Baums, von der Seite gesehen, mit Alphakanal.
//  Es entsteht beim Export und liegt danach im Paket. Im Spiel hängt es als
//  Tafel dort, wo sonst der Baum stünde — ein Rechteck statt zweier Netze mit
//  Hunderten Rechtecken.
//
//  Anders als die beiden Schattenrisse entsteht es nicht auf einer 2D-Leinwand,
//  sondern mit dem Renderer. Es muss auch: der Riss braucht nur Deckung, die
//  Ansicht dagegen die fertigen Farben, das Rindenbild und die Beleuchtung —
//  alles, was ohnehin schon in Shadern steht. Der WebGL-Kontext dafür wird
//  einmal aufgemacht und gleich wieder geschlossen.
//
//  Drei Dinge sind an der Aufnahme festgelegt, und alle drei aus demselben
//  Grund — das Bild soll nichts mitbringen, was in der Szene noch einmal
//  vorkommt:
//
//    Die Perspektive ist unendlich, also orthografisch. Ein perspektivisches
//    Bild trüge seine eigene Fluchtung in sich; auf einer Tafel, die dann
//    ihrerseits perspektivisch gezeichnet wird, stünde sie doppelt.
//
//    Kein Nebel. Der kommt in der Szene dazu, wo er hingehört — gebacken wäre
//    er für eine Entfernung richtig und für jede andere falsch.
//
//    Die Sonne steht links oben, ANSICHT_NEIGUNG Grad aus der Senkrechten, in
//    der Bildebene. Sie dreht sich mit der Tafel mit, denn ein Bild kann nicht
//    anders. Das ist der Preis der Sache und der Grund, weshalb die Tafel erst
//    in einiger Entfernung übernimmt: dort ist die Lichtrichtung eines
//    einzelnen Baums keine sichtbare Größe mehr.
// =============================================================================

// Sonnenstand der Aufnahme, Grad aus der Senkrechten. Der Azimut ist nicht
// einstellbar: in der Bildebene gibt es nur links und rechts, und links ist
// gesetzt.
export const ANSICHT_NEIGUNG = 20;
// Rand um den Baum, Anteil der längeren Kante. Ohne ihn schnitte die
// Kantenglättung die äußersten Blätter an.
const ANSICHT_RAND = 0.03;

// Die Ansicht rechnen.
//
//   px         längere Bildkante in Bildpunkten, Vorgabe 512
//   opt.basis  Wurzelpfad für die Rinde, Standard './'
//
// Zurück kommt, was ins Paket geht:
//
//   bild     PNG mit Alphakanal als Datenadresse
//   breite   Breite der Tafel in Metern
//   hoehe    Höhe der Tafel in Metern
//   mitteY   Höhe der Tafelmitte über dem Baumfuß
//   pxX,pxY  Maße des Bildes in Bildpunkten
export async function baueAnsicht(skel, cfg, satz, opt){
  const o = opt || {};
  const px = Math.max(64, Math.min(2048, Math.round(o.px || 512)));
  const basis = o.basis || './';
  const c = normiere(cfg);

  // --- Ausdehnung bestimmen -------------------------------------------------
  // Waagerecht wird nicht die Breite dieser einen Ansicht genommen, sondern der
  // größte Abstand von der Stammachse überhaupt. Die Tafel steht später zu
  // jedem beliebigen Winkel; nähme man die Breite der Aufnahme, würde derselbe
  // Baum je nach Drehung mal breiter und mal schmaler — und beim Umschalten
  // spränge er.
  let R = 0, yO = -Infinity, yU = Infinity;
  const fasse = (x, y, z, r) => {
    const d = Math.hypot(x, z) + r;
    if (d > R) R = d;
    if (y + r > yO) yO = y + r;
    if (y - r < yU) yU = y - r;
  };

  let netz = null;
  if (satz){
    netz = baueBillboards(skel, c, satz);
    for (const a of netz.userData.anker)
      // Zur Kamera gedreht und beliebig gerollt reicht das Quadrat bis zu
      // seiner halben Diagonale.
      fasse(a.x, a.y, a.z, a.h * Math.SQRT2);
  }
  const nd = skel.knoten;
  for (let i = 0; i < nd.length; i++) fasse(nd[i].pos.x, nd[i].pos.y, nd[i].pos.z, nd[i].r);
  if (!isFinite(yO)){ if (netz) netz.geometry.dispose(); return null; }

  let breite = 2 * R, hoehe = yO - yU;
  const zug = Math.max(breite, hoehe) * ANSICHT_RAND;
  breite += 2 * zug; hoehe += 2 * zug;
  const mitteY = (yO + yU) / 2;
  const lang = Math.max(breite, hoehe);
  const pxX = Math.max(8, Math.round(px * breite / lang));
  const pxY = Math.max(8, Math.round(px * hoehe  / lang));

  // --- Aufbauen -------------------------------------------------------------
  const bild = document.createElement('canvas');
  bild.width = pxX; bild.height = pxY;
  const rnd = new THREE.WebGLRenderer({ canvas: bild, antialias: true,
                                        alpha: true, preserveDrawingBuffer: true });
  rnd.setPixelRatio(1);
  rnd.setSize(pxX, pxY, false);
  rnd.setClearColor(0x000000, 0);           // freigestellt, nicht auf Himmel

  const szene = new THREE.Scene();           // ohne Nebel, das ist der Punkt
  szene.add(new THREE.HemisphereLight(0xdff0ff, 0x6a6650, 1.5));
  const sonne = new THREE.DirectionalLight(0xfff3e0, 1.9);
  // Links oben, in der Bildebene. Die Kamera schaut aus +z auf den Ursprung,
  // also ist links −x und oben +y; z bleibt null.
  const n = ANSICHT_NEIGUNG * Math.PI / 180;
  sonne.position.set(-Math.sin(n) * 40, Math.cos(n) * 40, 0).add(new THREE.Vector3(0, mitteY, 0));
  sonne.target.position.set(0, mitteY, 0);
  szene.add(sonne, sonne.target);

  // Die Rinde wird hier selbst geladen und nicht über holzMaterial() geholt.
  // Jenes lädt sie nach und gibt das Material sofort zurück — für eine Szene,
  // die dreißigmal in der Sekunde neu gezeichnet wird, ist das richtig; für
  // eine einzige Aufnahme wäre der Stamm dann nackt.
  const rinde = (c.paket && c.paket.rinde) || c.holz.textur;
  let rindeTex = null;
  if (rinde){
    const url = /^(data:|https?:|\/)/.test(rinde) ? rinde : basis + rinde;
    rindeTex = await new Promise(ok =>
      new THREE.TextureLoader().load(url, t => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.repeat.set(c.holz.kachel, c.holz.kachel);
        ok(t);
      }, undefined, () => ok(null)));
  }
  const holzMat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(c.holz.farbe), vertexColors: true, map: rindeTex });
  const holz = new THREE.Mesh(baueHolz(skel), holzMat);
  szene.add(holz);
  if (netz) szene.add(netz);

  // --- Aufnehmen ------------------------------------------------------------
  // Orthografisch: keine Fluchtung im Bild. Wie weit die Kamera dabei steht,
  // ändert am Maßstab nichts — nur die Klippebenen müssen den Baum umschließen.
  const weit = lang * 2 + 10;
  const kam = new THREE.OrthographicCamera(-breite/2, breite/2, hoehe/2, -hoehe/2,
                                           0.01, weit * 2);
  kam.position.set(0, mitteY, weit);
  kam.lookAt(0, mitteY, 0);
  rnd.render(szene, kam);
  const daten = bild.toDataURL('image/png');

  holz.geometry.dispose();
  holzMat.dispose();
  if (rindeTex) rindeTex.dispose();
  if (netz) netz.geometry.dispose();
  rnd.dispose();
  rnd.forceContextLoss();

  return { bild: daten, breite: breite, hoehe: hoehe, mitteY: mitteY,
           pxX: pxX, pxY: pxY, neigung: ANSICHT_NEIGUNG };
}

// Das Material der Tafel. Ein fertiges Bild braucht kein Licht mehr — es steckt
// darin. Zwei Eigenheiten hat es doch:
//
//   Die Tafel steht immer zur Kamera. Aufgespannt wird sie im Blickraum, genau
//   wie die Billboards der Krone: der Ort kommt aus der Matrix, die Ecken
//   kommen daneben. Eine Drehung der Instanz geht dabei nicht ein — sie kann
//   auch nicht, ein Bild hat keine Rückseite.
//
//   Gedreht wird um beide Achsen und nicht nur um die senkrechte. Von oben
//   gesehen legt sich die Tafel dadurch flach hin, was sie nicht sollte; nur um
//   die Senkrechte gedreht stünde sie dort dagegen auf der Kante und wäre ganz
//   verschwunden. Von zwei schiefen Bildern ist das sichtbare das bessere.
export function ansichtMaterial(tex, instanziert){
  const m = new THREE.MeshBasicMaterial({
    map: tex, alphaTest: 0.5, transparent: false,
    side: THREE.FrontSide,
    // Der Nebel gehört in die Szene, nicht ins Bild — aber die Krone der nahen
    // Bäume kennt ihn auch nicht, und zwei verschiedene Dunstschleier über
    // demselben Wald fielen mehr auf als gar keiner.
    fog: false, toneMapped: false
  });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', /* glsl */`
      vec4 mvPosition = vec4(0.0, 0.0, 0.0, 1.0);
      float tafelS = length(modelMatrix[0].xyz);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
        tafelS *= length(instanceMatrix[0].xyz);
      #endif
      mvPosition = modelViewMatrix * mvPosition;
      mvPosition.xy += transformed.xy * tafelS;
      gl_Position = projectionMatrix * mvPosition;
    `);
  };
  // Zwei Fassungen desselben Programms brauchen zwei Schlüssel, sonst hält
  // three die instanzierte für die gewöhnliche.
  m.customProgramCacheKey = () => 'ansicht' + (instanziert ? 'I' : '');
  return m;
}

// Die Seitenansicht aus einem Paket, fertig als Tafelfeld. Zurück kommt ein
// InstancedMesh mit `anzahl` Plätzen; gesetzt werden sie wie gewohnt über
// setMatrixAt(). Der Ort ist der Baumfuß plus `mitteY` mal Instanzgröße —
// die Höhe der Tafelmitte über dem Boden.
//
//   const tafeln = await ansichtTafeln(zeug.config.paket.ansicht, 200);
//   tafeln.setMatrixAt(i, new THREE.Matrix4().compose(
//     new THREE.Vector3(x, y + ansicht.mitteY * g, z),
//     new THREE.Quaternion(), new THREE.Vector3(g, g, g)));
//
// Die Drehung bleibt ohne Wirkung, die Größe wirkt. Gerechnet werden darf mit
// einem Zeichenaufruf für den ganzen Wald und zwei Dreiecken je Baum.
export async function ansichtTafeln(ansicht, anzahl){
  if (!ansicht || !ansicht.bild) return null;
  const n = Math.max(1, Math.round(anzahl || 1));
  const tex = await new Promise(ok =>
    new THREE.TextureLoader().load(ansicht.bild, t => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      ok(t);
    }));
  const netz = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(ansicht.breite, ansicht.hoehe),
    ansichtMaterial(tex, true), n);
  netz.name = 'ansicht';
  // Die Tafel wird erst im Shader aus ihrem Ankerpunkt aufgespannt; was das
  // Sichtvolumen von der Geometrie hält, stimmt damit nicht mehr.
  netz.frustumCulled = false;
  netz.castShadow = netz.receiveShadow = false;
  netz.userData.ansicht = ansicht;
  return netz;
}

// =============================================================================
//  Farbvarianten
// =============================================================================

// Die Töne, aus denen im Spiel je Baum einer gewürfelt wird: ungefärbt und die
// fünf Varianten aus der Datei, sechs gleich wahrscheinliche Möglichkeiten.
//
//   const toene = laubtoene(cfg);
//   wald.faerbe(i, toene[(zufall() * toene.length) | 0]);
//
// Das Würfeln bleibt beim Aufrufer, und das mit Absicht: eine Landschaft, die
// bei gleichem Startwert gleich aussehen soll, braucht ihren eigenen Zufall
// und nicht Math.random.
//
// Ungefärbt steht als erster Eintrag fest darin, auch wenn eine Variante
// ebenfalls auf eins steht — die Verteilung ist eine Eigenschaft des Spiels
// und nicht der eingetragenen Werte. Wer den weißen Baum nicht will, trägt
// fünf Varianten ein und lässt den ersten Eintrag weg.
export function laubtoene(cfg){
  const f = (cfg && cfg.laubfarben) || [];
  const out = [new THREE.Color(1, 1, 1)];
  for (let i = 0; i < LAUBFARBEN; i++){
    const t = Array.isArray(f[i]) ? f[i] : [1, 1, 1];
    out.push(new THREE.Color().setRGB(num(t[0], 1), num(t[1], 1), num(t[2], 1)));
  }
  return out;
}

// =============================================================================
//  Nach außen
// =============================================================================

// Einen Baum aus einer Konfiguration bauen.
//
//   cfg              Konfigurationsobjekt (wird normiert)
//   opt.basis        Wurzelpfad für img/ und Texturen, Standard './'
//
// Zurück kommt ein THREE.Group mit zwei Netzen. group.userData.baum trägt die
// verwendete Konfiguration und die Kennzahlen; group.dispose() gibt die
// Geometrien frei (Material und Textur sind geteilt und bleiben stehen).
export async function erzeugeBaum(cfg, opt){
  const o = opt || {};
  const c = normiere(cfg);
  const basis = o.basis || './';

  const skel = baueSkelett(c);
  const grp = new THREE.Group();
  grp.name = c.name;

  const holz = new THREE.Mesh(baueHolz(skel), holzMaterial(c, basis));
  holz.name = 'holz';
  grp.add(holz);

  const satz = await ladeBillboardSatz(c, basis);
  if (satz) grp.add(baueBillboards(skel, c, satz));

  grp.userData.baum = { config: c, stats: skel.stats };
  grp.dispose = () => { for (const k of grp.children) k.geometry.dispose(); };
  return grp;
}

// Denselben Baum vielfach, als zwei InstancedMesh — der eine Weg, auf dem ein
// ganzer Wald in zwei Zeichenaufrufen steht.
//
//   cfg, opt.basis   wie bei erzeugeBaum
//   anzahl           wie viele Bäume Platz haben sollen
//
// Zurück kommt ein THREE.Group mit den Netzen „holz“ und „laub“. Beide tragen
// dieselben Instanzen; gesetzt werden sie über die gewöhnliche three-Schnitt-
// stelle, und zwar in beiden gleich:
//
//   const wald = await erzeugeBaumInstanzen(cfg, 200, { basis: './' });
//   const m = new THREE.Matrix4().makeTranslation(x, 0, z);
//   wald.setze(i, m);                       // Ort in beiden Netzen
//   wald.faerbe(i, new THREE.Color(0xc8d8a0));   // Tönung nur der Krone
//   wald.fertig();                          // einmal am Ende
//
// Der Stamm bleibt dabei ungetönt: das Blattwerk soll sich von Baum zu Baum
// unterscheiden, die Rinde nicht.
//
// Verschiedene Stämme zu verschiedenen Kronen zu stellen, geht ebenfalls —
// gerade weil es zwei Netze sind. Man baut mehrere Stammnetze und mehrere
// Kronennetze und paart sie frei: aus K + M Geometrien werden K × M Bäume,
// und Zeichenaufrufe kostet es K + M.
export async function erzeugeBaumInstanzen(cfg, anzahl, opt){
  const o = opt || {};
  const c = normiere(cfg);
  const basis = o.basis || './';
  const n = Math.max(1, Math.round(anzahl));

  const skel = baueSkelett(c);
  const grp = new THREE.Group();
  grp.name = c.name;

  const holz = new THREE.InstancedMesh(baueHolz(skel), holzMaterial(c, basis), n);
  holz.name = 'holz';
  grp.add(holz);

  let laub = null;
  const satz = await ladeBillboardSatz(c, basis);
  if (satz){
    const netz = baueBillboards(skel, c, satz);
    laub = new THREE.InstancedMesh(netz.geometry, satz.materialInstanz, n);
    laub.name = 'laub';
    // Die Rechtecke wachsen erst im Shader aus ihrem Ankerpunkt heraus. Was
    // die Geometrie dafür an ihrer Hüllkugel zugelegt hat, muss die Instanz
    // übernehmen — sonst schneidet das Sichtvolumen die Kronen am Bildrand weg.
    laub.boundingSphere = netz.geometry.boundingSphere;
    grp.add(laub);
  }

  // Jede Instanz bekommt von vornherein eine Tönung. Ohne das gäbe es das
  // Attribut instanceColor gar nicht, und der Shader läse Nullen — die Krone
  // bliebe schwarz, bis der Aufrufer zufällig faerbe() benutzt.
  const weiss = new THREE.Color(1, 1, 1);
  const leer = new THREE.Matrix4();
  for (let i = 0; i < n; i++){
    holz.setMatrixAt(i, leer);
    if (laub){ laub.setMatrixAt(i, leer); laub.setColorAt(i, weiss); }
  }

  grp.setze = (i, matrix) => {
    holz.setMatrixAt(i, matrix);
    if (laub) laub.setMatrixAt(i, matrix);
  };
  grp.faerbe = (i, farbe) => { if (laub) laub.setColorAt(i, farbe); };
  grp.fertig = () => {
    holz.instanceMatrix.needsUpdate = true;
    holz.computeBoundingSphere();
    if (laub){
      laub.instanceMatrix.needsUpdate = true;
      if (laub.instanceColor) laub.instanceColor.needsUpdate = true;
    }
  };
  // Skelett und Billboardsatz kommen mit: das Rohmaterial, aus dem Risse,
  // Schattenkarte und Seitenansicht gerechnet werden. Im Spiel stehen sie
  // fertig im Paket; wer sie zur Laufzeit noch einmal rechnen will, braucht
  // genau diese beiden.
  grp.userData.baum = { config: c, stats: skel.stats, skelett: skel, satz: satz };
  grp.dispose = () => { for (const k of grp.children) k.geometry.dispose(); };
  grp.fertig();
  return grp;
}

// Denselben Baum aus einer .json-Datei. Der Pfad zu den Bildern wird, sofern
// nicht anders angegeben, aus dem Ort der Datei abgeleitet: json/eiche.json
// sucht seine Billboards in img/ daneben, also eine Ebene höher.
export async function ladeBaum(url, opt){
  return erzeugeBaum(await hole(url), ergaenzeBasis(url, opt));
}

// Und derselbe Baum vielfach, als zwei InstancedMesh.
export async function ladeBaumInstanzen(url, anzahl, opt){
  return erzeugeBaumInstanzen(await hole(url), anzahl, ergaenzeBasis(url, opt));
}

async function hole(url){
  const antwort = await fetch(url);
  if (!antwort.ok) throw new Error('Baum nicht ladbar: ' + url);
  return antwort.json();
}

// Der Pfad zu den Bildern wird, sofern nicht anders angegeben, aus dem Ort der
// Datei abgeleitet: json/eiche.json sucht seine Billboards in img/ daneben,
// also eine Ebene höher.
function ergaenzeBasis(url, opt){
  const o = Object.assign({}, opt);
  if (!o.basis){
    const teile = String(url).split('/');
    teile.pop();
    if (teile[teile.length-1] === 'json') teile.pop();
    o.basis = teile.length ? teile.join('/') + '/' : './';
  }
  return o;
}

export default { STANDARD, VERSION, MOTIV, LAUBFARBEN, laubtoene,
                 normiere, baueHuelle, baueSkelett,
                 baueHolz, baueBillboards, ladeBillboardSatz, holzMaterial,
                 erzeugeBaum, erzeugeBaumInstanzen, ladeBaum,
                 ladeBaumInstanzen, packe, baueSchatten, baueSchattenkarte,
                 schattenTextur, schattenkarteWerfer,
                 baueAnsicht, ansichtMaterial, ansichtTafeln };
