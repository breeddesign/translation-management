import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config.js";
import { LocalQueue, type BulkJob, type JobOptions } from "./local-queue.js";

/**
 * Gemeinsame Schnittstelle beider Queue-Implementierungen.
 * Server-Modus nutzt BullMQ/Redis, Desktop-Modus die lokale SQLite-Queue.
 */
export interface AppQueue {
  readonly name: string;
  add(name: string, data: any, opts?: JobOptions): Promise<unknown>;
  addBulk(jobs: BulkJob[]): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getFailed(
    start?: number,
    end?: number
  ): Promise<Array<{ name: string; failedReason?: string | null; attemptsMade: number; data: unknown }>>;
  close(): Promise<void>;
}

// ── Redis Connection (nur Server-Modus) ─────────────────────

export function createRedisConnection(): IORedis | null {
  if (config.queue.driver === "local") return null;

  return new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null, // required by BullMQ
  });
}

// ── Queue Definitions (used by both web and worker) ─────────

export const QUEUE_NAMES = [
  "proofread",
  "poll-proofread",
  "generate-video",
  "poll-video",
  "download-assets",
] as const;

export function createQueues(redis: IORedis | null) {
  const make = (name: string): AppQueue =>
    redis
      ? (new Queue(name, { connection: redis }) as unknown as AppQueue)
      : new LocalQueue(name);

  return {
    proofread: make("proofread"),
    pollProofread: make("poll-proofread"),
    generateVideo: make("generate-video"),
    pollVideo: make("poll-video"),
    downloadAssets: make("download-assets"),
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

export async function enqueueAssetDownloads(
  queues: Queues,
  translatedVideoIds: string[]
) {
  const jobs = translatedVideoIds.map((translatedVideoId) => ({
    name: `download-assets-${translatedVideoId}`,
    data: { translatedVideoId },
    opts: {
      jobId: `download-assets:${translatedVideoId}`,
      attempts: 10,
      backoff: { type: "exponential" as const, delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  }));

  await queues.downloadAssets.addBulk(jobs);
  return jobs.length;
}
