import { db, isDuplicateKeyError } from "../db/index.js";
import type { JobLike } from "./types.js";

/**
 * SQLite-gestützte Job-Queue für den Desktop-Modus — Ersatz für BullMQ/Redis.
 *
 * Nachgebildet wird nur, was die App tatsächlich nutzt: deterministische
 * Job-IDs (Dedup), verzögerter Start, Retries mit Fixed/Exponential-Backoff
 * sowie Zähler und Fehlerliste für die Jobs-Seite. Persistenz ist wichtig,
 * weil Poll-Jobs mit bis zu 120 Versuchen über Stunden laufen und einen
 * Neustart der App überleben müssen.
 */

const POLL_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 60 * 60_000; // 1h Deckel für exponentielles Backoff
const KEEP_COMPLETED = 100;
const KEEP_FAILED = 200;

export interface JobOptions {
  /** Entspricht BullMQ jobId: verhindert doppeltes Einreihen */
  jobId?: string;
  attempts?: number;
  backoff?: { type: "fixed" | "exponential"; delay: number };
  delay?: number;
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
}

export interface BulkJob {
  name: string;
  data: unknown;
  opts?: JobOptions;
}

export interface JobCounts {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  [status: string]: number;
}

export interface FailedJobView {
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  data: unknown;
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function backoffDelay(opts: { type: string | null; delay: number }, attemptsMade: number): number {
  if (!opts.delay) return 0;
  if (opts.type === "exponential") {
    return Math.min(MAX_BACKOFF_MS, opts.delay * Math.pow(2, Math.max(0, attemptsMade - 1)));
  }
  return opts.delay;
}

async function insertJob(queue: string, name: string, data: unknown, opts: JobOptions) {
  await db
    .insertInto("local_jobs")
    .values({
      queue,
      name,
      job_key: opts.jobId ?? null,
      data: JSON.stringify(data ?? null),
      status: "waiting",
      run_at: iso(opts.delay ?? 0),
      attempts_made: 0,
      max_attempts: opts.attempts ?? 1,
      backoff_type: opts.backoff?.type ?? null,
      backoff_delay: opts.backoff?.delay ?? 0,
    })
    .execute();
}

async function addJob(queue: string, name: string, data: unknown, opts: JobOptions): Promise<void> {
  // Ohne jobId ist jeder Aufruf ein eigener Lauf (z. B. manueller Re-Pull)
  if (!opts.jobId) {
    await insertJob(queue, name, data, opts);
    return;
  }

  const existing = await db
    .selectFrom("local_jobs")
    .select(["id", "status"])
    .where("queue", "=", queue)
    .where("job_key", "=", opts.jobId)
    .executeTakeFirst();

  if (existing) {
    // Läuft oder wartet bereits → Dedup wie bei BullMQ
    if (existing.status === "waiting" || existing.status === "active") return;

    // Abgeschlossen oder fehlgeschlagen → als neuer Lauf wiederverwenden
    await db
      .updateTable("local_jobs")
      .set({
        name,
        data: JSON.stringify(data ?? null),
        status: "waiting",
        run_at: iso(opts.delay ?? 0),
        attempts_made: 0,
        max_attempts: opts.attempts ?? 1,
        backoff_type: opts.backoff?.type ?? null,
        backoff_delay: opts.backoff?.delay ?? 0,
        failed_reason: null,
        updated_at: iso(),
      })
      .where("id", "=", existing.id)
      .execute();
    return;
  }

  try {
    await insertJob(queue, name, data, opts);
  } catch (err) {
    // Rennen mit einem parallelen add auf denselben Key — harmlos
    if (!isDuplicateKeyError(err)) throw err;
  }
}

// ── Queue ───────────────────────────────────────────────────

export class LocalQueue {
  constructor(public readonly name: string) {}

  async add(jobName: string, data: unknown, opts: JobOptions = {}): Promise<void> {
    await addJob(this.name, jobName, data, opts);
  }

  async addBulk(jobs: BulkJob[]): Promise<void> {
    for (const job of jobs) {
      await addJob(this.name, job.name, job.data, job.opts ?? {});
    }
  }

  async getJobCounts(..._types: string[]): Promise<Record<string, number>> {
    const rows = await db
      .selectFrom("local_jobs")
      .select(["status", "run_at"])
      .where("queue", "=", this.name)
      .execute();

    const now = iso();
    const counts: JobCounts = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === "waiting") {
        if (row.run_at > now) counts.delayed++;
        else counts.waiting++;
      } else if (row.status in counts) {
        counts[row.status as keyof JobCounts]++;
      }
    }
    return counts;
  }

  async getFailed(start = 0, end = 9): Promise<FailedJobView[]> {
    const rows = await db
      .selectFrom("local_jobs")
      .select(["name", "failed_reason", "attempts_made", "data"])
      .where("queue", "=", this.name)
      .where("status", "=", "failed")
      .orderBy("updated_at", "desc")
      .limit(Math.max(0, end - start + 1))
      .offset(start)
      .execute();

    return rows.map((row) => ({
      name: row.name,
      failedReason: row.failed_reason,
      attemptsMade: row.attempts_made,
      data: safeParse(row.data),
    }));
  }

  async close(): Promise<void> {
    // Kein eigener Verbindungszustand — die DB wird zentral geschlossen
  }
}

// ── Worker ──────────────────────────────────────────────────

interface ClaimedJob {
  id: number;
  name: string;
  data: string;
  attempts_made: number;
  max_attempts: number;
  backoff_type: string | null;
  backoff_delay: number;
}

export class LocalWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private closed = false;

  constructor(
    public readonly name: string,
    private readonly processor: (job: JobLike<any>) => Promise<unknown>,
    private readonly opts: { concurrency: number }
  ) {
    void this.tick();
  }

  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => void this.tick(), POLL_INTERVAL_MS);
  }

  private async tick() {
    if (this.closed) return;
    try {
      while (this.running < this.opts.concurrency) {
        const job = await this.claimNext();
        if (!job) break;
        // run() behandelt Job-Fehler selbst; dieser catch fängt Fehler der
        // Fehlerbehandlung (z. B. SQLITE_BUSY beim Statusschreiben) ab
        void this.run(job).catch((err) =>
          console.error(`Queue ${this.name}: Job ${job.id} nicht abschließbar`, err)
        );
      }
    } catch (err) {
      console.error(`Queue ${this.name}: Poll-Fehler`, err);
    } finally {
      this.schedule();
    }
  }

  /** Holt den nächsten fälligen Job und markiert ihn atomar als aktiv. */
  private async claimNext(): Promise<ClaimedJob | null> {
    const candidate = await db
      .selectFrom("local_jobs")
      .select(["id"])
      .where("queue", "=", this.name)
      .where("status", "=", "waiting")
      .where("run_at", "<=", iso())
      .orderBy("run_at", "asc")
      .limit(1)
      .executeTakeFirst();

    if (!candidate) return null;

    // Die Statusbedingung entscheidet das Rennen, falls parallel geclaimt wird
    const claimed = await db
      .updateTable("local_jobs")
      .set({ status: "active", updated_at: iso() })
      .where("id", "=", candidate.id)
      .where("status", "=", "waiting")
      .executeTakeFirst();

    if (Number(claimed.numUpdatedRows) === 0) return null;

    const row = await db
      .selectFrom("local_jobs")
      .select(["id", "name", "data", "attempts_made", "max_attempts", "backoff_type", "backoff_delay"])
      .where("id", "=", candidate.id)
      .executeTakeFirst();

    return row ?? null;
  }

  private async run(job: ClaimedJob) {
    this.running++;
    try {
      await this.processor({ data: safeParse(job.data), name: job.name, id: String(job.id) });
      await db
        .updateTable("local_jobs")
        .set({ status: "completed", failed_reason: null, updated_at: iso() })
        .where("id", "=", job.id)
        .execute();
    } catch (err) {
      await this.handleFailure(job, err);
    } finally {
      this.running--;
    }
  }

  private async handleFailure(job: ClaimedJob, err: unknown) {
    const attempts = job.attempts_made + 1;
    const reason = err instanceof Error ? err.message : String(err);

    if (attempts >= job.max_attempts) {
      await db
        .updateTable("local_jobs")
        .set({ status: "failed", attempts_made: attempts, failed_reason: reason, updated_at: iso() })
        .where("id", "=", job.id)
        .execute();
      return;
    }

    const delay = backoffDelay({ type: job.backoff_type, delay: job.backoff_delay }, attempts);
    await db
      .updateTable("local_jobs")
      .set({
        status: "waiting",
        attempts_made: attempts,
        failed_reason: reason,
        run_at: iso(delay),
        updated_at: iso(),
      })
      .where("id", "=", job.id)
      .execute();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    // Laufende Jobs auslaufen lassen (max. 30s)
    const deadline = Date.now() + 30_000;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// ── Wartung ─────────────────────────────────────────────────

/**
 * Jobs, die beim letzten Beenden mitten in der Ausführung waren, wieder
 * einreihen — sonst blieben sie für immer auf "active" stehen.
 */
export async function recoverStalledJobs(): Promise<number> {
  const result = await db
    .updateTable("local_jobs")
    .set({ status: "waiting", run_at: iso(), updated_at: iso() })
    .where("status", "=", "active")
    .executeTakeFirst();

  const count = Number(result.numUpdatedRows);
  if (count > 0) console.log(`♻️  ${count} unterbrochene Job(s) wieder eingereiht`);
  return count;
}

/** Alte erledigte/fehlgeschlagene Jobs beschneiden (analog removeOnComplete). */
export async function pruneJobs(): Promise<void> {
  for (const [status, keep] of [
    ["completed", KEEP_COMPLETED],
    ["failed", KEEP_FAILED],
  ] as const) {
    const survivors = await db
      .selectFrom("local_jobs")
      .select(["id"])
      .where("status", "=", status)
      .orderBy("updated_at", "desc")
      .limit(keep)
      .execute();

    let query = db.deleteFrom("local_jobs").where("status", "=", status);
    if (survivors.length > 0) {
      query = query.where("id", "not in", survivors.map((s) => s.id));
    }
    await query.execute();
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
