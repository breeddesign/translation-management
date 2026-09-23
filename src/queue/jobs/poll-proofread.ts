import type { JobLike as Job } from "../types.js";
import { db } from "../../db/index.js";
import * as heygen from "../../services/heygen.js";
import { srtToExcel } from "../../services/srt-excel.js";
import { getStorage } from "../../services/storage.js";
import { transitionProofread } from "../../lib/state-machine.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";

interface PollProofreadData {
  proofreadId: string;
  heygenProofreadId: string;
}

export function createPollProofreadProcessor(rateLimiter: RateLimiter) {
  return async function processPollProofreadJob(job: Job<PollProofreadData>) {
    const { proofreadId, heygenProofreadId } = job.data;

    await rateLimiter.acquire();
    const result = await heygen.getProofreadSession(heygenProofreadId);

    if (result.error) throw new Error(`HeyGen poll error: ${result.error}`);

    const status = result.data.status;

    if (status === "processing") {
      throw new Error("Still processing"); // BullMQ retries
    }

    if (status === "completed") {
      await rateLimiter.acquire();
      const srtResult = await heygen.downloadProofreadSrt(heygenProofreadId);
      const srtUrl = srtResult.data.srt_url;

      const srtResponse = await fetch(srtUrl);
      const srtContent = await srtResponse.text();

      // Convert SRT → Excel
      const excelBuffer = await srtToExcel(srtContent);

      // Upload via storage abstraction
      const storage = getStorage();
      const proofread = await db
        .selectFrom("proofreads")
        .select(["video_id", "language", "status"])
        .where("id", "=", proofreadId)
        .executeTakeFirstOrThrow();

      const srtKey = `proofreads/${proofread.video_id}/${proofread.language}/original.srt`;
      const excelKey = `proofreads/${proofread.video_id}/${proofread.language}/v0.xlsx`;

      await storage.upload(srtKey, srtContent, "text/plain");
      await storage.upload(excelKey, excelBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

      // Guarded transition: only if still "processing"
      await transitionProofread(proofreadId, "processing", "completed", {
        srt_url: srtUrl,
        srt_storage_key: srtKey,
        excel_storage_key: excelKey,
        excel_revision: 0,
      });
    } else {
      // Failed
      await transitionProofread(proofreadId, "processing", "failed", {
        error_message: result.data.failure_message ?? "Unknown error",
      });
    }
  };
}
