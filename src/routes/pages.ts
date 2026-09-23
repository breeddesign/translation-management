import { Hono } from "hono";
import { db, type ProjectSettings, parseSettings } from "../db/index.js";
import { render, renderPartial } from "../lib/templates.js";
import * as heygen from "../services/heygen.js";

export const pages = new Hono();

// ── Fallback languages (used when HeyGen API is unreachable) ─

const FALLBACK_LANGUAGES = [
  "English", "German", "French", "Spanish", "Italian", "Portuguese",
  "Dutch", "Polish", "Russian", "Turkish", "Arabic", "Hindi",
  "Japanese", "Korean", "Chinese", "Swedish", "Norwegian", "Danish",
  "Finnish", "Czech", "Romanian", "Hungarian", "Indonesian", "Thai",
  "Vietnamese", "Filipino", "Malay", "Ukrainian",
];

// ── Folder tree helper ──────────────────────────────────────

interface FolderNode {
  id: string;
  name: string;
  parent_id: string | null;
  children: FolderNode[];
  project_count: number;
}

function buildFolderTree(
  folders: Array<{ id: string; name: string; parent_id: string | null }>,
  projectsByFolder: Map<string, number>
): FolderNode[] {
  const nodeMap = new Map<string, FolderNode>();

  for (const f of folders) {
    nodeMap.set(f.id, {
      id: f.id,
      name: f.name,
      parent_id: f.parent_id,
      children: [],
      project_count: projectsByFolder.get(f.id) ?? 0,
    });
  }

  const roots: FolderNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children alphabetically
  const sortChildren = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortChildren(n.children));
  };
  sortChildren(roots);

  return roots;
}

async function loadFolderData() {
  const [foldersRes, projects] = await Promise.all([
    heygen.listFolders(),
    db.selectFrom("projects").select(["id", "name", "heygen_folder_id", "status"]).execute(),
  ]);

  // Count projects per folder
  const projectsByFolder = new Map<string, number>();
  for (const p of projects) {
    if (p.heygen_folder_id) {
      projectsByFolder.set(p.heygen_folder_id, (projectsByFolder.get(p.heygen_folder_id) ?? 0) + 1);
    }
  }

  const tree = buildFolderTree(foldersRes.data.folders, projectsByFolder);
  return { tree, folders: foldersRes.data.folders, projects };
}

// ── Folder Browser (Home) ───────────────────────────────────

// Die Seite rendert sofort; der Ordnerbaum wird per HTMX nachgeladen
pages.get("/", (c) => c.html(render("folder-browser", { selectedFolderId: null })));

// Ordnerbaum (HTMX-Fragment) — der vollständige HeyGen-Baum braucht beim
// ersten Laden einige Sekunden und darf die Seite nicht blockieren
pages.get("/partials/folder-tree", async (c) => {
  try {
    const { tree } = await loadFolderData();
    return c.html(renderPartial("partials/folder-tree", { tree }));
  } catch (err) {
    console.warn("Ordnerbaum konnte nicht geladen werden:", err);
    return c.html(renderPartial("partials/folder-tree", { failed: true }));
  }
});

// Rückfallebene, falls die HeyGen-Ordner nicht erreichbar sind
pages.get("/projects", async (c) => {
  const projects = await db.selectFrom("projects").selectAll().orderBy("created_at", "desc").execute();
  const enriched = await Promise.all(
    projects.map(async (p) => {
      const [{ count }] = await db
        .selectFrom("videos")
        .select(db.fn.countAll().as("count"))
        .where("project_id", "=", p.id)
        .execute();
      const settings: ProjectSettings = parseSettings(p.settings);
      return { ...p, video_count: count, languages: settings.output_languages };
    })
  );
  return c.html(render("projects-list", { projects: enriched }));
});

// ── HeyGen-Video → View-Model ───────────────────────────────

function mapHeygenVideo(v: heygen.VideoListItem, folderNames?: Map<string, string>) {
  const dur = v.duration != null ? Number(v.duration) : null;
  return {
    ...v,
    title: v.title ?? "Ohne Titel",
    duration_fmt: dur
      ? `${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, "0")}`
      : null,
    created_fmt: v.created_at
      ? new Date(v.created_at * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })
      : null,
    is_translation: !!v.output_language,
    folder_name: v.folder_id ? folderNames?.get(v.folder_id) ?? "–" : "–",
  };
}

// ── Video-Suche (HTMX partial) ──────────────────────────────

pages.get("/search/videos", async (c) => {
  const q = (c.req.query("q") ?? "").trim();

  if (!q) {
    // Leere Suche → zurück zur Ordner-Auswahl-Ansicht
    return c.html(`<div class="flex flex-col items-center justify-center h-full text-gray-400 py-16">
      <span class="material-symbols-rounded" style="font-size:64px">folder_open</span>
      <p class="text-lg font-medium">Ordner auswählen</p>
      <p class="text-sm mt-1">Klicke links auf einen Ordner — oder suche oben nach Videos.</p>
    </div>`);
  }

  try {
    const [page, foldersRes] = await Promise.all([
      heygen.listVideos({ title: q, limit: 100 }),
      heygen.listFolders(),
    ]);
    const folderNames = new Map(foldersRes.data.folders.map((f) => [f.id, f.name]));
    const videos = (page.data ?? []).map((v) => mapHeygenVideo(v, folderNames));

    return c.html(renderPartial("partials/video-search-results", {
      q,
      videos,
      hasVideos: videos.length > 0,
      hasMore: page.has_more,
      zip_name: `Suche_${q}`,
    }));
  } catch (err) {
    console.warn("Video search failed:", err);
    return c.html(`<p class="text-sm text-red-600 py-8 text-center">Suche fehlgeschlagen — siehe Server-Log.</p>`);
  }
});

// ── Folder Content (HTMX partial) ───────────────────────────

pages.get("/folders/:id", async (c) => {
  const folderId = c.req.param("id");

  // Dieselbe URL bedient zwei Fälle: HTMX-Fragment beim Klick im Baum und
  // vollständige Seite bei Direktaufruf, Reload oder Browser-Zurück
  // (HTMX schickt dabei HX-History-Restore-Request).
  const isHtmx = !!c.req.header("HX-Request");
  const isHistoryRestore = !!c.req.header("HX-History-Restore-Request");

  if (!isHtmx || isHistoryRestore) {
    return c.html(render("folder-browser", { selectedFolderId: folderId }));
  }

  // Ordnerstruktur, Projekte und HeyGen-Videos parallel laden;
  // Video-Listing darf den Ordner-View nicht blockieren, wenn es fehlschlägt
  const [{ folders, projects }, heygenVideosResult] = await Promise.all([
    loadFolderData(),
    heygen.listAllFolderVideos(folderId).catch((err) => {
      console.warn(`Could not list HeyGen videos for folder ${folderId}:`, err);
      return null;
    }),
  ]);

  const folder = folders.find((f) => f.id === folderId);
  const childFolders = folders.filter((f) => f.parent_id === folderId);
  const folderProjects = projects.filter((p) => p.heygen_folder_id === folderId);

  // Enrich projects with video count
  const enrichedProjects = await Promise.all(
    folderProjects.map(async (p) => {
      const [{ count }] = await db
        .selectFrom("videos")
        .select(db.fn.countAll().as("count"))
        .where("project_id", "=", p.id)
        .execute();
      return { ...p, video_count: count };
    })
  );

  const heygenVideos = (heygenVideosResult ?? []).map((v) => mapHeygenVideo(v));

  return c.html(renderPartial("partials/folder-content", {
    folder: folder ?? { id: folderId, name: "Ordner" },
    childFolders,
    projects: enrichedProjects,
    heygenVideos,
    videosUnavailable: heygenVideosResult === null,
    hasChildren: childFolders.length > 0,
    hasProjects: enrichedProjects.length > 0,
    hasVideos: heygenVideos.length > 0,
  }));
});

// ── Full page folder view (for direct navigation) ───────────

pages.get("/folders/:id/view", (c) =>
  c.html(render("folder-browser", { selectedFolderId: c.req.param("id") }))
);

// ── Jobs Overview ───────────────────────────────────────────

pages.get("/jobs", async (c) => {
  const queues = (c as any).get("queues");

  const queueEntries = Object.entries(queues) as Array<[string, any]>;
  const queueStats = await Promise.all(
    queueEntries.map(async ([name, queue]) => {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "completed", "failed");
      return {
        name: queue.name ?? name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
      };
    })
  );

  // Fehlgeschlagene Jobs mit Grund (max. 10 pro Queue)
  const failedJobs = (
    await Promise.all(
      queueEntries.map(async ([, queue]) => {
        const jobs = await queue.getFailed(0, 9);
        return jobs.map((j: any) => ({
          queue: queue.name,
          job_name: j.name,
          reason: (j.failedReason ?? "").slice(0, 200),
          attempts: j.attemptsMade,
          data: JSON.stringify(j.data).slice(0, 120),
        }));
      })
    )
  ).flat();

  const jobLog = await db
    .selectFrom("job_log")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();

  return c.html(render("jobs", {
    queueStats,
    failedJobs,
    hasFailedJobs: failedJobs.length > 0,
    jobLog,
    hasJobLog: jobLog.length > 0,
  }));
});

// ── New Project Modal ───────────────────────────────────────

pages.get("/projects/new", async (c) => {
  const preselectedFolderId = c.req.query("folder_id") ?? "";
  const preselectedFolderName = c.req.query("folder_name") ?? "";

  let folders: Array<{ id: string; name: string }> = [];
  let languages: string[] = FALLBACK_LANGUAGES;

  try {
    const [foldersRes, langsRes] = await Promise.all([
      heygen.listFolders(),
      heygen.listSupportedLanguages(),
    ]);
    folders = foldersRes.data.folders.map((f) => ({ id: f.id, name: f.name }));
    languages = langsRes.data.languages;
  } catch (err) {
    console.warn("Could not load HeyGen data, using fallbacks:", err);
  }

  return c.html(renderPartial("modals/new-project", {
    folders,
    hasFolders: folders.length > 0,
    languages,
    preselectedFolderId,
    preselectedFolderName,
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

  const settings: ProjectSettings = parseSettings(project.settings);

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
