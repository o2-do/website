/**
 * geometry.js — Erzeugt die Geometrie eines Grasbüschels aus einer Konfiguration.
 * ------------------------------------------------------------------------------
 * Reine Mathematik, keine Abhängigkeit zu three.js oder zum DOM. Rückgabe sind
 * flache Typed Arrays, die sich direkt in eine BufferGeometry (oder jede andere
 * Engine) füllen lassen — damit ist die Datei ebenfalls im Gartensimulator nutzbar.
 *
 *   PflanzenGeometry.buildTuft(config) -> { positions, normals, uvs, colors, indices, stats }
 *
 * Koordinatensystem: Y = oben, Einheiten = mm, Büschelzentrum bei (0,0,0).
 *
 * --- Aufbau eines Halms -------------------------------------------------------
 * Ein Halm besteht aus einer Mittelrippe (dem "Knick") und zwei Hauptsegmenten,
 * die links und rechts davon um $winkel_haupt nach außen abgeknickt sind. Vom
 * Büschelzentrum aus blickt man auf die Kante, an der beide zusammenstoßen.
 * Alle Punkte der Mittelrippe liegen übereinander.
 *
 * Der Halm wird über ein mitwanderndes Dreibein (T = Tangente der Mittelrippe,
 * W = Breitenachse tangential zum Büschel, N = T × W = Außennormale) aufgebaut.
 * Weil die Kippung ($winkel_unten, $winkel_versatz) ausschließlich um W erfolgt,
 * bleibt W konstant und N dreht sich korrekt mit — dadurch stimmen die Eckpunkte
 * auch dann, wenn Abknickung und zunehmende Kippung zusammenkommen.
 *
 * --- Kolben -------------------------------------------------------------------
 * Ein Teil der Halme kann oben einen Kolben tragen: ein Sechskant-Rohr mit je
 * einer Spitze oben und unten. Seine Achse ist die Richtung des letzten
 * Halmsegmentes — er kippt also mit seinem Halm mit — und er überlappt die
 * Halmspitze um KOLBEN_UEBERLAPPUNG, damit zwischen beiden kein Spalt klafft.
 *
 * --- Breitenkurve -------------------------------------------------------------
 * Die Breite folgt nicht der Geraden zwischen unten/Mitte/oben, sondern einem
 * Kreisabschnitt über der Sehne unten→oben: die Sehne ist die lineare
 * Interpolation von $breite_unten nach $breite_oben, darauf addiert sich eine
 * elliptische Ausbauchung, die an der Stelle $hoehe_mitte exakt $breite_mitte
 * erreicht und dort waagerechte Tangente hat. An Fuß und Spitze läuft sie mit
 * senkrechter Tangente in die Sehne — genau die Form eines Kreisabschnitts.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PflanzenGeometry = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEG = Math.PI / 180;
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 137.5° — gleichmäßige Punktverteilung

  var KOLBEN_UEBERLAPPUNG = 10;   // mm, um die der Kolben über die Halmspitze rutscht
  var KOLBEN_SPITZENWINKEL = 60;  // ° voller Öffnungswinkel der Spitzen oben und unten
  var KOLBEN_TRIS = 24;           // 6 Seitenflächen à 2 + 6 + 6 Dreiecke der Spitzen
  var KOLBEN_VERTS = KOLBEN_TRIS * 3;   // jedes Dreieck mit eigenen Ecken -> harte Kanten

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** sRGB 0..1 -> linear 0..1 (der Renderer arbeitet linear und gibt sRGB aus) */
  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function hexToLinearRgb(hex) {
    var h = String(hex || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '000000';
    return [
      srgbToLinear(parseInt(h.slice(0, 2), 16) / 255),
      srgbToLinear(parseInt(h.slice(2, 4), 16) / 255),
      srgbToLinear(parseInt(h.slice(4, 6), 16) / 255)
    ];
  }

  /**
   * Breitenfunktion des Halms.
   * @returns {(t:number)=>number} halbe Halmbreite (= Breite EINES Hauptsegmentes)
   *          für t = Laufweg entlang der Mittelrippe / hoehe_oben, t ∈ [0,1]
   */
  function makeWidthFn(cfg) {
    var H = cfg.hoehe_oben;
    var wu = cfg.breite_unten;
    var wm = cfg.breite_mitte;
    var wo = cfg.breite_oben;

    if (H <= 0) return function () { return 0; };

    // Lage der breitesten Stelle, von den Rändern weggehalten (sonst Division durch 0)
    var tm = clamp(cfg.hoehe_mitte / H, 0.001, 0.999);

    var chordAtTm = wu + (wo - wu) * tm;
    var bulge = wm - chordAtTm;          // Höhe des Kreisabschnitts über der Sehne

    return function (t) {
      t = clamp(t, 0, 1);
      var chord = wu + (wo - wu) * t;
      var x = t <= tm ? (tm - t) / tm : (t - tm) / (1 - tm);
      var f = Math.sqrt(Math.max(0, 1 - x * x));   // Viertelellipse, links und rechts von tm
      return Math.max(0, chord + bulge * f);
    };
  }

  /**
   * Verschiebt den Farbverlauf nach oben.
   * @param {number} startPercent  0 = Verlauf über den ganzen Halm,
   *        50 = untere Hälfte durchgehend "Farbe unten", darüber der Verlauf.
   * @returns {(g:number)=>number} Mischanteil "Farbe oben" für die Laufweite g ∈ [0,1].
   *          An der Spitze (g = 1) wird immer 1 erreicht, also "Farbe oben".
   */
  function makeRampFn(startPercent) {
    var s = clamp((startPercent || 0) / 100, 0, 1);
    if (s <= 0) return function (g) { return g; };
    if (s >= 1) return function (g) { return g >= 1 ? 1 : 0; };
    return function (g) { return g <= s ? 0 : (g - s) / (1 - s); };
  }

  /**
   * Baut das komplette Büschel.
   * @param {object} cfg   validierte Konfiguration (siehe loader.js)
   * @param {object} [opts]
   * @param {number} [opts.wurzeltiefe=0]  Maß in mm, um das die Stiele unter die
   *        Grundfläche weiterlaufen. Sie laufen dabei auf einen gemeinsamen Punkt
   *        (0, -wurzeltiefe, 0) zusammen — der Büschel bekommt also einen echten
   *        Wurzelpunkt statt lauter einzelner Stummel. Der Teil über dem Boden
   *        bleibt unverändert, ebenso Farbverlauf und Textur.
   *        Wird für geneigtes Gelände gebraucht (siehe gartenloader.js).
   */
  function buildTuft(cfg, opts) {
    var sink = Math.max(0, (opts && opts.wurzeltiefe) || 0);
    var nSeg = Math.max(0, Math.round(cfg.anzahl_segmente));
    var nBlades = Math.max(0, Math.round(cfg.anzahl));
    var H = Math.max(0, cfg.hoehe_oben);
    var stalk = Math.max(0, cfg.hoehe_stil);
    var R = Math.max(0, cfg.grundflaeche_radius);

    var alpha = cfg.winkel_haupt * DEG;
    var ca = Math.cos(alpha);
    var sa = Math.sin(alpha);
    var tiltBase = cfg.winkel_unten * DEG;
    var tiltStep = cfg.winkel_versatz * DEG;

    var widthAt = makeWidthFn(cfg);
    var colLo = hexToLinearRgb(cfg.farbe_unten);
    var colHi = hexToLinearRgb(cfg.farbe_oben);
    var rampAt = makeRampFn(cfg.farbverlauf_start);

    var hasLeaf = nSeg > 0 && H > 0;
    var hasStalk = stalk > 0;
    var hasRoot = sink > 0;
    var segCount = (hasRoot ? 1 : 0) + (hasStalk ? 1 : 0) + (hasLeaf ? nSeg : 0);

    if (nBlades === 0 || segCount === 0) return emptyResult();

    var nodeCount = segCount + 1;
    var vertsPerBlade = nodeCount * 4;              // je Knoten: außenL, mitteL, mitteR, außenR
    var trisPerBlade = segCount * 4;                // je Segment: 2 Vierecke à 2 Dreiecke

    // --- Kolben: wie viele, und passen sie überhaupt?
    var kolbenR = Math.max(0, cfg.kolben_durchmesser || 0) / 2;
    var kolbenL = Math.max(0, cfg.kolben_laenge || 0);
    var kolbenPct = clamp(cfg.kolben_anteil || 0, 0, 100) / 100;
    var nKolben = (kolbenR > 0 && kolbenL > 0) ? Math.round(nBlades * kolbenPct) : 0;

    var blattIndices = nBlades * trisPerBlade * 3;
    var vTotal = nBlades * vertsPerBlade + nKolben * KOLBEN_VERTS;
    var iTotal = blattIndices + nKolben * KOLBEN_TRIS * 3;

    var positions = new Float32Array(vTotal * 3);
    var normals = new Float32Array(vTotal * 3);
    var uvs = new Float32Array(vTotal * 2);
    var colors = new Float32Array(vTotal * 3);
    var indices = (vTotal > 65535) ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

    // Wiederverwendete Puffer je Halm
    var segLen = new Float64Array(segCount);
    var dirs = new Float64Array(segCount * 3);
    var nodeW = new Float64Array(nodeCount);
    var nodeT = new Float64Array(nodeCount * 3);
    var cum = new Float64Array(nodeCount);

    var vi = 0;   // Vertexzähler
    var ii = 0;   // Indexzähler
    var maxHeight = 0;
    var minHeight = 0;
    var maxRadius = 0;
    var kolbenTips = [];   // Spitzenpunkte der Halme, die einen Kolben tragen

    for (var b = 0; b < nBlades; b++) {
      // --- Standort auf der Grundfläche: Sonnenblumen-/Fibonacci-Spirale.
      //     r ∝ √(i) sorgt für flächengleiche Ringe, der goldene Winkel für
      //     gleichmäßige Abstände ohne sichtbare Reihen.
      var frac = nBlades > 1 ? (b + 0.5) / nBlades : 0;
      var r = R * Math.sqrt(frac);
      var theta = b * GOLDEN_ANGLE;
      var cth = Math.cos(theta), sth = Math.sin(theta);

      // u = radial nach außen, w = tangential (Breitenachse), up = (0,1,0)
      var ux = cth, uz = sth;
      var wx = -sth, wz = cth;

      // Neigung des untersten Segmentes: außen voll, im Zentrum senkrecht
      var tilt0 = tiltBase * (R > 0 ? (r / R) : 0);

      // --- Segmentlängen und -richtungen
      var s = 0;
      if (hasRoot) {
        // Wurzelsegment: läuft vom gemeinsamen Punkt (0, -sink, 0) unter der
        // Grundfläche schräg nach außen bis zum Austrittspunkt an der Oberfläche.
        // Alle Halme treffen sich damit in einem Zentrum — auf geneigtem Gelände
        // steht der Büschel dadurch nirgends in der Luft.
        segLen[s] = Math.hypot(r, sink);
        setDir(dirs, s, Math.atan2(r, sink), ux, uz);
        s++;
      }
      if (hasStalk) {
        segLen[s] = stalk;
        setDir(dirs, s, tilt0, ux, uz);
        s++;
      }
      if (hasLeaf) {
        var L = H / nSeg;
        for (var i = 0; i < nSeg; i++) {
          segLen[s] = L;
          setDir(dirs, s, tilt0 + i * tiltStep, ux, uz);
          s++;
        }
      }

      // --- Knotenbreiten (halbe Halmbreite = Breite eines Hauptsegmentes)
      var k = 0;
      if (hasRoot) nodeW[k++] = widthAt(0);           // Wurzelpunkt: rechteckig
      if (hasStalk) nodeW[k++] = widthAt(0);          // Fuß des Stiels: rechteckig
      if (hasLeaf) {
        for (var j = 0; j <= nSeg; j++) nodeW[k++] = widthAt(j / nSeg);
      } else {
        nodeW[k++] = widthAt(0);                      // ohne Blatt: oben wie unten
      }

      // --- Knotentangenten (an Knicken gemittelt, damit die Breite sauber anliegt)
      for (k = 0; k < nodeCount; k++) {
        var a = k - 1, c = k;
        if (a < 0) a = 0;
        if (c > segCount - 1) c = segCount - 1;
        var tx = dirs[a * 3] + dirs[c * 3];
        var ty = dirs[a * 3 + 1] + dirs[c * 3 + 1];
        var tz = dirs[a * 3 + 2] + dirs[c * 3 + 2];
        var tl = Math.hypot(tx, ty, tz);
        if (tl < 1e-9) { tx = dirs[c * 3]; ty = dirs[c * 3 + 1]; tz = dirs[c * 3 + 2]; tl = 1; }
        nodeT[k * 3] = tx / tl;
        nodeT[k * 3 + 1] = ty / tl;
        nodeT[k * 3 + 2] = tz / tl;
      }

      // --- Laufweg je Knoten (für Farbverlauf und Textur-V). Gemessen ab der
      //     Oberfläche, damit die Wurzel den sichtbaren Verlauf nicht verschiebt.
      cum[0] = 0;
      for (k = 0; k < segCount; k++) cum[k + 1] = cum[k] + segLen[k];
      var gOff = hasRoot ? cum[1] : 0;
      var total = (cum[segCount] - gOff) || 1;

      // --- Knotenpunkte setzen. Mit Wurzel startet der Halm im gemeinsamen
      //     Zentrum unter der Grundfläche, ohne Wurzel am Austrittspunkt.
      var px = hasRoot ? 0 : r * cth;
      var py = hasRoot ? -sink : 0;
      var pz = hasRoot ? 0 : r * sth;
      var baseVert = vi;

      for (k = 0; k < nodeCount; k++) {
        if (k > 0) {
          var d = (k - 1) * 3;
          px += dirs[d] * segLen[k - 1];
          py += dirs[d + 1] * segLen[k - 1];
          pz += dirs[d + 2] * segLen[k - 1];
        }

        // Außennormale N = T × W  (zeigt bei senkrechtem Halm nach radial außen)
        var Tx = nodeT[k * 3], Ty = nodeT[k * 3 + 1], Tz = nodeT[k * 3 + 2];
        var nx = Ty * wz;
        var ny = Tz * wx - Tx * wz;
        var nz = -Ty * wx;
        var nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;

        var hw = nodeW[k];
        // Versatz zur Außenkante = Breitenanteil entlang W (spiegelt sich links/rechts)
        //                        + Knickanteil entlang N (zeigt auf BEIDEN Seiten nach außen)
        var bx = wx * hw * ca, bz = wz * hw * ca;
        var fx = nx * hw * sa, fy = ny * hw * sa, fz = nz * hw * sa;

        var lx = px - bx + fx, ly = py + fy, lz = pz - bz + fz;
        var rx = px + bx + fx, ry = py + fy, rz = pz + bz + fz;

        var g = clamp((cum[k] - gOff) / total, 0, 1);
        var f = rampAt(g);                      // Farbverlauf, ggf. nach oben verschoben
        var cr = colLo[0] + (colHi[0] - colLo[0]) * f;
        var cg = colLo[1] + (colHi[1] - colLo[1]) * f;
        var cb = colLo[2] + (colHi[2] - colLo[2]) * f;

        // Reihenfolge je Knoten: 0 = außen links, 1 = Mitte links,
        //                        2 = Mitte rechts, 3 = außen rechts.
        // Die Mitte ist doppelt vorhanden, damit der Knick eine echte Kante bleibt.
        //
        // Textur-U: an der Mittelrippe 0, an beiden Außenkanten 1 — die Textur
        // liegt also auf beiden Hauptsegmenten und ist an der senkrechten
        // Mittellinie gespiegelt. (Für ein durchgehendes Mapping über den ganzen
        // Halm stattdessen 0.0 / 0.5 / 0.5 / 1.0 eintragen.)
        putVertex(vi + 0, lx, ly, lz, 1.0, g, cr, cg, cb);
        putVertex(vi + 1, px, py, pz, 0.0, g, cr, cg, cb);
        putVertex(vi + 2, px, py, pz, 0.0, g, cr, cg, cb);
        putVertex(vi + 3, rx, ry, rz, 1.0, g, cr, cg, cb);
        vi += 4;

        if (ly > maxHeight) maxHeight = ly;
        if (ry > maxHeight) maxHeight = ry;
        if (ly < minHeight) minHeight = ly;
        if (ry < minHeight) minHeight = ry;
        var radL = Math.hypot(lx, lz), radR = Math.hypot(rx, rz);
        if (radL > maxRadius) maxRadius = radL;
        if (radR > maxRadius) maxRadius = radR;
      }

      // --- Trägt dieser Halm einen Kolben?
      // Die Auswahl läuft ohne Zufall: der Bruch nKolben/nBlades wird über die
      // Halmnummern aufsummiert und immer dann ein Kolben gesetzt, wenn die
      // Summe eine ganze Zahl überschreitet. Das ergibt exakt nKolben Stück,
      // gleichmäßig über die Reihenfolge verteilt — und weil die Reihenfolge
      // der Fibonacci-Spirale folgt, auch gleichmäßig über die Grundfläche.
      if (nKolben > 0 &&
          Math.floor((b + 1) * nKolben / nBlades) > Math.floor(b * nKolben / nBlades)) {
        // px/py/pz stehen nach der Knotenschleife auf der Spitze der Mittelrippe.
        // Dazu die Richtung des letzten Segmentes und die Breitenachse W — der
        // Kolben kippt damit genauso wie das Halmende, an dem er sitzt.
        var ld = (segCount - 1) * 3;
        kolbenTips.push(px, py, pz, dirs[ld], dirs[ld + 1], dirs[ld + 2], wx, wz);
      }

      // --- Dreiecke
      for (k = 0; k < segCount; k++) {
        var v0 = baseVert + k * 4;
        var v1 = v0 + 4;
        // linkes Hauptsegment: Mitte(1) — außen(0)
        indices[ii++] = v0 + 1; indices[ii++] = v0 + 0; indices[ii++] = v1 + 0;
        indices[ii++] = v0 + 1; indices[ii++] = v1 + 0; indices[ii++] = v1 + 1;
        // rechtes Hauptsegment: Mitte(2) — außen(3)
        indices[ii++] = v0 + 2; indices[ii++] = v1 + 3; indices[ii++] = v0 + 3;
        indices[ii++] = v0 + 2; indices[ii++] = v1 + 2; indices[ii++] = v1 + 3;
      }
    }

    buildKolben();

    computeNormals(positions, indices, normals);

    // Die Kolben liegen im selben Puffer, bilden aber eine eigene Zeichengruppe.
    // Damit reicht EIN Mesh: wer will, hängt zwei Materialien daran (Blatt,
    // Kolben) — der Kolben bekommt dadurch die Halm-Textur nicht ab. Wer nur ein
    // einzelnes Material setzt, für den ignoriert three.js die Gruppen, und alles
    // bleibt wie vorher. Ohne Kolben entstehen gar keine Gruppen.
    var groups = nKolben > 0 ? [
      { start: 0, count: blattIndices, materialIndex: 0 },
      { start: blattIndices, count: nKolben * KOLBEN_TRIS * 3, materialIndex: 1 }
    ] : [];

    return {
      positions: positions,
      normals: normals,
      uvs: uvs,
      colors: colors,
      indices: indices,
      groups: groups,
      stats: {
        blades: nBlades,
        segmentsPerBlade: segCount,
        kolben: nKolben,
        vertices: vTotal,
        triangles: iTotal / 3,
        height: maxHeight,
        minY: minHeight,
        radius: maxRadius
      }
    };

    // ---- lokale Helfer (schließen über die Puffer) ----

    function putVertex(idx, x, y, z, u, v, cr, cg, cb) {
      var p3 = idx * 3, p2 = idx * 2;
      positions[p3] = x; positions[p3 + 1] = y; positions[p3 + 2] = z;
      uvs[p2] = u; uvs[p2 + 1] = v;
      colors[p3] = cr; colors[p3 + 1] = cg; colors[p3 + 2] = cb;
    }

    /**
     * Ein Dreieck mit drei eigenen Ecken. Weil nichts geteilt wird, mittelt
     * computeNormals nichts weg — der Sechskant behält seine harten Kanten.
     *
     * Die UV liegt auf (0.5, 0.5) statt auf (0,0): sollte doch einmal die
     * Halm-Textur auf dem Kolben landen (nur ein Material statt zwei), trifft
     * er damit die Bildmitte und nicht den Rand, der bei freigestellten PNGs
     * durchsichtig ist und ihn per alphaTest verschwinden ließe.
     */
    function putTri(ax, ay, az, bx, by, bz, cx, cy, cz, cr, cg, cb) {
      putVertex(vi, ax, ay, az, 0.5, 0.5, cr, cg, cb);
      putVertex(vi + 1, bx, by, bz, 0.5, 0.5, cr, cg, cb);
      putVertex(vi + 2, cx, cy, cz, 0.5, 0.5, cr, cg, cb);
      indices[ii++] = vi; indices[ii++] = vi + 1; indices[ii++] = vi + 2;
      vi += 3;

      // Hülle mitziehen — der gekippte Kolben ragt sonst aus stats.height/radius
      bounds(ax, ay, az); bounds(bx, by, bz); bounds(cx, cy, cz);
    }

    function bounds(x, y, z) {
      if (y > maxHeight) maxHeight = y;
      if (y < minHeight) minHeight = y;
      var r = Math.hypot(x, z);
      if (r > maxRadius) maxRadius = r;
    }

    /**
     * Sechskant-Rohr mit Spitze oben und unten, an jeder gemerkten
     * Halmspitze eines.
     *
     * $kolben_durchmesser ist der Durchmesser über die Ecken (Umkreis), und
     * $kolben_laenge die Gesamtlänge EINSCHLIESSLICH beider Spitzen. Bei
     * KOLBEN_SPITZENWINKEL = 60° voller Öffnungswinkel ist eine Spitze
     * R / tan(30°) = R·√3 hoch, also gut 0,87 × Durchmesser. Ist der Kolben zu
     * kurz, als dass beide Spitzen daneben noch Platz hätten, wird die
     * Spitzenhöhe auf die halbe Länge gedeckelt: dann treffen sich die Spitzen
     * in der Mitte und der Winkel wird spitzer. Die eingestellte Länge stimmt
     * so in jedem Fall — sie ist das Maß, das man am Ergebnis sieht.
     */
    function buildKolben() {
      if (!kolbenTips.length) return;

      var col = hexToLinearRgb(cfg.kolben_farbe);
      var cr = col[0], cg = col[1], cb = col[2];

      var tipH = Math.min(kolbenR / Math.tan(KOLBEN_SPITZENWINKEL / 2 * DEG), kolbenL / 2);
      var shaft = Math.max(0, kolbenL - 2 * tipH);

      // Sechseck-Ecken, für alle Kolben dieselben — nur verschoben.
      var Uy0 = 0;   // die Breitenachse W liegt immer waagerecht
      var ex = [], ez = [];
      for (var e = 0; e < 6; e++) {
        ex.push(Math.cos(e * 60 * DEG) * kolbenR);
        ez.push(Math.sin(e * 60 * DEG) * kolbenR);
      }

      var P = [0, 0, 0], Q = [0, 0, 0], A = [0, 0, 0], B = [0, 0, 0];
      var C = [0, 0, 0], D = [0, 0, 0];

      for (var t = 0; t < kolbenTips.length; t += 8) {
        // Dreibein des Kolbens: T = Achse (Richtung des letzten Halmsegmentes),
        // U = Breitenachse des Halms, V = T × U.
        var Tx = kolbenTips[t + 3], Ty = kolbenTips[t + 4], Tz = kolbenTips[t + 5];
        var Ux = kolbenTips[t + 6], Uz = kolbenTips[t + 7];
        // V = U × T (nicht T × U): das Dreibein muss dieselbe Händigkeit haben
        // wie früher das feste (X, Z, Y), sonst dreht sich der Umlauf um und
        // alle Normalen zeigen nach innen.
        var Vx = -Ty * Uz, Vy = Tx * Uz - Tz * Ux, Vz = Ty * Ux;

        // Fußpunkt: um die Überschneidung ENTGEGEN der Achse hinter die Spitze
        var bx0 = kolbenTips[t] - Tx * KOLBEN_UEBERLAPPUNG;
        var by0 = kolbenTips[t + 1] - Ty * KOLBEN_UEBERLAPPUNG;
        var bz0 = kolbenTips[t + 2] - Tz * KOLBEN_UEBERLAPPUNG;

        /** Punkt im Kolben: a mm entlang der Achse, dazu der Sechskant-Versatz e. */
        function at(out, a, e) {
          var s1 = e < 0 ? 0 : ex[e], s2 = e < 0 ? 0 : ez[e];
          out[0] = bx0 + Tx * a + Ux * s1 + Vx * s2;
          out[1] = by0 + Ty * a + Uy0 * s1 + Vy * s2;
          out[2] = bz0 + Tz * a + Uz * s1 + Vz * s2;
          return out;
        }

        at(P, 0, -1);                       // untere Spitze
        at(Q, kolbenL, -1);                 // obere Spitze

        for (var i = 0; i < 6; i++) {
          var j = (i + 1) % 6;
          at(A, tipH, i); at(B, tipH, j);              // Ring unten
          at(C, tipH + shaft, i); at(D, tipH + shaft, j);  // Ring oben

          // Mantel: zwei Dreiecke je Sechskantfläche, Umlauf so gewählt, dass
          // die Normale nach außen zeigt (Vorderseite außen).
          putTri(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2], cr, cg, cb);
          putTri(A[0], A[1], A[2], D[0], D[1], D[2], B[0], B[1], B[2], cr, cg, cb);

          // Spitze unten (Apex, dann im Uhrzeigersinn) und oben (andersherum)
          putTri(P[0], P[1], P[2], A[0], A[1], A[2], B[0], B[1], B[2], cr, cg, cb);
          putTri(Q[0], Q[1], Q[2], D[0], D[1], D[2], C[0], C[1], C[2], cr, cg, cb);
        }
      }
    }
  }

  /** Richtung eines Segmentes: um W gekippte Senkrechte, phi = Winkel zur Vertikalen */
  function setDir(dirs, s, phi, ux, uz) {
    var sp = Math.sin(phi), cp = Math.cos(phi);
    dirs[s * 3] = sp * ux;
    dirs[s * 3 + 1] = cp;
    dirs[s * 3 + 2] = sp * uz;
  }

  /**
   * Flächennormalen auf die Ecken addieren. Weil die Mittelrippe doppelt
   * vorhanden ist, mitteln sich links und rechts nicht — der Knick bleibt scharf.
   */
  function computeNormals(positions, indices, normals) {
    for (var i = 0; i < indices.length; i += 3) {
      var a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      var e1x = positions[b] - positions[a];
      var e1y = positions[b + 1] - positions[a + 1];
      var e1z = positions[b + 2] - positions[a + 2];
      var e2x = positions[c] - positions[a];
      var e2y = positions[c + 1] - positions[a + 1];
      var e2z = positions[c + 2] - positions[a + 2];
      var nx = e1y * e2z - e1z * e2y;
      var ny = e1z * e2x - e1x * e2z;
      var nz = e1x * e2y - e1y * e2x;
      normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
      normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
      normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
    }
    for (var v = 0; v < normals.length; v += 3) {
      var l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]);
      if (l > 1e-12) { normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l; }
      else { normals[v + 1] = 1; }
    }
  }

  function emptyResult() {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint16Array(0),
      groups: [],
      stats: { blades: 0, segmentsPerBlade: 0, kolben: 0, vertices: 0, triangles: 0, height: 0, minY: 0, radius: 0 }
    };
  }

  /**
   * Breitester Durchmesser der Pflanze in der Aufsicht (mm).
   *
   * Gemeint ist der Kreis, den die Pflanze von oben gesehen abdeckt — also
   * inklusive der nach außen gekippten Blattspitzen, nicht nur die Grundfläche,
   * auf der die Halme austreten. Für die Schattenkarte des Gartens ist genau
   * dieses Maß gefragt, deshalb wird es beim Export mitgeschrieben.
   *
   * Der Wert kommt aus der fertigen Geometrie (stats.radius) statt aus einer
   * Näherungsformel — sonst müsste die gesamte Kipp- und Breitenrechnung ein
   * zweites Mal nachgebildet werden und könnte auseinanderlaufen.
   */
  function durchmesser(cfg) {
    return buildTuft(cfg).stats.radius * 2;
  }

  return {
    buildTuft: buildTuft,
    durchmesser: durchmesser,
    makeWidthFn: makeWidthFn,
    makeRampFn: makeRampFn,
    hexToLinearRgb: hexToLinearRgb,
    GOLDEN_ANGLE: GOLDEN_ANGLE
  };
}));
