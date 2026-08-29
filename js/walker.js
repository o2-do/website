/**
 * Fortbewegung ueber ein globales Geschwindigkeitsprofil statt Einzelanimationen
 * (PLAN.md, Abschnitt 6).
 *
 *   u      Fortschritt innerhalb der laufenden Aktion, 0..1
 *   phase  0..1, Rampenzustand; speed = VMAX * smoothstep(phase)
 *
 * Beschleunigt wird zeitgesteuert (lineare Rampe ueber RAMP Sekunden),
 * gebremst wird streckengesteuert: phase = invStop(rest). Dadurch landet die
 * Bewegung exakt auf der Aktionsgrenze und die Bremskurve ist das Spiegelbild
 * der Beschleunigung. Solange noch etwas in der Queue liegt, ist rest > 0.5
 * und es wird gar nicht erst gebremst -> das Ease-out wird hinausgezoegert.
 *
 * Kalibriert: RAMP = 0.775 -> Einzelaktion 1.50 s, jede weitere +0.78 s.
 *
 * Die Pose wird inkrementell fortgeschrieben (Delta je Frame), nicht aus einer
 * Startpose neu berechnet. Nur so kann die Maus die Blickrichtung mitten in
 * einer laufenden Aktion veraendern, ohne dass die bereits zurueckgelegte
 * Strecke rueckwirkend in eine andere Richtung zeigt.
 */
const RAMP = 0.775;
const VMAX = 1 / RAMP;          // Aktionen pro Sekunde bei voller Fahrt
const MAX_PENDING = 2;          // wartende Klicks zusaetzlich zum laufenden
const STEP_M = 1.0;             // 1 m vor bzw. zurueck
/**
 * WIE WEIT EINE SEITWAERTSANWEISUNG DREHT: 15 Grad, immer.
 *
 * Eine Aktion dauert immer gleich lang, gleich was sie tut (siehe das
 * Geschwindigkeitsprofil oben). Der Drehwinkel je Aktion IST damit die
 * Drehgeschwindigkeit - und fuer das SCHNELLE Umsehen gibt es bereits ein
 * besseres Mittel als die Taste: das Ziehen mit Maus oder Finger dreht so weit
 * und so rasch, wie man will. Die Taste muss deshalb nicht beides koennen; sie
 * darf sich ganz auf das feine Ausrichten verlegen, und dafuer sind 30 Grad zu
 * grob gewesen.
 */
const STEP_RAD = Math.PI / 12;  // 15 Grad
const EYE = 1.5;                // Augenhoehe
const RETURN = 0.9;             // Ruecklaufdauer der Neigung in s
const PITCH_MAX = 1.2;          // ~69 Grad
const SLOPE_AHEAD = 2.0;        // Blickziel fuer die Gefaelleneigung in m
const SLOPE_LAG = 0.35;         // Zeitkonstante der Neigungsnachfuehrung in s

const ss = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** Wieviel eine Aktion an der Blickrichtung dreht, in Vielfachen von 15 Grad. */
const drehsinn = (a) => {
  if (a.type === 'left') return +1;
  if (a.type === 'right') return -1;
  if (a.type === 'step' && a.yaw) return a.yaw > 0 ? +1 : -1;
  return 0;
};

// Tabelle: Strecke, die das Ausrampen von phase p auf 0 kostet.
const N = 256;
const STOP = new Float64Array(N + 1);
for (let k = 0; k <= N; k++) {
  const p = k / N;
  let s = 0;
  for (let i = 0; i < N; i++) s += ss(p * (i + 0.5) / N);
  STOP[k] = VMAX * RAMP * p * s / N;
}
const STOP_FULL = STOP[N];      // = 0.5

function invStop(d) {
  if (d >= STOP_FULL) return 1;
  let lo = 0, hi = N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (STOP[m] <= d) lo = m; else hi = m; }
  const span = STOP[hi] - STOP[lo];
  return (lo + (span > 1e-12 ? (d - STOP[lo]) / span : 0)) / N;
}

export function createWalker(camera, getHeight) {
  const pose = { x: 0, z: 0, yaw: 0 };
  const actions = [];             // actions[0] laeuft gerade
  let u = 0, phase = 0;
  let onChange = null;

  // Freies Umschauen mit der Maus. Waehrend des Ziehens liegt der Versatz
  // additiv auf der Pose; beim Loslassen wird die horizontale Drehung in die
  // Pose uebernommen (bleibt also erhalten) und nur die Neigung faehrt zurueck.
  const look = { yaw: 0, pitch: 0 };
  let dragging = false, retT = RETURN, pitchFrom = 0;
  // Halbmesser, ueber den hinaus nicht gelaufen wird. 0 heisst: keine Grenze.
  let grenze = 0;
  // EINE LUECKE IN DER SCHRANKE. `durchlass(x, z)` sagt, ob an dieser Stelle
  // trotz der Grenze weitergegangen werden darf - das Tor, sobald das Spiel es
  // freigibt. Fehlt sie, schliesst der Kreis rundum wie bisher.
  let durchlass = null;
  // `hindernis(x, z)` sagt, ob dort etwas im Weg steht. Fehlt sie, laeuft es
  // wie bisher - der Konfigurator kann sie also nachreichen, wenn der Garten
  // fertig ist, und nichts haengt in der Zwischenzeit.
  let hindernis = null;
  // Ob der letzte Schritt an der Grenze haengengeblieben ist - damit das
  // Ereignis eine Flanke ist und kein Dauerton.
  let angestossen = false;

  /**
   * „Jemand wollte den Garten verlassen."
   *
   * Der Walker entscheidet nichts darueber, was daraufhin geschieht - er
   * meldet nur. Was ein Ausgang bedeutet, ist eine Frage des Spiels und nicht
   * der Fortbewegung; deshalb ein Ereignis am Fenster und keine Rueckrufliste
   * hier drin.
   */
  function meldeAusgang() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('garten-ausgang', {
      detail: { x: pose.x, z: pose.z, yaw: pose.yaw, grenze },
    }));
  }

  // Blick folgt dem Gefaelle: geht es vor mir bergab, schaut man hinunter.
  // Bergauf bleibt der Blick waagerecht - man laeuft ja nicht mit der Nase
  // am Hang. Deshalb nur die negative Haelfte.
  let slope = 0;
  function slopeTarget() {
    if (!getHeight) return 0;
    const yaw = pose.yaw + look.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const h0 = getHeight(pose.x, pose.z);
    const h1 = getHeight(pose.x + fx * SLOPE_AHEAD, pose.z + fz * SLOPE_AHEAD);
    return Math.min(0, Math.atan2(h1 - h0, SLOPE_AHEAD));
  }

  function apply() {
    const y = getHeight ? getHeight(pose.x, pose.z) + EYE : EYE;
    camera.position.set(pose.x, y, pose.z);
    camera.rotation.set(slope + look.pitch, pose.yaw + look.yaw, 0);
  }

  /**
   * Einen Schritt setzen, aber nicht ueber den Zaun hinaus.
   *
   * AM ZAUN WIRD GESCHOBEN, NICHT GESTOPPT. Wer schraeg auf ihn zulaeuft,
   * kommt seitlich weiter - genau um den Anteil des Schrittes, der laengs des
   * Zauns zeigt. Wer im rechten Winkel darauf zulaeuft, bewegt sich gar nicht:
   * dort ist der laengs zeigende Anteil null. Das ist dasselbe, was eine Wand
   * mit einem tut, und es fuehlt sich richtiger an als ein Anhalten, weil man
   * an einem Zaun entlanglaufen kann, ohne die Blickrichtung zu korrigieren.
   *
   * Gerechnet wird radial: `grenze` ist ein Halbmesser um die Gartenmitte,
   * die Tangente steht senkrecht darauf. Solange der Zaun ein Kreis ist,
   * braucht es dafuer keine Geometrie, nur zwei Skalarprodukte.
   */
  /**
   * AM HINDERNIS WIRD ENTLANGGERUTSCHT, NICHT ANGEHALTEN.
   *
   * Dasselbe Prinzip wie am Zaun, nur ohne dessen Geometrie: von einem
   * Baumstamm, einem Felsen oder einem Gelaender ist die Richtung nicht
   * bekannt, also wird sie GESUCHT - und zwar richtig, nicht durch Probieren.
   *
   * Das Hindernisraster ist ein Feld aus Nullen und Einsen; seine Steigung an
   * der Beruehrstelle zeigt ins Hindernis hinein. Acht Abfragen ringsum
   * ergeben diese Richtung, und von da an ist es einfache Vektorrechnung: der
   * Anteil des Schrittes LAENGS der Wand bleibt, der Anteil dagegen faellt weg.
   *
   *     tangential = d - n * (d . n)
   *
   * Wer flach an ein Gelaender geraet, laeuft also fast ungebremst daran
   * entlang, statt haengenzubleiben - und behaelt dabei seine Blickrichtung.
   * Vorher wurde der Schritt in festen Stufen gedreht und dabei um den Kosinus
   * gekuerzt; bei einem schmalen Weg zwischen zwei Gelaendern war keine der
   * Stufen frei, und man stand.
   *
   * ZWEI SICHERUNGEN. Steht man schon IM Hindernis - das Raster ist grob, das
   * Gelaende schiebt einen -, gilt es nicht: sonst waere jede Richtung gesperrt
   * und man kaeme nie wieder heraus. Und findet sich keine Normale (man steckt
   * mitten in einer Flaeche), bleibt das Drehen als letzter Ausweg.
   */
  // Wo ringsum gemessen wird. Ein halber Meter ist grob genug, um die Wand als
  // Ganzes zu sehen, und fein genug, um an einer Ecke noch zu stimmen.
  const FUEHLER = 0.5;
  // WIE WEIT VORAUSGESCHAUT WIRD, mindestens.
  //
  // Ein Schritt dauert eine knappe Sekunde und wird auf sechzig Bilder
  // verteilt: je Bild sind das keine zwei Zentimeter, waehrend eine Rasterzelle
  // fuenfzehn misst. Fragt man nur, ob DIESER Zentimeter frei ist, entscheidet
  // nicht die Wand, sondern der Zufall der Zellgrenze - laengs einer schraegen
  // Wand liegt die naechste Zelle abwechselnd frei und gesperrt, und der Geher
  // blieb an dieser Treppung haengen. Geprueft wird deshalb immer ein Stueck
  // voraus, gegangen aber nur der kleine Schritt.
  const VORAUS = 0.25;

  function frei(dx, dz) {
    // Der naechste Schritt selbst - sonst traete man in die Zelle hinein und
    // waere drin; von drinnen laesst die Notbremse weiter unten alles zu, und
    // man liefe glatt durch das Gelaender hindurch.
    if (hindernis(pose.x + dx, pose.z + dz)) return false;
    const l = Math.hypot(dx, dz);
    if (l < 1e-9) return true;
    const f = VORAUS / l;
    return f <= 1 || !hindernis(pose.x + dx * f, pose.z + dz * f);
  }

  function hindernisNormale(x, z) {
    let nx = 0, nz = 0, treffer = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sx = Math.sin(a), sz = Math.cos(a);
      if (hindernis(x + sx * FUEHLER, z + sz * FUEHLER)) { nx += sx; nz += sz; treffer++; }
    }
    if (!treffer) return null;
    // Die Summe zeigt INS Hindernis; die Normale zeigt heraus.
    const l = Math.hypot(nx, nz);
    return l < 1e-6 ? null : [-nx / l, -nz / l];
  }

  function ausweichen(dx, dz) {
    if (!hindernis || frei(dx, dz)) return [dx, dz];
    // Schon drin: nicht auch noch einsperren.
    if (hindernis(pose.x, pose.z)) return [dx, dz];
    const laenge = Math.hypot(dx, dz);
    if (laenge < 1e-6) return [0, 0];

    const f = Math.max(1, VORAUS / laenge);
    const n = hindernisNormale(pose.x + dx * f, pose.z + dz * f);
    if (n) {
      const rein = dx * n[0] + dz * n[1];
      const tx = dx - n[0] * rein, tz = dz - n[1] * rein;
      // ERST GLATT, DANN MIT ABSTAND. Der Rutschweg laeuft dicht an der Wand,
      // und die Wand ist im Raster eine Treppe aus 15-cm-Zellen: mal liegt die
      // naechste Zelle frei, mal nicht. Geht es glatt nicht, wird ein Stueck
      // von der Wand weggedrueckt - zwei Zentimeter reichen meist, sechs immer.
      // Nur wenn es noetig ist, sonst schoebe es einen bei jedem Schritt weiter
      // in die Wegmitte.
      for (const ab of [0, 0.02, 0.06]) {
        const ex = tx + n[0] * ab, ez = tz + n[1] * ab;
        if (frei(ex, ez)) return [ex, ez];
      }
    }

    // Letzter Ausweg: den Schritt drehen, bis etwas frei ist.
    const w0 = Math.atan2(dx, dz);
    for (const grad of [15, 30, 45, 60, 75, 88]) {
      const w = (grad * Math.PI) / 180;
      const kurz = laenge * Math.cos(w);
      for (const seite of [1, -1]) {
        const a = w0 + seite * w;
        const ex = Math.sin(a) * kurz, ez = Math.cos(a) * kurz;
        if (frei(ex, ez)) return [ex, ez];
      }
    }
    return [0, 0];
  }

  function schiebe(dx, dz) {
    const r = Math.hypot(pose.x, pose.z);
    const nx1 = pose.x + dx, nz1 = pose.z + dz;
    if (grenze <= 0 || Math.hypot(nx1, nz1) <= grenze
        || (durchlass && durchlass(nx1, nz1))) {
      const [ex, ez] = ausweichen(dx, dz);
      pose.x += ex; pose.z += ez;
      angestossen = false;
      return;
    }
    // Wer hinauswollte, hat es versucht - einmal je Versuch, nicht je Bild.
    // Ohne die Flanke feuerte das Ereignis sechzigmal in der Sekunde, solange
    // jemand gegen den Zaun laeuft, und niemand koennte darauf etwas bauen.
    if (!angestossen) {
      angestossen = true;
      meldeAusgang();
    }
    // Aussenrichtung und Tangente am eigenen Standpunkt. Steht man exakt in
    // der Mitte, gibt es keine - dann kann der Schritt aber auch nicht
    // hinausfuehren.
    if (r < 1e-6) { pose.x = nx1; pose.z = nz1; return; }
    const ax = pose.x / r, az = pose.z / r;
    const tx = -az, tz = ax;
    const laengs = dx * tx + dz * tz;
    // Erst am Zaun entlang, dann um die Hindernisse herum - beides derselbe
    // Gedanke, nur nacheinander angewandt.
    const [ex, ez] = ausweichen(tx * laengs, tz * laengs);
    pose.x += ex;
    pose.z += ez;
    // Der Schritt laengs des Zauns fuehrt auf der Sehne minimal nach aussen;
    // deshalb zum Schluss noch einmal auf den Kreis zurueckziehen.
    //
    // ABER NUR, WER DRINNEN WAR. Wer durch das geoeffnete Tor hinausgegangen
    // ist, steht rechtmaessig ausserhalb des Kreises; ihn zurueckzuziehen
    // riefe ihn bei jedem Schritt, der neben der Toroeffnung liegt, an den
    // Zaun zurueck.
    const r2 = Math.hypot(pose.x, pose.z);
    if (r2 > grenze && r <= grenze) { pose.x *= grenze / r2; pose.z *= grenze / r2; }
  }

  // Ein Teilschritt der laufenden Aktion. `du` ist der Fortschrittsanteil.
  function advance(a, du) {
    if (a.type === 'left') { pose.yaw += STEP_RAD * du; return; }
    if (a.type === 'right') { pose.yaw -= STEP_RAD * du; return; }
    if (a.type === 'step') pose.yaw += a.yaw * du;      // Drehen und Gehen zugleich
    const dist = (a.type === 'back' ? -STEP_M : STEP_M) * du;
    schiebe(-Math.sin(pose.yaw) * dist, -Math.cos(pose.yaw) * dist);
  }

  return {
    get pending() { return Math.max(0, actions.length - 1); },
    get queueFull() { return actions.length - 1 >= MAX_PENDING; },
    get pose() { return { ...pose }; },

    onChange(fn) { onChange = fn; },

    enqueue(type, opts) {
      if (actions.length > 0 && actions.length - 1 >= MAX_PENDING) return false;
      actions.push({ type, yaw: opts && opts.yaw ? opts.yaw : 0 });
      if (onChange) onChange();
      return true;
    },

    /**
     * Drehen von der Tastatur. `dir` ist +1 fuer links, -1 fuer rechts.
     *
     * Die Pfeiltasten sind das Lenkrad und verhalten sich deshalb anders als
     * die Knoepfe, die schlicht hinten anhaengen. Drei Regeln, in dieser
     * Reihenfolge:
     *
     *   1. GEGENDREHUNGEN LOESCHEN SICH AUS. Wartet in der Schlange eine
     *      Drehung in die andere Richtung, verschwindet sie - und die neue
     *      wird gar nicht erst eingereiht. Steckt sie in einer Kurve, bleibt
     *      das Geradeaus stehen. Wer sich vertippt, tippt zurueck, statt einen
     *      Schlenker abwarten zu muessen.
     *   2. STEHT EIN GERADEAUS AN, wird die Drehung VORNE eingefuegt und mit
     *      ihm verschmolzen: `step` dreht und geht zugleich, der Schritt wird
     *      zur Kurve statt zu Ecke-und-Gerade. Wer drei Schritte eingereiht hat
     *      und abbiegen will, meint „an der naechsten Ecke", nicht „in drei
     *      Metern".
     *   3. SONST hinten anhaengen. Zweimal rechts sind dann dreissig Grad -
     *      ohne Geradeaus dazwischen ist das genau, was gemeint ist.
     */
    enqueueTurn(dir) {
      // 1. Gegendrehung suchen - nur in der Warteschlange, nicht in der
      //    laufenden Aktion: die ist bereits zu einem Teil gedreht, sie liesse
      //    sich nicht mehr sauber zuruecknehmen.
      for (let i = 1; i < actions.length; i++) {
        if (drehsinn(actions[i]) !== -dir) continue;
        if (actions[i].type === 'step') {
          actions[i].yaw = 0;                   // aus der Kurve wird die Gerade
          actions[i].type = 'forward';
        } else {
          actions.splice(i, 1);
        }
        if (onChange) onChange();
        return true;
      }

      // 2. Wartendes Geradeaus? Dann dort hinein, so frueh wie moeglich.
      for (let i = 1; i < actions.length; i++) {
        if (actions[i].type !== 'forward') continue;
        actions.splice(i, 1);
        actions.splice(1, 0, { type: 'step', yaw: dir > 0 ? STEP_RAD : -STEP_RAD });
        if (onChange) onChange();
        return true;
      }

      // 3. Hinten anhaengen.
      if (actions.length > 0 && actions.length - 1 >= MAX_PENDING) return false;
      actions.push({ type: dir > 0 ? 'left' : 'right', yaw: 0 });
      if (onChange) onChange();
      return true;
    },

    /**
     * Die Schranke setzen - der Halbmesser, innerhalb dessen gelaufen werden
     * darf. Sie liegt ein Stueck vor dem Zaun, damit die Kamera nicht in einen
     * Pfosten hineinsieht. 0 hebt sie auf; das braucht die Eingangssequenz,
     * die ja von draussen kommt.
     */
    setzeGrenze(radius) { grenze = Math.max(0, radius || 0); angestossen = false; },
    /**
     * Die Luecke in der Schranke setzen (oder mit `null` schliessen). Was
     * darin liegt, ist Sache des Spiels - hier zaehlt nur, dass die Grenze
     * dort nicht gilt.
     */
    setzeDurchlass(fn) { durchlass = typeof fn === 'function' ? fn : null; },
    /** Die Abfrage auf feste Hindernisse setzen (oder mit `null` abschalten). */
    setzeHindernis(fn) { hindernis = typeof fn === 'function' ? fn : null; },
    get grenze() { return grenze; },

    /** Ob gerade eine Aktion laeuft oder wartet. */
    get beschaeftigt() { return actions.length > 0; },

    reset(x = 0, z = 0, yaw = 0) {
      actions.length = 0;
      u = 0; phase = 0;
      look.yaw = 0; look.pitch = 0;
      dragging = false; retT = RETURN; pitchFrom = 0;
      pose.x = x; pose.z = z; pose.yaw = yaw;
      if (grenze > 0) {
        const r = Math.hypot(pose.x, pose.z);
        if (r > grenze) { pose.x *= grenze / r; pose.z *= grenze / r; }
      }
      slope = slopeTarget();
      apply();
      if (onChange) onChange();
    },

    beginLook() { dragging = true; },
    look(dYaw, dPitch) {
      if (!dragging) return;
      look.yaw += dYaw;
      look.pitch = Math.min(PITCH_MAX, Math.max(-PITCH_MAX, look.pitch + dPitch));
    },
    endLook() {
      if (!dragging) return;
      dragging = false;
      pose.yaw += look.yaw;      // horizontale Drehung bleibt stehen
      look.yaw = 0;
      pitchFrom = look.pitch;    // nur die Neigung faehrt zurueck
      retT = 0;
    },

    update(dt) {
      if (!dragging && retT < RETURN) {
        retT = Math.min(RETURN, retT + dt);
        look.pitch = pitchFrom * (1 - ss(retT / RETURN));
      }
      slope += (slopeTarget() - slope) * Math.min(1, dt / SLOPE_LAG);

      if (actions.length === 0) {
        if (phase > 0) phase = Math.max(0, phase - dt / RAMP);
        apply();
        return;
      }

      const rest = actions.length - u;
      phase = rest > STOP_FULL ? Math.min(1, phase + dt / RAMP) : invStop(rest);
      let du = VMAX * ss(phase) * dt;
      // Restweg unter Wahrnehmungsschwelle: sauber einrasten statt auszukriechen
      if (actions.length - (u + du) < 1e-4) du = actions.length - u;

      while (du > 1e-12 && actions.length > 0) {
        const part = Math.min(du, 1 - u);
        advance(actions[0], part);
        u += part;
        du -= part;
        if (u >= 1 - 1e-12) {
          actions.shift();
          u = 0;
          if (onChange) onChange();
        }
      }
      apply();
    },
  };
}

export { EYE, MAX_PENDING };
