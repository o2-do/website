import * as THREE from 'three';
import { atArcLength } from './paths.js';
import { stream } from './rng.js';

/**
 * Schildtextur auf einem Canvas. Der Name muss vollstaendig aufs Schild passen,
 * deshalb wird die Schriftgroesse so lange verkleinert, bis er in die Breite
 * passt; erst wenn eine Untergrenze erreicht ist, wird auf zwei Zeilen
 * umgebrochen.
 */
const PX = 1000;                                     // Pixel je Meter
const FONT = (px) => `600 ${px}px system-ui, -apple-system, Segoe UI, sans-serif`;

let _measure = null;
function measureCtx() {
  if (!_measure) _measure = document.createElement('canvas').getContext('2d');
  return _measure;
}

/**
 * Die Schrift hat eine feste Groesse, das Schild richtet sich danach: kein
 * Umbruch, keine gestauchten Namen - stattdessen wird das Brett so breit wie
 * noetig. Die Hoehe ist fuer alle Schilder gleich (Schriftgroesse + Rand),
 * damit alle Schilder auf derselben Hoehe haengen.
 */
export function signSize(text, cfg) {
  const ctx = measureCtx();
  ctx.font = FONT(cfg.schriftGroesse * PX);
  const textW = ctx.measureText(text).width / PX;
  return {
    width: textW + 2 * cfg.schildRand,
    height: cfg.schildHoehe,          // = schriftGroesse * 1.35 + 2 * schildRand
  };
}

export function makeSignTexture(text, cfg) {
  const size = signSize(text, cfg);
  const w = Math.max(8, Math.round(size.width * PX));
  const h = Math.max(8, Math.round(size.height * PX));

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.font = FONT(cfg.schriftGroesse * PX);
  ctx.fillStyle = '#666666';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { texture: tex, ...size };
}

/**
 * Vor jedem benannten Baum steht ein Schild mit seinem Namen. Der Pfahl steht
 * 10 cm von der Wegkante auf derselben Bogenlaenge wie der Baum, das Schild
 * zeigt mit der lesbaren Seite zum Weg.
 *
 * `benannt` ist die Paarung aus Baumplatz und Name, die garden.js aus der
 * Namensliste bildet - die Schilderzahl ist damit nicht mehr frei einstellbar,
 * sondern die Zahl der Eintraege in der Liste.
 */
export function planSigns(benannt, paths, pathIndex, hf, cfg) {
  const out = [];
  for (const { trunk: t, name } of benannt) {
    const path = paths[t.pathIdx];
    if (!path) continue;
    // Die Kante des Weges, an dem der Baum steht - eine Abkuerzung ist
    // schmaler als der Rundweg.
    const offset = path.width / 2 + cfg.pfahlAbstandWeg;
    const c = atArcLength(path, t.s);
    const x = c.x + c.nx * offset * t.side;
    const z = c.z + c.nz * offset * t.side;
    // Der Pfahl steht bewusst dicht am eigenen Weg; geprueft wird gegen die
    // anderen Wege.
    if (pathIndex.surfaceDistance(x, z, t.pathIdx) < cfg.pfahlDurchmesser) continue;

    out.push({
      x, z, y: hf.heightAt(x, z), trunk: t, text: name,
      // Blickrichtung des Schildes: zurueck zum Weg
      fx: -c.nx * t.side, fz: -c.nz * t.side,
    });
  }
  return out;
}


// Die Texturkoordinaten eines Pfahls auf METER bringen. Ein Zylinder liefert
// u und v von 0 bis 1; auf einem fuenf Zentimeter duennen, anderthalb Meter
// hohen Pfahl waere die Maserung damit einmal ueber die ganze Laenge gezogen.
// Dieselbe Rechnung wie beim Zaun (`kachle` in `zaun.js`), nur hier fuer sich.
const PFAHL_KACHEL = 1.0;
function kachlePfahl(geo, umfang, laenge) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (umfang / PFAHL_KACHEL), uv.getY(i) * (laenge / PFAHL_KACHEL));
  }
  uv.needsUpdate = true;
}

export function buildSigns(signs, cfg, postMaterial) {
  const group = new THREE.Group();
  group.name = 'schilder';
  if (signs.length === 0) return { group, faces: [] };

  const pr = cfg.pfahlDurchmesser / 2;
  const ph = cfg.pfahlHoehe;
  const postGeo = new THREE.CylinderGeometry(pr, pr, ph, 8);
  kachlePfahl(postGeo, Math.PI * cfg.pfahlDurchmesser, ph);
  const posts = new THREE.InstancedMesh(postGeo, postMaterial, signs.length);
  posts.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  posts.castShadow = true;
  posts.receiveShadow = true;
  posts.name = 'pfaehle';

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);

  const faces = [];

  signs.forEach((s, i) => {
    const sink = 0.05;
    p.set(s.x, s.y - sink + ph / 2, s.z);
    m.compose(p, q, one);
    posts.setMatrixAt(i, m);

    // Breite folgt dem Namen, Hoehe ist fuer alle gleich
    const sign = makeSignTexture(s.text, cfg);
    const boardGeo = new THREE.PlaneGeometry(sign.width, sign.height);
    const front = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({
      map: sign.texture, roughness: 0.9, metalness: 0,
    }));
    const back = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({
      color: 0xf2f2f2, roughness: 0.9, metalness: 0,
    }));

    const yaw = Math.atan2(s.fx, s.fz);
    const cy = cfg.schildMitteHoehe + s.y;      // Schildmitte auf Augenhoehe
    // knapp vor bzw. hinter dem Pfahl, damit nichts durchsticht
    for (const [mesh, dir, rot] of [[front, 1, yaw], [back, -1, yaw + Math.PI]]) {
      mesh.position.set(s.x + s.fx * pr * 1.2 * dir, cy, s.z + s.fz * pr * 1.2 * dir);
      mesh.rotation.set(0, rot, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    faces.push({ mesh: front, back, texture: sign.texture });
  });

  posts.instanceMatrix.needsUpdate = true;
  posts.computeBoundingSphere();
  group.add(posts);
  return { group, faces };
}

/**
 * Namen nachtraeglich setzen (spaetere Version: individuelle Namen je Schild).
 * Weil die Schildbreite dem Namen folgt, wird auch die Geometrie neu gebaut.
 */
export function setSignName(face, text, cfg) {
  face.texture.dispose();
  face.mesh.geometry.dispose();
  const sign = makeSignTexture(text, cfg);
  const geo = new THREE.PlaneGeometry(sign.width, sign.height);
  face.mesh.geometry = geo;
  face.back.geometry = geo;
  face.mesh.material.map = sign.texture;
  face.mesh.material.needsUpdate = true;
  face.texture = sign.texture;
}


/* ---------------- Der Wegweiser am Tor ---------------- */

// Der Winkel an der Spitze. Neunzig Grad heisst: die Spitze steht so weit vor,
// wie das Brett halb hoch ist.
const PFEIL_SPITZE = 0.5;
// Wie weit der Pfahl von der Wegkante steht.
const PFEIL_AB_KANTE = 0.25;
// Wie weit ein Abkuerzungsmaul umgangen wird, bevor der Wegweiser steht.
const PFEIL_FREI = 1.5;

/**
 * DER WEGWEISER GEGENUEBER DEM EINGANG.
 *
 * Wer durch das Tor kommt, stoesst auf den Rundweg und muss sich entscheiden.
 * Auf der anderen Seite steht deshalb ein Schild mit einer Spitze, das in eine
 * der beiden Richtungen zeigt - welche, entscheidet der Startwert. Es ist kein
 * Hinweis auf ein Ziel, sondern auf den Weg selbst: beide Richtungen fuehren
 * herum, eine muss man nehmen.
 *
 * MUENDET DORT EINE ABKUERZUNG, RUECKT ER ZUR SEITE. Auf ihrem Maul stuende er
 * mitten im Pflaster; gesucht wird dann die naechste freie Stelle laengs des
 * Rundwegs, in Richtung der Spitze - so steht er an dem Weg, auf den er zeigt.
 */
export function planWegweiser(paths, tor, pathIndex, hf, cfg) {
  if (!cfg.wegweiser || !tor) return null;
  const rund = paths.find((p) => p.art === 'rund');
  const zugang = paths.find((p) => p.art === 'tor');
  if (!rund || !zugang) return null;

  // Wo der Zugang auf den Rundweg trifft: sein inneres Ende.
  const ende = zugang.samples[0];
  let sTreffer = 0, best = Infinity;
  for (const c of rund.samples) {
    const d = (c.x - ende.x) ** 2 + (c.z - ende.z) ** 2;
    if (d < best) { best = d; sTreffer = c.s; }
  }

  // Rechts oder links - aus dem Startwert, damit derselbe Garten dasselbe
  // Schild bekommt.
  const rng = stream(cfg._seed, 'wegweiser');
  const richtung = rng() < 0.5 ? 1 : -1;

  // Die Seite GEGENUEBER dem Tor: die Torseite ist die, auf der der Zugang
  // herankommt.
  const c0 = atArcLength(rund, sTreffer);
  const zumTor = (tor.mitte.x - c0.x) * c0.nx + (tor.mitte.z - c0.z) * c0.nz;
  const seite = zumTor > 0 ? -1 : 1;

  // Laengs weiterruecken, bis der Platz frei von fremden Wegflaechen ist.
  //
  // ZWEI WEGE ZAEHLEN DABEI NICHT. Der Rundweg nicht, denn an ihm soll das
  // Schild ja stehen. Und der ZUGANG nicht: er laeuft bis in die Mitte des
  // Rundwegs hinein (so entsteht die Kreuzung, siehe `wegnetz.js`), und sein
  // Band ist so breit wie er selbst. Gegenueber dem Tor - genau dort, wo das
  // Schild hingehoert - liegt der Platz damit rechnerisch dicht an seiner
  // Flaeche, obwohl dort in Wirklichkeit nichts als Wiese ist: was ueber die
  // Wegkante hinausragt, ist beim Vernetzen laengst abgeschnitten worden.
  // Das Schild wurde deshalb jedes Mal am Eingang weitergeschoben.
  //
  // Eine Abkuerzung, die dort einmuendet, schiebt es weiterhin.
  const ausser = new Set([rund.index, zugang.index]);
  const freiVonFremden = (x, z) => {
    for (const q of paths) {
      if (ausser.has(q.index)) continue;
      const grenze = q.width / 2 + PFEIL_FREI;
      const sm = q.samples;
      const bis = q.closed ? sm.length : sm.length - 1;
      for (let i = 0; i < bis; i++) {
        const a = sm[i], b = sm[(i + 1) % sm.length];
        const ex = b.x - a.x, ez = b.z - a.z;
        const l2 = ex * ex + ez * ez || 1e-9;
        let t = ((x - a.x) * ex + (z - a.z) * ez) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (a.x + ex * t), dz = z - (a.z + ez * t);
        if (dx * dx + dz * dz < grenze * grenze) return false;
      }
    }
    return true;
  };
  const abstand = rund.width / 2 + PFEIL_AB_KANTE;
  for (let k = 0; k <= 24; k++) {
    const s = sTreffer + richtung * k * 0.5;
    const c = atArcLength(rund, s);
    const x = c.x + c.nx * abstand * seite;
    const z = c.z + c.nz * abstand * seite;
    if (!freiVonFremden(x, z)) continue;
    if (Math.hypot(x, z) > 0.97 * hf.radius) continue;
    // Die Laengsrichtung des Weges steht nicht in `atArcLength` - dort kommt
    // nur die Normale zurueck. Sie ist aber genau deren Senkrechte: in
    // `makePath` ist n = (-tz, tx), also t = (nz, -nx).
    return {
      x, z, y: hf.heightAt(x, z), text: 'Rundweg', richtung,
      // Das Brett blickt quer ueber den Weg zurueck - dorthin, wo man steht,
      // wenn man aus dem Tor kommt.
      fx: -c.nx * seite, fz: -c.nz * seite,
      // Und die Spitze zeigt laengs, in die gewaehlte Richtung.
      tx: c.nz * richtung, tz: -c.nx * richtung,
    };
  }
  return null;
}

/**
 * Die Textur des Wegweisers: dasselbe Brett wie sonst, nur laenger, damit die
 * Spitze Platz hat. Die Schrift bleibt im rechteckigen Teil - in der Spitze
 * liefe sie sonst aus dem Brett heraus.
 */
function wegweiserTextur(text, cfg, spitze, spiegel) {
  const brett = signSize(text, cfg);
  const ganz = brett.width + brett.height * spitze;
  const w = Math.max(8, Math.round(ganz * PX));
  const h = Math.max(8, Math.round(brett.height * PX));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.font = FONT(cfg.schriftGroesse * PX);
  ctx.fillStyle = '#666666';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Die Schrift steht am STUMPFEN Ende, und wo das liegt, haengt an der
  // Spiegelung: bei gespiegelter Geometrie zeigt die Spitze nach -X, das
  // stumpfe Ende also nach +X - und dort laeuft die Texturkoordinate gegen 1.
  const mitteX = spiegel ? w - Math.round(brett.width * PX) / 2
                         : Math.round(brett.width * PX) / 2;
  ctx.fillText(text, mitteX, h / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { texture: tex, breite: brett.width, hoehe: brett.height, ganz };
}

/**
 * Das Brett mit der Spitze: fuenf Ecken, zwei Dreiecke plus eins.
 *
 * Gebaut wird nach RECHTS zeigend; wohin es wirklich zeigt, entscheidet die
 * Drehung beim Aufstellen. So gibt es nur eine Geometrie und keine zwei Faelle.
 */
function pfeilGeometrie(breite, hoehe, spitze, spiegel) {
  const halbH = hoehe / 2;
  const sp = spiegel ? -1 : 1;
  const x0 = (-breite / 2) * sp, x1 = (breite / 2) * sp;
  const tip = x1 + halbH * spitze * 2 * sp;
  const pos = [
    x0, -halbH, 0,   x1, -halbH, 0,   x1, halbH, 0,   x0, halbH, 0,
    tip, 0, 0,
  ];
  // Die Textur laeuft immer vom stumpfen Ende zur Spitze - gespiegelt wird die
  // Geometrie, nicht die Schrift.
  // DIE TEXTURKOORDINATE LAEUFT IMMER MIT +X, auch gespiegelt. Von vorn
  // gesehen liegt +X rechts, und Schrift wird nach rechts gelesen; wer u
  // umdreht, dreht damit jeden Buchstaben um. Verschoben wird stattdessen die
  // Schrift auf der Leinwand (siehe `wegweiserTextur`).
  const links = Math.min(x0, tip), ganz = Math.abs(tip - x0);
  const uv = [];
  for (let i = 0; i < pos.length; i += 3) {
    uv.push((pos[i] - links) / ganz, (pos[i + 1] + halbH) / hoehe);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // Gespiegelt kehrt sich der Umlaufsinn um; sonst blickte das Brett nach
  // hinten und man saehe von vorn nur seine Rueckseite.
  geo.setIndex(spiegel ? [0, 2, 1, 0, 3, 2, 1, 2, 4] : [0, 1, 2, 0, 2, 3, 1, 4, 2]);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export function buildWegweiser(plan, cfg, postMaterial) {
  if (!plan) return null;
  const gruppe = new THREE.Group();
  gruppe.name = 'wegweiser';

  const pr = cfg.pfahlDurchmesser / 2;
  const ph = cfg.pfahlHoehe;
  const pfahlGeo = new THREE.CylinderGeometry(pr, pr, ph, 8);
  kachlePfahl(pfahlGeo, Math.PI * pr * 2, ph);
  const pfahl = new THREE.Mesh(pfahlGeo, postMaterial);
  pfahl.position.set(plan.x, plan.y - 0.05 + ph / 2, plan.z);
  pfahl.castShadow = true;
  pfahl.receiveShadow = true;
  gruppe.add(pfahl);

  const cy = cfg.schildMitteHoehe + plan.y;

  // DIE DREHUNG MACHT DAS BRETT LESBAR, DIE GEOMETRIE MACHT DIE SPITZE.
  //
  // Gedreht wird so, dass die Vorderseite dorthin blickt, wo man steht, wenn
  // man aus dem Tor kommt. Damit steht auch schon fest, wohin die oertliche
  // +X-Achse zeigt - naemlich quer dazu, also laengs des Weges. Ob das die
  // gewuenschte Richtung ist oder die andere, entscheidet ein Skalarprodukt;
  // stimmt es nicht, wird die Spitze gespiegelt statt das Brett zu verdrehen.
  // Andersherum staende die Schrift auf dem Kopf.
  const yaw = Math.atan2(plan.fx, plan.fz);
  const spiegel = (plan.fz * plan.tx - plan.fx * plan.tz) < 0;
  const t = wegweiserTextur(plan.text, cfg, PFEIL_SPITZE, spiegel);
  const geo = pfeilGeometrie(t.breite, t.hoehe, PFEIL_SPITZE, spiegel);

  const vorne = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: t.texture, roughness: 0.9, metalness: 0, side: THREE.FrontSide,
  }));
  const hinten = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xf2f2f2, roughness: 0.9, metalness: 0, side: THREE.BackSide,
  }));
  for (const [mesh, ab] of [[vorne, 1], [hinten, -1]]) {
    mesh.position.set(plan.x + plan.fx * pr * 1.2 * ab, cy, plan.z + plan.fz * pr * 1.2 * ab);
    mesh.rotation.set(0, yaw, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    gruppe.add(mesh);
  }
  return gruppe;
}
