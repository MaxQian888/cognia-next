/**
 * Durable step checkpoints for a Bot handler.
 *
 * A handler is re-entered from the top after a crash, a Host handover, or a
 * resumed wait. These rows are what make that safe: a step that already
 * completed returns its stored output instead of running again.
 *
 * Kept out of the run journal on purpose. `runEventJournal` redacts every
 * string in an event payload, which is right for a timeline and fatal for a
 * memoized value, because the handler would carry on with corrupted data it
 * has no way to notice.
 */

import { getDb } from "@/lib/db/schema"
import type { BotRunStepRow } from "@/lib/db/bot-types"

/** The memoization key. Stable across re-entries by construction. */
export function botRunStepId(runId: string, name: string): string {
  return `${runId}::${name}`
}

export type BotStepBeginResult =
  { memoized: true; value: unknown } | { memoized: false; attempt: number }

/**
 * Claim a step, or hand back what it already produced.
 *
 * A `failed` step is re-entered rather than replayed: the whole point of a
 * retry is to try the failing work again, and only a completed step carries an
 * output worth trusting. The attempt counter comes back so a handler can back
 * off on its own if it wants to.
 */
export async function beginBotRunStep(
  runId: string,
  name: string,
  now = Date.now()
): Promise<BotStepBeginResult> {
  const db = getDb()
  const id = botRunStepId(runId, name)
  return db.transaction("rw", db.botRunSteps, async () => {
    const existing = await db.botRunSteps.get(id)
    if (existing?.status === "completed") {
      return { memoized: true, value: existing.output } as const
    }
    const attempt = (existing?.attempt ?? 0) + 1
    const row: BotRunStepRow = {
      id,
      runId,
      name,
      status: "running",
      attempt,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    }
    await db.botRunSteps.put(row)
    return { memoized: false, attempt } as const
  })
}

/** Record a step's output. Idempotent: a repeat write keeps the first value. */
export async function completeBotRunStep(
  runId: string,
  name: string,
  output: unknown,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  const id = botRunStepId(runId, name)
  await db.transaction("rw", db.botRunSteps, async () => {
    const existing = await db.botRunSteps.get(id)
    if (existing?.status === "completed") return
    await db.botRunSteps.put({
      id,
      runId,
      name,
      status: "completed",
      output,
      attempt: existing?.attempt ?? 1,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    })
  })
}

/**
 * Record a step's failure.
 *
 * The row survives so the next entry knows which attempt it is on. Deleting it
 * would make every retry look like the first one, which is how a permanently
 * failing step retries forever.
 */
export async function failBotRunStep(
  runId: string,
  name: string,
  error: string,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  const id = botRunStepId(runId, name)
  await db.transaction("rw", db.botRunSteps, async () => {
    const existing = await db.botRunSteps.get(id)
    if (existing?.status === "completed") return
    await db.botRunSteps.put({
      id,
      runId,
      name,
      status: "failed",
      error,
      attempt: existing?.attempt ?? 1,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    })
  })
}

export async function getBotRunStep(
  runId: string,
  name: string
): Promise<BotRunStepRow | undefined> {
  return getDb().botRunSteps.get(botRunStepId(runId, name))
}

/** Every checkpoint of one run, in the order the handler reached them. */
export async function listBotRunSteps(runId: string): Promise<BotRunStepRow[]> {
  const rows = await getDb().botRunSteps.where("runId").equals(runId).toArray()
  return rows.sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))
}

/** Drop a run's checkpoints. Used when a retry mints a fresh attempt. */
export async function clearBotRunSteps(runId: string): Promise<number> {
  const db = getDb()
  const ids = (await db.botRunSteps.where("runId").equals(runId).toArray()).map((row) => row.id)
  if (ids.length === 0) return 0
  await db.botRunSteps.bulkDelete(ids)
  return ids.length
}
