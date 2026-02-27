import { Hono } from "hono";
import { db, type ProjectSettings } from "../db/index.js";
import { render, renderPartial } from "../lib/templates.js";

export const pages = new Hono();

// ── Available languages (cache from HeyGen or hardcode common ones) ─

const COMMON_LANGUAGES = [
  "English", "German", "French", "Spanish", "Italian", "Portuguese",
  "Dutch", "Polish", "Russian", "Turkish", "Arabic", "Hindi",
  "Japanese", "Korean", "Chinese", "Swedish", "Norwegian", "Danish",
  "Finnish", "Czech", "Romanian", "Hungarian", "Indonesian", "Thai",
  "Vietnamese", "Filipino", "Malay", "Ukrainian",
];

// ── Projects List ───────────────────────────────────────────

pages.get("/", async (c) => {
  const projects = await db
    .selectFrom("projects")
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();

  // Enrich with video count and languages
  const enriched = await Promise.all(
    projects.map(async (p) => {
      const [{ count }] = await db
        .selectFrom("videos")
        .select(db.fn.countAll().as("count"))
        .where("project_id", "=", p.id)
        .execute();

      const settings: ProjectSettings = JSON.parse(p.settings);
      return {
        ...p,
        video_count: count,
        languages: settings.output_languages,
      };
    })
  );

  return c.html(render("projects-list", { projects: enriched }));
});

// ── New Project Modal ───────────────────────────────────────

pages.get("/projects/new", async (c) => {
  return c.html(renderPartial("modals/new-project", {
    languages: COMMON_LANGUAGES,
  }));
});

// ── Project Detail ──────────────────────────────────────────

pages.get("/projects/:id", async (c) => {
  const projectId = c.req.param("id");

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();

  const videos = await db
    .selectFrom("videos")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at", "asc")
    .execute();

  const proofreads = await db
    .selectFrom("proofreads")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at", "asc")
    .execute();

  // Enrich proofreads with video title
  const videoMap = new Map(videos.map((v) => [v.id, v.title]));
  const enrichedProofreads = proofreads.map((p) => ({
    ...p,
    video_title: videoMap.get(p.video_id) ?? "Unknown",
  }));

  const translated = await db
    .selectFrom("translated_videos")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at", "asc")
    .execute();

  // Enrich translated with video title + language
  const proofreadMap = new Map(
    proofreads.map((p) => [p.id, { video_id: p.video_id, language: p.language }])
  );
  const enrichedTranslated = translated.map((t) => {
    const pr = proofreadMap.get(t.proofread_id);
    return {
      ...t,
      video_title: pr ? videoMap.get(pr.video_id) ?? "Unknown" : "Unknown",
      language: pr?.language ?? "Unknown",
    };
  });

  const settings: ProjectSettings = JSON.parse(project.settings);

  return c.html(
    render("project-detail", {
      project: { ...project, settings },
      videos,
      proofreads: enrichedProofreads,
      translated: enrichedTranslated,
      videoCount: videos.length,
      proofreadCount: proofreads.length,
      translatedCount: translated.length,
      languages: settings.output_languages,
      hasEditedProofreads: proofreads.some(
        (p) => p.status === "completed" || p.status === "edited"
      ),
      hasCompletedTranslations: translated.some(
        (t) => t.status === "completed"
      ),
      stats: buildStats(videos.length, proofreads, translated),
    })
  );
});

// ── Upload Videos Modal ─────────────────────────────────────

pages.get("/projects/:id/videos/upload", async (c) => {
  return c.html(renderPartial("modals/upload-videos", {
    projectId: c.req.param("id"),
  }));
});

// ── Upload Excel Modal ──────────────────────────────────────

pages.get("/projects/:id/proofreads/:proofreadId/upload", async (c) => {
  const proofread = await db
    .selectFrom("proofreads")
    .select(["id", "video_id", "language"])
    .where("id", "=", c.req.param("proofreadId"))
    .executeTakeFirstOrThrow();

  const video = await db
    .selectFrom("videos")
    .select(["title"])
    .where("id", "=", proofread.video_id)
    .executeTakeFirstOrThrow();

  return c.html(renderPartial("modals/upload-excel", {
    proofreadId: proofread.id,
    videoTitle: video.title,
    language: proofread.language,
  }));
});

// ── HTMX Partials (live-refreshed) ─────────────────────────

pages.get("/partials/projects/:id/status", async (c) => {
  const projectId = c.req.param("id");

  const [{ count: videoCount }] = await db
    .selectFrom("videos")
    .select(db.fn.countAll().as("count"))
    .where("project_id", "=", projectId)
    .execute();

  const proofreads = await db
    .selectFrom("proofreads")
    .selectAll()
    .where("project_id", "=", projectId)
    .execute();

  const translated = await db
    .selectFrom("translated_videos")
    .selectAll()
    .where("project_id", "=", projectId)
    .execute();

  return c.html(renderPartial("partials/status-cards", {
    stats: buildStats(Number(videoCount), proofreads, translated),
  }));
});

pages.get("/partials/projects/:id/proofreads", async (c) => {
  const projectId = c.req.param("id");

  const proofreads = await db
    .selectFrom("proofreads")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at", "asc")
    .execute();

  const videos = await db
    .selectFrom("videos")
    .select(["id", "title"])
    .where("project_id", "=", projectId)
    .execute();

  const videoMap = new Map(videos.map((v) => [v.id, v.title]));

  return c.html(renderPartial("partials/proofreads-table", {
    proofreads: proofreads.map((p) => ({
      ...p,
      video_title: videoMap.get(p.video_id) ?? "Unknown",
    })),
  }));
});

pages.get("/partials/projects/:id/translated", async (c) => {
  const projectId = c.req.param("id");

  const translated = await db
    .selectFrom("translated_videos")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at", "asc")
    .execute();

  const proofreads = await db
    .selectFrom("proofreads")
    .select(["id", "video_id", "language"])
    .where("project_id", "=", projectId)
    .execute();

  const videos = await db
    .selectFrom("videos")
    .select(["id", "title"])
    .where("project_id", "=", projectId)
    .execute();

  const videoMap = new Map(videos.map((v) => [v.id, v.title]));
  const proofreadMap = new Map(
    proofreads.map((p) => [p.id, { video_id: p.video_id, language: p.language }])
  );

  return c.html(renderPartial("partials/translated-table", {
    translated: translated.map((t) => {
      const pr = proofreadMap.get(t.proofread_id);
      return {
        ...t,
        video_title: pr ? videoMap.get(pr.video_id) ?? "Unknown" : "Unknown",
        language: pr?.language ?? "Unknown",
      };
    }),
  }));
});

// ── Helper ──────────────────────────────────────────────────

function buildStats(
  videoCount: number,
  proofreads: Array<{ status: string }>,
  translated: Array<{ status: string }>
) {
  const pCounts = proofreads.reduce(
    (acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const tCounts = translated.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return {
    videos: videoCount,
    proofreads_processing: (pCounts.pending ?? 0) + (pCounts.processing ?? 0),
    proofreads_completed:
      (pCounts.completed ?? 0) + (pCounts.edited ?? 0) + (pCounts.done ?? 0),
    proofreads_failed: pCounts.failed ?? 0,
    translated_processing:
      (tCounts.pending ?? 0) + (tCounts.processing ?? 0),
    translated_completed: tCounts.completed ?? 0,
    translated_failed: tCounts.failed ?? 0,
  };
}
