import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Projects ──────────────────────────────────────────────
  await db.schema
    .createTable("projects")
    .addColumn("id", "varchar(21)", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("heygen_folder_id", "varchar(255)")
    .addColumn("settings", "json", (col) =>
      col.notNull().defaultTo(
        sql`('{"mode":"fast","output_languages":["English"],"enable_video_stretching":false,"disable_music_track":false,"enable_speech_enhancement":true,"translate_audio_only":false,"speaker_num":1,"brand_voice_id":null,"captions":true}')`
      )
    )
    .addColumn("status", "varchar(50)", (col) => col.notNull().defaultTo("draft"))
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`))
    .execute();

  // ── Videos ────────────────────────────────────────────────
  await db.schema
    .createTable("videos")
    .addColumn("id", "varchar(21)", (col) => col.primaryKey())
    .addColumn("project_id", "varchar(21)", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("title", "varchar(500)", (col) => col.notNull())
    .addColumn("original_filename", "varchar(500)")
    .addColumn("video_url", "text", (col) => col.notNull())
    .addColumn("storage_key", "varchar(500)")
    .addColumn("duration_seconds", "integer")
    .addColumn("file_size_bytes", "bigint")
    .addColumn("status", "varchar(50)", (col) => col.notNull().defaultTo("uploaded"))
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex("idx_videos_project").on("videos").column("project_id").execute();

  // ── Proofreads ────────────────────────────────────────────
  await db.schema
    .createTable("proofreads")
    .addColumn("id", "varchar(21)", (col) => col.primaryKey())
    .addColumn("video_id", "varchar(21)", (col) => col.notNull().references("videos.id").onDelete("cascade"))
    .addColumn("project_id", "varchar(21)", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("language", "varchar(50)", (col) => col.notNull())
    .addColumn("heygen_proofread_id", "varchar(255)")
    // Idempotency: deterministic key prevents duplicate HeyGen submissions
    .addColumn("idempotency_key", "varchar(255)", (col) => col.unique())
    .addColumn("status", "varchar(50)", (col) => col.notNull().defaultTo("pending"))
    .addColumn("srt_url", "text")
    .addColumn("srt_storage_key", "varchar(500)")
    .addColumn("excel_storage_key", "varchar(500)")
    .addColumn("edited_srt_storage_key", "varchar(500)")
    // Excel revision tracking
    .addColumn("excel_revision", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error_message", "text")
    .addColumn("retry_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex("idx_proofreads_video").on("proofreads").column("video_id").execute();
  await db.schema.createIndex("idx_proofreads_project_status").on("proofreads").columns(["project_id", "status"]).execute();
  await db.schema.createIndex("idx_proofreads_idempotency").on("proofreads").column("idempotency_key").execute();

  // ── Proofread Revisions (audit log for Excel edits) ───────
  await db.schema
    .createTable("proofread_revisions")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("proofread_id", "varchar(21)", (col) => col.notNull().references("proofreads.id").onDelete("cascade"))
    .addColumn("revision", "integer", (col) => col.notNull())
    .addColumn("excel_storage_key", "varchar(500)", (col) => col.notNull())
    .addColumn("srt_storage_key", "varchar(500)")
    .addColumn("uploaded_by", "varchar(100)", (col) => col.notNull().defaultTo("user"))
    .addColumn("diff_summary", "text") // e.g. "Changed 12 of 45 lines"
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex("idx_revisions_proofread").on("proofread_revisions").column("proofread_id").execute();

  // ── Translated Videos ─────────────────────────────────────
  await db.schema
    .createTable("translated_videos")
    .addColumn("id", "varchar(21)", (col) => col.primaryKey())
    .addColumn("proofread_id", "varchar(21)", (col) => col.notNull().references("proofreads.id").onDelete("cascade"))
    .addColumn("project_id", "varchar(21)", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("heygen_video_translate_id", "varchar(255)")
    .addColumn("idempotency_key", "varchar(255)", (col) => col.unique())
    .addColumn("status", "varchar(50)", (col) => col.notNull().defaultTo("pending"))
    .addColumn("video_url", "text")
    .addColumn("storage_key", "varchar(500)")
    .addColumn("vtt_storage_key", "varchar(500)")
    .addColumn("srt_storage_key", "varchar(500)")
    .addColumn("error_message", "text")
    .addColumn("retry_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex("idx_translated_videos_proofread").on("translated_videos").column("proofread_id").execute();

  // ── Job Log ───────────────────────────────────────────────
  await db.schema
    .createTable("job_log")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("job_type", "varchar(100)", (col) => col.notNull())
    .addColumn("reference_id", "varchar(21)", (col) => col.notNull())
    .addColumn("status", "varchar(50)", (col) => col.notNull())
    .addColumn("message", "text")
    .addColumn("payload", "json")
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("job_log").ifExists().execute();
  await db.schema.dropTable("translated_videos").ifExists().execute();
  await db.schema.dropTable("proofread_revisions").ifExists().execute();
  await db.schema.dropTable("proofreads").ifExists().execute();
  await db.schema.dropTable("videos").ifExists().execute();
  await db.schema.dropTable("projects").ifExists().execute();
}
