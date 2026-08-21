# Pflanzen-Generator — Grasbüschel

Parametrischer Generator für 3-dimensionale Grasbüschel. Oben die WebGL-Ansicht,
darunter die Einstellungen. Alle Maße in mm.

Dazu gehört der **Beet-Konfigurator** (`beetgenerator.html`), der die fertigen
Pflanzen auf einem Beet verteilt — dort in Metern, siehe unten.

## Starten

`index.html` per Doppelklick öffnen — es werden nur klassische `<script>`-Tags
verwendet, deshalb läuft alles direkt über `file://`, ohne Server und ohne Internet.

Falls doch ein lokaler Server gewünscht ist:

```bash
python3 -m http.server 8251
```

Der **Beet-Konfigurator** (`beetgenerator.html`) braucht einen Server, sobald ein
gespeichertes Beet geladen wird: er holt die Pflanzen-Dateien per `fetch` nach,
und das lässt `file://` nicht zu. Ohne Server lassen sich die fehlenden Dateien
von Hand nachreichen.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `style.css` | Seitengerüst und Gestaltung |
| `main.js` | Erzeugt die Bedienelemente aus dem Schema, verbindet UI und Viewer |
| `viewer.js` | three.js-Szene: Wiese, Licht, Schatten, Maussteuerung |
| `geometry.js` | **Reine Mathematik** — Konfiguration → Vertex-Buffer. Ohne three.js/DOM |
| `loader.js` | **Schema, Validierung, Speichern & Laden.** Ohne three.js/DOM |
| `gartenloader.js` | Adapter für den Gartensimulator: `window.Pflanze`, Ausgabe in Metern |
| `beetgenerator.html`, `beet.css`, `beet.js` | Beet-Konfigurator: Pflanzen auf einem Beet verteilen |
| `vendor/` | three.js r147 (UMD) + OrbitControls, lokal abgelegt |
| `beispiel-ziergras.json` | Beispielkonfiguration für den Generator |
| `Segge.pflanze.json` | Beispiel für den Garten: 480 Dreiecke, im Budget |
| `json/` | Ablage der exportierten Pflanzen — von hier holt der Beet-Konfigurator sie |

## Bedienung

* **Ansicht:** Ziehen = drehen, Mausrad = zoomen, rechte Maustaste = verschieben.
  Die Grundfläche ist weiß und absichtlich sehr groß, damit sich der Schattenwurf
  gut beurteilen lässt. Sie gehört nur zur Vorschau und wird nie mitexportiert.
* **Generieren** baut das Büschel neu. Mit **automatisch** geschieht das bei jeder
  Änderung sofort — bei 200 Halmen dauert ein Neuaufbau wenige Millisekunden.
* **Schatten** wirkt sofort, ohne Neuaufbau.
* **Name** ist der Name der Pflanze. Er wird beim Speichern zum Dateinamen
  `{name}.json` und steht auch im `name`-Feld der Datei. Beim Laden wandert
  umgekehrt der Dateiname (ohne `.json`) ins Namensfeld — die Pflanze behält
  also ihren Namen, egal aus welcher Richtung sie kommt. Unter genau diesem
  Namen spricht der Beet-Konfigurator sie später als `art` an.
* **Konfiguration speichern / laden** schreibt bzw. liest eine JSON-Datei.
  Eine `.json` lässt sich auch einfach ins Fenster ziehen.
* **Standardwerte** setzt alles zurück.

## Durchmesser in der Exportdatei

Jede gespeicherte Pflanze enthält das Feld `durchmesser`: den **breitesten
Durchmesser in der Aufsicht**, in Millimetern, auf 0,1 mm gerundet.

Gemeint ist der Kreis, den die Pflanze von oben gesehen abdeckt — also
einschließlich der nach außen gekippten Blattspitzen, nicht nur die Grundfläche
`$grundflaeche_radius`, auf der die Halme austreten. Bei den Standardwerten sind
das rund 900 mm gegenüber 90 mm Grundfläche. Für die Schattenkarte des Gartens
ist genau dieses äußere Maß gefragt, deshalb steht es als eigener Punkt in der
Datei und muss nicht aus den Formparametern zurückgerechnet werden.

Der Wert wird beim Speichern immer frisch aus der Geometrie bestimmt
(`PflanzenGeometry.durchmesser(config)` = `stats.radius × 2`) und nicht aus der
geladenen Datei übernommen — er kann also nicht veralten. Ein `durchmesser` in
einer eingelesenen Datei wird durchgereicht, beim nächsten Speichern aber
überschrieben.

## Aufbau eines Halms

Ein Halm besteht aus einer Mittelrippe (dem Knick) und zwei Hauptsegmenten, die
links und rechts um `$winkel_haupt` abgeknickt sind. Alle Punkte der Mittelrippe
liegen exakt übereinander.

`$winkel_haupt` darf **negativ** sein (−45 … 45). Das Vorzeichen bestimmt nur, zu
welcher Seite gefaltet wird — der Winkel zwischen den Hälften ist bei +30° und −30°
derselbe:

| | |
|---|---|
| **positiv** | Kiel zeigt zur Büschelmitte, das Blatt schalt sich nach außen-unten. Vom Zentrum aus blickt man auf die Kante, an der die Hälften zusammenstoßen — die Grasform. |
| **0°** | flaches Blatt, beide Hälften in einer Ebene |
| **negativ** | andersherum gefaltet: das Blatt schalt sich nach oben, der Kiel zeigt nach außen. Ergibt die Rinnenform großblättriger Rosettenpflanzen. |

Die Rechnung ist für beide Vorzeichen dieselbe — der Knick steckt allein im Anteil
`N · sin(α)`, und die Außennormale `N` hängt nicht von α ab. Geprüft: die Außenkanten
stehen bei jedem Winkel exakt rechtwinklig auf der Mittelrippe, und die Normalen
kippen beim Durchgang durch 0° nicht um.

Aufgebaut wird über ein mitwanderndes Dreibein: **T** = Tangente der Mittelrippe,
**W** = Breitenachse (tangential zum Büschel), **N = T × W** = Außennormale. Weil
`$winkel_unten` und `$winkel_versatz` ausschließlich um **W** kippen, bleibt **W**
konstant und **N** dreht korrekt mit. Damit stimmen die Eckpunkte auch dann, wenn
Abknickung und zunehmende Kippung zusammenkommen — die Außenkanten stehen an jedem
Knoten exakt senkrecht auf der Mittelrippe.

### Breitenkurve

Die Breite nimmt nicht geradlinig zu und ab, sondern beschreibt einen **Kreisabschnitt
über der Sehne**: Die Sehne ist die lineare Interpolation von `$breite_unten` nach
`$breite_oben`, darauf addiert sich eine elliptische Ausbauchung, die

* bei `$hoehe_mitte` exakt `$breite_mitte` erreicht und dort waagerechte Tangente hat,
* an Fuß und Spitze mit senkrechter Tangente in die Sehne läuft.

Genau diese Form hat ein Kreisabschnitt auf seiner Sehne. `$breite_oben = 0` ergibt
dadurch eine saubere Spitze.

> Kleine Feinheit: Wenn `$breite_oben` deutlich kleiner ist als `$breite_unten`, fällt
> die Sehne, und die *rechnerisch* breiteste Stelle liegt dann ein paar Prozent unter
> `$hoehe_mitte` (Abweichung typischerweise < 0,5 %). Dafür ist garantiert, dass die
> Breite bei `$hoehe_mitte` exakt `$breite_mitte` beträgt.

### Verteilung im Büschel

Die Halme sitzen auf einer Fibonacci-Spirale (`r ∝ √i`, goldener Winkel). Das ergibt
gleiche Abstände ohne sichtbare Reihen oder Lücken. `$winkel_unten` wird linear mit
dem Radius eingeblendet: der Halm im Zentrum startet senkrecht, die äußersten
erreichen den vollen Winkel.

## Zwei Abweichungen von der Vorgabe

1. **`$breite_oben` geht von 0 bis 100** statt 1 bis 100 — sonst wäre die geforderte
   Spitze (`= 0`) nicht einstellbar.
2. **Die Höhenangaben werden entlang der Mittelrippe gemessen**, nicht als
   Senkrechte über dem Boden. Bei stark gekippten Halmen ist die tatsächliche
   Höhe über dem Boden deshalb geringer als `$hoehe_stil + $hoehe_oben`. Anders geht
   es nicht: sobald `$winkel_versatz` den Halm über 90° hinaus kippt, gäbe es zu einer
   vorgegebenen senkrechten Höhe gar keine Lösung mehr. Die erreichte Höhe steht in
   der Statuszeile über der Ansicht.

## Farbverlauf

`$farbe_unten` und `$farbe_oben` laufen entlang des Halms ineinander.
`$farbverlauf_start` (0–100 %) schiebt den Verlauf nach oben:

| Wert | Wirkung |
|---|---|
| 0 % | Verlauf über den ganzen Halm (Voreinstellung) |
| 50 % | untere Hälfte durchgehend `$farbe_unten`, darüber der Verlauf |
| 100 % | ganzer Halm `$farbe_unten`, nur die Spitze `$farbe_oben` |

An der Spitze wird immer `$farbe_oben` erreicht. Der Verlauf sitzt in den
Vertexfarben, wird also je Knoten abgetastet — bei wenigen Teilsegmenten wird er
entsprechend stufiger. Die Textur-Koordinaten bleiben davon unberührt.

## Glanz

`$glanz` (0–100 %) steuert die Rauheit des Materials: 0 % stumpf matt, 100 % speckig
glänzend. Der Glanzfleck kommt aus der Lichtrichtung und wandert beim Drehen mit.

Wichtig für die Einbindung: **sichtbar wird Glanz nur, wenn es etwas zu spiegeln gibt.**
Ein gerichtetes Licht allein erzeugt nur eine sehr schmale Glanzkeule — nachgemessen
war das Bild bei geringer Rauheit sogar minimal dunkler statt glänzender. Die Vorschau
legt deshalb eine kleine Studio-Umgebung auf das Halm-Material (weißer Zenit, heller
Fleck in Sonnenrichtung). Im Garten übernimmt das dessen `scene.environment`;
`buildMaterial` setzt dafür `envMapIntensity` passend zum Glanzwert.

Die Umgebung hängt bewusst nur am Halm-Material, nicht an der Szene, und ist bei 0 %
ganz abgeschaltet — ein mattes Büschel bleibt innen also genauso dunkel wie ohne diese
Ergänzung. Gemessene mittlere Helligkeit der Pflanzenpixel: 25 bei 0 %, 55 bei 50 %,
87 bei 100 %.

### Was Glanz kostet

Der **Wert** ist kostenlos — er landet in Uniforms, der Shader rechnet die Glanzkeule
ohnehin. Die **Umgebung** dagegen ist eine eigene Shader-Variante und kostet echte
Füllrate. Gemessen an 16 800 Dreiecken auf 1200 × 900 (Median aus 9 × 30 Bildern,
mit GPU-Synchronisation):

| | ms je Bild |
|---|---|
| Glanz 0 % (Umgebung abgehängt) | 0,66 |
| Glanz 20 % | 1,59 |
| Glanz 100 % | 1,79 |

Zwischen 20 % und 100 % ändert sich also praktisch nichts — der Sprung liegt allein
zwischen „keine Umgebung" und „Umgebung". Deshalb wird sie bei Glanz 0 komplett
abgehängt statt nur mit 0 multipliziert; ein mattes Büschel rendert dadurch exakt so
schnell wie vor der Glanz-Ergänzung. Der einmalige Aufbau der Umgebung (~23 ms) läuft
erst beim ersten Glanz > 0.

**Im Garten** ändert sich dadurch nichts an der Bildrate: dort liefert `scene.environment`
die Spiegelung, die ohnehin für alle Materialien gilt. `buildMaterial` setzt nur
`envMapIntensity` und hängt keine eigene Umgebung an.

## Textur

Optional; wird als Data-URL in der Konfiguration mitgespeichert (die JSON-Datei wird
dadurch entsprechend größer).

Das Mapping ist an der senkrechten Mittellinie **gespiegelt**: `u = 0` liegt an der
Mittelrippe, `u = 1` an beiden Außenkanten, `v` läuft von 0 am Fuß bis 1 an der Spitze.
Die Textur wird mit dem Farbverlauf multipliziert, `$farbe_unten`/`$farbe_oben` färben
sie also weiterhin ein — für die reine Texturfarbe beide auf `ffffff` setzen.
Transparente PNGs funktionieren (Alpha-Test bei 0,5), damit lässt sich die Halmform
auch freistellen.

Soll die Textur stattdessen *durchgehend* über den ganzen Halm laufen statt gespiegelt,
sind es in `geometry.js` vier Zahlen — die Stelle ist dort kommentiert.

## Beet-Konfigurator

`beetgenerator.html` verteilt fertige Pflanzen auf einem rechteckigen Beet.
Die Geometrie kommt über `gartenloader.js` — also über denselben Weg, den auch
der Gartensimulator nimmt. Gerechnet wird durchgehend in **Metern**.

### Modi

| Modus | Maus |
|---|---|
| **EDIT** | Feste isometrische Ansicht von schräg oben. Links auf eine Pflanze = auswählen (dicker roter Rahmen), gedrückt halten und ziehen = verschieben, loslassen = endgültige Position. Rechts ziehen verschiebt den Ausschnitt, das Rad zoomt. |
| **ANSICHT** | Ziehen = drehen und kippen, Rad = zoomen, rechts ziehen = verschieben. |

Getroffen wird beim Anklicken nicht das Blattwerk selbst, sondern ein
unsichtbarer Zylinder über der Standfläche der Pflanze — zwischen den Halmen ist
mehr Luft als Blatt, direkt auf sie zu zielen wäre kaum zu treffen. Sein
Durchmesser ist der `durchmesser` aus der Pflanzendatei.

### Einstellungen

* **Beetgröße** Breite X × Länge Y in Metern, voreingestellt 4,0 × 2,0.
  Beim Verkleinern rücken Pflanzen, die sonst draußen stünden, nach innen.
* **Textur** für den Boden, wahlweise gekachelt:
  * *ungekachelt* — das Bild wird auf die vollen Beetmaße gezogen, seine Größe
    und sein Seitenverhältnis spielen keine Rolle.
  * *gekachelt* — die Kachel ist quadratisch. Das gewählte Bild wird dafür auf
    256, 512 oder 1024 px umgerechnet und dann alle `kachelgroesse` Meter
    wiederholt. Ohne diese Umrechnung würde ein hochformatiges Bild als
    verzerrte Kachel liegen.
* **Pflanze einfügen** liest eine (oder mehrere) Exportdateien des
  Pflanzen-Generators und setzt sie in die Beetmitte. Mehrere Exemplare
  derselben Art teilen sich Geometrie und Material.
* **Duplizieren** legt die Kopie auf das Original und wählt sie aus — sie wird
  anschließend an ihren Platz gezogen.
* **Löschen** entfernt die ausgewählte Pflanze (auch mit `Entf`).

### Beet-Datei

```jsonc
{
  "format": "gartensimulator/beet",
  "version": 2,
  "name": "beispielbeet",          // = Dateiname, {name}.json
  "beschreibung": "Beet aus dem Beetkonfigurator",
  "breite": 2.1,                   // m, X
  "hoehe": 2.1,                    // m, Y
  "textur": "data:image/…",        // Data-URL oder null
  "kacheln": true,
  "kachelgroesse": 0.8,            // m, Kantenlänge einer Kachel
  "kachelpixel": 512,              // 256 | 512 | 1024, quadratisch
  "pflanzen": [
    { "art": "pflanze1", "x": -0.6, "y": 0, "scale": 0.9, "durchmesser": 0.81 }
  ]
}
```

`x` und `y` zählen **von der Beetmitte** in Metern: `x` nach rechts (Weltachse X),
`y` nach hinten (Weltachse Z). `art` ist der Dateiname der Pflanze ohne `.json`;
ihre Konfiguration steckt **nicht** in der Beet-Datei. Beim Laden wird sie als
`json/{art}.json` gesucht, ersatzweise als `{art}.json` neben der Beet-Datei;
was fehlt, meldet der Konfigurator und lässt es von Hand nachreichen.

`durchmesser` je Pflanze ist der Durchmesser der Art **mal ihrer Skalierung**,
in Metern — der Garten kann seine Schattenkarte damit aufbauen, ohne die
Pflanzendateien überhaupt zu öffnen.

## Einbindung in den Gartensimulator

`gartenloader.js` setzt die Vorgaben aus `PFLANZENKONFIGURATOR.md` um.

**Mitgehen müssen drei Dateien**, `gartenloader.js` allein reicht nicht: er ist nur der
Adapter und ruft `loader.js` (Schema, Validierung) und `geometry.js` (die eigentliche
Geometrie) auf. Alle drei sind ohne Abhängigkeiten, `viewer.js`, `main.js`, `style.css`,
`index.html` und `vendor/` bleiben zurück — die gehören zum Konfigurator, nicht zur
Pflanze. Dazu die `.pflanze.json`-Dateien.

Einbinden wie den Baumloader — klassische Dateien, nach dem `THREE`-Global, vor dem
Modulstart:

```html
<script type="module">
  import * as THREE from 'three';
  window.THREE = THREE;
</script>
<script defer src="pflanzenloader/loader.js"></script>
<script defer src="pflanzenloader/geometry.js"></script>
<script defer src="pflanzenloader/gartenloader.js"></script>
<script type="module" src="js/main.js"></script>
```

Beim bloßen Laden passiert nichts außer dem Setzen von `window.Pflanze`.

```js
const config = await Pflanze.loadConfig('json/Segge.pflanze.json');
const { geometry, stats } = Pflanze.buildPlant({ config });
// optional, der Garten darf auch sein eigenes Material nehmen:
const material = Pflanze.buildMaterial({ config });

// stats = { height, footprint, footRadius, rootDepth, minY, triangles, vertices, blades }
```

`buildPlant` liefert **nur die Pflanze**: eine `BufferGeometry` mit Position, Normale,
UV und Vertexfarbe. Nicht dabei sind Grundfläche/Wiese, Licht, Schatten, Kamera,
Renderer, Hintergrund und Nebel — das stellt der Garten. Das Feld `schatten` in der
Konfiguration betrifft ausschließlich die Vorschau im Generator und wird beim Export
ignoriert.

| | |
|---|---|
| Einheit | **Meter** (der Generator rechnet in mm, `buildPlant` skaliert) |
| Achsen | y nach oben, rechtshändig |
| Ursprung | (0, 0, 0) = Standpunkt auf der Grasnarbe, waagerecht in der Mitte des Fußkreises |
| `min.y` | negativ — siehe Wurzelpunkt |

### Wurzelpunkt

Die Stiele hören nicht bei y = 0 auf, sondern laufen unter der Grundfläche weiter und
**treffen sich in einem gemeinsamen Punkt** `(0, −rootDepth, 0)`. Der Büschel hat damit
einen echten Fuß statt lauter einzelner Stummel und steht auf geneigtem Gelände
nirgends in der Luft.

Die Tiefe richtet sich nach dem **Fußradius** (`$grundflaeche_radius`, dort treten die
Stiele aus) — nicht nach dem Blattüberhang, denn eintauchen muss der Fuß, nicht die
Blattspitze:

```
rootDepth = max(0,10 m,  footRadius × tan(20°) + 0,03 m)
```

Bei steilerem Gelände über `Pflanze.buildPlant({ config, wurzeltiefe: 0.25 })` erhöhen.
Das Wurzelsegment kostet 4 Dreiecke je Halm.

### Polygonzahl

Die Polygonzahl steckt in der Konfiguration, nicht im Code, und ist je Pflanze frei
wählbar:

```
Dreiecke = $anzahl × ($anzahl_segmente + Stiel + Wurzel) × 4
```

`Segge.pflanze.json` liegt mit 24 Halmen × (3 + 1 + 1) Segmenten × 4 bei **480 Dreiecken**
und damit im Budget. Für die Nahansicht kann derselbe Generator auch 16 800 — dann ist
es aber eine Einzelpflanze am Weg und keine von dreihundert. Immer `stats.triangles`
prüfen.

Der große Hebel für wenig Dreiecke bei gutem Aussehen ist eine **freigestellte Textur**:
wenige breite Halme mit Alpha-PNG (`alphaTest`, kein `transparent`) sehen aus zwei Metern
besser aus als viele schmale Vierecke. `buildMaterial` setzt das passend auf.

### Farbraum

Die Vertexfarben liegen im **linearen** Farbraum. Das passt zu jedem three ab r152,
wo `ColorManagement` standardmäßig an ist — dort ist genau das der Arbeitsfarbraum,
es ist also nichts einzustellen. Geprüft gegen three r147 und r170; die Textur bekommt
je nach Version `colorSpace = SRGBColorSpace` oder ersatzweise das alte `encoding`.

Sollte der Garten ausnahmsweise ohne Farbmanagement rendern, in `geometry.js`
`srgbToLinear` auf `return c;` umstellen.

### Reproduzierbarkeit

Der Aufbau ist vollständig deterministisch — die Halme sitzen auf einer
Fibonacci-Spirale, es kommt kein `Math.random()` vor. Gleiche Konfiguration ergibt
immer identische Vertexdaten. Ein `seed` in der Datei wird deshalb durchgereicht,
aber nicht gebraucht; er schadet auch nicht.

## Direkte Nutzung ohne den Adapter

`loader.js` und `geometry.js` sind ohne Abhängigkeiten und im UMD-Muster geschrieben,
laufen also als `<script>`, unter Node und über Bundler — praktisch, wenn die Geometrie
in mm oder ohne three.js gebraucht wird.

```js
// Konfiguration: validiert, ergänzt fehlende Felder, klemmt Wertebereiche
const { config, warnings } = await PflanzenLoader.fromUrl('ziergras.json');
if (warnings.length) console.warn(warnings);
// ... oder: PflanzenLoader.fromFile(file) / PflanzenLoader.parse(jsonText)

// Geometrie (Y = oben, mm, Ursprung = Büschelmitte)
const data = PflanzenGeometry.buildTuft(config, { wurzeltiefe: 100 });
// data.positions / .normals / .uvs / .colors  → Float32Array
// data.indices                                → Uint16Array | Uint32Array
// data.stats  → { blades, segmentsPerBlade, vertices, triangles, height, minY, radius }
```

Das Material braucht `vertexColors: true` und `side: THREE.DoubleSide`.
Die Vertexfarben liegen bereits im **linearen** Farbraum — passend zu
`renderer.outputEncoding = THREE.sRGBEncoding` und `ColorManagement.legacyMode = false`.
Wird ohne Farbmanagement gerendert, in `geometry.js` einfach `srgbToLinear` auf
`return c;` umstellen.

### Weitere nützliche Funktionen

```js
PflanzenLoader.PARAMS        // Schema: key, type, min, max, step, def, label, hint, group
PflanzenLoader.DEFAULTS      // Standardkonfiguration
PflanzenLoader.normalize(o)  // beliebiges Objekt → { config, warnings }
PflanzenLoader.serialize(c, { name, durchmesser })  // → JSON-String
PflanzenLoader.download(c, dateiname, { name, durchmesser })   // → Datei-Download

PflanzenGeometry.durchmesser(config)   // breitester Durchmesser in der Aufsicht, mm
PflanzenGeometry.makeWidthFn(config)   // (t 0..1) → halbe Halmbreite in mm

Pflanze.normalizeConfig(obj)           // wie oben, gibt direkt die Konfiguration zurück
Pflanze.defaultSink(config)            // voreingestellte Wurzeltiefe in Metern
```

Im Generator selbst steht zusätzlich `window.PflanzenApp` mit
`getConfig()`, `setConfig()`, `generate()`, `resetView()` und `viewer` zur Verfügung —
praktisch zum Ausprobieren in der Browserkonsole.
