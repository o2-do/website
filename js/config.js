// Parameter-Schema. Aus dieser Liste wird das Formular unter dem Canvas
// generiert; neue Parameter brauchen nur hier einen Eintrag.
// live: true  -> wirkt sofort, ohne den Garten neu zu bauen.

export const SCHEMA = [
  { group: 'Allgemein', key: 'seed', label: 'Startwert', type: 'text', default: 'garten-01' },

  // Wie steil der Boden hoechstens sein darf, damit dort noch etwas gepflanzt
  // wird. Gilt fuer Baeume wie fuer Beete und wird am MITTELPUNKT geprueft -
  // ein Baum steht auf einem Punkt, und ein Beet, dessen Mitte flach liegt,
  // liegt als Ganzes flach genug.
  { group: 'Wiese', key: 'maxNeigung', label: 'Max. Neigung fuer Bewuchs', unit: 'Grad', type: 'range', min: 10, max: 70, step: 1, default: 40 },
  { group: 'Wiese', key: 'durchmesser', label: 'Gartendurchmesser', unit: 'm', type: 'range', min: 20, max: 200, step: 5, default: 100 },
  // Erhebung und Senke getrennt, gemessen von Null - und Null ist der Rand des
  // Gartens, an dem die Horizontscheibe anschliesst. Zusammen ergeben sie den
  // Hoehenunterschied zwischen tiefstem und hoechstem Punkt der Wiese.
  { group: 'Wiese', key: 'maxHoehe', label: 'Max. Verformung über Null', unit: 'cm', type: 'range', min: 0, max: 1200, step: 5, default: 30 },
  { group: 'Wiese', key: 'maxTiefe', label: 'Max. Verformung unter Null', unit: 'cm', type: 'range', min: 0, max: 1200, step: 5, default: 30 },
  { group: 'Wiese', key: 'staerke', label: 'Staerke der Verformung', unit: 'wenig – viel', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  { group: 'Wiese', key: 'randAuslauf', label: 'Randauslauf', unit: '× Radius', type: 'range', min: 0.05, max: 0.6, step: 0.05, default: 0.2 },
  // Wie weit das Gelaende geglaettet wird, als Radius eines Gaussfilters.
  // Wirkt nicht auf das fertige Netz, sondern auf die Wellen, aus denen es
  // entsteht (siehe `terrain.js`) - und kostet deshalb nichts. Gross heisst:
  // nur noch die weiten Formen bleiben, jede feine Falte verschwindet.
  { group: 'Wiese', key: 'gelaendeGlaettung', label: 'Gelaende glaetten', unit: 'm (0 = aus)', type: 'range', min: 0, max: 8, step: 0.25, default: 2 },
  { group: 'Wiese', key: 'gitter', label: 'Gitterweite', unit: 'm', type: 'range', min: 0.25, max: 2, step: 0.05, default: 0.5 },
  { group: 'Wiese', key: 'kachelWiese', label: 'Texturkachel Wiese', unit: 'm', type: 'range', min: 0.5, max: 10, step: 0.25, default: 2 },

  { group: 'Wege', key: 'attraktoren', label: 'Attraktoren je Richtung', unit: '× dasselbe', type: 'range', min: 4, max: 20, step: 1, default: 10 },
  { group: 'Wege', key: 'attraktorenEcken', label: 'Eckattraktoren entfernen', unit: 'je Ecke', type: 'select', options: [1, 3, 6, 10], default: 3 },
  { group: 'Wege', key: 'attraktorenAnteil', label: 'Erhaltene Attraktoren', unit: '%', type: 'range', min: 10, max: 100, step: 5, default: 40 },
  { group: 'Wege', key: 'wegRand', label: 'Abstand vom Gartenrand', unit: '% der Breite', type: 'range', min: 0, max: 20, step: 1, default: 8 },
  { group: 'Wege', key: 'wegGlaettung', label: 'Glaettungsradius', unit: 'm', type: 'range', min: 0, max: 50, step: 0.5, default: 25 },
  { group: 'Wege', key: 'maxAbkuerzungen', label: 'Max. Anzahl Abkuerzungen', unit: '0 = keine', type: 'range', min: 0, max: 20, step: 1, default: 6 },
  { group: 'Wege', key: 'wegBreite', label: 'Wegbreite Rundweg', unit: 'm', type: 'range', min: 0.5, max: 4, step: 0.1, default: 1.5 },
  // Eine Abkuerzung ist ein Trampelpfad und darf schmaler sein als der
  // angelegte Rundweg. Belag und Kachelung hat sie schon fuer sich; die Breite
  // war das Letzte, was noch am Rundweg hing.
  { group: 'Wege', key: 'wegBreiteAbk', label: 'Wegbreite Abkuerzung', unit: 'm', type: 'range', min: 0.3, max: 4, step: 0.1, default: 1.0 },
  // WIE LANG DER ANLAUF VOR EINER EINMUENDUNG IST.
  //
  // Quer waagerecht zu liegen ist das Prinzip jedes Weges - der Rundweg bleibt
  // ihm ausnahmslos treu. Eine Abkuerzung kann es an ihrer Muendung nicht: dort
  // erbt ihre Stirnseite die Querneigung des Rundwegs, und zwei Meter davor
  // laege sie wieder waagerecht. Genau das war der Knick.
  //
  // Deshalb gibt sie ihre waagerechte Lage schon vorher auf - erst kaum, dann
  // immer mehr. Dieser Wert sagt, wie viele Meter vor der Muendung das beginnt.
  // 0 schaltet den Anlauf ab und laesst den Knick stehen.
  { group: 'Wege', key: 'wegAnlauf', label: 'Anlauf vor der Einmuendung', unit: 'm (0 = ohne)', type: 'range', min: 0, max: 12, step: 0.5, default: 4 },
  // DIE BOESCHUNG NEBEN DEM WEG.
  //
  // Ein Weg liegt quer waagerecht, das Gelaende nicht. Am Hang steht seine
  // untere Kante deshalb ueber dem Boden - bei anderthalb Metern Breite und
  // 30 % Gefaelle gut zwanzig Zentimeter. Die Wiese daneben liegt auf
  // Gelaendehoehe, und dazwischen faellt sie auf einem halben Meter ab: eine
  // Stufe von 35 Grad.
  //
  // Dieser Wert sagt, ueber wie viele Meter dieser Absatz auslaeuft. Die
  // Wiesenpunkte werden dafuer nur ANGEHOBEN, nie gesenkt: an der oberen
  // Wegkante schneidet der Weg in den Hang, und dort soll die Boeschung
  // stehenbleiben, wie sie ist.
  { group: 'Wege', key: 'wegBoeschung', label: 'Boeschung neben dem Weg', unit: 'm (0 = aus)', type: 'range', min: 0, max: 6, step: 0.1, default: 1.5 },
  { group: 'Wege', key: 'kachelWeg', label: 'Texturkachel Weg', unit: 'm', type: 'range', min: 0.3, max: 4, step: 0.1, default: 1.5 },
  { group: 'Wege', key: 'kachelAbk', label: 'Texturkachel Abkuerzung', unit: 'm', type: 'range', min: 0.3, max: 4, step: 0.1, default: 1.0 },

  { group: 'Felsen', key: 'felsSorten', label: 'Unterschiedliche Felsen', type: 'range', min: 1, max: 20, step: 1, default: 10 },
  { group: 'Felsen', key: 'felsMenge', label: 'Anzahl Haufen', unit: 'wenig – viel', type: 'range', min: 0, max: 120, step: 1, default: 20 },
  { group: 'Felsen', key: 'felsProHaufenMin', label: 'Brocken je Haufen (min)', type: 'range', min: 1, max: 12, step: 1, default: 3 },
  { group: 'Felsen', key: 'felsProHaufenMax', label: 'Brocken je Haufen (max)', type: 'range', min: 1, max: 20, step: 1, default: 8 },
  { group: 'Felsen', key: 'felsMin', label: 'Brockengroesse min', unit: 'm', type: 'range', min: 0.1, max: 3, step: 0.1, default: 0.5 },
  { group: 'Felsen', key: 'felsMax', label: 'Brockengroesse max', unit: 'm', type: 'range', min: 0.2, max: 6, step: 0.1, default: 2.0 },
  { group: 'Felsen', key: 'felsVerzerrung', label: 'Verzerrung je Brocken', unit: '± %', type: 'range', min: 0, max: 50, step: 1, default: 20 },
  { group: 'Felsen', key: 'felsEinsinken', label: 'Im Boden versenkt', unit: '× Hoehe', type: 'range', min: 0, max: 0.9, step: 0.05, default: 0.5 },
  { group: 'Felsen', key: 'felsDetail', label: 'Felsaufloesung', unit: 'Subdivisions', type: 'range', min: 1, max: 3, step: 1, default: 2 },
  // NEGATIV HEISST: IN DEN WEG HINEIN.
  //
  // Gemessen wird vom Umriss des gedrehten Brockens zur Wegkante. Bei null
  // stoesst er genau an, darunter liegt er auf dem Belag - ein Findling, um den
  // herum der Weg gebaut wurde. Der Schatten macht das mit: der Weg nimmt die
  // eingebrannte Bodenkarte genauso an wie die Wiese, und beim gerechneten
  // Schatten wirft der Fels ohnehin auf alles, was ihn empfaengt.
  { group: 'Felsen', key: 'felsAbstandWegMin', label: 'Abstand zur Wegkante (min)', unit: 'm', type: 'range', min: -0.4, max: 4, step: 0.05, default: -0.2 },
  { group: 'Felsen', key: 'felsAbstandWegMax', label: 'Abstand zur Wegkante (max)', unit: 'm', type: 'range', min: -0.4, max: 8, step: 0.05, default: 2.5 },
  { group: 'Felsen', key: 'kachelFels', label: 'Texturkachel Fels', unit: 'm', type: 'range', min: 0.2, max: 4, step: 0.1, default: 1.0 },

  // Ein Baum ist ein Holznetz und ein Laubnetz aus Rechtecken - zusammen ein
  // paar tausend Dreiecke. Deshalb wird er gezeichnet, wie er in der Datei
  // steht; Detailstufen, Puschel und Stellvertreter sind ersatzlos entfallen.
  // Was bleibt, ist die gebackene Seitenansicht fuer die Ferne (Gruppe
  // „Ferne“) und der Schatten aus dem Paket (siehe unten).
  { group: 'Baeume', key: 'baumListe', label: 'Namen und Baeume', type: 'file', accept: '.json', default: 'json/baeume.json' },
  { group: 'Baeume', key: 'anzahlBaeume', label: 'Anzahl Baeume', unit: 'inkl. der benannten', type: 'range', min: 0, max: 120, step: 1, default: 12 },
  { group: 'Baeume', key: 'stammAbstandWeg', label: 'Abstand zur Wegkante', unit: 'm', type: 'range', min: 0, max: 8, step: 0.25, default: 2 },
  { group: 'Baeume', key: 'stammAbstand', label: 'Mindestabstand untereinander', unit: 'm', type: 'range', min: 1, max: 25, step: 0.5, default: 8 },
  // Alle Baeume einer Sorte sind dasselbe Netz. Groesse und Blattfarbe sind
  // das Einzige, was sie unterscheiden darf - beides kostet nichts, weil es je
  // Instanz im Shader wirkt und nicht am Netz.
  { group: 'Baeume', key: 'baumStreuung', label: 'Groessenstreuung', unit: '± %', type: 'range', min: 0, max: 40, step: 1, default: 15 },
  { group: 'Baeume', key: 'blattTon', label: 'Blatthelligkeit', unit: '%', type: 'range', min: 40, max: 160, step: 5, default: 100 },
  // Nur Helligkeit, kein Farbton: welche Farbe ein Baum hat, entscheidet die
  // Baumdatei (`laubfarben`), nicht dieser Regler. Er sorgt dafuer, dass zwei
  // Baeume derselben Variante nicht wie gestempelt nebeneinanderstehen.
  { group: 'Baeume', key: 'blattStreuung', label: 'Blatthelligkeit streut', unit: '± %', type: 'range', min: 0, max: 40, step: 1, default: 8 },

  // Der Zaun folgt der Gartenkante, an den Ecken unter 45 Grad abgeschnitten -
  // und zwar genau so weit, wie das Attraktorraster dort Punkte auslaesst
  // (siehe `zaun.js`). Deshalb hat er keine eigenen Masse im Formular: seine
  // Gestalt steht schon unter „Wege".
  { group: 'Zaun', key: 'zaun', label: 'Zaun um den Garten', type: 'checkbox', default: true },
  // Die Schwelle zwischen den Torsaeulen - sie deckt die Stossfuge der beiden
  // Zugangswege ab (siehe `buildBordstein` in `zaun.js`).
  { group: 'Zaun', key: 'bordstein', label: 'Schwelle im Tor', type: 'checkbox', default: false },
  // GELAENDER STATT ZAUN: dieselben Pfosten und Querhoelzer, aber am Weg statt
  // an der Grenze. Gesetzt werden sie dort, wo es neben dem Weg steil bergab
  // geht - das ist am Gartenrand die Regel, weil dort die Boeschung keinen
  // Platz mehr hat.
  { group: 'Zaun', key: 'gelaender', label: 'Gelaender an steilen Wegen', type: 'checkbox', default: true },
  { group: 'Zaun', key: 'gelaenderAb', label: 'Gelaender ab Gefaelle', unit: 'Grad', type: 'range', min: 10, max: 60, step: 1, default: 28 },

  { group: 'Schilder', key: 'schriftGroesse', label: 'Schriftgroesse', unit: 'm', type: 'range', min: 0.04, max: 0.3, step: 0.005, default: 0.12 },
  { group: 'Schilder', key: 'schildRand', label: 'Rand um die Schrift', unit: 'm', type: 'range', min: 0.01, max: 0.2, step: 0.005, default: 0.05 },
  { group: 'Schilder', key: 'schildMitteHoehe', label: 'Schildmitte ueber Grund', unit: 'm', type: 'range', min: 0.3, max: 2.5, step: 0.05, default: 1.3 },
  { group: 'Schilder', key: 'pfahlDurchmesser', label: 'Pfahldurchmesser', unit: 'm', type: 'range', min: 0.02, max: 0.2, step: 0.01, default: 0.05 },
  { group: 'Schilder', key: 'pfahlAbstandWeg', label: 'Abstand zur Wegkante', unit: 'm', type: 'range', min: 0, max: 1, step: 0.05, default: 0.1 },

  { group: 'Gras 1 – Wegrand', key: 'halmeTyp1', label: 'Halme je Bueschel', type: 'range', min: 0, max: 400, step: 10, default: 200 },
  { group: 'Gras 1 – Wegrand', key: 'wegSegment', label: 'Laenge eines Wegsegments', unit: 'm', type: 'range', min: 0.5, max: 8, step: 0.5, default: 2 },
  { group: 'Gras 1 – Wegrand', key: 'grasBreiteWeg', label: 'Reicht in die Wiese', unit: 'm', type: 'range', min: 0.2, max: 3, step: 0.1, default: 1 },

  { group: 'Gras 2 – Wiese', key: 'halmeTyp2', label: 'Halme je Bueschel', type: 'range', min: 0, max: 400, step: 10, default: 100 },
  { group: 'Gras 2 – Wiese', key: 'anzahlBueschel2', label: 'Anzahl Bueschel', type: 'range', min: 0, max: 1500, step: 10, default: 300 },
  { group: 'Gras 2 – Wiese', key: 'bueschelD2', label: 'Durchmesser', unit: 'm', type: 'range', min: 0.2, max: 2, step: 0.1, default: 0.5 },

  { group: 'Gras 3 – am Stamm', key: 'halmeTyp3', label: 'Halme je Bueschel', type: 'range', min: 0, max: 400, step: 10, default: 200 },
  { group: 'Gras 3 – am Stamm', key: 'bueschelD3', label: 'Durchmesser', unit: 'm', type: 'range', min: 0.5, max: 4, step: 0.1, default: 1.5 },

  { group: 'Halme (alle Sorten)', key: 'halmHoeheMin', label: 'Hoehe min', unit: 'm', type: 'range', min: 0.05, max: 1, step: 0.01, default: 0.15 },
  { group: 'Halme (alle Sorten)', key: 'halmHoeheMax', label: 'Hoehe max', unit: 'm', type: 'range', min: 0.05, max: 1.5, step: 0.01, default: 0.35 },
  { group: 'Halme (alle Sorten)', key: 'halmBreite', label: 'Breite', unit: 'm', type: 'range', min: 0.005, max: 0.1, step: 0.005, default: 0.02 },
  { group: 'Halme (alle Sorten)', key: 'halmNeigung', label: 'Max. Neigung', unit: '°', type: 'range', min: 0, max: 45, step: 1, default: 10 },
  // Jenseits dieser Entfernung werden ganze Grassektoren abgeschaltet. Das
  // Sichtvolumen allein sortiert nur nach Richtung aus; wer vom Rand quer
  // durch den Garten schaut, hat sonst alle 122 000 Halme im Bild, von denen
  // die meisten zwei Bildpunkte hoch sind. 0 hebt die Grenze auf.
  { group: 'Halme (alle Sorten)', key: 'grasWeite', label: 'Halme sichtbar bis', unit: 'm (0 = ohne Grenze)', type: 'range', min: 0, max: 120, step: 5, default: 40, live: true },

  // Welche Pflanzen gebaut werden, sagen seit Fassung 2 die Beete selbst: sie
  // nennen ihre Arten beim Dateinamen. Der frueher noetige Regler „Verwendete
  // Arten" waere jetzt eine zweite Meinung ueber einen Entwurf, den der
  // Beetkonfigurator schon getroffen hat.
  { group: 'Pflanzen', key: 'anzahlBeete', label: 'Anzahl Beete', type: 'range', min: 0, max: 120, step: 1, default: 24 },
  { group: 'Pflanzen', key: 'beetAbstandMin', label: 'Abstand von der Wegkante (min)', unit: 'm', type: 'range', min: 0, max: 10, step: 0.1, default: 0.4 },
  { group: 'Pflanzen', key: 'beetAbstandMax', label: 'Abstand von der Wegkante (max)', unit: 'm', type: 'range', min: 0, max: 15, step: 0.1, default: 3 },

  // Der Tuempel: eine Mulde in der Wiese und eine Scheibe darin. Der Platz
  // wird gesucht, nicht gewuerfelt - unter vierhundert Kandidaten gewinnt der
  // ebenste, denn ein Tuempel am Hang laeuft aus und man sieht es ihm an.
  // Als benannte Wahl und nicht als Haken: so steht in der gespeicherten Datei
  // „mit See" und nicht „true", und wer sie spaeter liest, muss nicht raten.
  { group: 'Wasser', key: 'see', label: 'See im Garten', type: 'select', options: ['mit See', 'ohne See'], default: 'mit See' },
  { group: 'Wasser', key: 'teichDurchmesser', label: 'Durchmesser des Sees', unit: 'm', type: 'range', min: 1, max: 20, step: 0.5, default: 5 },
  // Was die Wasserflaeche kostet:
  //   einfarbig   eine Flaeche in einer Farbe - so teuer wie jedes Dreieck
  //   spiegel     die Szene wird je Bild ein zweites Mal gezeichnet (~0,24 ms)
  { group: 'Wasser', key: 'wasserQualitaet', label: 'Spiegelung', type: 'select', options: ['einfarbig', 'spiegel'], default: 'spiegel' },
  // Wie viel Wasserfarbe sich ueber das Spiegelbild legt. Null ist der reine
  // Spiegel; wirkt sofort, ohne Neuaufbau.
  { group: 'Wasser', key: 'wasserToenung', label: 'Toenung des Spiegels', unit: '%', type: 'range', min: 0, max: 100, step: 5, default: 0, live: true },

  // Zypressen stehen zu dritt: zweimal die eine Vorlage, einmal die andere,
  // im gleichseitigen Dreieck. Einzeln gesetzt saehen sie aus wie Pfosten.
  { group: 'Zypressen', key: 'zypressenGruppen', label: 'Anzahl Gruppen', unit: 'à 3 Baeume', type: 'range', min: 0, max: 40, step: 1, default: 5 },
  { group: 'Zypressen', key: 'zypressenAbstand', label: 'Abstand im Dreieck', unit: 'm', type: 'range', min: 0.5, max: 8, step: 0.25, default: 2 },
  { group: 'Zypressen', key: 'zypressenAbstandWeg', label: 'Abstand zur Wegkante', unit: 'm', type: 'range', min: 0, max: 8, step: 0.25, default: 1.5 },

  { group: 'Waldhorizont', key: 'wald', label: 'Wald am Horizont', type: 'checkbox', default: true, live: true },
  { group: 'Waldhorizont', key: 'waldAbstand', label: 'Abstand von der Mitte', unit: '× Gartenradius', type: 'range', min: 1.1, max: 8, step: 0.1, default: 3, live: true },
  { group: 'Waldhorizont', key: 'waldHoehe', label: 'Hoehe der Baeume', unit: 'm', type: 'range', min: 5, max: 80, step: 1, default: 28, live: true },

  { group: 'Ansicht', key: 'rasterWeite', label: 'Belegungsraster', unit: 'm', type: 'range', min: 0.05, max: 0.5, step: 0.05, default: 0.15 },
  // Raeumliches Aufteilen: Gras, Pflanzen, Felsen und Beetboeden entstehen je
  // Sektor als eigenes Netz, damit das Sichtvolumen ganze Felder verwerfen
  // kann. 0 schaltet es ab - dann steht jedes Gewerk wieder als ein einziges
  // gartenweites Netz da und wird immer vollstaendig gezeichnet.
  { group: 'Ansicht', key: 'sektorWeite', label: 'Sektorweite', unit: 'm (0 = aus)', type: 'range', min: 0, max: 50, step: 2, default: 16 },
  // Gegenlicht-Trick fuer Blaetter und Pflanzen: wo die Sonne von hinten auf
  // die Flaeche faellt, glimmt sie in ihrer eigenen Farbe. Kostet ein
  // Skalarprodukt je Fragment und wirkt sofort.
  { group: 'Ansicht', key: 'transluzenz', label: 'Transluzenz (Blaetter, Pflanzen)', unit: '%', type: 'range', min: 0, max: 100, step: 5, default: 45, live: true },
  // --- Schatten, ein Schalter -----------------------------------------------
  //
  //   aus          Kein Schatten, nirgends.
  //   simpel       Alles wird EINMAL beim Aufbau in eine Bodenkarte gebrannt:
  //                Baumkronen aus dem gerechneten Riss der Baumdatei, Pflanzen
  //                und Felsen als weiche Kreise (`bodenkarte.js`). Danach
  //                kostet der Schatten nichts mehr - kein Durchgang je Bild,
  //                keine Lichtquelle. Dafuer liegt er flach auf dem Boden:
  //                senkrechte Flaechen bleiben unbeschattet.
  //   detailliert  Echter Wurf je Objekt. Baeume werfen dabei nicht mit Krone
  //                und Geaest, sondern mit der unsichtbaren Schattenkarte aus
  //                ihrer Datei - zwei Dreiecke statt tausender. Felsen,
  //                Schilder und Pflanzen werfen mit ihrer Geometrie; Gras nie
  //                (122 000 Halme gegen 480 Pflanzen).
  //
  // „detailliert" rechnet die Karte EINMAL und friert sie ein: Sonne und
  // Garten stehen fest, es gibt nichts nachzufuehren, und der Schattendurchgang
  // je Bild faellt ersatzlos weg.
  { group: 'Ansicht', key: 'schatten', label: 'Schatten', type: 'select', options: ['aus', 'simpel', 'detailliert'], default: 'simpel', live: true },
  { group: 'Ansicht', key: 'bodenkartePx', label: 'Aufloesung „simpel“', unit: 'px', type: 'select', options: [1024, 2048, 4096], default: 2048 },

  // --- Ferne ----------------------------------------------------------------
  // Jenseits der Grenze steht statt des Baums seine gebackene Seitenansicht:
  // ein Rechteck mit zwei Dreiecken, das sich im Shader zur Kamera dreht. Das
  // Bild liegt fertig in der Baumdatei; gerechnet wird dafuer nichts.
  //
  // Es gilt nur in Augenhoehe. Aus der Vogelperspektive schaut man der Tafel
  // von oben auf die flache Seite - dort stehen immer die echten Baeume.
  // 0 heisst: keine Tafeln, ueberall der volle Baum.
  { group: 'Ferne', key: 'tafelAb', label: 'Tafel statt Baum ab', unit: 'm (0 = nie)', type: 'range', min: 0, max: 120, step: 1, default: 25, live: true },
  // Damit ein Baum an der Grenze nicht bei jedem Schritt hin und her springt,
  // liegt die Rueckkehr zum Netz ein Stueck naeher als der Wechsel zur Tafel.
  { group: 'Ferne', key: 'tafelBand', label: 'Uebergangsband', unit: 'm', type: 'range', min: 0.5, max: 10, step: 0.5, default: 2, live: true },
  { group: 'Ansicht', key: 'schattenAufloesung', label: 'Aufloesung „detailliert“', unit: 'px', type: 'select', options: [1024, 2048, 4096, 8192], default: 2048, live: true },
  // Der Blickwinkel des Objektivs in Augenhoehe. Das Mausrad zieht den
  // Ausschnitt darueber hinaus enger, ohne diesen Wert zu vergessen: im HUD
  // steht deshalb der wirksame Winkel UND der Zoomfaktor.
  { group: 'Ansicht', key: 'blickwinkel', label: 'Blickwinkel (Augenhoehe)', unit: '°', type: 'select', options: [45, 50, 55, 60], default: 60, live: true },
  { group: 'Ansicht', key: 'nebel', label: 'Nebeldichte', type: 'range', min: 0, max: 0.02, step: 0.0005, default: 0.0045, live: true },
  { group: 'Ansicht', key: 'drahtgitter', label: 'Drahtgitter', type: 'checkbox', default: false, live: true },
  { group: 'Ansicht', key: 'horizont', label: 'Horizontradius', unit: 'm', type: 'range', min: 200, max: 1500, step: 50, default: 600 },
];

export function defaults() {
  const cfg = {};
  for (const f of SCHEMA) cfg[f.key] = f.default;
  return cfg;
}

// Abgeleitete Werte / Plausibilisierung an einer Stelle.
export function normalize(cfg) {
  const c = { ...cfg };
  c.felsProHaufenMax = Math.max(c.felsProHaufenMin, c.felsProHaufenMax);
  c.felsMax = Math.max(c.felsMin, c.felsMax);
  c.felsProHaufen = [c.felsProHaufenMin, c.felsProHaufenMax];
  c.beetAbstandMax = Math.max(c.beetAbstandMin, c.beetAbstandMax);
  c.felsAbstandWegMax = Math.max(c.felsAbstandWegMin, c.felsAbstandWegMax);
  c.halmHoeheMax = Math.max(c.halmHoeheMin, c.halmHoeheMax);

  // Schildhoehe folgt der Schriftgroesse (kein Umbruch, feste Schrift), die
  // Pfahlhoehe folgt daraus, damit die Schildmitte auf der gewuenschten Hoehe
  // sitzt. Beides deshalb abgeleitet statt frei einstellbar.
  c.schildSenkung = 0.05;
  c.schildHoehe = c.schriftGroesse * 1.35 + 2 * c.schildRand;
  // Der Mindestabstand darf nicht kleiner sein als der Weg breit ist plus ein
  // Stammdurchmesser; wie weit die Kronen wirklich reichen, bringt die
  // Baumdatei selbst mit.
  c.stammAbstand = Math.max(c.stammAbstand, 1.5);
  // Das Band darf die Grenze nicht ueberholen, sonst kaeme ein Baum nie zurueck.
  c.tafelBand = Math.min(c.tafelBand, Math.max(0.5, c.tafelAb * 0.5));
  c.pfahlHoehe = c.schildMitteHoehe + c.schildHoehe / 2 + c.schildSenkung;
  c.horizont = Math.max(c.horizont, c.durchmesser);
  // Der Wald steht auf der Horizontscheibe: weiter aussen als die Ecken des
  // Gartenquadrats (R·√2) und noch innerhalb der Scheibe.
  const R = c.durchmesser / 2;
  c.waldRadius = Math.min(Math.max(R * c.waldAbstand, R * 1.45), c.horizont * 0.95);

  // DER GARTEN IST EINE SCHEIBE, kein Quadrat.
  //
  // Verformt wird das Gelaende ohnehin nur innerhalb des Kreises - der Falloff
  // drueckt es ab `durchmesser/2` auf null. Alles, was frueher darueber hinaus
  // im Quadrat lag, war flache Wiese, die genauso gut zur Horizontscheibe
  // gehoeren kann. Die Wiese endet deshalb auf dem Kreis.
  //
  // `randSegmente` ist die Eckenzahl dieses Vielecks - und sie steht hier und
  // nicht in `wegnetz.js`, weil Wiesenrand, Horizontscheibe und Kartenkasten
  // DIESELBEN Ecken brauchen. Ein Vieleck mit weniger Ecken liegt innerhalb des
  // anderen, und an der Kante klaffte ein Spalt.
  c.randSegmente = Math.max(48, Math.round((Math.PI * c.durchmesser) / c.gitter));

  c.wegSample = 0.5;        // Abtastschritt der Mittellinie in m
  // DER WEG LIEGT IN DER WIESE, NICHT DARAUF.
  //
  // Hier standen einmal 5 cm, und der Kommentar daneben nannte sie einen
  // sichtbaren Absatz. Das war eine nachtraegliche Erklaerung: gebraucht wurden
  // sie, weil die Wiese als durchgehendes Gitter unter den Waegen lag und bei
  // kraeftigem Gelaende durch den Belag stach. Der Absatz brauchte dann einen
  // Ausgleichswall, der ihn abfing, und der Wall wurde auf steilem Hang
  // metertief.
  //
  // Seit die Wiese an der Wegkante geschnitten wird (terrain.js:
  // `buildGround`), faellt die ganze Kette weg. Bleibt eine Null - wer wieder
  // einen Absatz will, setzt sie hoch; die Wiese schliesst dann eben tiefer an.
  c.wegHoehe = 0;
  // Beete liegen weiterhin AUF der Wiese: sie sind keine geschnittene Flaeche,
  // sondern ein eigenes kleines Gitter darueber. Ohne Absatz flackerten sie.
  c.beetHoehe = 0.02;
  return c;
}
