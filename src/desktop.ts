import { config } from "./config.js";
import { startDesktopRuntime } from "./runtime-desktop.js";

/** Headless-Start der Desktop-Laufzeit (zum Entwickeln/Testen ohne Electron). */
const runtime = await startDesktopRuntime(config.port);

console.log(`
  ╔══════════════════════════════════════════╗
  ║  HeyGen Proofreader (desktop, headless)  ║
  ║  ${runtime.url.padEnd(38)}  ║
  ║  SQLite + lokale Queue, kein Docker      ║
  ╚══════════════════════════════════════════╝
  Daten: ${config.dataDir}
`);

async function shutdown(signal: string) {
  console.log(`\n🛑 ${signal} — fahre herunter...`);
  await runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
