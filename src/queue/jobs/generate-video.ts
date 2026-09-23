import type { JobLike as Job } from "../types.js";
import { nanoid } from "nanoid";
import { db, isDuplicateKeyError, type ProjectSettings, parseSettings } from "../../db/index.js";
import * as heygen from "../../services/heygen.js";
import { transitionProofread } from "../../lib/state-machine.js";
import { withJitter } from "../../lib/rate-limiter.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { Queues } from "../index.js";

interface GenerateVideoData {
  proofreadId: string;
}

export function createGenerateVideoProcessor(rateLimiter: RateLimiter, queues: Queues) {
  return async function processGenerateVideoJob(job: Job<GenerateVideoData>) {
    const { proofreadId } = job.data;

    const proofread = await db
      .selectFrom("proofreads")
      .selectAll()
      .where("id", "=", proofreadId)
      .executeTakeFirstOrThrow();

    // Guard: only proceed if in correct state
    if (proofread.status !== "completed" && proofread.status !== "edited") {
      console.log(`⏭️ Proofread ${proofreadId} in state ${proofread.status}, skipping generation`);
      return;
    }

    const project = await db
      .selectFrom("projects")
      .select(["settings"])
      .where("id", "=", proofread.project_id)
      .executeTakeFirstOrThrow();

    const settings: ProjectSettings = parseSettings(project.settings);

    await rateLimiter.acquire();

    // v3: Captions werden immer generiert (settings.captions ist obsolet)
    const result = await heygen.generateVideoFromProofread(
      proofread.heygen_proofread_id!,
      {
        translate_audio_only: settings.translate_audio_only,
      }
    );

    if (result.error) throw new Error(`HeyGen error: ${result.error}`);

    const translatedVideoId = nanoid();
    const idempotencyKey = `translate:${proofreadId}:r${proofread.excel_revision}`;

    // Idempotent insert
    try {
      await db.insertInto("translated_videos").values({
        id: translatedVideoId,
        proofread_id: proofreadId,
        project_id: proofread.project_id,
        heygen_video_translate_id: result.data.video_translation_id,
        idempotency_key: idempotencyKey,
        status: "processing",
      }).execute();
    } catch (err: any) {
      if (isDuplicateKeyError(err)) {
        console.log(`⏭️ TranslatedVideo already exists: ${idempotencyKey}`);
        return;
      }
      throw err;
    }

    // Guarded transition
    await transitionProofread(proofreadId, ["completed", "edited"], "generating");

    await queues.pollVideo.add(
      `poll-video-${result.data.video_translation_id}`,
      {
        translatedVideoId,
        heygenVideoTranslateId: result.data.video_translation_id,
        proofreadId,
      },
      {
        jobId: `poll-video:${result.data.video_translation_id}`,
        delay: withJitter(60_000),
        attempts: 120,
        backoff: { type: "fixed", delay: 60_000 },
        removeOnComplete: 50,
      }
    );
  };
}
