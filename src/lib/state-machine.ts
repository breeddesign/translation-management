import { db } from "../db/index.js";

// ── State Machine: Allowed Transitions ──────────────────────

const PROOFREAD_TRANSITIONS: Record<string, string[]> = {
  pending:    ["processing", "failed"],
  processing: ["completed", "failed"],
  completed:  ["edited"],
  edited:     ["generating", "failed"],
  generating: ["done", "failed"],
  done:       [],            // terminal
  failed:     ["pending"],   // retry resets to pending
};

const TRANSLATED_TRANSITIONS: Record<string, string[]> = {
  pending:    ["processing", "failed"],
  processing: ["completed", "failed"],
  completed:  [],
  failed:     ["pending"],
};

// ── Guarded transition: only updates if current status allows it ─

export async function transitionProofread(
  id: string,
  fromStatus: string | string[],
  toStatus: string,
  updates: Record<string, unknown> = {}
): Promise<boolean> {
  const fromArr = Array.isArray(fromStatus) ? fromStatus : [fromStatus];

  // Validate transition is allowed
  for (const from of fromArr) {
    const allowed = PROOFREAD_TRANSITIONS[from];
    if (!allowed || !allowed.includes(toStatus)) {
      console.warn(`⚠️ Proofread ${id}: transition ${from} → ${toStatus} not allowed`);
      return false;
    }
  }

  const result = await db
    .updateTable("proofreads")
    .set({ status: toStatus, ...updates } as any)
    .where("id", "=", id)
    .where("status", "in", fromArr as any)
    .executeTakeFirst();

  const changed = Number(result.numUpdatedRows) > 0;
  if (!changed) {
    console.warn(`⚠️ Proofread ${id}: transition to ${toStatus} failed (not in expected state)`);
  }
  return changed;
}

export async function transitionTranslatedVideo(
  id: string,
  fromStatus: string | string[],
  toStatus: string,
  updates: Record<string, unknown> = {}
): Promise<boolean> {
  const fromArr = Array.isArray(fromStatus) ? fromStatus : [fromStatus];

  for (const from of fromArr) {
    const allowed = TRANSLATED_TRANSITIONS[from];
    if (!allowed || !allowed.includes(toStatus)) {
      console.warn(`⚠️ TranslatedVideo ${id}: transition ${from} → ${toStatus} not allowed`);
      return false;
    }
  }

  const result = await db
    .updateTable("translated_videos")
    .set({ status: toStatus, ...updates } as any)
    .where("id", "=", id)
    .where("status", "in", fromArr as any)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) > 0;
}

// ── Check if any proofreads are actively processing ─────────

export async function hasActiveJobs(projectId: string): Promise<boolean> {
  const active = await db
    .selectFrom("proofreads")
    .select(db.fn.countAll().as("count"))
    .where("project_id", "=", projectId)
    .where("status", "in", ["pending", "processing", "generating"])
    .executeTakeFirst();

  const activeTranslated = await db
    .selectFrom("translated_videos")
    .select(db.fn.countAll().as("count"))
    .where("project_id", "=", projectId)
    .where("status", "in", ["pending", "processing"])
    .executeTakeFirst();

  return (Number(active?.count) + Number(activeTranslated?.count)) > 0;
}
