import type { JobLike as Job } from "../types.js";
import { db } from "../../db/index.js";
import * as heygen from "../../services/heygen.js";
import { getStorage } from "../../services/storage.js";
import { srtToVtt } from "../../lib/subtitles.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";

interface DownloadAssetsData {
  translatedVideoId: string;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Asset download failed: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Asset download failed: ${res.status} ${url}`);
  return res.text();
}

/**
 * Zieht Video + Captions (VTT/SRT) einer fertigen Übersetzung von HeyGen
 * in den konfigurierten Storage. Nur GET-Aufrufe — verbraucht keine Credits.
 * HeyGen-URLs sind presigned und laufen ab, daher wird der Status frisch
 * abgefragt statt gespeicherte URLs zu verwenden.
 */
export function createDownloadAssetsProcessor(rateLimiter: RateLimiter) {
  return async function processDownloadAssetsJob(job: Job<DownloadAssetsData>) {
    const { translatedVideoId } = job.data;

    const translated = await db
      .selectFrom("translated_videos")
      .select(["id", "proofread_id", "heygen_video_translate_id", "status", "storage_key", "vtt_storage_key", "srt_storage_key"])
      .where("id", "=", translatedVideoId)
      .executeTakeFirstOrThrow();

    if (!translated.heygen_video_translate_id) {
      throw new Error(`TranslatedVideo ${translatedVideoId} has no HeyGen translation ID`);
    }

    // Bereits vollständig gezogen → nichts zu tun (idempotent bei Retries)
    if (translated.storage_key && translated.vtt_storage_key && translated.srt_storage_key) {
      return;
    }

    const proofread = await db
      .selectFrom("proofreads")
      .select(["video_id", "language"])
      .where("id", "=", translated.proofread_id)
      .executeTakeFirstOrThrow();

    await rateLimiter.acquire();
    const result = await heygen.getVideoTranslation(translated.heygen_video_translate_id);
    const detail = result.data;

    if (detail.status !== "completed") {
      throw new Error(`Translation ${translated.heygen_video_translate_id} not completed (${detail.status})`);
    }
    if (!detail.video_url) {
      throw new Error(`Translation ${translated.heygen_video_translate_id} completed but has no video_url`);
    }

    const storage = getStorage();
    const prefix = `translated/${proofread.video_id}/${proofread.language}/${translated.id}`;

    // ── Video ────────────────────────────────────────────────
    const videoKey = translated.storage_key ?? `${prefix}/video.mp4`;
    if (!translated.storage_key) {
      const videoBuffer = await fetchBuffer(detail.video_url);
      await storage.upload(videoKey, videoBuffer, "video/mp4");
    }

    // ── Captions: SRT zuerst (dient ggf. als VTT-Fallback) ──
    let srtKey = translated.srt_storage_key;
    let srtContent: string | null = null;
    if (!srtKey && detail.srt_caption_url) {
      srtContent = await fetchText(detail.srt_caption_url);
      srtKey = `${prefix}/captions.srt`;
      await storage.upload(srtKey, srtContent, "application/x-subrip");
    }

    let vttKey = translated.vtt_storage_key;
    if (!vttKey) {
      if (detail.vtt_caption_url) {
        const vttContent = await fetchText(detail.vtt_caption_url);
        vttKey = `${prefix}/captions.vtt`;
        await storage.upload(vttKey, vttContent, "text/vtt");
      } else if (srtContent) {
        vttKey = `${prefix}/captions.vtt`;
        await storage.upload(vttKey, srtToVtt(srtContent), "text/vtt");
        console.warn(`⚠️ ${translatedVideoId}: keine vtt_caption_url von HeyGen, VTT lokal aus SRT konvertiert`);
      }
    }

    await db
      .updateTable("translated_videos")
      .set({
        storage_key: videoKey,
        vtt_storage_key: vttKey ?? null,
        srt_storage_key: srtKey ?? null,
        video_url: detail.video_url,
      })
      .where("id", "=", translatedVideoId)
      .execute();

    await db.insertInto("job_log").values({
      job_type: "download_assets",
      reference_id: translatedVideoId,
      status: "downloaded",
      message: `Video${vttKey ? " + VTT" : ""}${srtKey ? " + SRT" : ""} in Storage abgelegt`,
      payload: JSON.stringify({ videoKey, vttKey, srtKey }),
    }).execute();
  };
}
