import type { Job } from "bullmq";
import { db } from "../../db/index.js";
import * as heygen from "../../services/heygen.js";
import { transitionProofread, transitionTranslatedVideo } from "../../lib/state-machine.js";
import { RateLimiter } from "../../lib/rate-limiter.js";

interface PollVideoData {
  translatedVideoId: string;
  heygenVideoTranslateId: string;
  proofreadId: string;
}

export function createPollVideoProcessor(rateLimiter: RateLimiter) {
  return async function processPollVideoJob(job: Job<PollVideoData>) {
    const { translatedVideoId, heygenVideoTranslateId, proofreadId } = job.data;

    await rateLimiter.acquire();
    const result = await heygen.getTranslationStatus(heygenVideoTranslateId);

    if (result.error) throw new Error(`HeyGen poll error: ${result.error}`);

    const status = result.data.status;

    if (status === "pending" || status === "running") {
      throw new Error("Still processing");
    }

    if (status === "success") {
      await transitionTranslatedVideo(translatedVideoId, "processing", "completed", {
        video_url: result.data.url ?? null,
      });
      await transitionProofread(proofreadId, "generating", "done");
    } else {
      const errMsg = result.data.message ?? "Video generation failed";
      await transitionTranslatedVideo(translatedVideoId, "processing", "failed", {
        error_message: errMsg,
      });
      await transitionProofread(proofreadId, "generating", "failed", {
        error_message: errMsg,
      });
    }
  };
}
