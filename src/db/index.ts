import { Kysely, MysqlDialect, type Generated } from "kysely";
import { createPool } from "mysql2";
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

export interface Database {
  projects: ProjectTable;
  videos: VideoTable;
  proofreads: ProofreadTable;
  proofread_revisions: ProofreadRevisionTable;
  translated_videos: TranslatedVideoTable;
  job_log: JobLogTable;
}

const pool = createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  connectionLimit: 10,
  timezone: "+00:00",
});

export const db = new Kysely<Database>({
  dialect: new MysqlDialect({ pool: pool as any }),
});
