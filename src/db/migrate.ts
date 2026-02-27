import { createPool } from "mysql2/promise";
import { config } from "../config.js";

async function migrate() {
  console.log("Starting migration...");

  const pool = createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    multipleStatements: true,
  });

  const sql = `
    CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(21) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      heygen_folder_id VARCHAR(255),
      settings JSON NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS videos (
      id VARCHAR(21) PRIMARY KEY,
      project_id VARCHAR(21) NOT NULL,
      title VARCHAR(500) NOT NULL,
      original_filename VARCHAR(500),
      video_url TEXT NOT NULL,
      storage_key VARCHAR(500),
      duration_seconds INT,
      file_size_bytes BIGINT,
      status VARCHAR(50) NOT NULL DEFAULT 'uploaded',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_videos_project (project_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS proofreads (
      id VARCHAR(21) PRIMARY KEY,
      video_id VARCHAR(21) NOT NULL,
      project_id VARCHAR(21) NOT NULL,
      language VARCHAR(50) NOT NULL,
      heygen_proofread_id VARCHAR(255),
      idempotency_key VARCHAR(255) UNIQUE,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      srt_url TEXT,
      srt_storage_key VARCHAR(500),
      excel_storage_key VARCHAR(500),
      edited_srt_storage_key VARCHAR(500),
      excel_revision INT NOT NULL DEFAULT 0,
      error_message TEXT,
      retry_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_proofreads_video (video_id),
      INDEX idx_proofreads_project_status (project_id, status),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS proofread_revisions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      proofread_id VARCHAR(21) NOT NULL,
      revision INT NOT NULL,
      excel_storage_key VARCHAR(500) NOT NULL,
      srt_storage_key VARCHAR(500),
      uploaded_by VARCHAR(100) NOT NULL DEFAULT 'user',
      diff_summary TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_revisions_proofread (proofread_id),
      FOREIGN KEY (proofread_id) REFERENCES proofreads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS translated_videos (
      id VARCHAR(21) PRIMARY KEY,
      proofread_id VARCHAR(21) NOT NULL,
      project_id VARCHAR(21) NOT NULL,
      heygen_video_translate_id VARCHAR(255),
      idempotency_key VARCHAR(255) UNIQUE,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      video_url TEXT,
      storage_key VARCHAR(500),
      error_message TEXT,
      retry_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_translated_videos_proofread (proofread_id),
      FOREIGN KEY (proofread_id) REFERENCES proofreads(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS job_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      job_type VARCHAR(100) NOT NULL,
      reference_id VARCHAR(21) NOT NULL,
      status VARCHAR(50) NOT NULL,
      message TEXT,
      payload JSON,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await pool.query(sql);
    console.log("All migrations complete");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }

  await pool.end();
  process.exit(0);
}

migrate();
