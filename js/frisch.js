/**
 * Zeitstempel an jede zur Laufzeit geladene Adresse.
 *
 * Der Anlass: nach einer Aenderung an `scene.js` lief der Garten mit der alten
 * Fassung weiter und meldete, eine frisch hinzugefuegte Funktion des Viewers
 * gebe es nicht. Schuld war der Browsercache - `python -m http.server` schickt keinerlei
 * Cache-Vorgaben, also raet der Browser und behaelt Dateien.
 *
 * Fuer alles, was zur Laufzeit nachgeladen wird - Baum- und Beetdateien,
 * Namenslisten, Bildtexturen -, genuegt dieser Anhang. Die **ES-Module** selbst
 * erreicht er nicht: deren `import`-Pfade stehen fest im Quelltext, und eine
 * Abfrage am Modulpfad vererbt sich nicht auf dessen eigene Importe. Dagegen
 * hilft nur, dass der Server es sagt - `dev-server.py` schickt deshalb
 * `Cache-Control: no-store`.
 */

// Ein Stempel je Sitzung, nicht je Aufruf: sonst laedt derselbe Baum bei jedem
// Neuaufbau des Gartens neu herunter, und der Bauplancache in baumloader.js
// liefe ins Leere.
const STEMPEL = Date.now();

export function frisch(url) {
  if (!url || /^data:/i.test(url)) return url;      // eingebettete Bilder nicht anfassen
  if (/[?&]t=\d+$/.test(url)) return url;           // schon gestempelt, nicht doppelt
  return url + (url.includes('?') ? '&' : '?') + 't=' + STEMPEL;
}

// Auch global, denn der Pflanzen-Konfigurator (`plantloader/`) besteht aus
// klassischen Dateien und kann dieses Modul nicht importieren. Sie laden
// selbst nach, was in ihren Konfigurationsdateien als Pfad steht - etwa die
// Halmtextur einer Pflanze. Denselben Weg geht index.html mit `window.THREE`.
globalThis.frisch = frisch;
