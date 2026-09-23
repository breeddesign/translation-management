import { cp, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Kopiert alles nach dist/ bzw. public/static/, was tsc nicht selbst erzeugt:
 *
 * 1. Handlebars-Templates — templates.ts lädt sie relativ zum kompilierten
 *    Modul (dist/lib/templates.js → dist/views).
 * 2. Frontend-Bibliotheken aus node_modules — damit die Oberfläche ohne CDN
 *    läuft. Für die Desktop-App ist das entscheidend: ein unpkg-Ausfall würde
 *    sonst die gesamte UI lahmlegen.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");
const staticDir = join(root, "public", "static");

// ── Views → dist/views ──────────────────────────────────────

await mkdir(join(root, "dist"), { recursive: true });
await cp(join(root, "src", "views"), join(root, "dist", "views"), { recursive: true });
console.log("📄 Views nach dist/views kopiert");

// ── Frontend-Bibliotheken → public/static ───────────────────

await mkdir(staticDir, { recursive: true });

// Die Icon-Schrift erzeugt scripts/build-icon-font.mjs (nur die verwendeten
// Symbole statt der vollständigen 5-MB-Variable-Font).
const vendor = [
  ["htmx.org/dist/htmx.min.js", "htmx.min.js"],
  ["htmx-ext-response-targets/response-targets.js", "htmx-ext-response-targets.js"],
  ["htmx-ext-json-enc/json-enc.js", "htmx-ext-json-enc.js"],
];

for (const [from, to] of vendor) {
  await cp(join(modules, from), join(staticDir, to));
}

console.log(`📦 ${vendor.length} Frontend-Dateien nach public/static kopiert`);
