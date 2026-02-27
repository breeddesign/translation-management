import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config.js";

// ── Redis Connection (shared) ───────────────────────────────

export function createRedisConnection(): IORedis {
  return new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null, // required by BullMQ
  });
}

// ── Queue Definitions (used by both web and worker) ─────────

export function createQueues(redis: IORedis) {
  return {
    proofread: new Queue("proofread", { connection: redis }),
    pollProofread: new Queue("poll-proofread", { connection: redis }),
    generateVideo: new Queue("generate-video", { connection: redis }),
    pollVideo: new Queue("poll-video", { connection: redis }),
  };
}

export type Queues = ReturnType<typeof createQueues>;

// ── Enqueue helpers (called by web process) ─────────────────

export async function enqueueProjectProofreads(
  queues: Queues,
  projectId: string,
  videoIds: string[]
) {
  const jobs = videoIds.map((videoId) => ({
    name: `proofread-${projectId}-${videoId}`,
    data: { projectId, videoId },
    opts: {
      // Deterministic jobId → idempotent: re-enqueue won't duplicate
      jobId: `proofread:${projectId}:${videoId}`,
      attempts: 3,
      backoff: { type: "exponential" as const, delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  }));

  await queues.proofread.addBulk(jobs);
  return jobs.length;
}

export async function enqueueVideoGenerations(
  queues: Queues,
  proofreadIds: string[]
) {
  const jobs = proofreadIds.map((proofreadId) => ({
    name: `generate-${proofreadId}`,
    data: { proofreadId },
    opts: {
      jobId: `generate:${proofreadId}`,
      attempts: 3,
      backoff: { type: "exponential" as const, delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  }));

  await queues.generateVideo.addBulk(jobs);
  return jobs.length;
}
