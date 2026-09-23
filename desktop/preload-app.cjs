/**
 * Markiert das Dokument als "läuft in der Desktop-App".
 *
 * Das Layout lässt daraufhin links Platz für die macOS-Fensterkontrollen
 * (titleBarStyle "hiddenInset" blendet die Titelleiste aus, die Ampel-Buttons
 * überlagern aber weiterhin den Seiteninhalt). Im Browser — also im
 * Server-Modus — fehlt die Markierung und das Layout bleibt unverändert.
 */
const mark = () => {
  document.documentElement?.setAttribute("data-desktop", "1");
};

// Preload läuft vor dem Parsen; documentElement existiert je nach Zeitpunkt
// noch nicht, deshalb zusätzlich beim DOMContentLoaded setzen.
mark();
document.addEventListener("DOMContentLoaded", mark);
