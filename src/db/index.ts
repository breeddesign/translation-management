import { Kysely, MysqlDialect, SqliteDialect, type Generated } from "kysely";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";

export interface ProjectSettings {
  mode: "fast" | "quality";
  output_languages: string[];
  enable_video_stretching: boolean;
  disable_music_track: boolean;
  enable_speech_enhancement: boolean;
  translate_audio_only: boolean;
  speaker_num: number;
  brand_voice_id: string | null;
  captions: boolean;
}

/** MySQL JSON columns are returned as already-parsed objects by mysql2. */
export function parseSettings(settings: string | ProjectSettings): ProjectSettings {
  return typeof settings === "string" ? JSON.parse(settings) : settings;
}

export interface ProjectTable {
  id: string;
  name: string;
  heygen_folder_id: Generated<string | null>;
  settings: string;
  status: Generated<"draft" | "active" | "completed" | "archived">;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VideoTable {
  id: string;
  project_id: string;
  title: string;
  original_filename: Generated<string | null>;
  video_url: string;
  storage_key: Generated<string | null>;
  duration_seconds: Generated<number | null>;
  file_size_bytes: Generated<number | null>;
  status: Generated<"uploaded" | "ready" | "error">;
  created_at: Generated<Date>;
}

export interface ProofreadTable {
  id: string;
  video_id: string;
  project_id: string;
  language: string;
  heygen_proofread_id: Generated<string | null>;
  idempotency_key: Generated<string | null>;
  status: Generated<"pending" | "processing" | "completed" | "edited" | "generating" | "done" | "failed">;
  srt_url: Generated<string | null>;
  srt_storage_key: Generated<string | null>;
  excel_storage_key: Generated<string | null>;
  edited_srt_storage_key: Generated<string | null>;
  excel_revision: Generated<number>;
  error_message: Generated<string | null>;
  retry_count: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProofreadRevisionTable {
  id: Generated<number>;
  proofread_id: string;
  revision: number;
  excel_storage_key: string;
  srt_storage_key: Generated<string | null>;
  uploaded_by: Generated<string>;
  diff_summary: Generated<string | null>;
  created_at: Generated<Date>;
}

export interface TranslatedVideoTable {
  id: string;
  proofread_id: string;
  project_id: string;
  heygen_video_translate_id: Generated<string | null>;
  idempotency_key: Generated<string | null>;
  status: Generated<"pending" | "processing" | "completed" | "failed">;
  video_url: Generated<string | null>;
  storage_key: Generated<string | null>;
  vtt_storage_key: Generated<string | null>;
  srt_storage_key: Generated<string | null>;
  error_message: Generated<string | null>;
  retry_count: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface JobLogTable {
  id: Generated<number>;
  job_type: string;
  reference_id: string;
  status: string;
  message: Generated<string | null>;
  payload: Generated<string | null>;
  created_at: Generated<Date>;
}

/** Job-Queue des Desktop-Modus (nur SQLite; im Server-Modus übernimmt BullMQ). */
export interface LocalJobTable {
  id: Generated<number>;
  queue: string;
  name: string;
  job_key: string | null;
  data: string;
  status: Generated<"waiting" | "active" | "completed" | "failed">;
  run_at: string;
  attempts_made: Generated<number>;
  max_attempts: Generated<number>;
  backoff_type: Generated<string | null>;
  backoff_delay: Generated<number>;
  failed_reason: Generated<string | null>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface Database {
  projects: ProjectTable;
  videos: VideoTable;
  proofreads: ProofreadTable;
  proofread_revisions: ProofreadRevisionTable;
  translated_videos: TranslatedVideoTable;
  job_log: JobLogTable;
  local_jobs: LocalJobTable;
}

/**
 * Erkennt Unique-Constraint-Verletzungen treiberübergreifend.
 * MySQL meldet ER_DUP_ENTRY, SQLite SQLITE_CONSTRAINT_UNIQUE/_PRIMARYKEY.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === "ER_DUP_ENTRY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

// ── Dialekt nach Modus wählen ───────────────────────────────

async function createDialect() {
  if (config.db.driver === "sqlite") {
    const { default: SQLite } = await import("better-sqlite3");
    const { applySqliteSchema } = await import("./sqlite-schema.js");

    mkdirSync(dirname(config.db.sqlitePath), { recursive: true });
    const sqlite = new SQLite(config.db.sqlitePath);
    // Desktop-App startet ohne separaten Migrationsschritt
    applySqliteSchema(sqlite);
    console.log(`🗄️  SQLite: ${config.db.sqlitePath}`);
    return new SqliteDialect({ database: sqlite });
  }

  const { createPool } = await import("mysql2");
  const pool = createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    connectionLimit: 10,
    timezone: "+00:00",
  });
  return new MysqlDialect({ pool: pool as any });
}

export const db = new Kysely<Database>({ dialect: await createDialect() });
