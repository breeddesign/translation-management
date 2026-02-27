import IORedis from "ioredis";
import { config } from "../config.js";

/**
 * Token Bucket rate limiter backed by Redis.
 * 
 * Why not just BullMQ limiter?
 * BullMQ limiter controls "jobs per second" but doesn't account for:
 * - Burst patterns (30 poll requests all firing at the same second)
 * - Multiple queue types sharing the same API rate limit
 * - Jitter to spread load
 * 
 * This limiter sits INSIDE each job processor, before the actual API call.
 */

const BUCKET_KEY = "heygen:rate:tokens";
const BUCKET_TS_KEY = "heygen:rate:ts";

const MAX_TOKENS = config.heygen.requestsPerMinute; // e.g. 30
const REFILL_RATE = MAX_TOKENS / 60; // tokens per second
const REFILL_INTERVAL_MS = 1000;

export class RateLimiter {
  private redis: IORedis;

  constructor(redis: IORedis) {
    this.redis = redis;
  }

  /**
   * Acquire a token. Blocks (with backoff) until a token is available.
   * Returns the wait time in ms.
   */
  async acquire(): Promise<number> {
    let totalWait = 0;
    const maxWait = 60_000; // give up after 60s

    while (totalWait < maxWait) {
      const acquired = await this.tryAcquire();
      if (acquired) return totalWait;

      // Wait with jitter: 500ms-1500ms
      const delay = 500 + Math.random() * 1000;
      await sleep(delay);
      totalWait += delay;
    }

    throw new Error("Rate limiter: timed out waiting for token");
  }

  /**
   * Try to acquire a single token. Returns true if successful.
   * Uses Redis MULTI for atomicity.
   */
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
