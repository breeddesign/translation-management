import { readdir, readFile, writeFile, cp, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Erzeugt public/static/material-symbols-rounded.{css,woff2}.
 *
 * Die vollständige Variable-Font enthält ~3000 Symbole (5,1 MB); die App nutzt
 * knapp 30. Google Fonts liefert über `icon_names` eine passgenaue Teilmenge
 * (~5 KB), die hier einmalig beim Bauen geholt und lokal abgelegt wird.
 *
 * Ohne Netz greift der Rückfall auf die vollständige Schrift aus node_modules —
 * der Build schlägt dadurch nie fehl, die App wird nur größer.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(ROOT, "public", "static");
const FONT_FILE = "material-symbols-rounded.woff2";
const CSS_FILE = "material-symbols-rounded.css";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── Verwendete Icon-Namen aus den Templates einsammeln ──────

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function collectIconNames() {
  const names = new Set();
  // <span class="material-symbols-rounded" …>folder_open</span>
  const pattern = /material-symbols-rounded[^>]*>\s*([a-z0-9_]+)\s*</g;

  for await (const file of walk(join(ROOT, "src"))) {
    if (!/\.(hbs|ts)$/.test(file)) continue;
    const source = await readFile(file, "utf-8");
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
}

// ── Rückfall: vollständige Schrift aus node_modules ─────────

async function useFullFont(reason) {
  console.warn(`⚠️  Icon-Subset nicht möglich (${reason}) — nutze vollständige Schrift`);
  const pkg = join(ROOT, "node_modules", "material-symbols");
  await cp(join(pkg, "rounded.css"), join(STATIC_DIR, CSS_FILE));
  await cp(join(pkg, FONT_FILE), join(STATIC_DIR, FONT_FILE));
}

// ── Hauptlauf ───────────────────────────────────────────────

await mkdir(STATIC_DIR, { recursive: true });

const icons = await collectIconNames();
if (icons.length === 0) {
  await useFullFont("keine Icon-Namen gefunden");
  process.exit(0);
}

try {
  const url =
    "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded" +
    ":opsz,wght,FILL,GRAD@24,400,0,0" +
    `&icon_names=${icons.join(",")}&display=block`;

  const cssRes = await fetch(url, { headers: { "User-Agent": UA } });
  if (!cssRes.ok) throw new Error(`Google Fonts antwortete mit ${cssRes.status}`);
  const css = await cssRes.text();

  const fontUrl = css.match(/url\((https:[^)]+)\)/)?.[1];
  if (!fontUrl) throw new Error("keine Font-URL in der Antwort");

  const fontRes = await fetch(fontUrl, { headers: { "User-Agent": UA } });
  if (!fontRes.ok) throw new Error(`Font-Download scheiterte mit ${fontRes.status}`);
  const font = Buffer.from(await fontRes.arrayBuffer());

  await writeFile(join(STATIC_DIR, FONT_FILE), font);
  // Absolute Google-URL durch die lokale Datei ersetzen
  await writeFile(
    join(STATIC_DIR, CSS_FILE),
    `/* Erzeugt von scripts/build-icon-font.mjs — enthält nur die ${icons.length}\n` +
      `   in den Templates verwendeten Symbole. Nicht von Hand bearbeiten. */\n` +
      css.replace(/url\(https:[^)]+\)/, `url("./${FONT_FILE}")`)
  );

  console.log(`🔤 Icon-Schrift: ${icons.length} Symbole, ${(font.length / 1024).toFixed(1)} KB`);
} catch (err) {
  await useFullFont(err instanceof Error ? err.message : String(err));
}
