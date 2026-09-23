import { config } from "./config.js";
import { startWorkers } from "./worker-runtime.js";

const handle = await startWorkers();

console.log(`
  ╔══════════════════════════════════════════╗
  ║  HeyGen Proofreader (worker)             ║
  ║  Queue: ${handle.driver.padEnd(31)}  ║
  ║  Concurrency: ${String(handle.concurrency).padEnd(25)}  ║
  ║  Rate limit: ${String(config.heygen.requestsPerMinute).padEnd(24)} rpm ║
  ║  Queues: proofread, poll-proofread,      ║
  ║          generate-video, poll-video,     ║
  ║          download-assets                 ║
  ╚══════════════════════════════════════════╝
`);

// ── Graceful Shutdown ───────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`\n🛑 ${signal} received, closing workers gracefully...`);
  await handle.close();
  console.log("✅ Workers closed. Bye!");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
