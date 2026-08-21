# Landschaftssimulator — Übergabe

Stand: 2026-08-19 (12). Was ein neuer Thread wissen muss. Die Schnittstelle zum
Pflanzengenerator beschreibt `plantloader/README.md`.

---

## Start

```bash
python3 dev-server.py
```
→ `http://localhost:8123/` (oder `PORT=…` bzw. `python3 dev-server.py 9000`)

`dev-server.py` ist `python -m http.server` plus `Cache-Control: no-store`. Der
Header ist kein Luxus: `http.server` schickt gar keine Cache-Vorgaben, also rät
der Browser und behält Dateien — nach einer Änderung lief der Garten mit einer
alten Fassung weiter und meldete Methoden als „is not a function".

**Nicht über `file://` öffnen** — ES-Module und Texturen werden von der
CORS-Policy blockiert. three.js liegt lokal unter `vendor/three.module.js`
(r169) und Bootstrap 5.3.3 unter `vendor/bootstrap.min.css` — beides lokal,
damit es offline läuft. Von Bootstrap wird nur das CSS gebraucht; `game.html`
kommt ohne dessen JavaScript aus.

Debug-Handle in der Konsole: `__sim.garden`, `__sim.walker`, `__sim.viewer`,
`__sim.rebuild()`.

---

## Aufbau

| Datei | Inhalt |
|---|---|
| `js/config.js` | Parameter-Schema. Das Formular wird daraus generiert; ein neuer Parameter braucht nur hier einen Eintrag. `live: true` heißt: wirkt sofort ohne Neuaufbau. |
| `js/rng.js` | Seedbare Zufallszahlen, ein eigener Stream pro Gewerk |
| `js/noise.js` | Perlin 2D (Gelände), Value 3D (Felsbrocken) |
| `js/frisch.js` | Zeitstempel an jede zur Laufzeit geladene Adresse (siehe unten) |
| `js/terrain.js` | `createHeightField`, `withPathCorridor` (Wegplanie), Bodengitter, Horizontscheibe, Kartenmaske, Kartenkasten |
| `js/paths.js` | Wegfindung über Attraktoren, Bandgeometrie, 45°-Ausgleichswall, räumlicher Weg-Index |
| `js/occupancy.js` | Belegungsraster für Objekt-gegen-Objekt |
| `js/trees.js` | Baumplätze am Weg (nur die Standorte) |
| `js/baumloader.js` | Brücke zum Baumgenerator: Baupläne bauen und cachen, Wald/Werfer/Tafeln als InstancedMesh, Bestandsliste, Sonnenstand |
| `js/baumbestand.js` | Der Baumbestand eines Gartens: Plätze besetzen, Tönung, nah/fern, Schattenart |
| `js/bodenkarte.js` | Eingebrannte Schatten: Leinwand über dem Garten, in die Bodenmaterialien gehängt |
| `js/sektoren.js` | Grobes Quadratraster; Gras, Pflanzen, Felsen und Beetböden zerfallen danach in eigene Netze |
| `js/zaun.js` | Zaun auf der Gartenkante, Ecken unter 45° gekappt |
| `js/plants.js` | Brücke zum Pflanzen-Konfigurator: Modelle, Beetvorlagen, Beete setzen |
| `js/rocks.js`, `js/signs.js`, `js/grass.js` | die übrigen Gewerke |
| `js/textures.js` | Bildtexturen laden und über Neuaufbauten hinweg halten |
| `js/translucency.js` | Gegenlicht-Trick für Blätter und Pflanzen (Shadereingriff) |
| `js/mapmarks.js` | Standpunkt und Namensschilder für die Karte |
| `js/garden.js` | Orchestrierung: `buildGarden(cfg, tex)` → `THREE.Group`, `disposeGarden` |
| `js/walker.js` | Fortbewegung, Kamera |
| `js/scene.js` | Renderer, Licht, Himmel, Nebel, Waldhorizont, Karten-/Augenansicht |
| `js/main.js` | Konfigurator: Formular, Rebuild, Maus/Tastatur, Einstellungen speichern/laden |
| `js/game.js` | Spieleinstieg (`game.html`): baut aus `json/garten.json`, Steuerkreuz, Kartenknopf |
| `baumloader/` | Baumgenerator (fremd, **ES-Modul** — wird importiert, nicht global) |
| `plantloader/` | Pflanzen-Konfigurator (fremd, klassische Dateien → `window.Pflanze`) |
| `json/` | Bestandsliste, Baumdateien, Pflanzendateien, Beetvorlagen, `garten.json` für `game.html` |

**Fremde Loader einbinden.** Der Baumgenerator (`baumloader/baum-import.js`)
ist ein ES-Modul und braucht in `index.html` nichts — `js/baumloader.js`
importiert ihn. Der Pflanzen-Konfigurator ist noch eine klassische Datei, die
`window.THREE` erwartet und sich an ein Global hängt:

```html
<script type="module">import * as THREE from 'three'; window.THREE = THREE;</script>
<script defer src="plantloader/loader.js"></script>
<script defer src="plantloader/geometry.js"></script>
<script defer src="plantloader/gartenloader.js"></script>
<script type="module" src="js/main.js"></script>
```

Aufgeschobene klassische Dateien und Module laufen in **Dokumentreihenfolge** —
damit steht `THREE` sicher vor den Loadern und die Loader vor `main.js`.
Denselben Weg geht `frisch.js`: es legt sich zusätzlich global aus, damit der
Pflanzen-Konfigurator ihn benutzen kann.

---

## Kennzahlen

Voreinstellungen, nachgemessen (Apple M3, 1280 × 820 bei dpr 2):
**Neuaufbau 402 ms**, 223 Meshes, **180 k gezeichnete Dreiecke** aus 735 k
vorhandenen, **41 Zeichenaufrufe**, 60 fps. Zusammensetzung: ein geschlungener
Rundweg mit 2 Abkürzungen (455 m), 101 Felsbrocken, 12 Bäume (1 benannt) mit
zusammen 259 Blattbildern, 1 Schild, 24 Beete mit 240 Pflanzen in 3 Arten,
122 095 Grashalme.

Zwei Umbauten stecken in dem Sprung von den ursprünglich 1,41 Mio. Dreiecken:
der Baumwechsel (10 199 Einzelblätter → 259 Blattrechtecke) brachte 908 k, die
Sektoren (Entscheidung 12) davon noch einmal drei Viertel weg.

| | Dreiecke je Baum | Zeichenaufrufe je Sorte |
|---|---|---|
| `baum.json` | 1 076 Holz + 40 Laub | 2 (+1 Werfer, +1 Tafeln) |
| `baum_gross.json` | 2 488 Holz + 80 Laub | 2 (+1 Werfer, +1 Tafeln) |

CPU-Zeit für einen `render()`-Aufruf, ohne Vsync gemessen: **0,09 ms** für die
ganze Szene, 0,07 ms ohne Gras und Pflanzen. Der Sichtvolumen-Test kostet
**0,0033 ms je Bild** für alle 41 Objekte (0,08 µs je Objekt). Beides ist gegen
16,7 ms Bildbudget nichts — wer hier optimiert, optimiert am falschen Ende.

---

## Die tragenden Entscheidungen

1. **Eine einzige Höhenfunktion `hf.heightAt(x,z)`** ist die Wahrheit für Boden,
   Weg, Fels, Baum, Schild, Gras, Pflanze **und Kamera**. Nie aus dem Mesh
   zurücklesen. Wer sich daran hält, sitzt automatisch richtig im Gelände.

2. **Zwei Stufen beim Höhenfeld.** Die Wege brauchen ein Höhenfeld, das
   Höhenfeld braucht die Wege (für die Planie). Deshalb:
   `createHeightField` → `buildPaths` → `makePathIndex` → `withPathCorridor`.
   Ab da arbeitet **alles** mit dem planierten Feld.

3. **Getrennte RNG-Streams pro Gewerk** (`stream(seed, 'rocks')`). Sonst
   verschiebt eine geänderte Halmzahl sämtliche Felsen.

4. **Zwei-Pass bei jedem InstancedMesh** — `count` muss beim Konstruktor
   feststehen: erst Platzierungsliste, dann Mesh.

5. **Erhebung und Senke sind zwei Einstellungen, nicht eine Spanne.** Die Null
   ist keine willkürliche Mitte: auf ihr liegt der Rand des Gartens, dort
   schließt die Horizontscheibe an, und dort steht der Zaun. `maxHoehe` und
   `maxTiefe` (beide in cm) strecken die obere und die untere Hälfte des
   Rauschens getrennt — der höchste Punkt der Wiese liegt danach genau
   `maxHoehe` über und der tiefste genau `maxTiefe` unter Null. Bei gleichen
   Werten kommt dasselbe heraus wie mit einer gemeinsamen Spanne; erst
   getrennt lässt sich eine hügelige Wiese ohne Mulden bestellen. `hf.amplitude`
   bleibt der Gesamthub — daran hängt, wie tief der Kartenkasten unter den
   Garten reichen muss.

6. **Quadratgitter mit radialem Falloff** statt Polargitter. Der Falloff drückt
   den kompletten Rand inklusive Ecken auf exakt y = 0, deshalb kann der
   Horizont eine runde Scheibe mit quadratischem Loch sein — überlappungsfrei,
   kein Z-Fighting. Dasselbe macht die Kartenmaske möglich (siehe Ansichten).

7. **Gras hat eine Entfernungsgrenze, und sie wirkt je Sektor**
   (`grasWeite`, Vorgabe 40 m; `aktualisiereGrasSicht` in `grass.js`). Das
   Sichtvolumen allein sortiert nur nach Richtung aus: wer vom Rand quer durch
   den Garten schaut, hat jeden Sektor vor sich. Nachgemessen an genau dieser
   Stelle: **109 231 → 44 317 Halme**, 656 k → 462 k Dreiecke, 189 → 153
   Zeichenaufrufe.

   Gerechnet wird je Netz, nicht je Instanz — rund siebzig Abstandsvergleiche
   pro Bild, kein Instanzpuffer wird angefasst. Gemessen wird zur **nächsten**
   Ecke des Sektors (Mittelpunkt minus Hüllkugelradius): so verschwindet nie
   ein Halm, der näher als `grasWeite` steht. Der Preis ist, dass einzelne
   Halme bis rund 63 m überleben — ein 17-Meter-Sektor reicht eben weiter als
   sein nächster Punkt. Wer das enger will, verkleinert die Sektorweite. Ein
   4-Meter-Band verhindert das Flackern an der Grenze.

8. **Geschwindigkeitsprofil statt Per-Klick-Easing** (`walker.js`). Kalibriert:
   eine Aktion 1,50 s, jede angehängte +0,78 s ohne Zwischenbremsung.

   **Die Pfeiltasten sind das Lenkrad und verhalten sich anders als die
   Knöpfe.** Vor und Zurück hängen hinten an (`enqueue`), Links und Rechts
   gehen über `enqueueTurn` und folgen drei Regeln in dieser Reihenfolge:

   1. **Gegendrehungen löschen sich aus.** Wartet in der Schlange eine Drehung
      in die andere Richtung, verschwindet sie, und die neue wird gar nicht
      erst eingereiht; steckt sie in einer Kurve, bleibt das Geradeaus stehen.
      Wer sich vertippt, tippt zurück, statt einen Schlenker abwarten zu
      müssen.
   2. **Steht ein Geradeaus an, wird vorne eingefügt und verschmolzen** —
      `step` dreht und geht zugleich, der Schritt wird zur Kurve statt zu
      Ecke-und-Gerade. Wer drei Schritte eingereiht hat und abbiegen will,
      meint „an der nächsten Ecke", nicht „in drei Metern".
   3. **Sonst hinten anhängen.** Zweimal rechts sind dann sechzig Grad — ohne
      Geradeaus dazwischen ist das genau, was gemeint ist.

   Die **laufende** Aktion bleibt von allem unberührt: sie ist bereits zu
   einem Teil ausgeführt und ließe sich nicht mehr sauber zurücknehmen. Die
   Knöpfe bleiben beim schlichten Anhängen — dort zielt man auf ein Feld und
   meint genau das.

9. **Fremde Geometrie wird geteilt und überdauert den Garten.** Ein Baumskelett
   kostet einige hundert Millisekunden. `baumloader.js` und `plants.js` halten
   Modelle in einem Cache; die Meshes tragen `userData.geteilt = true`, und
   `disposeGarden` lässt genau die in Ruhe — ruft bei einem `InstancedMesh`
   aber `dispose()` auf, denn dessen Instanzpuffer gehören dem Garten. Ohne das
   kostet jeder Klick auf „neu erzeugen" wieder die volle Baumrechnerei.

10. **Der Garten hängt an der Dreieckszahl, nicht am Shader.** Nachgemessen bei
   17,9 Mio. Dreiecken: Standard 29,7 ms, Phong 30,8, Lambert 30,1, **Basic
   (gar keine Beleuchtung) 30,1** — alles im Rauschen. Dieselbe Szene mit
   12,4 Mio. → 23 ms, 10,4 Mio. → 18 ms. Wer Bildrate sucht, muss Dreiecke
   sparen, nicht Materialien vereinfachen.

11. **Die Laubfarbe kommt aus der Baumdatei, gewürfelt wird im Garten.**
    `laubtoene(cfg)` liefert sechs gleich wahrscheinliche Töne: den ungefärbten
    (1,1,1) und die fünf Varianten aus dem Baumkonfigurator. Gewürfelt wird in
    `baumbestand.js` mit dem Startwert des Gartens — eine Landschaft, die bei
    gleichem Startwert gleich aussehen soll, braucht ihren eigenen Zufall und
    nicht den des Generators. Die Regler „Blatthelligkeit“ und „Blattfarbe
    streut“ liegen darüber und geben jedem Baum noch eine Kleinigkeit mit,
    damit zwei derselben Variante nicht wie gestempelt nebeneinanderstehen; ein
    benannter Baum darf über `ton` in der Bestandsliste alles überstimmen.

    Die Werte dürfen **über eins** liegen (1,8 färbt kräftiger, als das Bild
    ist). Wer sie zählen will, darf deshalb nicht über `getHex()` gehen — das
    kappt bei eins. Kommt eine Variante doppelt vor, ist sie doppelt so
    wahrscheinlich; das ist gewollt und die einfachste Art zu gewichten. Steht
    eine Variante auf (1,1,1), verdoppelt sie damit den ungefärbten Anteil —
    von sechs Plätzen sind dann zwei ungefärbt und nur vier tragen Farbe.

    **Die Tafel ist EIN Bild, Holz und Laub zusammen.** `baueAnsicht` rendert
    beides in dieselbe orthografische Aufnahme — das Holz mit seinem
    Rindenmaterial, die Krone mit dem Billboard-Material —, danach gibt es
    keine Trennung mehr. Die Tönung je Instanz multipliziert deshalb die
    **ganze** Tafel, den Stamm eingeschlossen. Das ist eine bewusste
    Abwägung des Generators: ohne sie spränge die Farbe eines Baums beim
    Wechsel zwischen Netz und Tafel, und auf zwanzig Meter sieht niemand, dass
    der Stamm mitgefärbt ist. Wer den Stamm neutral haben will, bräuchte zwei
    Bilder oder einen Maskenkanal im Paket — also eine Änderung am Export, nicht
    am Garten.

    **Die Streuung verschiebt die Farbe nicht.** Sie hellt auf und ab, sonst
    nichts. Solange die Töne im Garten gerechnet wurden, drehte sie zusätzlich
    an der Wärme — rot hoch, blau herunter —, denn ohne das wären alle Bäume
    gleich gewesen. Seit die Varianten aus der Datei kommen, ist das falsch:
    bei 25 % Streuung verschob sie den Farbton um ein Sechstel und machte aus
    einem neutralen Baum einen warm-orangen. Neben einem wirklich roten Ton sah
    der Garten dadurch nach weit mehr Rot aus, als gewürfelt war. Nachgemessen
    über 530 Bäume: der rote Ton kommt auf 16,0 % — genau ein Sechstel.

12. **Ein Baum ist zwei Netze, und der ganze Bestand einer Sorte ist zwei
   Zeichenaufrufe.** Holz als Röhren, Laub als Rechtecke, die der Vertexshader
   zur Kamera dreht — zusammen gut tausend Dreiecke statt zig tausend
   Einzelblättern. Deshalb gibt es keine Detailstufen, keine Puschel und keine
   Stellvertreter mehr; der Baum wird gezeichnet, wie er ist. Das Einzige, was
   in der Ferne übernimmt, ist die **fertig gebackene Seitenansicht** aus der
   Baumdatei (Vorgabe: ab 25 m, nur in Augenhöhe).

13. **Schatten ist EIN Schalter mit drei Stufen** (`Ansicht → Schatten`):

    | | Bäume | Felsen | Pflanzen | Schilder | Gras |
    |---|---|---|---|---|---|
    | `aus` | – | – | – | – | – |
    | `simpel` | Riss aus der Baumdatei | Kreis | Kreis | – | – |
    | `detailliert` | Schattenkarte | Geometrie | Geometrie | Geometrie | nie |

    - **simpel** brennt alles beim Aufbau **einmal** in eine Leinwand über dem
      ganzen Garten (`bodenkarte.js`) und multipliziert sie in Wiese, Wege,
      Wälle, Gras und Beetböden hinein. Danach kostet der Schatten **nichts**:
      kein Durchgang je Bild, keine Lichtquelle. Der Preis ist, dass er flach
      auf dem Boden liegt — senkrechte Flächen bleiben unbeschattet.
    - **Die Karte ist voll ausgesteuert, die Wirkung wird erst beim Anwenden
      gedämpft.** Jeder Stempel geht bis Schwarz: der gerechnete Riss des
      Baumgenerators ebenso wie die Kreise für Pflanzen und Felsen. Wie viel
      davon zu sehen ist, entscheidet **eine Konstante**, `SCHATTEN_STAERKE`
      in `bodenkarte.js`, Vorgabe **0,30**. Der Umweg lohnt zweifach: „der
      dunklere gewinnt" vergleicht nur dann Vergleichbares, wenn alle Stempel
      denselben Maßstab haben, und die Stärke ist ein Uniform — sie lässt sich
      ändern, ohne eine Leinwand neu zu zeichnen
      (`__sim.garden.bodenkarte.setzeStaerke(0.5)`).
    - **detailliert** wirft echt. Bäume dabei nicht mit Krone und Geäst,
      sondern mit der unsichtbaren **Schattenkarte** aus ihrer Datei: eine
      Fläche quer zum Sonnenstrahl, in der Kronenmitte aufgehängt und **nicht
      mit dem Baum mitgedreht** — die Sonne dreht sich ja auch nicht mit. Zwei
      Dreiecke statt tausender.
    - Gerechnet wird die Schattenkarte der Szene **einmal und dann
      eingefroren** (`shadowMap.autoUpdate = false`). Sonne und Garten stehen
      fest, es gibt nichts nachzuführen. Der frühere Schalter „Schattenart" ist
      damit entfallen.
    - **Gras wirft nie** — 122 000 Halme gegen 480 Pflanzen.

14. **Die Sonnenrichtung ist nicht mehr frei.** Die drei Bilder im Baumpaket
    sind für Südost, 20° aus der Senkrechten gerechnet (`SONNE_AZIMUT`,
    `SONNE_NEIGUNG` in `baum-import.js`). `scene.js` holt sich die Richtung
    über `sonnenRichtung()`. Stünde die Sonne der Szene woanders, fiele der
    gebrannte Schatten in die eine und der geworfene in die andere Richtung.

15. **Räumlich aufgeteilt wird beim Aufbau, nicht je Bild** (`sektoren.js`).
    three sortiert je Objekt aus, nicht je Instanz: ein InstancedMesh mit
    90 000 Grashalmen über den ganzen Garten hat 62 m Hüllkugel und ist nie zu
    verwerfen. Deshalb entstehen Gras, Pflanzen, Felsen und Beetböden je Sektor
    eines groben Rasters als eigenes Netz — danach greift der vorhandene,
    kostenlose Sichtvolumen-Test von selbst, **ohne eine Zeile je Bild**.
    Nachgemessen, gleicher Standpunkt:

    | | Netze | Zeichenaufrufe | Dreiecke | Aufbau |
    |---|---|---|---|---|
    | ohne Sektoren | 42 | 29 | 735 124 | 369 ms |
    | 16 m Sektoren | 223 | 41 | **180 466** | 402 ms |

    Drei Viertel der Dreiecke fallen weg, der Test kostet dafür 0,0222 statt
    0,0033 ms je Bild. Der Regler „Sektorweite" stellt den Handel ein, 0
    schaltet ihn ab.

16. **Alles, was zur Laufzeit geladen wird, bekommt einen Zeitstempel**
    (`frisch(url)` → `?t=…`, ein Stempel je Sitzung, damit der Modellcache
    greift). Betroffen: Bestandsliste, Baum-, Pflanzen- und Beetdateien,
    Bildtexturen. Eingebettete `data:`-URLs lässt `frisch` in Ruhe. Die
    ES-Module selbst erreicht der Stempel **nicht** — deren `import`-Pfade
    stehen fest im Quelltext; dagegen hilft nur der `no-store`-Header des
    Servers.

---

## Wegführung: ein geschlungener Rundweg über Attraktoren

Raster aus `attraktoren`² Punkten → an jeder Ecke ein Dreieck von 1/3/6/10
Punkten entfernen → mischen und `attraktorenAnteil` % behalten →
Nearest-Neighbor + 2-opt → Ecken mit `wegGlaettung` verrunden → gleichmäßig
abtasten. 2-opt entfernt gerade die Selbstüberschneidungen: der Weg schlingt
sich, kreuzt sich aber nicht.

**Kreuzungen entstehen erst durch die Abkürzungen** — gerade Stichwege zwischen
Stellen, die räumlich nah, entlang des Weges aber weit auseinander liegen.
Bewertet wird der Gewinn (gesparte Weglänge je Meter Stichweg), dann greedy mit
räumlicher Sperre; `maxAbkuerzungen` deckelt.

Deshalb ist **nicht mehr jeder Weg geschlossen**; `path.closed` unterscheidet
sie, und Bandgeometrie, Weg-Index, `atArcLength` und das Belegungsraster müssen
das berücksichtigen. Abkürzungen haben eigene Textur und eigene Kachelung
(`path.kachel`).

Zwei Stolpersteine: die 2-opt-Verbesserung über die **Kantendifferenz** rechnen
(die naheliegende Fassung rechnet je Kandidat die ganze Tour neu — bei 396
Attraktoren undurchführbar), und die Enden einer Abkürzung auf das nächstliegende
Sample der Mittellinie ziehen, weil die Attraktoren nach der Verrundung nicht
mehr exakt auf dem Weg liegen.

---

## Wegplanie und Ausgleichswall

Der Weg ist **quer zur Laufrichtung waagerecht**: beide Randvertices des Bandes
bekommen die Höhe der Mittellinie. Damit die Wiese anschließt, zieht
`withPathCorridor` sie in einem Streifen von `wegBoeschung` (1,5 m) per
`smoothstep` an die Weghöhe heran.

An einer Kreuzung setzt die Planie die Höhe des *nächstliegenden* Weges an — das
Band des höheren schwebt dann über dem Boden. Das schließt der **Ausgleichswall**
(`buildPathWalls`): eine **45°-Böschung** von der Bandkante nach außen bis unter
das Gelände, beidseitig sichtbar, mit der Textur des Bandes, das sie trägt.

Beim Stichweg läuft der Wall als **ein einziger geschlossener Streifen** um das
ganze Band: rechte Seite vorwärts → Eckfächer → Stirnseite quer → Eckfächer →
linke Seite zurück. Längs- und Stirnwall sind dadurch dieselbe Fläche.

Gemessen bei 6 m Relief: alle 1858 Rippen exakt 45,0°, alle 20 438 Proben
entlang der Fußlinie mindestens 2,11 cm unter Grund, alle Normalen nach außen.
Fasenbreite bei den Defaults: Median 5 cm, Maximum 12 cm.

`WALL_AN_KREUZUNGEN_UNTERBRECHEN` in `paths.js` steht **auf `false`** — der Wall
läuft derzeit durch die Kreuzungen hindurch. Auf `true` endet er dort, wo die
Wegkante auf der Fläche eines anderen Weges liegt.

---

## Bäume, Pflanzen, Beete

**Maße:** beide Konfiguratoren liefern **Meter, y nach oben, Ursprung auf der
Grasnarbe**, und der Fuß läuft unter y = 0 weiter (Baum 10 cm, Pflanze
mindestens 10 cm). Der Garten skaliert nichts — er verschiebt nach
`(x, hf.heightAt(x,z), z)`, dreht frei um die Hochachse und streut die Größe
(Regler „Größenstreuung").

**Bestandsliste** `json/baeume.json`, im Formular austauschbar:

```json
{ "standard": ["baum.json"],
  "baeume":   [ { "name": "Herr Baumgärtner", "baum": "baum_gross.json" } ],
  "pflanzen": ["pflanze1.json", "pflanze2.json", "pflanze3.json"],
  "beete":    ["beet1.json", "…", "beet10.json"] }
```

- Jeder Eintrag unter `baeume` bekommt einen eigenen Baum **und ein Schild mit
  seinem Namen davor**. Optional `"ton": "#8fbf5a"` oder `"ton": [1.1,1.0,0.9]`
  — die Tönung seiner Blätter. Alle übrigen Baumplätze werden aus `standard`
  besetzt (mehrere Dateien erlaubt, je Platz zufällig gezogen) und bekommen ihre
  Tönung aus „Blatthelligkeit" und „Blattfarbe streut".
- **Je Sorte ein InstancedMesh-Paar**, nicht mehr je Baum eine Gruppe. Das war
  früher andersherum, weil ein Baum 20 000 Blattinstanzen hatte und eine
  gartenweite Hüllkugel deshalb 3,5 Mio. Dreiecke einreichte. Bei 40–80
  Blattrechtecken je Baum ist das kein Posten mehr, und zwei Zeichenaufrufe für
  den ganzen Bestand sind der bessere Handel.
- **Die Hüllkugel des Laubnetzes muss über die Instanzen gehen**
  (`laub.computeBoundingSphere()`), nicht die der Geometrie sein: die liegt im
  Baumkoordinatensystem, also um den Gartenursprung. Wer sie unbesehen
  übernimmt, lässt das Sichtvolumen jede Krone wegschneiden, die nicht zufällig
  in der Gartenmitte steht — und sieht zwölf kahle Gerüste (real passiert).
- **Nah und fern** (`baumbestand.js`): jenseits der Grenze wird der Baum zur
  Tafel, indem seine Instanz im Wald auf Größe 0 und die Tafelinstanz an ihren
  Platz geschrieben wird. Der Schatten hängt daran **nicht** — weder der Werfer
  noch der Stempel in der Bodenkarte wissen, wie der Baum gerade gezeichnet
  wird. Deshalb gibt es beim Überqueren der Grenze nichts neu zu zeichnen.
- `beete` sind die Vorlagen aus dem Beetkonfigurator. **Eine eigene
  Pflanzenliste gibt es nicht mehr**: welche Arten gebaut werden, sagen die
  Beete selbst.

### Beete, Fassung 2

Der Beetkonfigurator (`plants_new/beetgenerator.html`) hat die programmatisch
erzeugten `beet1`–`beet10` abgelöst. Drei Dinge sind dadurch anders, und alle
drei haben Folgen im Garten:

```jsonc
{ "format": "gartensimulator/beet", "version": 2,
  "breite": 4, "hoehe": 2,              // m, X und Y (= Z)
  "textur": "data:image/…",             // Boden des Beetes, Kies o. ä.
  "kacheln": true, "kachelgroesse": 0.72,
  "pflanzen": [
    { "art": "pflanze1", "x": 0.668, "y": 0.679, "scale": 1, "durchmesser": 0.901 }
  ] }
```

1. **`art` ist der Dateiname, keine laufende Nummer mehr.** Früher würfelte der
   Garten aus, welche Pflanze hinter Art 1 steckt; jetzt hat der Konfigurator
   die Bepflanzung wirklich entworfen, und daran ist nichts zu würfeln.
   `pickPlants` und der Regler „Verwendete Arten" sind ersatzlos entfallen —
   geladen wird, was die Beete nennen (`pflanzenAusBeeten`). Aus demselben
   Grund gilt `scale` jetzt **genau**; die frühere Streuung von ±10 % hätte
   einen Entwurf verwackelt.
2. **`breite`/`hoehe` stehen in der Datei.** Früher folgten die Maße aus dem
   Inhalt, weil eine mitgespeicherte Größe eine zweite Wahrheit gewesen wäre.
   Jetzt ist die Beetgröße eine eigene Entscheidung im Konfigurator (Pflanzen
   dürfen überstehen oder Platz lassen) und damit die erste. Die längere Seite
   kommt an den Weg; steht die Vorlage hochkant, wird sie um 90° gedreht. Der
   eingestellte Abstand gilt bis zur **Vorderkante**.
3. **`textur`** macht das Beet sichtbar. Im Garten wird daraus eine Fläche, die
   dem Gelände folgt — keine ebene Platte: das Beet liegt auf der Böschung
   neben dem Weg und stünde sonst mit einer Ecke in der Luft. Alle Beete einer
   Vorlage in einem Sektor werden in **ein** Netz verschmolzen.

`durchmesser` je Pflanze ist ihr Aufsichtsdurchmesser **mal ihrer Skalierung**,
in Metern. Damit stempelt die Bodenkarte ihren Schatten, ohne eine einzige
Pflanzendatei zu öffnen.

Bei nur einer Vorlage im Vorrat stünden zwei Dutzend identische Beete im
Garten; deshalb wird jedes zusätzlich **gespiegelt** gesetzt (längs, quer oder
beides) — aus einer Vorlage werden vier Bilder.

---

## Zaun

`zaun.js`, ein Schalter im Formular. Ein **Kreis**, `ZAUN_EINRUECKUNG` = 0,5 m
innerhalb der Gartenkante. Der halbe Meter ist kein Zierrat: der Garten ist ein
Quadrat, das die Kartenmaske in der Vogelperspektive auf einen Kreis
beschneidet — genau auf der Kante verschwände der Zaun dort halb unter der Maske
und liefe an den Ecken ins Weiße. Nachgemessen bei 100 m Garten: r = 49,5 m,
Umfang 311 m, 156 Pfosten.

**Zwei Netze je Sektor**, nicht 470 Objekte: alle Pfosten ein InstancedMesh,
alle Querhölzer ein zweites. Maße als Konstanten in `zaun.js` — Pfosten 10 cm
Durchmesser, 100 cm hoch, Querhölzer ebenso dick in 45 und 95 cm Höhe, Feldweite
2 m; die Feldzahl wird so gerundet, dass sie ganz auf den Umfang geht. Die
Querhölzer sind Sehnen, keine Bögen (bei 2 m auf 50 m Halbmesser ein Zentimeter
Abweichung). Sie werden nach der **Mitte** ihres Feldes einsortiert, sonst fiele
ein Holz in einen anderen Sektor als seine Pfosten und an der Sektorgrenze
klaffte eine Lücke.

### Das Tor

Eine Lücke von zwei Zaunfeldern, zwei sechskantige Säulen (3,40 m hoch, 0,20 m
Schlüsselweite) und ein Schilderbrett dazwischen (0,80 × 0,05 m, Unterkante bei
2,50 m, also 10 cm unter den Säulenoberkanten). Die Säulen stehen dort, wo
sonst die beiden Zaunpfosten am Rand der Lücke stünden — das Tor setzt den Zaun
fort, statt daneben zu stehen. Von außen liest man „Eingang", von innen
„Ausgang", in `#aa8833` auf derselben Maserung wie das übrige Holz.

**Wo es steht, entscheiden zwei Kriterien in dieser Reihenfolge**
(`planTor`): erst die Flachheit der Strecke vom Tor zum nächsten Weg — gemessen
als größter Höhensprung je Meter, nicht als Gesamtgefälle, denn eine Stufe
mittendrin fällt auf und ein gleichmäßiger Hang nicht —, dann unter den
flachsten die parallelste Wegführung.

**`TOR_FLACH_TOLERANZ` (0,20) stellt das Verhältnis ein**: wie viel steiler als
die flachste Stelle eine noch sein darf, um bei der Parallelität mitzureden.
Im flachen Standardgarten ist der Wert wirkungslos — dort liegt die ganze
Spannweite der Kandidaten bei 0…0,078, alles ist flach. Er entscheidet im
hügeligen Garten, und dort deutlich (±9 m Relief, fünf Startwerte, jeweils
gewählte Steilste / Parallelität):

| Startwert | 0,05 | 0,10 | 0,20 |
|---|---|---|---|
| garten-01 | 0,040 / 0,998 | 0,040 / 0,998 | 0,192 / 1,000 |
| probe-1 | 0,039 / **0,121** | 0,105 / 0,923 | 0,165 / 0,999 |
| probe-2 | 0,016 / **0,121** | 0,093 / 0,840 | 0,171 / 0,961 |
| probe-3 | 0,046 / 0,929 | 0,086 / 0,987 | 0,112 / 0,998 |
| probe-4 | 0,045 / **0,160** | 0,094 / 0,200 | 0,163 / 0,978 |

Bei 0,05 stand das Tor in drei von fünf Gärten fast **quer** zum Weg; 0,10
räumt das nicht auf. Der Preis für 0,20 ist ein Hang von rund 0,16 (etwa 9°)
statt 0,04 — das ist gemeint mit „etwas hügeliger, dafür parallel".

**Der Zugangsweg** (`torWeg` in `paths.js`) läuft **radial**, also auf der
Verlängerung Gartenmitte → Tor, und 4 m über die Gartengrenze hinaus. Sein
inneres Ende wird gesucht, nicht gerechnet: vom Tor nach innen abgeschritten,
bis der Punkt auf einer Wegfläche liegt. Er trägt `art: 'tor'` und bekommt
dadurch Belag, Kachelung und Breite des **Rundwegs**, nicht die der
Abkürzungen — er ist ein angelegter Zugang, kein Trampelpfad. Der Teil außerhalb
verschwindet in der Karte unter der weißen Maske.

**Der Zaun ist zugleich die Schranke des Spaziergangs.** `walker.setzeGrenze`
bekommt `zaunRadius(cfg) − 0,6 m` — ein Stück davor, sonst steckt die Kamera
zwischen den Pfosten. **Am Zaun wird geschoben, nicht gestoppt:** vom Schritt
bleibt der Anteil übrig, der längs des Zauns zeigt. Wer schräg dagegen läuft,
kommt an ihm entlang weiter; wer im rechten Winkel darauf zuläuft, bewegt sich
gar nicht. Weil der Zaun ein Kreis ist, braucht das keine Geometrie, nur zwei
Skalarprodukte gegen die Tangente. Nachgemessen: senkrecht 0,00 m seitlich,
unter 45° 2,06 m nach sechs Schritten, r bleibt beide Male exakt auf der
Schranke.

---

## Ansichten

**Augenhöhe:** perspektivisch, Himmel, Nebel, weite Horizontscheibe
(bis `horizont`) und Waldsilhouette. Der Wald ist ein Zylinder um die
Gartenmitte, von innen betrachtet, mit `img/wald.png` bespannt; die
durchsichtigen Stellen werden per `alphaTest` verworfen (echte Transparenz
müsste nach Tiefe sortiert werden). Die Kachelzahl folgt dem Seitenverhältnis
des Bildes und wird **ganzzahlig** gerundet, sonst klafft an der Naht ein halber
Baum.

Der Sichtwinkel hat **zwei Anteile, und sie sind getrennt**: der *Blickwinkel*
(Formular, 45/50/55/60°) ist die Gestaltungsentscheidung, der *Zoom* (Mausrad,
0,75×–8×) zieht den Ausschnitt darüber hinaus enger. Gerechnet wird
`fov = Blickwinkel / Zoom`; auf `walkCam.fov` steht immer der **wirksame**
Winkel, denn `main.js` leitet daraus den Drehwinkel eines Doppelklicks ab. Das
HUD zeigt beides: `24° FOV (45° · Zoom 1,88×)`. Das Mausrad gilt nur über dem
Canvas — darunter scrollt es weiter die Seite, sonst käme man an die Regler
nicht mehr heran.

**Vogelperspektive = isometrische Landkarte.** Kein Himmel, kein Nebel, kein
Wald, weißer Grund — und **keine Grasbüschel**. Von oben sind sie nur ein
Rauschen, stellen aber die Hälfte aller Dreiecke, und die Karte ist die einzige
Ansicht mit dem ganzen Garten im Bild. Geschaltet wird über
`userData.nurAugenhoehe`, das `applyView` beim Kamerawechsel durchläuft.

**Der Zaun bleibt ebenfalls draußen.** Von oben ist er ein haardünner Ring am
Rand, der wie eine Rahmenlinie wirkt und den runden Ausschnitt doppelt. Das
**Tor** dagegen bleibt stehen — es ist der Zugang und damit eine Angabe zur
Anlage.

**Das Holz der Bäume war kurz ebenfalls draußen** (es spart ein Siebtel der
Dreiecke: 464 k → 397 k bei 50 Bäumen) — und ist wieder drin. Ohne den Stamm
schwebte die Krone über ihrem eigenen Schatten; er ist das Einzige, was sie
sichtbar mit dem Boden verbindet.

**Die weiße Maske ist vier Gartenbreiten groß** (`buildMapMask`, halbe Kante
= 2 × Durchmesser) und nicht mehr ein Viertel größer als der Garten. Der Grund
ist die Parallelprojektion aus 35°: was tief liegt, erscheint darin nach vorn
verschoben, um seine Tiefe mal Kosinus der Neigung. Bei kräftigem Relief
rutschten die Ausgleichswälle am Rand deshalb aus dem Umriss der Maske und
standen als graue Schollen im Weiß. Ein Viertel Zuschlag reichte dafür nicht;
vier Gartenbreiten reichen immer, und es sind zwei Dreiecke.

**Die Beete bleiben stehen**, obwohl sie teurer sind als das Gras. Sie waren
zuerst ebenfalls draußen — aber ihr Schatten steckt in der eingebrannten
Bodenkarte und lässt sich nicht mit ausblenden. Übrig blieben Schattenflecken
auf blanker Wiese, und man suchte, was sie wirft. Beim Gras stellt sich die
Frage nicht: Halme werfen keinen Schatten (Entscheidung 13).

**Der Schatten ist in der Karte immer `simpel`**, unabhängig von der
Einstellung (`schattenAnwenden` in `main.js` und `game.js`). Ein echter
Durchgang müsste dort jedes Objekt einreichen, und bei senkrechtem Blick auf
fast senkrechte Sonne wäre kaum etwas davon zu sehen — die eingebrannte
Bodenkarte zeigt dasselbe und kostet nichts. `aus` wäre ebenfalls falsch: ohne
Schatten fehlt die Tiefe, und die Bäume sind nicht mehr als Bäume zu erkennen.

Die Kamera ist eine `OrthographicCamera`:

- **Neigung fest auf arctan(1/√2) = 35,264°.** Bei genau diesem Winkel liegt die
  Blickrichtung auf der Raumdiagonalen (1,1,1) und alle drei Achsen sind gleich
  stark verkürzt — das ist die Definition der Isometrie. Streng gilt sie
  zusätzlich nur bei 45°, 135°, … Azimut; weil sich der Garten frei drehen lässt,
  trifft es an vier Stellen exakt zu, dazwischen ist es eine allgemeine
  Axonometrie. Nachgemessen bei 45°: Blickrichtung (0,5774 / 0,5774 / 0,5774).
- **Ziehen dreht nur um die Hochachse**, die Neigung steht. Die Drehrichtung ist
  **umgekehrt** zum Umsehen in Augenhöhe: nach rechts ziehen fasst die
  Vorderkante des Gartens an und schiebt sie nach rechts.
- **Zoom ändert den Ausschnitt**, nicht den Abstand — eine Parallelprojektion hat
  keinen Sichtwinkel, und näher herangehen ändert an der Größe nichts. Der
  Abstand (4 · Radius) dient nur dazu, alles zwischen Near und Far zu bekommen.
- Der Ausschnitt wird in `birdUpdate` je Drehung, Zoom und Fenstergröße neu
  gebildet: waagerecht muss der Garten hineinpassen, senkrecht seine um
  sin(Neigung) verkürzte Tiefe plus die Baumhöhe mal cos(Neigung).

**Die Kartenmaske** beschneidet den quadratischen Garten optisch auf einen
runden: ein weißes Quadrat, ein Viertel breiter als der Garten, mit rundem
Ausschnitt von 0,995 · Gartenbreite, flach 5 cm über dem Gelände. Was außerhalb
liegt — die vier Ecken der Wiese — verschwindet darunter. Sie ist ein
`MeshBasicMaterial` und **nimmt deshalb gar keinen Schatten an**: die Schatten
des Gartens enden von selbst an der Kante des Ausschnitts, ohne Zusatzschalter.
Dass unter ihr flaches Gelände liegt, garantiert der Falloff des Höhenfelds
(Entscheidung 5).

Dazu ein weißer Kasten unter dem Gartenquadrat, damit man bei flacher Sicht
nicht unter das Höhenfeld schaut, der Standpunkt als rotes Dreieck und je Schild
ein weißes Namensschild als Billboard — beide mit `depthTest: false` über allem,
sonst verschwinden die Namen hinter den Kronen.

Doppelklick versetzt den Standpunkt: Sehstrahl gegen die Ebene y = 0, dann
zweimal gegen die Ebene der dort gefundenen Höhe. Das konvergiert bei diesen
Neigungen in zwei Schritten und ist mit der Orthogonalkamera pixelgenau
(nachgemessen: 1 px Abweichung bei der Rückrechnung).

---

## Zwei Einstiege

`index.html` ist der **Konfigurator**: alle Regler, das HUD, Einstellungen
speichern und laden. `game.html` ist der **Spieleinstieg** — Bootstrap 5.3,
helles Layout, kein Formular und kein HUD.

Was `game.js` von `main.js` unterscheidet, ist genau das Fehlende. Der Garten
kommt aus `json/garten.json`, einer Datei, wie sie „Einstellungen speichern“
schreibt. Sie wird **über die Vorgaben gelegt**, nicht als Ganzes genommen:

```js
{ ...defaults(), ...daten.werte }
```

Eine gespeicherte Datei kennt nur die Parameter, die es zu ihrer Zeit gab. Kommt
später einer hinzu, stünde er sonst auf `undefined` und der Aufbau liefe ins
Leere — bei einem Auswahlfeld wie `schatten` schon beim ersten Vergleich.

**Die Eingangssequenz.** Nach dem Aufbau steht der Spaziergang 5 m vor dem Tor,
draußen, mit Blick zur Gartenmitte, und läuft 6 m von selbst hinein; erst danach
nimmt der Walker Eingaben an und erst danach greift die Zaunschranke — sie
hielte sonst genau das auf, was gewollt ist.

Die vier Schritte werden **nicht auf einmal** eingereiht: die Warteschlange
nimmt nur `MAX_PENDING` zusätzlich zur laufenden Aktion, der Rest fiele stumm
unter den Tisch (nachgezählt: von vier Schritten kamen drei an). Stattdessen
wird je Bild nachgelegt, solange etwas offen ist — nebenbei bleibt die Schlange
dabei voll, und der Gang läuft ohne Zwischenbremsung durch.

**„Jemand wollte hinaus."** Bleibt ein Schritt an der Schranke hängen, schickt
der Walker ein `garten-ausgang`-Ereignis ans Fenster (mit Ort, Blickrichtung
und Schranke im `detail`). Es ist **flankengetriggert** — einmal je Versuch,
nicht sechzigmal in der Sekunde, solange jemand gegen den Zaun läuft. `game.js`
hängt daran die leere Platzhalterfunktion `exitGarden(detail)`; was ein Ausgang
bedeutet, ist eine Frage des Spiels und nicht der Fortbewegung.

Die Bedienelemente: ein Steuerkreuz aus vier Knöpfen (CSS-Grid, drei Spalten mal
zwei Zeilen — die Anordnung ist die Bedeutung), das Kartensymbol
(`img/karte.jpg`) über dem Bild oben rechts als Umschalter zur Vogelperspektive,
und „Neuen Garten erstellen“, das einen zufälligen Startwert setzt und neu baut.
Maus und Pfeiltasten verhalten sich wie im Konfigurator.

---

## Licht und Himmel

Zwei Lichter, und ihr Verhältnis macht den Eindruck: ein Hemisphärenlicht (2,0)
als Himmelslicht, das überallhin fällt und den Schatten aufhellt, und die Sonne
(3,0) als gerichtetes darüber. Beide zusammen bestimmen die Helligkeit, ihr
Abstand den Kontrast. Die obere Farbe des Hemisphärenlichts ist absichtlich viel
blasser als der gemalte Himmel — als Licht wirkt sie auf alles, ein gesättigtes
Blau färbte den ganzen Garten kalt ein.

Der Himmel ist ein Verlauf von `#5588ff` im Zenit auf `#ccddff` am Horizont;
der untere Wert ist zugleich die Nebelfarbe, damit alles, was in den Dunst
läuft, genau auf den Himmel trifft.

---

## Transluzenz (`translucency.js`)

Gegenlicht-Trick für Blätter und Pflanzen: wo die Sonne von hinten auf die
Fläche fällt, wird ein inneres Leuchten addiert — in der **eigenen Farbe der
Fläche**, dadurch glimmt die Rotbuche rot und die Birke gelbgrün ohne zweite
Farbpflege. Regler unter Ansicht, sofort wirksam.

Drei Dinge, an denen die naheliegende Fassung des Tricks scheitert:

1. `vNormal` liegt im **Sichtraum**. Eine fest verdrahtete Lichtrichtung dreht
   sich mit — das Gegenlicht käme immer von da, wo man hinschaut. Die
   Sonnenrichtung wird deshalb je Bild in den Sichtraum gerechnet.
2. Eingehängt wird an `lights_fragment_end`, **nicht** an `dithering_fragment`:
   dort ist die Farbe schon belichtet, in den Ausgabefarbraum gewandelt und
   vernebelt — das Leuchten strahlte durch den Nebel.
3. `normal` statt `vNormal`: normiert und bei beidseitigen Materialien schon zur
   Kamera gedreht, genau das braucht der Test „Licht steht dahinter".

Kosten bei 17,9 Mio. Dreiecken: ≤ 2 ms von 30, am Rand der Streuung. Bei den
Voreinstellungen nicht messbar.

**Glanz** (`glanz` der Pflanzen, `lgls` der Bäume) ist ein Rauheitswert und
damit gratis — derselbe Shader. `envMapIntensity` läuft allerdings ins Leere,
weil der Garten kein `scene.environment` hat; vom Glanz bleibt der direkte
Sonnenreflex. Das ist Absicht.

---

## Fallstricke (alle real aufgetreten, alle nachgemessen)

1. **Dreiecks-Wicklung der Bänder.** Falsch herum zeigen die Normalen nach
   unten, das Band wird als Rückseite weggeculled und ist *nur im Drahtgitter*
   sichtbar. Prüfkriterium: alle Normalen-Y > 0.
2. **Kein Sicherheitszuschlag im Weg-Index.** Ein pauschaler Zuschlag von einer
   halben Abtastschrittweite (0,25 m) frisst genau die Zone am Wegrand: der
   Schildpfahl steht 10 cm von der Kante (⇒ *null* Schilder), und dort ist das
   Randgras am dichtesten (⇒ 37 000 Halme fehlten). Der Index registriert
   deshalb **Strecken statt Punkte**. `except` blendet den eigenen Weg aus.
3. **Dichteverteilung ≠ Gleichverteilung.** „Halme nehmen zum Rand hin
   gleichmäßig ab" heißt: die *Flächendichte* fällt linear, die CDF muss
   invertiert werden. Lateral `d = 1 − √(1−u)`. Radial ist die CDF mit dem
   Ringflächenfaktor exakt `smoothstep`, die Umkehrung also geschlossen:
   **`r = R·(0,5 − sin(asin(1−2u)/3))`**.
4. **Tiefenauflösung statt Höhenabstand.** Flächen, die 1–2 cm auseinander
   liegen, flackern in der Ferne. `near = 0.4` statt 0.1 (Auflösung geht mit
   1/near) und kräftiger `polygonOffset`. Mehr Höhenabstand wäre falsch — ein
   6-cm-Absatz ist aus 1,3 m Augenhöhe sichtbar.
5. **Eigene Shader wandeln den Ausgabefarbraum nicht von selbst.** Eine
   `THREE.Color` rechnet ihren Hexwert in den linearen Arbeitsfarbraum um, der
   Bildschirm will ihn in sRGB. Die Standardmaterialien hängen die Rückrechnung
   selbst an; der Himmelsshader tat es nicht — aus bestellten `#5588ff` wurden
   gemessene `#173fff`, deutlich zu dunkel und zu satt. Abhilfe:
   `#include <colorspace_fragment>` als letzte Zeile in `main()`.
6. **Die Naht eines geschlossenen Bandes braucht eigene Eckpunkte.** Die
   Wegtextur läuft über die Bogenlänge (`v = s / kachel`). Beim Rundweg
   schließt das letzte Viereck an Stützstelle 0 an, und deren `s` ist 0 — das
   eine Viereck spannte damit die Kachelung des **ganzen** Rundwegs auf 50 cm
   zusammen. Die Grafikkarte griff zur gröbsten Mipmap-Stufe, und heraus kam
   ein einfarbig graues Band quer über den Weg, genau am Startpunkt des
   Spaziergangs. Abhilfe: die erste Stützstelle ein zweites Mal ausgeben,
   diesmal mit `s = total`. Betrifft `buildPathMesh` **und** `buildPathWalls`
   — dort ist jeder Streifen geschlossen, auch der eines Stichwegs, der einmal
   um das ganze Band herumläuft. Dazu wird beim Rundweg die Kachelgröße leicht
   nachgezogen, damit eine ganze Zahl Kacheln auf den Umfang geht.

7. **Abkürzungen enden an der Kante, nicht in der Mitte.** Ein Stichweg wird
   auf die Mittellinie des Rundwegs gezogen (die Attraktoren liegen nach der
   Verrundung nicht mehr exakt auf dem Weg) und von dort wieder zurück bis an
   dessen **Kante** gekürzt. Wie weit das ist, hängt am Schnittwinkel: schräg
   einmünden heißt einen längeren Weg von der Mitte bis zur Kante, nämlich
   `halbeBreite / sin(Winkel)`. Zwei Sicherungen: ein Deckel bei der
   vierfachen halben Breite (bei sehr flachem Winkel liefe die Rechnung
   davon) und 5 cm Überstand, damit an der Naht eine Überlappung steht und
   kein Spalt. Ohne die Kürzung lag ein knapper Meter Trampelpfad quer über
   dem Kiesband.

   **Die Breite ist eine Eigenschaft des Weges, nicht der Einstellung.**
   Rundweg und Abkürzung haben getrennte Regler (`wegBreite`, `wegBreiteAbk`,
   Vorgaben 1,5 und 1,0 m). Ab `makePath` fragt deshalb niemand mehr `cfg` nach
   der Wegbreite, sondern `path.width` — das gilt für Band, Wall, Baumabstand,
   Schildpfahl, Randgras, Beetabstand und das Belegungsraster. Auch der
   Weg-Index führt die halbe Breite **je Segment** (`STRIDE = 8`) und merkt sich
   zum nächsten Treffer, zu welchem Weg er gehört; `onSurface`/`farFrom` suchen
   mit der größten halben Breite und vergleichen dann gegen die des gefundenen
   Weges — sonst übersähe die Suche einen breiten Weg, der knapp außerhalb des
   schmalen Radius beginnt.

   **Und sie werden schräg angeschnitten.** Eine stumpfe Stirnkante quer zur
   eigenen Laufrichtung lässt auf der einen Seite einen Zwickel Wiese stehen
   und ragt auf der anderen über die Wegkante. `bandPunkt` verschiebt deshalb
   die beiden Bandecken antisymmetrisch längs der eigenen Tangente, bis die
   Stirnkante auf der Kante des Rundwegs liegt: `d = -sgn·halbe·(n·Nm)/(t·Nm)`.
   Weil der Versatz linear in `sgn` ist, stimmen die Zwischenpunkte des
   Stirnwalls von selbst. Gedeckelt bei der doppelten halben Breite — bei sehr
   flachem Schnitt kippte sonst das Schlussviereck um. Nachgemessen liegen
   danach alle Bandecken 3–12 cm **innerhalb** der Wegfläche, über den ganzen
   Bereich beider Breitenregler hinweg.

   Angeschnitten wird aber **nur, solange die Abkürzung nicht breiter ist als
   der Weg, in den sie mündet** (`schraegAn`). Sonst hat der Schnitt kein Ziel:
   ein 3,5 m breites Maul reicht an einem 0,6 m breiten Weg links und rechts
   ins Gras, so weit man es auch hineinschiebt — das ist keine Lücke, sondern
   die Geometrie. Dort ist der stumpfe Schnitt richtig; der breite Trampelpfad
   läuft eben breiter aus als der Weg, den er trifft, und hat für sein Ende
   ohnehin einen eigenen Wall.

8. **Nicht jeder Weg ist geschlossen.** Seit es Abkürzungen gibt, muss überall
   dort, wo mit `(k+1) % m` um den Ring gelaufen wird, `path.closed` abgefragt
   werden. Und wer einen Weg zufällig zieht, muss **nach Länge gewichten** —
   sonst sitzen an einem 8-m-Stichweg so viele Bäume wie am 400-m-Rundweg.
9. **Aufbau immer in `try/finally`.** Sonst bleibt nach einem Fehler der Spinner
   stehen *und* das `building`-Flag gesetzt: die UI ist dauerhaft blockiert.
10. **`setPointerCapture` kann werfen** und reißt dann den Rest des
   `pointerdown`-Handlers mit. In `try/catch`, Zustandsvariablen davor setzen.
11. **`requestAnimationFrame` feuert in Hintergrund-Tabs nicht.** Die Yields im
   Aufbau brauchen einen `setTimeout`-Fallback.
12. **Spinner-Mindeststandzeit** (600 ms), sonst blitzt er bei 360 ms Aufbau auf.
13. **Messen nur im sichtbaren Tab.** Chrome drosselt versteckte Tabs; Messungen
    daraus waren um den Faktor 4–5 zu langsam.
14. **Chrome stellt Formularwerte beim Reload wieder her.** Beim Messen vorher
    explizit auf die Schema-Defaults setzen.
15. **Geteilte Geometrie nicht mit dem Garten wegräumen** — siehe Entscheidung 9.
16. **`customProgramCacheKey` bei `onBeforeCompile`.** Ohne eigenen Schlüssel
    teilt three das übersetzte Programm mit einem gleich konfigurierten, aber
    nicht angefassten Material.
17. **Synthetische Maus-Events sind kein Ersatz für echte.** Ein per
    `dispatchEvent` nachgebauter Doppelklick lief durch die Paarerkennung nicht
    durch, während der echte pixelgenau traf. Bedienung mit echten Eingaben
    prüfen, sonst jagt man Phantome.

---

## Offene Themen

**Kreuzungen, der harte Kern.** `nearestSurface` liefert die Höhe *eines*
Weges — des nächstliegenden. Wo zwei Wege sich kreuzen, gewinnt mal der eine,
mal der andere. Der Ausgleichswall schließt den Hohlraum *unter* dem
schwebenden Band; das Gegenstück fehlt noch: bei kräftigem Relief **stößt das
Gelände durch das Band** (gemessen: 0,1 cm bei 60 cm Relief, 10 cm bei 3 m,
22 cm bei 6 m).

Versucht und wieder ausgebaut: runde Kiesscheibe über dem Schnittpunkt (Radius
ist `h/sin(θ/2)`, nicht `h/sin θ` — die Zwickelspitze liegt auf der
Winkelhalbierenden) und Achteck mit hartem Grat (rechnete sauber, überzeugte
optisch nicht, und bei fast parallel laufenden Bändern gibt es gar keinen
Schnittpunkt).

Der eigentliche Kern ist vermutlich nicht „Kreuzung", sondern **Überlappung**:
zwei Bänder, die sich eine Fläche teilen, brauchen dort ein *gemeinsames*
Höhenprofil — zu bestimmen, bevor die Bänder gebaut werden.

Angedacht: Abkürzungen als "Treppen" bauen, vermeidet einige der Probleme.

**Was am Schatten noch fehlt.** Die drei Stufen stehen (Entscheidung 13). Offen
sind zwei Kleinigkeiten:

- **Schilder stempeln in `simpel` nicht.** Ein Brett in 1,30 m Höhe wirft einen
  schmalen Streifen, keinen Kreis — dafür bräuchte es ein Rechteck im
  Weltmaßstab statt der weichen Ellipse. Bisher nicht als Fehlen aufgefallen.
- **Senkrechte Flächen bleiben in `simpel` unbeschattet.** Die Bodenkarte wird
  über x/z abgetastet; ein Fels im Baumschatten bekommt an seiner Flanke nichts
  ab. Das ist der Preis der Sache und lässt sich nicht flicken, nur wechseln.

**Wie Stempel sich überlagern: der dunklere gewinnt.** Die Stempel liegen als
undurchsichtiges Grau vor und werden mit `globalCompositeOperation = 'darken'`
gezeichnet, nicht als Schwarz mit Deckkraft. Mit Deckkraft lägen zwei einander
deckende Kronen zu je 60 % am Ende bei 84 %, und wo Baum- und Pflanzenschatten
zusammenfallen, säuft der Boden ab. Mit `darken` bleibt es bei 60 %: ein
Schatten ist fehlendes Sonnenlicht, und fehlen kann es nur einmal.

Derselbe Gedanke steckt seit der Fassung vom 19.8. auch **im Baumgenerator**:
`risse()` zeichnet den Schattenriss jetzt weiß auf schwarz mit `lighten` statt
mit Deckkraft übereinander. Vorher summierte jede weitere Blattlage den Wert
auf — in einer dichten Krone liegen leicht ein Dutzend Rechtecke übereinander,
dort lief der Riss in die Sättigung, während er am dünn besetzten Rand blass
blieb. Wie kräftig der Schatten ausfiel, hing damit an der Zahl der Billboards
statt an der Gestalt des Baums.

**Der Schattendurchgang hängt an den Pflanzen.** Nachgemessen (CPU-Zeit je
`render()`, Schattenkarte jedes Bild erzwungen):

| | ms |
|---|---|
| ohne Schattendurchgang | 0,088 |
| voller Schattendurchgang | 0,236 |
| davon ohne Pflanzenschatten | 0,150 |
| davon ohne Pflanzen und Felsen | 0,143 |

Die 480 Pflanzen sind **422 880 Dreiecke** und damit 58 % des ganzen
Durchgangs; die 101 Felsbrocken sind 5 %. Die Bäume kosten seit dem Umbau
2 Dreiecke je Baum. Der wirksamste Eingriff am Pflanzengenerator wäre deshalb
**dieselbe Schattenkarte, die der Baumgenerator schon exportiert**: ein
Silhouettenriss quer zum Sonnenstrahl, im Paket der Pflanzendatei. Aus 422 880
Dreiecken würden 960.

**Warum frühere Optimierungen langsamer waren** — und weshalb die Sektoren
(Entscheidung 15) es nicht sind: die früheren haben Arbeit **in die
Bildschleife** gelegt (Instanzpuffer umschreiben, Materialien umschalten,
Shader neu übersetzen). Die ganze Szene einzureichen kostet 0,09 ms CPU; jede
Buchführung, die je Bild mehr als das kostet, ist ein Verlustgeschäft, egal wie
viele Dreiecke sie spart. Die Sektoren kosten je Bild **nichts** — sie stehen
nach dem Aufbau fest, und was danach entscheidet, ist der Test, den three
ohnehin macht.

**Weiteres**
- Kronen von Bäumen am Rand ragen in der Karte über den runden Ausschnitt
  hinaus: der Stamm steht innen, die Krone ist bis zu 5 m weit, und die Maske
  ist flach. Bisher nicht als störend bewertet.
- Krone und Tafel kennen **keinen Nebel** (`fog: false`, Entscheidung des
  Generators — zwei verschiedene Dunstschleier über demselben Wald fielen mehr
  auf als gar keiner). Der Stamm dagegen ist ein Lambert-Material und nebelt
  mit. Bei der voreingestellten Nebeldichte auf 50 m nicht sichtbar; bei
  dichtem Nebel wird es auffallen.
- Gras wirft keinen Schatten (Entscheidung 13). Es ist dieselbe eine Zeile in
  `grass.js` wie bei den Pflanzen — vorher messen.
- Ein Beetkonfigurator soll die `beet*.json` erzeugen; die zehn vorhandenen sind
  Wegwerf-Vorlagen im 10×2-Raster für die optische Bewertung.
- `transluzenz` wirkt auf Bäume nicht mehr: das Laub ist ein
  `RawShaderMaterial` des Generators und geht an `translucency.js` vorbei. Für
  Pflanzen gilt der Trick unverändert.
- Gewicht und Standortwunsch je Pflanze in der Bestandsliste (`häufig/selten`,
  `wegrand/wiese/unterBaum`), wenn aus drei Arten zwanzig werden.
- Die Texturen in `img/` sind Platzhalter. Die Kachelung läuft über Welt-UVs
  (`kachelWiese`, `kachelWeg`, `kachelAbk`, `kachelFels` in Metern), nicht über
  `texture.repeat`.
