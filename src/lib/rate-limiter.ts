import type IORedis from "ioredis";
import { config } from "../config.js";

/**
 * Token Bucket rate limiter vor jedem HeyGen-API-Call.
 *
 * Why not just BullMQ limiter?
 * BullMQ limiter controls "jobs per second" but doesn't account for:
 * - Burst patterns (30 poll requests all firing at the same second)
 * - Multiple queue types sharing the same API rate limit
 * - Jitter to spread load
 *
 * Zwei Implementierungen: Redis (Server-Modus, prozessübergreifend) und
 * In-Memory (Desktop-Modus, ein einziger Prozess).
 */

const BUCKET_KEY = "heygen:rate:tokens";
const BUCKET_TS_KEY = "heygen:rate:ts";

const MAX_TOKENS = config.heygen.requestsPerMinute; // e.g. 30
const REFILL_RATE = MAX_TOKENS / 60; // tokens per second

export interface RateLimiter {
  /** Wartet bis ein Token frei ist; liefert die Wartezeit in ms. */
  acquire(): Promise<number>;
  init(): Promise<void>;
}

/** Gemeinsame Warteschleife für beide Implementierungen. */
async function acquireLoop(tryAcquire: () => Promise<boolean>): Promise<number> {
  let totalWait = 0;
  const maxWait = 60_000; // give up after 60s

  while (totalWait < maxWait) {
    if (await tryAcquire()) return totalWait;

    // Wait with jitter: 500ms-1500ms
    const delay = 500 + Math.random() * 1000;
    await sleep(delay);
    totalWait += delay;
  }

  throw new Error("Rate limiter: timed out waiting for token");
}

// ── Redis (Server-Modus) ────────────────────────────────────

export class RedisRateLimiter implements RateLimiter {
  private redis: IORedis;

  constructor(redis: IORedis) {
    this.redis = redis;
  }

  async acquire(): Promise<number> {
    return acquireLoop(() => this.tryAcquire());
  }

  private async tryAcquire(): Promise<boolean> {
    const now = Date.now();

    // Refill tokens based on time elapsed
    const lastRefill = Number(await this.redis.get(BUCKET_TS_KEY)) || now;
    const elapsed = (now - lastRefill) / 1000;
    const newTokens = elapsed * REFILL_RATE;

    if (newTokens >= 1) {
      // Add tokens (capped at MAX_TOKENS)
      const currentTokens = Number(await this.redis.get(BUCKET_KEY)) || 0;
      const refilled = Math.min(MAX_TOKENS, currentTokens + Math.floor(newTokens));
      await this.redis.set(BUCKET_KEY, refilled);
      await this.redis.set(BUCKET_TS_KEY, now);
    }

    // Try to decrement
    const remaining = await this.redis.decr(BUCKET_KEY);
    if (remaining >= 0) {
      return true;
    }

    // Rollback: we went below 0
    await this.redis.incr(BUCKET_KEY);
    return false;
  }

  /** Initialize bucket with full tokens */
  async init(): Promise<void> {
    const exists = await this.redis.exists(BUCKET_KEY);
    if (!exists) {
      await this.redis.set(BUCKET_KEY, MAX_TOKENS);
      await this.redis.set(BUCKET_TS_KEY, Date.now());
    }
  }
}

// ── In-Memory (Desktop-Modus) ───────────────────────────────

export class MemoryRateLimiter implements RateLimiter {
  private tokens = MAX_TOKENS;
  private lastRefill = Date.now();

  async acquire(): Promise<number> {
    return acquireLoop(async () => this.tryAcquire());
  }

  // Synchron und damit im Single-Thread-Prozess von Natur aus atomar
  private tryAcquire(): boolean {
    const now = Date.now();
    const newTokens = ((now - this.lastRefill) / 1000) * REFILL_RATE;

    if (newTokens >= 1) {
      this.tokens = Math.min(MAX_TOKENS, this.tokens + Math.floor(newTokens));
      this.lastRefill = now;
    }

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async init(): Promise<void> {
    this.tokens = MAX_TOKENS;
    this.lastRefill = Date.now();
  }
}

/** Wählt die Implementierung passend zum Modus (redis === null → Desktop). */
export function createRateLimiter(redis: IORedis | null): RateLimiter {
  return redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add jitter to polling intervals to prevent thundering herd.
 * Returns delay ± 20% jitter.
 */
export function withJitter(baseDelayMs: number): number {
  const jitter = baseDelayMs * 0.2;
  return baseDelayMs + (Math.random() * 2 - 1) * jitter;
}
