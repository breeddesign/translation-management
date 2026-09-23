import { config } from "./config.js";
import { startWeb } from "./app.js";

const { port } = await startWeb();

console.log(`
  ╔══════════════════════════════════════════╗
  ║  HeyGen Proofreader (web)                ║
  ║  http://localhost:${String(port).padEnd(22)} ║
  ║  Modus: ${config.mode.padEnd(31)}  ║
  ║  Storage: ${config.storage.provider.padEnd(28)}  ║
  ║  ${config.isDev ? "🔧 Development" : "🚀 Production"}                       ║
  ╚══════════════════════════════════════════╝
`);
