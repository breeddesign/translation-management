import type { Job } from "bullmq";
import { nanoid } from "nanoid";
import { db, type ProjectSettings, parseSettings } from "../../db/index.js";
import * as heygen from "../../services/heygen.js";
import { transitionProofread } from "../../lib/state-machine.js";
import { RateLimiter, withJitter } from "../../lib/rate-limiter.js";
import type { Queues } from "../index.js";

interface ProofreadJobData {
  projectId: string;
  videoId: string;
}

export function createProofreadProcessor(rateLimiter: RateLimiter, queues: Queues) {
  return async function processProofreadJob(job: Job<ProofreadJobData>) {
    const { projectId, videoId } = job.data;

    const project = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirstOrThrow();
    const video = await db.selectFrom("videos").selectAll().where("id", "=", videoId).executeTakeFirstOrThrow();
    const settings: ProjectSettings = parseSettings(project.settings);

    // Acquire rate limit token before calling HeyGen
    await rateLimiter.acquire();

    const result = await heygen.generateProofread({
      video_url: video.video_url,
      title: video.title,
      output_languages: settings.output_languages,
      brand_voice_id: settings.brand_voice_id ?? undefined,
      speaker_num: settings.speaker_num,
      folder_id: project.heygen_folder_id ?? undefined,
      enable_video_stretching: settings.enable_video_stretching,
      disable_music_track: settings.disable_music_track,
      enable_speech_enhancement: settings.enable_speech_enhancement,
    });

    if (result.error) throw new Error(`HeyGen error: ${result.error}`);

    const heygenIds = result.data.proofread_ids
      ? result.data.proofread_ids
      : result.data.proofread_id
        ? [result.data.proofread_id]
        : [];

    for (let i = 0; i < heygenIds.length; i++) {
      const heygenId = heygenIds[i];
      const language = settings.output_languages[i] ?? settings.output_languages[0];
      const proofreadId = nanoid();
      const idempotencyKey = `${projectId}:${videoId}:${language}`;

      // Idempotent insert: if this key already exists, skip
      try {
        await db.insertInto("proofreads").values({
          id: proofreadId,
          video_id: videoId,
          project_id: projectId,
          language,
          heygen_proofread_id: heygenId,
          idempotency_key: idempotencyKey,
          status: "processing",
        }).execute();
      } catch (err: any) {
        if (err.code === "ER_DUP_ENTRY") {
          console.log(`⏭️ Proofread already exists: ${idempotencyKey}`);
          continue;
        }
        throw err;
      }

      // Enqueue polling with jitter
      await queues.pollProofread.add(
        `poll-${heygenId}`,
        { proofreadId, heygenProofreadId: heygenId },
        {
          jobId: `poll-proofread:${heygenId}`,
          delay: withJitter(30_000),
          attempts: 120,
          backoff: { type: "fixed", delay: 30_000 },
          removeOnComplete: 50,
        }
      );
    }

    await db.insertInto("job_log").values({
      job_type: "generate_proofread",
      reference_id: videoId,
      status: "submitted",
      message: `Submitted ${heygenIds.length} proofread(s)`,
      payload: JSON.stringify({ heygenIds }),
    }).execute();
  };
}
