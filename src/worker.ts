import { Worker } from "bullmq";
import { config } from "./config.js";
import { createRedisConnection, createQueues } from "./queue/index.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import { createProofreadProcessor } from "./queue/jobs/proofread.js";
import { createPollProofreadProcessor } from "./queue/jobs/poll-proofread.js";
import { createGenerateVideoProcessor } from "./queue/jobs/generate-video.js";
import { createPollVideoProcessor } from "./queue/jobs/poll-video.js";

// ── Init ────────────────────────────────────────────────────

const redis = createRedisConnection();
const queues = createQueues(redis);
const rateLimiter = new RateLimiter(redis);
await rateLimiter.init();

const concurrency = config.heygen.maxConcurrency;

// ── Workers ─────────────────────────────────────────────────

const workers: Worker[] = [];

// Generate Proofread
workers.push(
  new Worker("proofread", createProofreadProcessor(rateLimiter, queues), {
    connection: redis,
    concurrency,
  })
);

// Poll Proofread Status
workers.push(
  new Worker("poll-proofread", createPollProofreadProcessor(rateLimiter), {
    connection: redis,
    concurrency,
  })
);

// Generate Video from Proofread
workers.push(
  new Worker("generate-video", createGenerateVideoProcessor(rateLimiter, queues), {
    connection: redis,
    concurrency,
  })
);

// Poll Video Translation Status
workers.push(
  new Worker("poll-video", createPollVideoProcessor(rateLimiter), {
    connection: redis,
    concurrency,
  })
);

console.log(`
  ╔══════════════════════════════════════════╗
  ║  HeyGen Proofreader (worker)             ║
  ║  Concurrency: ${String(concurrency).padEnd(25)}  ║
  ║  Rate limit: ${String(config.heygen.requestsPerMinute).padEnd(24)} rpm ║
  ║  Queues: proofread, poll-proofread,      ║
  ║          generate-video, poll-video      ║
  ╚══════════════════════════════════════════╝
`);

// ── Graceful Shutdown ───────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`\n🛑 ${signal} received, closing workers gracefully...`);
  await Promise.all(workers.map((w) => w.close()));
  await redis.quit();
  console.log("✅ Workers closed. Bye!");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
