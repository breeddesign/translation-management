import { config } from "../config.js";

const BASE = config.heygen.baseUrl;
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

interface HeyGenResponse<T> {
  error: string | null;
  data: T;
}

interface TranslateResult {
  video_translate_id: string | null;
  video_translate_ids: string[] | null;
}

interface ProofreadResult {
  proofread_id: string | null;
  proofread_ids: string[] | null;
  status: string;
}

interface ProofreadStatus {
  proofread_id: string;
  status: "processing" | "completed" | "failed";
  details: string | null;
  submitted_for_review: boolean;
}

interface SrtDownload {
  srt_url: string;
}

interface TranslateFromProofreadResult {
  video_translate_id: string;
  status: string;
}

interface TranslateStatus {
  video_translate_id: string;
  status: "pending" | "running" | "success" | "failed";
  url?: string;
  message?: string;
}

interface FolderResult {
  id: string;
  name: string;
  parent_id: string | null;
  project_type: string;
}

// ── Folders ─────────────────────────────────────────────────

export async function createFolder(
  name: string,
  projectType: string = "video_translate",
  parentId?: string
) {
  const body: Record<string, string> = { name, project_type: projectType };
  if (parentId) body.parent_id = parentId;
  return request<HeyGenResponse<FolderResult>>("POST", "/v1/folders/create", body);
}

export async function listFolders() {
  return request<HeyGenResponse<{ folders: FolderResult[] }>>(
    "GET",
    "/v1/folders"
  );
}

// ── Languages ───────────────────────────────────────────────

export async function listSupportedLanguages() {
  return request<HeyGenResponse<{ languages: string[] }>>(
    "GET",
    "/v2/video_translate/target_languages"
  );
}

// ── Translate (direct, without proofread) ───────────────────

export async function translateVideo(params: {
  video_url: string;
  title: string;
  output_language?: string;
  output_languages?: string[];
  translate_audio_only?: boolean;
  enable_dynamic_duration?: string;
  mode?: "fast" | "quality";
  speaker_num?: number;
  brand_voice_id?: string;
  keep_the_same_format?: boolean;
  callback_url?: string;
}) {
  return request<HeyGenResponse<TranslateResult>>(
    "POST",
    "/v2/video_translate",
    params
  );
}

// ── Proofread ───────────────────────────────────────────────

export async function generateProofread(params: {
  video_url: string;
  title: string;
  output_language?: string;
  output_languages?: string[];
  brand_voice_id?: string;
  speaker_num?: number;
  folder_id?: string;
  enable_video_stretching?: boolean;
  disable_music_track?: boolean;
  enable_speech_enhancement?: boolean;
}) {
  return request<HeyGenResponse<ProofreadResult>>(
    "POST",
    "/v2/video_translate/proofread",
    params
  );
}

export async function getProofreadStatus(proofreadId: string) {
  return request<HeyGenResponse<ProofreadStatus>>(
    "GET",
    `/v2/video_translate/proofread/status/${proofreadId}`
  );
}

export async function downloadProofreadSrt(proofreadId: string) {
  return request<HeyGenResponse<SrtDownload>>(
    "GET",
    `/v2/video_translate/proofread/${proofreadId}/download-srt`
  );
}

export async function uploadProofreadSrt(
  proofreadId: string,
  srtFileUrl: string
) {
  return request<HeyGenResponse<unknown>>(
    "POST",
    `/v2/video_translate/proofread/${proofreadId}/upload-srt`,
    { srt_file_url: srtFileUrl }
  );
}

export async function generateVideoFromProofread(
  proofreadId: string,
  params: {
    captions?: boolean;
    translate_audio_only?: boolean;
    callback_url?: string;
  }
) {
  return request<HeyGenResponse<TranslateFromProofreadResult>>(
    "POST",
    `/v2/video_translate/proofread/${proofreadId}/generate`,
    params
  );
}

// ── Translation Status ──────────────────────────────────────

export async function getTranslationStatus(videoTranslateId: string) {
  return request<HeyGenResponse<TranslateStatus>>(
    "GET",
    `/v1/video_translate.get?video_translate_id=${videoTranslateId}`
  );
}

// ── Caption ─────────────────────────────────────────────────

export async function getTranslationCaption(videoTranslateId: string) {
  return request<HeyGenResponse<{ caption_url: string }>>(
    "GET",
    `/v2/video_translate/${videoTranslateId}/caption`
  );
}
