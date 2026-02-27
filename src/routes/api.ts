import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db, type ProjectSettings } from "../db/index.js";
import * as heygen from "../services/heygen.js";
import { excelToSrt } from "../services/srt-excel.js";
import { getStorage } from "../services/storage.js";
import {
  createRedisConnection,
  createQueues,
  enqueueProjectProofreads,
  enqueueVideoGenerations,
  type Queues,
} from "../queue/index.js";

export const api = new Hono();

// ── Lazy queue init (set by web.ts middleware) ───────────────
function getQueues(c: any): Queues {
  return c.get("queues");
}

// ── Projects ────────────────────────────────────────────────

api.get("/projects", async (c) => {
  const projects = await db.selectFrom("projects").selectAll().orderBy("created_at", "desc").execute();
  return c.json(projects);
});

api.post("/projects", async (c) => {
  const body = await c.req.json<{ name: string; settings: ProjectSettings }>();
  const id = nanoid();

  const folderResult = await heygen.createFolder(body.name, "video_translate");
  const folderId = folderResult.data.id;

  await db.insertInto("projects").values({
    id,
    name: body.name,
    heygen_folder_id: folderId,
    settings: JSON.stringify(body.settings),
    status: "draft",
  }).execute();

  return c.json({ id, heygen_folder_id: folderId }, 201);
});

api.get("/projects/:id", async (c) => {
  const project = await db.selectFrom("projects").selectAll().where("id", "=", c.req.param("id")).executeTakeFirstOrThrow();
  const videos = await db.selectFrom("videos").selectAll().where("project_id", "=", project.id).orderBy("created_at", "asc").execute();
  const proofreads = await db.selectFrom("proofreads").selectAll().where("project_id", "=", project.id).orderBy("created_at", "asc").execute();
  const translatedVideos = await db.selectFrom("translated_videos").selectAll().where("project_id", "=", project.id).orderBy("created_at", "asc").execute();

  return c.json({ ...project, settings: JSON.parse(project.settings), videos, proofreads, translatedVideos });
});

api.patch("/projects/:id/settings", async (c) => {
  const body = await c.req.json<Partial<ProjectSettings>>();
  const project = await db.selectFrom("projects").select(["settings"]).where("id", "=", c.req.param("id")).executeTakeFirstOrThrow();
  const updated = { ...JSON.parse(project.settings), ...body };
  await db.updateTable("projects").set({ settings: JSON.stringify(updated) }).where("id", "=", c.req.param("id")).execute();
  return c.json(updated);
});

// ── Videos ──────────────────────────────────────────────────

api.post("/projects/:id/videos", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{
    videos: Array<{ title: string; video_url: string; original_filename?: string }>;
  }>();

  const ids: string[] = [];
  for (const v of body.videos) {
    const id = nanoid();
    await db.insertInto("videos").values({
      id,
      project_id: projectId,
      title: v.title,
      original_filename: v.original_filename ?? null,
      video_url: v.video_url,
      status: "uploaded",
    }).execute();
    ids.push(id);
  }

  return c.json({ video_ids: ids, count: ids.length }, 201);
});

// ── Batch: Generate Proofreads ──────────────────────────────

api.post("/projects/:id/proofreads/generate", async (c) => {
  const projectId = c.req.param("id");
  const queues = getQueues(c);

  const videos = await db
    .selectFrom("videos")
    .select(["id"])
    .where("project_id", "=", projectId)
    .where("status", "=", "uploaded")
    .execute();

  const videoIds = videos.map((v) => v.id);
  const count = await enqueueProjectProofreads(queues, projectId, videoIds);

  await db.updateTable("projects").set({ status: "active" }).where("id", "=", projectId).execute();

  return c.json({ message: `Enqueued ${count} proofread jobs`, count });
});

// ── Proofread Excel Download (signed URL) ───────────────────

api.get("/proofreads/:id/excel", async (c) => {
  const proofread = await db
    .selectFrom("proofreads")
    .select(["excel_storage_key", "language", "video_id"])
    .where("id", "=", c.req.param("id"))
    .executeTakeFirstOrThrow();

  if (!proofread.excel_storage_key) {
    return c.json({ error: "Excel not yet available" }, 404);
  }

  const storage = getStorage();
  const url = await storage.getSignedDownloadUrl(proofread.excel_storage_key);
  return c.json({ download_url: url });
});

// ── Proofread Excel Upload (with revision tracking & diff) ──

api.post("/proofreads/:id/excel", async (c) => {
  const proofreadId = c.req.param("id");

  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  if (!file) return c.json({ error: "No file uploaded" }, 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  const storage = getStorage();

  // Convert Excel → SRT
  const srtContent = await excelToSrt(buffer);

  const proofread = await db
    .selectFrom("proofreads")
    .select(["video_id", "language", "heygen_proofread_id", "excel_revision", "excel_storage_key"])
    .where("id", "=", proofreadId)
    .executeTakeFirstOrThrow();

  const newRevision = proofread.excel_revision + 1;

  // Upload new revision
  const excelKey = `proofreads/${proofread.video_id}/${proofread.language}/v${newRevision}.xlsx`;
  const srtKey = `proofreads/${proofread.video_id}/${proofread.language}/v${newRevision}_edited.srt`;

  await storage.upload(excelKey, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const srtUrl = await storage.upload(srtKey, srtContent, "text/plain");

  // Get public URL for HeyGen (must be internet-reachable)
  const publicSrtUrl = await storage.getPublicUrl(srtKey);

  // Upload to HeyGen
  await heygen.uploadProofreadSrt(proofread.heygen_proofread_id!, publicSrtUrl);

  // Create revision record (audit trail)
  // Compute simple diff summary
  let diffSummary = `Revision ${newRevision} uploaded`;
  if (proofread.excel_storage_key) {
    try {
      const oldExcel = await storage.download(proofread.excel_storage_key);
      const { excelToSrt: toSrt } = await import("../services/srt-excel.js");
      const oldSrt = await toSrt(oldExcel);
      const oldLines = oldSrt.split("\n").filter((l) => l.trim());
      const newLines = srtContent.split("\n").filter((l) => l.trim());
      const changed = oldLines.filter((l, i) => l !== newLines[i]).length;
      diffSummary = `Changed ${changed} of ${oldLines.length} lines`;
    } catch {
      diffSummary = `Revision ${newRevision} (diff unavailable)`;
    }
  }

  await db.insertInto("proofread_revisions").values({
    proofread_id: proofreadId,
    revision: newRevision,
    excel_storage_key: excelKey,
    srt_storage_key: srtKey,
    uploaded_by: "user",
    diff_summary: diffSummary,
  }).execute();

  // Update proofread
  await db
    .updateTable("proofreads")
    .set({
      status: "edited",
      excel_storage_key: excelKey,
      edited_srt_storage_key: srtKey,
      excel_revision: newRevision,
    })
    .where("id", "=", proofreadId)
    .execute();

  return c.json({ message: "Proofread updated", status: "edited", revision: newRevision, diff: diffSummary });
});

// ── Proofread Revision History ──────────────────────────────

api.get("/proofreads/:id/revisions", async (c) => {
  const revisions = await db
    .selectFrom("proofread_revisions")
    .selectAll()
    .where("proofread_id", "=", c.req.param("id"))
    .orderBy("revision", "desc")
    .execute();

  return c.json(revisions);
});

// ── Batch: Generate Videos ──────────────────────────────────

api.post("/projects/:id/videos/generate", async (c) => {
  const projectId = c.req.param("id");
  const queues = getQueues(c);
  const body = await c.req.json<{ proofread_ids?: string[] }>().catch(() => ({}) as { proofread_ids?: string[] });

  let proofreadIds: string[];

  if (body.proofread_ids?.length) {
    proofreadIds = body.proofread_ids;
  } else {
    const proofreads = await db
      .selectFrom("proofreads")
      .select(["id"])
      .where("project_id", "=", projectId)
      .where("status", "in", ["completed", "edited"])
      .execute();
    proofreadIds = proofreads.map((p) => p.id);
  }

  const count = await enqueueVideoGenerations(queues, proofreadIds);
  return c.json({ message: `Enqueued ${count} video generation jobs`, count });
});

// ── Downloads ───────────────────────────────────────────────

api.get("/projects/:id/downloads", async (c) => {
  const projectId = c.req.param("id");

  const videos = await db
    .selectFrom("translated_videos")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("status", "=", "completed")
    .execute();

  return c.json({
    count: videos.length,
    videos: videos.map((v) => ({
      id: v.id,
      proofread_id: v.proofread_id,
      video_url: v.video_url,
      status: v.status,
    })),
  });
});

// ── Status Overview (used by HTMX polling) ──────────────────

api.get("/projects/:id/status", async (c) => {
  const projectId = c.req.param("id");

  const [videoCount] = await db.selectFrom("videos").select(db.fn.countAll().as("count")).where("project_id", "=", projectId).execute();

  const proofreadStats = await db.selectFrom("proofreads").select(["status", db.fn.countAll().as("count")]).where("project_id", "=", projectId).groupBy("status").execute();

  const translatedStats = await db.selectFrom("translated_videos").select(["status", db.fn.countAll().as("count")]).where("project_id", "=", projectId).groupBy("status").execute();

  // Tell the client if jobs are active (for smart polling interval)
  const hasActive =
    proofreadStats.some((s) => ["pending", "processing", "generating"].includes(s.status)) ||
    translatedStats.some((s) => ["pending", "processing"].includes(s.status));

  return c.json({
    videos: videoCount.count,
    proofreads: Object.fromEntries(proofreadStats.map((s) => [s.status, s.count])),
    translated: Object.fromEntries(translatedStats.map((s) => [s.status, s.count])),
    hasActiveJobs: hasActive,
  });
});

// ── Retry failed proofread ──────────────────────────────────

api.post("/proofreads/:id/retry", async (c) => {
  const proofreadId = c.req.param("id");
  const queues = getQueues(c);

  const proofread = await db
    .selectFrom("proofreads")
    .select(["id", "video_id", "project_id", "status", "retry_count"])
    .where("id", "=", proofreadId)
    .executeTakeFirstOrThrow();

  if (proofread.status !== "failed") {
    return c.json({ error: "Can only retry failed proofreads" }, 400);
  }

  await db
    .updateTable("proofreads")
    .set({ status: "pending", error_message: null, retry_count: proofread.retry_count + 1 })
    .where("id", "=", proofreadId)
    .execute();

  await enqueueProjectProofreads(queues, proofread.project_id, [proofread.video_id]);

  return c.json({ message: "Retry enqueued" });
});
