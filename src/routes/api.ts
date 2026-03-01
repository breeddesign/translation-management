import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db, type ProjectSettings, parseSettings } from "../db/index.js";
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

// ── HeyGen Init (folders + languages for project creation) ──

api.get("/heygen/init", async (c) => {
  const [foldersRes, langsRes] = await Promise.all([
    heygen.listFolders(),
    heygen.listSupportedLanguages(),
  ]);
  return c.json({
    folders: foldersRes.data.folders,
    languages: langsRes.data.languages,
  });
});

// ── Folders ─────────────────────────────────────────────────

api.post("/folders", async (c) => {
  const body = await c.req.json<{ name: string; parent_id?: string }>();
  await heygen.createFolder(body.name, "video_translate", body.parent_id);
  c.header("HX-Redirect", "/");
  return c.body(null, 204);
});

// ── Projects ────────────────────────────────────────────────

api.get("/projects", async (c) => {
  const projects = await db.selectFrom("projects").selectAll().orderBy("created_at", "desc").execute();
  return c.json(projects);
});

api.post("/projects", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const id = nanoid();

  // HTMX json-enc sends flat keys like "settings.mode" instead of nested objects.
  // Build the settings object from either nested or flat format.
  let settings: ProjectSettings;
  if (body.settings && typeof body.settings === "object") {
    settings = body.settings as ProjectSettings;
  } else {
    settings = {
      mode: ((body["settings.mode"] as string) ?? "fast") as "fast" | "quality",
      output_languages: Array.isArray(body["settings.output_languages"])
        ? body["settings.output_languages"] as string[]
        : body["settings.output_languages"] ? [body["settings.output_languages"] as string] : [],
      enable_video_stretching: body["settings.enable_video_stretching"] === true || body["settings.enable_video_stretching"] === "on",
      disable_music_track: body["settings.disable_music_track"] === true || body["settings.disable_music_track"] === "on",
      enable_speech_enhancement: body["settings.enable_speech_enhancement"] === true || body["settings.enable_speech_enhancement"] === "on",
      translate_audio_only: body["settings.translate_audio_only"] === true || body["settings.translate_audio_only"] === "on",
      speaker_num: Number(body["settings.speaker_num"]) || 1,
      brand_voice_id: (body["settings.brand_voice_id"] as string) ?? null,
      captions: body["settings.captions"] === true || body["settings.captions"] === "on",
    };
  }

  const heygenFolderId = body.heygen_folder_id as string | undefined;
  let folderId: string;
  if (heygenFolderId) {
    folderId = heygenFolderId;
  } else {
    const folderResult = await heygen.createFolder(body.name as string, "video_translate");
    folderId = folderResult.data.id;
  }

  await db.insertInto("projects").values({
    id,
    name: body.name as string,
    heygen_folder_id: folderId,
    settings: JSON.stringify(settings),
    status: "draft",
  }).execute();

  // If request comes from HTMX, redirect to new project page
  if (c.req.header("HX-Request")) {
    c.header("HX-Redirect", `/projects/${id}`);
    return c.body(null, 204);
  }
  return c.json({ id, heygen_folder_id: folderId }, 201);
});

api.get("/projects/:id", async (c) => {
  const project = await db.selectFrom("projects").selectAll().where("id", "=", c.req.param("id")).executeTakeFirstOrThrow();
  const videos = await db.selectFrom("videos").selectAll().where("project_id", "=", project.id).orderBy("created_at", "asc").execute();
  const proofreads = await db.selectFrom("proofreads").selectAll().where("project_id", "=", project.id).orderBy("created_at", "asc").execute();
  const translatedVideos = await db.selectFrom("translated_videos").selectAll().where("project_id", "=", project.id).orderBy("created_at", "asc").execute();

  return c.json({ ...project, settings: parseSettings(project.settings), videos, proofreads, translatedVideos });
});

// ── Delete Project (+ cascade all children) ─────────────────

api.delete("/projects/:id", async (c) => {
  const projectId = c.req.param("id");

  // Cascade: translated_videos → proofread_revisions → proofreads → videos → job_log → project
  const proofreads = await db.selectFrom("proofreads").select("id").where("project_id", "=", projectId).execute();
  if (proofreads.length) {
    const proofreadIds = proofreads.map((p) => p.id);
    await db.deleteFrom("translated_videos").where("proofread_id", "in", proofreadIds).execute();
    await db.deleteFrom("proofread_revisions").where("proofread_id", "in", proofreadIds).execute();
  }
  await db.deleteFrom("proofreads").where("project_id", "=", projectId).execute();
  await db.deleteFrom("videos").where("project_id", "=", projectId).execute();
  await db.deleteFrom("job_log").where("reference_id", "=", projectId).execute();
  await db.deleteFrom("projects").where("id", "=", projectId).execute();

  if (c.req.header("HX-Request")) {
    c.header("HX-Redirect", "/");
    return c.body(null, 204);
  }
  return c.json({ message: "Project deleted" });
});

api.patch("/projects/:id/settings", async (c) => {
  const body = await c.req.json<Partial<ProjectSettings>>();
  const project = await db.selectFrom("projects").select(["settings"]).where("id", "=", c.req.param("id")).executeTakeFirstOrThrow();
  const updated = { ...parseSettings(project.settings), ...body };
  await db.updateTable("projects").set({ settings: JSON.stringify(updated) }).where("id", "=", c.req.param("id")).execute();
  return c.json(updated);
});

// ── Videos ──────────────────────────────────────────────────

api.post("/projects/:id/videos", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{
    videos: Array<{ title: string; video_url: string; original_filename?: string }>;
  }>();

  // Check for existing videos with same URL in this project
  const existingUrls = new Set(
    (await db.selectFrom("videos").select("video_url").where("project_id", "=", projectId).execute())
      .map((v) => v.video_url)
  );

  const ids: string[] = [];
  for (const v of body.videos) {
    if (existingUrls.has(v.video_url)) continue; // skip duplicates
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

// ── Delete Video (+ cascading proofreads & translated) ──────

api.delete("/projects/:id/videos/:videoId", async (c) => {
  const projectId = c.req.param("id");
  const videoId = c.req.param("videoId");

  // Cascade: delete translated videos → proofreads → video
  const proofreads = await db.selectFrom("proofreads").select("id").where("video_id", "=", videoId).execute();
  if (proofreads.length) {
    const proofreadIds = proofreads.map((p) => p.id);
    await db.deleteFrom("translated_videos").where("proofread_id", "in", proofreadIds).execute();
    await db.deleteFrom("proofread_revisions").where("proofread_id", "in", proofreadIds).execute();
    await db.deleteFrom("proofreads").where("video_id", "=", videoId).execute();
  }
  await db.deleteFrom("videos").where("id", "=", videoId).where("project_id", "=", projectId).execute();

  if (c.req.header("HX-Request")) {
    c.header("HX-Redirect", `/projects/${projectId}`);
    return c.body(null, 204);
  }
  return c.json({ message: "Video deleted" });
});

// ── Delete Proofread (+ cascading translated) ───────────────

api.delete("/proofreads/:id", async (c) => {
  const proofreadId = c.req.param("id");

  const proofread = await db.selectFrom("proofreads").select(["project_id"]).where("id", "=", proofreadId).executeTakeFirstOrThrow();

  await db.deleteFrom("translated_videos").where("proofread_id", "=", proofreadId).execute();
  await db.deleteFrom("proofread_revisions").where("proofread_id", "=", proofreadId).execute();
  await db.deleteFrom("proofreads").where("id", "=", proofreadId).execute();

  if (c.req.header("HX-Request")) {
    c.header("HX-Trigger", "pollStatus");
    return c.body(null, 204);
  }
  return c.json({ message: "Proofread deleted" });
});

// ── Batch: Delete Videos ────────────────────────────────────

api.post("/projects/:id/videos/batch-delete", async (c) => {
  const projectId = c.req.param("id");
  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!ids?.length) return c.json({ error: "No IDs provided" }, 400);

  for (const videoId of ids) {
    const proofreads = await db.selectFrom("proofreads").select("id").where("video_id", "=", videoId).execute();
    if (proofreads.length) {
      const proofreadIds = proofreads.map((p) => p.id);
      await db.deleteFrom("translated_videos").where("proofread_id", "in", proofreadIds).execute();
      await db.deleteFrom("proofread_revisions").where("proofread_id", "in", proofreadIds).execute();
      await db.deleteFrom("proofreads").where("video_id", "=", videoId).execute();
    }
    await db.deleteFrom("videos").where("id", "=", videoId).where("project_id", "=", projectId).execute();
  }

  if (c.req.header("HX-Request")) {
    c.header("HX-Redirect", `/projects/${projectId}`);
    return c.body(null, 204);
  }
  return c.json({ message: `Deleted ${ids.length} videos` });
});

// ── Batch: Delete Proofreads ────────────────────────────────

api.post("/proofreads/batch-delete", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!ids?.length) return c.json({ error: "No IDs provided" }, 400);

  let projectId: string | null = null;
  for (const id of ids) {
    const pr = await db.selectFrom("proofreads").select(["project_id"]).where("id", "=", id).executeTakeFirst();
    if (!pr) continue;
    projectId = pr.project_id;
    await db.deleteFrom("translated_videos").where("proofread_id", "=", id).execute();
    await db.deleteFrom("proofread_revisions").where("proofread_id", "=", id).execute();
    await db.deleteFrom("proofreads").where("id", "=", id).execute();
  }

  if (c.req.header("HX-Request")) {
    if (projectId) c.header("HX-Redirect", `/projects/${projectId}`);
    return c.body(null, 204);
  }
  return c.json({ message: `Deleted ${ids.length} proofreads` });
});

// ── Batch: Sync Proofreads ──────────────────────────────────

api.post("/proofreads/batch-sync", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!ids?.length) return c.json({ error: "No IDs provided" }, 400);

  const results: Array<{ id: string; status: string }> = [];
  for (const proofreadId of ids) {
    const proofread = await db.selectFrom("proofreads")
      .select(["id", "heygen_proofread_id", "status", "project_id", "video_id", "language"])
      .where("id", "=", proofreadId)
      .executeTakeFirst();

    if (!proofread?.heygen_proofread_id) continue;

    const result = await heygen.getProofreadStatus(proofread.heygen_proofread_id);
    if (result.error) { results.push({ id: proofreadId, status: "error" }); continue; }

    const heygenStatus = result.data.status;

    if (heygenStatus === "completed" && proofread.status === "processing") {
      const srtResult = await heygen.downloadProofreadSrt(proofread.heygen_proofread_id);
      const srtResponse = await fetch(srtResult.data.srt_url);
      const srtContent = await srtResponse.text();

      const { srtToExcel } = await import("../services/srt-excel.js");
      const excelBuffer = await srtToExcel(srtContent);

      const storage = getStorage();
      const srtKey = `proofreads/${proofread.video_id}/${proofread.language}/original.srt`;
      const excelKey = `proofreads/${proofread.video_id}/${proofread.language}/v0.xlsx`;

      await storage.upload(srtKey, srtContent, "text/plain");
      await storage.upload(excelKey, excelBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

      await db.updateTable("proofreads").set({
        status: "completed", srt_url: srtResult.data.srt_url,
        srt_storage_key: srtKey, excel_storage_key: excelKey, excel_revision: 0,
      }).where("id", "=", proofreadId).execute();
      results.push({ id: proofreadId, status: "completed" });
    } else if (heygenStatus === "failed") {
      await db.updateTable("proofreads").set({
        status: "failed", error_message: result.data.details ?? "Failed in HeyGen",
      }).where("id", "=", proofreadId).execute();
      results.push({ id: proofreadId, status: "failed" });
    } else {
      results.push({ id: proofreadId, status: heygenStatus });
    }
  }

  if (c.req.header("HX-Request")) {
    c.header("HX-Trigger", "pollStatus");
    return c.body(null, 204);
  }
  return c.json({ results });
});

// ── Batch: Download Proofreads (multiple Excel redirect) ────

api.post("/proofreads/batch-download", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!ids?.length) return c.json({ error: "No IDs provided" }, 400);

  const storage = getStorage();
  const urls: Array<{ id: string; language: string; video_title: string; url: string }> = [];

  for (const id of ids) {
    const pr = await db.selectFrom("proofreads")
      .select(["excel_storage_key", "language", "video_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!pr?.excel_storage_key) continue;

    const video = await db.selectFrom("videos").select("title").where("id", "=", pr.video_id).executeTakeFirst();
    const url = await storage.getSignedDownloadUrl(pr.excel_storage_key);
    urls.push({ id, language: pr.language, video_title: video?.title ?? "Unknown", url });
  }

  return c.json({ downloads: urls });
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

  if (videos.length === 0) {
    return c.json({ message: "No new videos to process", count: 0 });
  }

  const videoIds = videos.map((v) => v.id);
  const count = await enqueueProjectProofreads(queues, projectId, videoIds);

  // Mark videos as "ready" so they won't be re-enqueued on a second click
  await db.updateTable("videos").set({ status: "ready" }).where("project_id", "=", projectId).where("status", "=", "uploaded").execute();
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
  return c.redirect(url);
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

// ── Sync proofread status from HeyGen ───────────────────────

api.post("/proofreads/:id/sync", async (c) => {
  const proofreadId = c.req.param("id");
  const proofread = await db.selectFrom("proofreads")
    .select(["id", "heygen_proofread_id", "status", "project_id", "video_id", "language"])
    .where("id", "=", proofreadId)
    .executeTakeFirstOrThrow();

  if (!proofread.heygen_proofread_id) {
    return c.json({ error: "No HeyGen proofread ID" }, 400);
  }

  const result = await heygen.getProofreadStatus(proofread.heygen_proofread_id);
  if (result.error) {
    return c.json({ error: result.error }, 500);
  }

  const heygenStatus = result.data.status;

  if (heygenStatus === "completed" && proofread.status === "processing") {
    // Download SRT and process it
    const srtResult = await heygen.downloadProofreadSrt(proofread.heygen_proofread_id);
    const srtResponse = await fetch(srtResult.data.srt_url);
    const srtContent = await srtResponse.text();

    const { srtToExcel } = await import("../services/srt-excel.js");
    const excelBuffer = await srtToExcel(srtContent);

    const { getStorage } = await import("../services/storage.js");
    const storage = getStorage();

    const srtKey = `proofreads/${proofread.video_id}/${proofread.language}/original.srt`;
    const excelKey = `proofreads/${proofread.video_id}/${proofread.language}/v0.xlsx`;

    await storage.upload(srtKey, srtContent, "text/plain");
    await storage.upload(excelKey, excelBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    await db.updateTable("proofreads").set({
      status: "completed",
      srt_url: srtResult.data.srt_url,
      srt_storage_key: srtKey,
      excel_storage_key: excelKey,
      excel_revision: 0,
    }).where("id", "=", proofreadId).execute();
  } else if (heygenStatus === "failed") {
    await db.updateTable("proofreads").set({
      status: "failed",
      error_message: result.data.details ?? "Failed in HeyGen",
    }).where("id", "=", proofreadId).execute();
  }

  if (c.req.header("HX-Request")) {
    // Trigger pollStatus to refresh proofreads table in-place (no page reload)
    c.header("HX-Trigger", "pollStatus");
    return c.body(null, 204);
  }
  return c.json({ heygen_status: heygenStatus, local_status: proofread.status });
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
