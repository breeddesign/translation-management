import { Worker } from "bullmq";
import { config } from "./config.js";
import { createRedisConnection, createQueues } from "./queue/index.js";
import { createRateLimiter } from "./lib/rate-limiter.js";
import { LocalWorker, recoverStalledJobs, pruneJobs } from "./queue/local-queue.js";
import type { JobLike } from "./queue/types.js";
import { createProofreadProcessor } from "./queue/jobs/proofread.js";
import { createPollProofreadProcessor } from "./queue/jobs/poll-proofread.js";
import { createGenerateVideoProcessor } from "./queue/jobs/generate-video.js";
import { createPollVideoProcessor } from "./queue/jobs/poll-video.js";
import { createDownloadAssetsProcessor } from "./queue/jobs/download-assets.js";

const PRUNE_INTERVAL_MS = 5 * 60_000;

interface StoppableWorker {
  close(): Promise<void>;
}

export interface WorkerHandle {
  concurrency: number;
  driver: "bullmq" | "local";
  close(): Promise<void>;
}

/**
 * Startet alle Job-Prozessoren. Im Server-Modus als BullMQ-Worker gegen Redis,
 * im Desktop-Modus als lokale Worker gegen die SQLite-Queue — die Prozessoren
 * selbst sind in beiden Fällen dieselben.
 */
export async function startWorkers(): Promise<WorkerHandle> {
  const redis = createRedisConnection();
  const queues = createQueues(redis);
  const rateLimiter = createRateLimiter(redis);
  await rateLimiter.init();

  const concurrency = config.heygen.maxConcurrency;
  // Videodateien sind groß — weniger parallele Downloads als API-Calls
  const downloadConcurrency = Math.max(1, Math.min(concurrency, 2));

  // Jobs, die beim letzten Beenden mitten in der Ausführung waren
  if (!redis) await recoverStalledJobs();

  const start = (
    name: string,
    processor: (job: JobLike<any>) => Promise<unknown>,
    workerConcurrency: number
  ): StoppableWorker =>
    redis
      ? (new Worker(name, processor as any, {
          connection: redis,
          concurrency: workerConcurrency,
        }) as unknown as StoppableWorker)
      : new LocalWorker(name, processor, { concurrency: workerConcurrency });

  const workers: StoppableWorker[] = [
    start("proofread", createProofreadProcessor(rateLimiter, queues), concurrency),
    start("poll-proofread", createPollProofreadProcessor(rateLimiter), concurrency),
    start("generate-video", createGenerateVideoProcessor(rateLimiter, queues), concurrency),
    start("poll-video", createPollVideoProcessor(rateLimiter, queues), concurrency),
    start("download-assets", createDownloadAssetsProcessor(rateLimiter), downloadConcurrency),
  ];

  // BullMQ räumt über removeOnComplete selbst auf; die lokale Queue braucht es explizit
  const pruneTimer = redis
    ? null
    : setInterval(() => {
        pruneJobs().catch((err) => console.warn("Job-Aufräumen fehlgeschlagen:", err));
      }, PRUNE_INTERVAL_MS);

  return {
    concurrency,
    driver: redis ? "bullmq" : "local",
    async close() {
      if (pruneTimer) clearInterval(pruneTimer);
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
      redis?.disconnect();
    },
  };
}
