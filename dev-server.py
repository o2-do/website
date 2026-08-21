#!/usr/bin/env python3
"""
Entwicklungsserver fuer den Gartensimulator.

Wie `python -m http.server`, aber mit `Cache-Control: no-store`. Der Grund:
`http.server` schickt gar keine Cache-Vorgaben, also raet der Browser und
behaelt Dateien - nach einer Aenderung lief der Garten mit einer alten
Fassung weiter und meldete Methoden als "is not a function".

Der Zeitstempel aus `js/frisch.js` deckt nur ab, was zur Laufzeit nachgeladen
wird (Baumdateien, Texturen). Die ES-Module erreicht er nicht: deren
`import`-Pfade stehen fest im Quelltext. Dagegen hilft nur diese Kopfzeile.

    python3 dev-server.py [Port]

Ohne Portangabe gilt die Umgebungsvariable PORT, sonst 8123 - so laesst sich
ein zweiter Server daneben starten, ohne dem ersten den Port wegzunehmen.
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NichtZwischenspeichern(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # Nur Fehler melden; jede Texturanfrage zu protokollieren macht die
        # Konsole unbrauchbar.
        if args and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT') or 8123)
    handler = partial(NichtZwischenspeichern, directory='.')
    with ThreadingHTTPServer(('127.0.0.1', port), handler) as srv:
        print(f'Gartensimulator auf http://localhost:{port}/  (kein Cache)')
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print('\nbeendet')


if __name__ == '__main__':
    main()
