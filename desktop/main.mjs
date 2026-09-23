// electron ist ein CommonJS-Modul; benannte ESM-Importe sind daraus nicht auflösbar
import electron from "electron";
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = electron;

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, "..");

let runtime = null;
let mainWindow = null;
let quitting = false;

// ── Einstellungen (userData/settings.json) ──────────────────

const settingsPath = () => join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/**
 * Fragt den HeyGen-API-Key ab. Auflösung: true = gespeichert, false = abgebrochen.
 */
function promptForApiKey(current = "") {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560,
      height: 420,
      resizable: false,
      title: "HeyGen Proofreader — Einrichtung",
      webPreferences: { preload: join(__dirname, "preload.cjs") },
    });

    let saved = false;

    const onSave = (_event, apiKey) => {
      const settings = loadSettings();
      settings.heygenApiKey = String(apiKey || "").trim();
      saveSettings(settings);
      saved = true;
      win.close();
    };

    ipcMain.once("setup:save", onSave);
    win.on("closed", () => {
      ipcMain.removeListener("setup:save", onSave);
      resolve(saved);
    });

    win.loadFile(join(__dirname, "setup.html"), {
      query: { current: current ? "1" : "0" },
    });
  });
}

// ── Laufzeit starten ────────────────────────────────────────

async function startRuntime(settings) {
  process.env.APP_MODE = "desktop";
  process.env.APP_DATA_DIR = app.getPath("userData");
  process.env.HEYGEN_API_KEY = settings.heygenApiKey;
  process.env.NODE_ENV = "production";
  if (settings.storagePath) process.env.LOCAL_STORAGE_PATH = settings.storagePath;

  // Kein process.chdir: Views und statische Dateien werden über Modulpfade
  // aufgelöst, nicht über das Arbeitsverzeichnis. In app.asar wäre chdir ohnehin
  // nicht möglich, und ein Wechsel ins Projektverzeichnis würde im
  // Entwicklungsmodus die .env der Server-Konfiguration einschleusen.

  const entry = pathToFileURL(join(APP_ROOT, "dist", "runtime-desktop.js")).href;
  const { startDesktopRuntime } = await import(entry);

  // Port 0 → freien Port wählen, damit eine laufende Server-Instanz nicht kollidiert
  return startDesktopRuntime(0);
}

/** Zielpfad im Downloads-Ordner, ohne vorhandene Dateien zu überschreiben. */
function uniqueDownloadPath(filename) {
  const dir = app.getPath("downloads");
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";

  let candidate = join(dir, filename);
  let n = 2;
  while (existsSync(candidate)) candidate = join(dir, `${base} ${n++}${ext}`);
  return candidate;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "HeyGen Proofreader",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f9fafb",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Setzt data-desktop, damit das Layout Platz für die Ampel-Buttons lässt
      preload: join(__dirname, "preload-app.cjs"),
    },
  });

  // Erst zeigen, wenn Inhalt da ist. Notbremse, falls das Rendern hängt
  // (z. B. blockierende CDN-Requests ohne Netz) — sonst bliebe das Fenster
  // dauerhaft unsichtbar und die App wirkte wie nicht gestartet.
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }, 1500);

  mainWindow.webContents.on("did-fail-load", (_e, code, description, failedUrl) => {
    if (code === -3) return; // abgebrochene Navigation, kein Fehler
    mainWindow?.show();
    dialog.showErrorBox(
      "Seite konnte nicht geladen werden",
      `${description} (${code})\n${failedUrl}`
    );
  });

  // Im Vollbild verschwinden die Fensterkontrollen → Zusatzabstand entfällt
  const setFullscreenFlag = (on) => {
    mainWindow?.webContents
      .executeJavaScript(
        on
          ? `document.documentElement.setAttribute("data-fullscreen","1")`
          : `document.documentElement.removeAttribute("data-fullscreen")`
      )
      .catch(() => {});
  };
  mainWindow.on("enter-full-screen", () => setFullscreenFlag(true));
  mainWindow.on("leave-full-screen", () => setFullscreenFlag(false));
  // Nach jeder Navigation neu setzen — der Preload kennt den Vollbildzustand nicht
  mainWindow.webContents.on("dom-ready", () =>
    setFullscreenFlag(mainWindow?.isFullScreen() ?? false)
  );

  // Downloads ohne Speichern-Dialog in den Downloads-Ordner und im Finder zeigen
  mainWindow.webContents.session.removeAllListeners("will-download");
  mainWindow.webContents.session.on("will-download", (_event, item) => {
    const target = uniqueDownloadPath(item.getFilename());
    item.setSavePath(target);
    item.once("done", (_e, state) => {
      if (state === "completed") shell.showItemInFolder(target);
      else if (state !== "cancelled") {
        dialog.showErrorBox("Download fehlgeschlagen", item.getFilename());
      }
    });
  });

  mainWindow.loadURL(url);

  // Externe Links (HeyGen-Seiten, target=_blank) im Systembrowser öffnen
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu(runtimeUrl, storagePath) {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about", label: "Über HeyGen Proofreader" },
        { type: "separator" },
        {
          label: "HeyGen API-Key ändern…",
          click: async () => {
            const changed = await promptForApiKey(loadSettings().heygenApiKey);
            if (changed) {
              // Der Key wird beim Start eingelesen — Neustart übernimmt ihn
              app.relaunch();
              app.quit();
            }
          },
        },
        { type: "separator" },
        { role: "hide", label: "Ausblenden" },
        { role: "quit", label: "Beenden" },
      ],
    },
    {
      label: "Ablage",
      submenu: [
        {
          label: "Download-Ordner öffnen",
          click: () => shell.openPath(storagePath),
        },
        {
          label: "Datenordner öffnen (Datenbank)",
          click: () => shell.openPath(app.getPath("userData")),
        },
      ],
    },
    {
      label: "Bearbeiten",
      submenu: [
        { role: "undo", label: "Widerrufen" },
        { role: "redo", label: "Wiederholen" },
        { type: "separator" },
        { role: "cut", label: "Ausschneiden" },
        { role: "copy", label: "Kopieren" },
        { role: "paste", label: "Einsetzen" },
        { role: "selectAll", label: "Alles auswählen" },
      ],
    },
    {
      label: "Ansicht",
      submenu: [
        { role: "reload", label: "Neu laden" },
        { role: "toggleDevTools", label: "Entwicklerwerkzeuge" },
        { type: "separator" },
        { role: "resetZoom", label: "Originalgröße" },
        { role: "zoomIn", label: "Größer" },
        { role: "zoomOut", label: "Kleiner" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Vollbild" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App-Lebenszyklus ────────────────────────────────────────

// Nur eine Instanz: zwei Prozesse würden dieselbe SQLite-Datei beschreiben
// und dieselben Jobs doppelt abarbeiten.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  let settings = loadSettings();

  if (!settings.heygenApiKey) {
    const saved = await promptForApiKey();
    if (!saved) {
      app.quit();
      return;
    }
    settings = loadSettings();
  }

  try {
    runtime = await startRuntime(settings);
  } catch (err) {
    dialog.showErrorBox(
      "Start fehlgeschlagen",
      `Die Anwendung konnte nicht starten:\n\n${err?.stack ?? err}`
    );
    app.quit();
    return;
  }

  const storagePath =
    settings.storagePath ?? join(app.getPath("userData"), "storage");

  console.log(`✅ Desktop-Laufzeit bereit: ${runtime.url}`);
  console.log(`   Daten: ${app.getPath("userData")}`);

  buildMenu(runtime.url, storagePath);
  createWindow(runtime.url);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(runtime.url);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Laufende Jobs sauber beenden, bevor der Prozess endet. Das Fenster wird
// sofort ausgeblendet, damit Cmd-Q spürbar reagiert, und nach 8s hart beendet —
// ein laufender ZIP-Download könnte das Herunterfahren sonst minutenlang halten.
app.on("before-quit", async (event) => {
  if (quitting || !runtime) return;
  event.preventDefault();
  quitting = true;

  mainWindow?.hide();
  await Promise.race([
    runtime.close().catch((err) => console.error("Fehler beim Herunterfahren:", err)),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  app.exit(0);
});

// Backstop: eine unbehandelte Rejection soll die App nicht mit einem
// Electron-Fehlerdialog abschießen
process.on("unhandledRejection", (reason) => {
  console.error("Unbehandelte Rejection:", reason);
});
