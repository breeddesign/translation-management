import { config } from "../config.js";

const BASE = config.heygen.baseUrl;
const V3 = "/v3/video-translations";

const headers = {
  "x-api-key": config.heygen.apiKey,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// ── Generic request helper ──────────────────────────────────

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HeyGen API ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Types ───────────────────────────────────────────────────

// v3 wraps successful responses in { data }; errors come as HTTP status codes.
interface HeyGenResponse<T> {
  data: T;
  error?: string | null;
}

type FileSource =
  | { type: "url"; url: string }
  | { type: "asset_id"; asset_id: string };

export type TranslationMode = "speed" | "precision";

/** Map legacy project settings ("fast"/"quality") to v3 API modes. */
export function toApiMode(mode?: string): TranslationMode {
  return mode === "quality" || mode === "precision" ? "precision" : "speed";
}

interface CreateTranslationResult {
  video_translation_ids: string[];
}

interface ProofreadCreateResult {
  proofread_ids: string[];
  status: string;
}

export interface ProofreadSession {
  id: string;
  title: string | null;
  status: "processing" | "completed" | "failed";
  output_language: string | null;
  input_language: string | null;
  submitted_for_review: boolean | null;
  created_at: number | null;
  failure_message: string | null;
}

interface SrtDownload {
  srt_url: string;
  original_srt_url: string | null;
}

interface GenerateFromProofreadResult {
  video_translation_id: string;
  status: string;
}

export interface VideoTranslationDetail {
  id: string;
  title: string | null;
  status: "pending" | "running" | "completed" | "failed";
  output_language: string | null;
  input_language: string | null;
  duration: number | null;
  translate_audio_only: boolean | null;
  /** Only present when status is completed. Presigned, expires — download promptly. */
  video_url: string | null;
  audio_url: string | null;
  srt_caption_url: string | null;
  vtt_caption_url: string | null;
  callback_id: string | null;
  created_at: number | null;
  failure_message: string | null;
}

export interface FolderResult {
  id: string;
  name: string;
  parent_id: string | null;
  project_type: string;
  is_trash?: boolean;
  direct_children_count?: number;
  created_ts?: number;
  updated_ts?: number;
}

// ── Folders (v1, unchanged) ─────────────────────────────────

export async function createFolder(
  name: string,
  projectType: string = "video_translate",
  parentId?: string
) {
  const body: Record<string, string> = { name, project_type: projectType };
  if (parentId) body.parent_id = parentId;
  const res = await request<HeyGenResponse<FolderResult>>("POST", "/v1/folders/create", body);
  invalidateFolderCache();
  return res;
}

// GET /v1/folders liefert nur die Ordner EINER Ebene (Root ohne parent_id,
// Kinder nur mit ?parent_id=). Für den kompletten Baum wird rekursiv geladen
// und das Ergebnis gecacht, um die vielen Einzel-Requests zu amortisieren.
const FOLDER_CACHE_TTL_MS = 5 * 60_000;
let folderCache: { folders: FolderResult[]; at: number } | null = null;

export function invalidateFolderCache() {
  folderCache = null;
}

async function fetchFolderLevel(parentId?: string): Promise<FolderResult[]> {
  const folders: FolderResult[] = [];
  let token: string | null = null;

  do {
    const qs = new URLSearchParams({ limit: "100" });
    if (parentId) qs.set("parent_id", parentId);
    if (token) qs.set("token", token);
    const res: HeyGenResponse<{ folders: FolderResult[]; token: string | null; total: number }> =
      await request("GET", `/v1/folders?${qs}`);
    folders.push(...(res.data.folders ?? []));
    token = res.data.token || null;
  } while (token);

  return folders;
}

const FOLDER_FETCH_CONCURRENCY = 8;

/** Kompletten Ordnerbaum einlesen (Breitensuche, ebenenweise parallel). */
async function loadFolderTree(): Promise<FolderResult[]> {
  const all: FolderResult[] = [];
  const seen = new Set<string>();
  let level: Array<string | undefined> = [undefined];

  // Sicherheits-Cap gegen Endlosschleifen/-strukturen
  while (level.length > 0 && all.length < 2000) {
    const next: string[] = [];

    for (let i = 0; i < level.length; i += FOLDER_FETCH_CONCURRENCY) {
      const batch = level.slice(i, i + FOLDER_FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map((parentId) =>
          fetchFolderLevel(parentId).catch((err) => {
            console.warn(`Ordner-Ebene ${parentId ?? "root"} nicht ladbar:`, err);
            return [] as FolderResult[];
          })
        )
      );

      for (const folders of results) {
        for (const f of folders) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          if (f.is_trash) continue;
          all.push(f);
          // direct_children_count zählt auch Videos — eine Kind-Abfrage zu
          // viel ist harmlos (liefert dann einfach 0 Ordner)
          if ((f.direct_children_count ?? 0) > 0) next.push(f.id);
        }
      }
    }

    level = next;
  }

  return all;
}

let folderRefresh: Promise<FolderResult[]> | null = null;

function refreshFolders(): Promise<FolderResult[]> {
  // Parallele Aufrufe teilen sich denselben Ladevorgang
  folderRefresh ??= loadFolderTree()
    .then((folders) => {
      folderCache = { folders, at: Date.now() };
      return folders;
    })
    .finally(() => {
      folderRefresh = null;
    });
  return folderRefresh;
}

/**
 * Kompletten Ordnerbaum laden (rekursiv über parent_id, ohne Trash).
 * Abgelaufener Cache wird sofort ausgeliefert und im Hintergrund erneuert,
 * damit kein Seitenaufruf auf den vollständigen Baum warten muss.
 */
export async function listFolders(forceRefresh = false) {
  if (!forceRefresh && folderCache) {
    if (Date.now() - folderCache.at >= FOLDER_CACHE_TTL_MS) {
      refreshFolders().catch((err) => console.warn("Ordner-Refresh fehlgeschlagen:", err));
    }
    return { data: { folders: folderCache.folders } };
  }

  const folders = await refreshFolders();
  return { data: { folders } };
}

/** Ordnerbaum beim Start vorwärmen (Fehler sind unkritisch). */
export function warmFolderCache(): void {
  refreshFolders().catch((err) => console.warn("Ordner-Vorwärmen fehlgeschlagen:", err));
}

// ── Languages ───────────────────────────────────────────────

export async function listSupportedLanguages() {
  return request<HeyGenResponse<{ languages: string[] }>>(
    "GET",
    `${V3}/languages`
  );
}

// ── Translate (direct, without proofread) ───────────────────

export async function createVideoTranslation(params: {
  video_url: string;
  title: string;
  output_languages: string[];
  mode?: TranslationMode;
  speaker_num?: number | "auto";
  translate_audio_only?: boolean;
  enable_dynamic_duration?: boolean;
  disable_music_track?: boolean;
  enable_speech_enhancement?: boolean;
  enable_caption?: boolean;
  brand_voice_id?: string;
  callback_url?: string;
  callback_id?: string;
}) {
  const { video_url, ...rest } = params;
  const video: FileSource = { type: "url", url: video_url };
  return request<HeyGenResponse<CreateTranslationResult>>("POST", V3, {
    video,
    ...rest,
  });
}

// ── Proofread Sessions ──────────────────────────────────────

export async function createProofreadSession(params: {
  video_url: string;
  title: string;
  output_languages: string[];
  mode?: TranslationMode;
  speaker_num?: number;
  folder_id?: string;
  enable_video_stretching?: boolean;
  disable_music_track?: boolean;
  enable_speech_enhancement?: boolean;
  keep_the_same_format?: boolean;
  brand_glossary_id?: string;
}) {
  const { video_url, ...rest } = params;
  const video: FileSource = { type: "url", url: video_url };
  return request<HeyGenResponse<ProofreadCreateResult>>(
    "POST",
    `${V3}/proofreads`,
    { video, ...rest }
  );
}

export async function getProofreadSession(proofreadId: string) {
  return request<HeyGenResponse<ProofreadSession>>(
    "GET",
    `${V3}/proofreads/${proofreadId}`
  );
}

export async function downloadProofreadSrt(proofreadId: string) {
  return request<HeyGenResponse<SrtDownload>>(
    "GET",
    `${V3}/proofreads/${proofreadId}/srt`
  );
}

/**
 * Datei als HeyGen-Asset hochladen (max. 32 MB).
 * Erlaubt u. a. srt — dadurch braucht der SRT-Rückweg keine von außen
 * erreichbare URL, was lokalen Storage und die Desktop-App erst möglich macht.
 */
export async function uploadAsset(
  filename: string,
  content: string | Buffer,
  contentType: string
) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: contentType }), filename);

  // Kein Content-Type setzen — fetch ergänzt die multipart-boundary selbst
  const res = await fetch(`${BASE}/v3/assets`, {
    method: "POST",
    headers: { "x-api-key": config.heygen.apiKey, Accept: "application/json" },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`HeyGen API POST /v3/assets → ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<
    HeyGenResponse<{ asset_id: string; url: string; mime_type: string; size_bytes: number }>
  >;
}

/** Bearbeitete SRT über eine Asset-ID zurückspielen. */
export async function uploadProofreadSrt(proofreadId: string, assetId: string) {
  const srt: FileSource = { type: "asset_id", asset_id: assetId };
  return request<HeyGenResponse<ProofreadSession>>(
    "PUT",
    `${V3}/proofreads/${proofreadId}/srt`,
    { srt }
  );
}

export async function generateVideoFromProofread(
  proofreadId: string,
  params: {
    translate_audio_only?: boolean;
    callback_url?: string;
    callback_id?: string;
  } = {}
) {
  return request<HeyGenResponse<GenerateFromProofreadResult>>(
    "POST",
    `${V3}/proofreads/${proofreadId}/generate`,
    params
  );
}

// ── Videos (v3, inkl. übersetzter Videos) ───────────────────

export interface VideoListItem {
  id: string;
  title: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  created_at: number | null;
  completed_at: number | null;
  video_url: string | null;
  video_page_url: string | null;
  subtitle_url: string | null;
  duration: number | null;
  folder_id: string | null;
  /** Gesetzt = übersetztes Video, sonst generiertes Video */
  output_language: string | null;
}

interface VideoListPage {
  data: VideoListItem[];
  has_more: boolean;
  next_token?: string | null;
  error?: string | null;
}

export async function listVideos(params: {
  folder_id?: string;
  title?: string;
  limit?: number;
  token?: string;
} = {}) {
  const qs = new URLSearchParams();
  if (params.folder_id) qs.set("folder_id", params.folder_id);
  if (params.title) qs.set("title", params.title);
  qs.set("limit", String(params.limit ?? 100));
  if (params.token) qs.set("token", params.token);
  return request<VideoListPage>("GET", `/v3/videos?${qs}`);
}

/** Einzelnes Video (inkl. frischer video_url/subtitle_url). */
export async function getVideo(videoId: string): Promise<VideoListItem> {
  const res = await request<Record<string, unknown>>("GET", `/v3/videos/${videoId}`);
  const detail = res && typeof res === "object" && "data" in res ? res.data : res;
  return detail as VideoListItem;
}

/** Alle Videos eines Ordners laden (paginiert, gedeckelt auf maxItems). */
export async function listAllFolderVideos(folderId: string, maxItems = 300) {
  const videos: VideoListItem[] = [];
  let token: string | undefined;

  do {
    const page = await listVideos({ folder_id: folderId, limit: 100, token });
    videos.push(...(page.data ?? []));
    token = page.has_more && page.next_token ? page.next_token : undefined;
  } while (token && videos.length < maxItems);

  return videos.slice(0, maxItems);
}

// ── Video Translations ──────────────────────────────────────

export async function getVideoTranslation(videoTranslationId: string) {
  return request<HeyGenResponse<VideoTranslationDetail>>(
    "GET",
    `${V3}/${videoTranslationId}`
  );
}

export async function listVideoTranslations(limit = 20, token?: string) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (token) qs.set("token", token);
  return request<{
    data: VideoTranslationDetail[];
    has_more: boolean;
    next_token?: string | null;
    error?: string | null;
  }>("GET", `${V3}?${qs}`);
}

export async function deleteVideoTranslation(videoTranslationId: string) {
  return request<HeyGenResponse<unknown>>(
    "DELETE",
    `${V3}/${videoTranslationId}`
  );
}
