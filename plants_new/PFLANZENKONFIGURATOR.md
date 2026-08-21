# Pflanzenkonfigurator — was der Gartensimulator braucht

Kurzfassung dessen, was ein Pflanzengenerator samt eigenem Loader einhalten
muss, damit seine Pflanzen sich in den Garten setzen lassen. Abgeleitet aus dem
Baumkonfigurator (`treeloader/loader.js`), der genau so angebunden ist.

---

## 1. Maße — das Wichtigste

**Ja: in Metern exportieren.** Und dazu diese vier Festlegungen:

| | |
|---|---|
| Einheit | **Meter**, 1 Einheit = 1 m. Keine Skalierung im Garten. |
| Achsen | **y nach oben**, rechtshändig (three.js-Standard) |
| Ursprung | **(0, 0, 0) = Standpunkt auf der Grasnarbe**, nicht der Schwerpunkt und nicht die Unterkante der Hüllbox |
| Blickrichtung | beliebig — der Garten dreht frei um die Hochachse |

**Der Fuß muss unter y = 0 weiterlaufen.** Der Garten setzt eine Pflanze nach
`(x, hf.heightAt(x,z), z)` — auf einen Punkt, nicht auf eine Ebene. Das Gelände
ist geneigt und wird um die Pflanze herum nicht planiert. Wer bei y = 0 aufhört,
schwebt an der Bergseite und steckt an der Talseite im Boden.

Der Baumkonfigurator löst das mit `TRUNK_SINK = 0.14` m: der Stamm wird um
dieses Maß nach unten verlängert und läuft dabei etwas breiter aus
(`TRUNK_FLARE = 1.10`). Für Pflanzen reicht weniger, es muss aber mehr sein als
die Geländeneigung über den Grundriss der Pflanze hergibt:

```
Eintauchtiefe  ≥  halber Grundrissdurchmesser × tan(größte Hangneigung)
```

Bei 0,6 m Durchmesser und 20° Hang sind das gut 11 cm. **Faustregel: 10 cm,
und bei Pflanzen mit breitem Fuß entsprechend mehr.** Ein Wurzelanlauf (unten
etwas breiter) kaschiert den Übergang zusätzlich.

Prüfmaß nach dem Export: `boundingBox.min.y` muss **negativ** sein.

### Größenordnung

Der Garten ist per Voreinstellung 100 m im Quadrat, die Wege sind 1,5 m breit,
die Augenhöhe liegt bei 1,30 m. Eine Pflanze von 0,2 bis 2 m ist der sinnvolle
Bereich; darüber wird es ein Strauch und konkurriert mit den Bäumen.

---

## 2. Was der Loader liefern muss

Der Loader wird als **klassische Datei** eingebunden (nicht als ES-Modul), hängt
sich an ein einziges globales Objekt und erwartet `window.THREE`. `index.html`
setzt das vor dem Modulstart; der Pflanzenloader kommt dann daneben:

```html
<script type="module">
  import * as THREE from 'three';
  window.THREE = THREE;
</script>
<script defer src="treeloader/loader.js"></script>
<script defer src="pflanzenloader/loader.js"></script>
<script type="module" src="js/main.js"></script>
```

Aufgeschobene klassische Dateien und Module laufen in Dokumentreihenfolge — die
Reihenfolge ist damit garantiert.

Gebraucht werden nur drei Dinge, alle **kopflos** (ohne Renderer, ohne Szene,
ohne Licht, ohne Kamera, ohne Boden, ohne Gras):

```js
window.Pflanze = {
  loadConfig(url)  -> Promise<config>   // .json holen und auffüllen
  normalizeConfig(obj) -> config        // fehlende Werte ergänzen
  buildPlant(opt)  -> {
    geometry,                           // BufferGeometry, Weltmaßstab, Ursprung am Fuß
    stats: { height, footprint, … }     // Höhe und Grundrissdurchmesser in Metern
  }
}
```

`footprint` ist derselbe Wert, der in der Pflanzendatei als `durchmesser` steht —
der breiteste Durchmesser in der Aufsicht, dort allerdings in Millimetern. Für
die Schattenkarte reicht damit das Lesen der `.json`, die Geometrie muss dafür
nicht gebaut werden. Die Beet-Datei (`gartensimulator/beet`) führt ihn je
Exemplar zusätzlich bereits mit der Skalierung verrechnet in Metern.

Hat die Pflanze Blätter oder Blüten als Instanzen (wie die Bäume), dann bitte
genauso getrennt:

```js
buildLeafGeometry(opt) -> BufferGeometry            // ein Blatt, im Ursprung
placeLeaves(skel, opt, (i, matrix, color) => …)     // Rückruf je Instanz
```

Der Garten multipliziert die Instanzmatrizen mit der Standortmatrix und legt
alle Blätter **aller** Exemplare einer Sorte in **ein** InstancedMesh. Deshalb
darf `placeLeaves` keine Meshes anlegen, sondern nur Matrizen melden.

**Was der Loader nicht mitbringen darf:** eine `View`-Funktion mit eigenem
Renderer ist in Ordnung (der Konfigurator braucht sie), sie darf aber beim
bloßen Laden der Datei nichts starten. Und: keine Grashalme, keine Bodenscheibe,
kein Nebel — das alles stellt der Garten.

---

## 3. Konfigurationsdateien

Eine Pflanze ist eine `.json` im Verzeichnis `json/`, flach nach Gruppen
sortiert, genau wie `*.baum.json`:

```json
{ "v": 1, "seed": 137, "pflanze": { … }, "blatt": { … }, "env": { … },
  "flags": { … }, "tex": "data:image/jpeg;base64,…", "texName": "rinde.jpg" }
```

- **Texturen als Datenadresse** (`data:`-URL) mitspeichern, wie beim Baum. Dann
  ist eine Pflanzendatei für sich vollständig und der Garten braucht keine
  zusätzlichen Bilddateien.
- **`seed` gehört in die Datei.** Gleicher Startwert → gleiche Pflanze, sonst
  ändert sich der Garten bei jedem Neuaufbau.
- Endung **`.pflanze.json`**, damit der Garten Baum- und Pflanzendateien
  auseinanderhalten kann.

Eingetragen werden sie in dieselbe Namensliste wie die Bäume
(`json/baeume.json`), zunächst als eigene Gruppe:

```json
{
  "standard": ["default.baum.json"],
  "baeume":   [ { "name": "Mike", "baum": "Birke.baum.json" } ],
  "pflanzen": ["Farn.pflanze.json", "Storchschnabel.pflanze.json"]
}
```

---

## 4. Zahlenrahmen

Der Garten steht bei den Voreinstellungen bei rund 6,4 Mio. Dreiecken und
60 fps. Davon gehen 5,7 Mio. auf zwölf Bäume. Für Pflanzen bleibt also **nicht
viel Luft**, und Pflanzen kommen nicht zu zwölft, sondern zu Hunderten.

| | Richtwert |
|---|---|
| Dreiecke je Pflanze | **unter 500**, lieber 100–200 |
| Blätter je Pflanze | unter 100 Instanzen, oder ganz ohne Instanzen |
| Rechenzeit je Sorte | unter 50 ms (der Baum braucht 90–400 ms und ist damit an der Grenze) |
| Sorten gleichzeitig | 3–8 |

Zum Vergleich, gemessen: ein Baum aus dem Baumkonfigurator hat 33 000 bis
278 000 Dreiecke im Holz und 21 000 bis 50 000 Blätter. Das ist für ein
Einzelstück am Weg richtig und für 300 Stauden völlig unmöglich.

**Der Hebel ist dieselbe Technik wie bei den Blättern: wenige große Vierecke mit
freigestellter Textur** (`alphaTest`, kein echtes Alpha — sonst müsste nach
Tiefe sortiert werden). Eine Staude aus acht texturierten Vierecken hat
16 Dreiecke und sieht aus zwei Metern Entfernung besser aus als 2000 einzeln
gerechnete Blättchen.

---

## 5. Materialien

- Vertexfarben nutzen (`vertexColors: true`), Materialfarbe weiß lassen. So
  reicht **ein** Material je Sorte, und die Streuung sitzt in den Instanzen.
- Blattflächen `side: THREE.DoubleSide` — man sieht von unten hinein.
- Freistellen über `alphaTest: 0.5`, nicht über `transparent: true`.
- Kein eigener Nebel, keine eigenen Lichtparameter: `MeshStandardMaterial` mit
  `roughness` um 1 fügt sich in die Beleuchtung des Gartens ein.
- Schattenwurf: Blätter und Halme werfen im Garten **keinen** Schatten
  (Hunderttausende Instanzen im Schattendurchgang kosten die halbe Bildrate und
  ergeben nur Rauschen). Stämme und Stängel dürfen.

---

## 6. Reproduzierbarkeit

Alles Zufällige läuft über den Startwert des Gartens. Der Konfigurator muss
dafür nur eines liefern: **bei gleichem `seed` in der Datei genau dieselbe
Geometrie.** Kein `Math.random()` im Aufbau — der Baumkonfigurator benutzt
`mulberry32`, das reicht.

Die Standorte, die Sortenwahl und die Drehung um die Hochachse würfelt der
Garten selbst aus seinem eigenen, nach Gewerk getrennten Zufallsstrom.

---

## 7. Checkliste vor dem ersten Einbau

- [ ] `boundingBox`: Höhe plausibel in Metern, `min.y` negativ (Fuß im Boden)
- [ ] Ursprung waagerecht in der Mitte des Grundrisses
- [ ] Dreiecke je Pflanze unter 500
- [ ] `window.Pflanze` gesetzt, sonst nichts Globales
- [ ] Beim bloßen Laden der Datei passiert nichts (kein Renderer, keine Schleife)
- [ ] Zweimal mit gleichem `seed` gebaut → identische Vertexdaten
- [ ] Textur als `data:`-URL in der `.json`
- [ ] Kein Gras, kein Boden, kein Himmel in der Ausgabe
