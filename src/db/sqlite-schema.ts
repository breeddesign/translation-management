import type BetterSqlite3 from "better-sqlite3";

/**
 * SQLite-Schema für den Desktop-Modus — inhaltlich identisch zum MySQL-Schema
 * in migrate.ts, nur mit SQLite-Syntax:
 *   AUTO_INCREMENT              → INTEGER PRIMARY KEY AUTOINCREMENT
 *   ON UPDATE CURRENT_TIMESTAMP → AFTER-UPDATE-Trigger
 *   JSON                        → TEXT (parseSettings verarbeitet beides)
 * Zeitstempel werden als ISO-8601 mit Z gespeichert, damit `new Date(...)`
 * sie korrekt als UTC liest und ORDER BY lexikografisch stimmt.
 */

const NOW = "STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')";

const DEFAULT_SETTINGS =
  '{"mode":"fast","output_languages":["English"],"enable_video_stretching":false,' +
  '"disable_music_track":false,"enable_speech_enhancement":true,"translate_audio_only":false,' +
  '"speaker_num":1,"brand_voice_id":null,"captions":true}';

const TABLES = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  heygen_folder_id TEXT,
  settings TEXT NOT NULL DEFAULT '${DEFAULT_SETTINGS}',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  original_filename TEXT,
  video_url TEXT NOT NULL,
  storage_key TEXT,
  duration_seconds INTEGER,
  file_size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'uploaded',
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_videos_project ON videos(project_id);

CREATE TABLE IF NOT EXISTS proofreads (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  heygen_proofread_id TEXT,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  srt_url TEXT,
  srt_storage_key TEXT,
  excel_storage_key TEXT,
  edited_srt_storage_key TEXT,
  excel_revision INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_proofreads_video ON proofreads(video_id);
CREATE INDEX IF NOT EXISTS idx_proofreads_project_status ON proofreads(project_id, status);

CREATE TABLE IF NOT EXISTS proofread_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proofread_id TEXT NOT NULL REFERENCES proofreads(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  excel_storage_key TEXT NOT NULL,
  srt_storage_key TEXT,
  uploaded_by TEXT NOT NULL DEFAULT 'user',
  diff_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_revisions_proofread ON proofread_revisions(proofread_id);

CREATE TABLE IF NOT EXISTS translated_videos (
  id TEXT PRIMARY KEY,
  proofread_id TEXT NOT NULL REFERENCES proofreads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  heygen_video_translate_id TEXT,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  video_url TEXT,
  storage_key TEXT,
  vtt_storage_key TEXT,
  srt_storage_key TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_translated_videos_proofread ON translated_videos(proofread_id);

CREATE TABLE IF NOT EXISTS job_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

-- Job-Queue des Desktop-Modus (ersetzt Redis/BullMQ)
CREATE TABLE IF NOT EXISTS local_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  job_key TEXT,
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  run_at TEXT NOT NULL,
  attempts_made INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  backoff_type TEXT,
  backoff_delay INTEGER NOT NULL DEFAULT 0,
  failed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
);
-- Dedup wie BullMQ-jobId; Jobs ohne Key (manuelle Re-Runs) bleiben unbeschränkt
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_jobs_key
  ON local_jobs(queue, job_key) WHERE job_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_local_jobs_poll ON local_jobs(queue, status, run_at);
`;

/** Tabellen mit updated_at, die einen Touch-Trigger brauchen. */
const TOUCH_TABLES = ["projects", "proofreads", "translated_videos", "local_jobs"];

function touchTrigger(table: string): string {
  // WHEN-Guard verhindert eine erneute Auslösung durch das Trigger-UPDATE selbst
  return `
CREATE TRIGGER IF NOT EXISTS ${table}_touch_updated_at
AFTER UPDATE ON ${table} FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE ${table} SET updated_at = ${NOW} WHERE id = NEW.id;
END;`;
}

/** Legt Schema und Trigger an (idempotent) und aktiviert die nötigen Pragmas. */
export function applySqliteSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  sqlite.exec(TABLES);
  for (const table of TOUCH_TABLES) sqlite.exec(touchTrigger(table));
}
