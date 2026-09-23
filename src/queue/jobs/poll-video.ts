import type { JobLike as Job } from "../types.js";
import * as heygen from "../../services/heygen.js";
import { transitionProofread, transitionTranslatedVideo } from "../../lib/state-machine.js";
import { withJitter } from "../../lib/rate-limiter.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { Queues } from "../index.js";

interface PollVideoData {
  translatedVideoId: string;
  heygenVideoTranslateId: string;
  proofreadId: string;
}

export function createPollVideoProcessor(rateLimiter: RateLimiter, queues: Queues) {
  return async function processPollVideoJob(job: Job<PollVideoData>) {
    const { translatedVideoId, heygenVideoTranslateId, proofreadId } = job.data;

    await rateLimiter.acquire();
    const result = await heygen.getVideoTranslation(heygenVideoTranslateId);

    if (result.error) throw new Error(`HeyGen poll error: ${result.error}`);

    const status = result.data.status;

    if (status === "pending" || status === "running") {
      throw new Error("Still processing");
    }

    if (status === "completed") {
      await transitionTranslatedVideo(translatedVideoId, "processing", "completed", {
        video_url: result.data.video_url ?? null,
      });
      await transitionProofread(proofreadId, "generating", "done");

      // Video + Captions (VTT/SRT) von HeyGen in den Storage ziehen —
      // die HeyGen-URLs sind presigned und laufen ab
      await queues.downloadAssets.add(
        `download-assets-${translatedVideoId}`,
        { translatedVideoId },
        {
          jobId: `download-assets:${translatedVideoId}`,
          delay: withJitter(2_000),
          attempts: 10,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 200,
        }
      );
    } else {
      const errMsg = result.data.failure_message ?? "Video generation failed";
      await transitionTranslatedVideo(translatedVideoId, "processing", "failed", {
        error_message: errMsg,
      });
      await transitionProofread(proofreadId, "generating", "failed", {
        error_message: errMsg,
      });
    }
  };
}
