/**
 * Re-check one mined project claim's evidence, then write what that means to
 * the row.
 *
 * WHY THIS IS A BACKGROUND JOB AND NOT PART OF RETRIEVAL. Retrieval runs on the
 * send path. Verifying a claim means reading its source messages and re-deriving
 * their excerpts, which is Dexie work proportional to the claim's citations —
 * paid on every turn, for every candidate, to learn something that changes only
 * when a message changes. So the sweep writes `staleness` / `trustState` /
 * `validatedAt` ahead of time and recall simply reads them through
 * `isMemoryEligibleForRetrieval` and `governanceScoreFor`, which already
 * consult all three. That is the entire payoff of adopting those fields in the
 * first place rather than inventing a claim-confidence the scorer must learn.
 *
 * The verdict a strategy can reach:
 *
 *   message-presence   the message exists AND its mining excerpt still hashes
 *                      the same → valid; gone or changed → revoked
 *   tool-result-hash   as above, plus the cited part index is still a tool part
 *                      (the excerpt embeds the tool body, so a changed result
 *                      changes the hash)
 *   user-confirmation  free: the row's own `reviewStatus === "verified"`
 *   none               `unverifiable`, contributing nothing — `code-location`
 *                      cannot be checked on mobile or web, and a claim must not
 *                      rank higher on desktop than on a phone
 *
 * A row with no `excerptHash` is left `unvalidated`, never revoked: it predates
 * hashing (or was restored from a backup, which carries evidence descriptors but
 * never verdicts), and "we cannot check this" is not "this is false".
 */

import type { MemoryEvidence } from "@/types/memory/governance"
import type { Memory } from "@/types/memory/memory"
import {
  assessClaimSupport,
  type ClaimSupportVerdict,
} from "@cognia/memory/lifecycle/claim-support"
import { projectMiningExcerpt } from "@cognia/memory/extract/project-excerpt"
import { isToolPart } from "@/lib/chat/mentions/tool-output-text"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"

export interface RevalidateClaimDeps {
  getMemory: (id: string) => Promise<Memory | undefined>
  listEvidence: (memoryId: string) => Promise<MemoryEvidence[]>
  /** The mining excerpt of a message as it stands today, or undefined if it is gone. */
  readExcerpt: (
    messageId: string
  ) => Promise<{ excerpt: string | undefined; partIsTool: (index: number) => boolean } | undefined>
  recordVerdict: (
    id: string,
    verdict: { validationState: MemoryEvidence["validationState"]; validatedAt: number }
  ) => Promise<void>
  patchMemory: (
    id: string,
    patch: Pick<Memory, "staleness" | "validatedAt"> & { trustState?: Memory["trustState"] }
  ) => Promise<void>
  invalidateMemory: (id: string) => Promise<void>
  now?: () => number
}

export interface RevalidateClaimResult {
  status: "revalidated" | "invalidated" | "skipped"
  reason?: "memory_missing" | "not_a_project_claim" | "already_invalidated" | "no_evidence"
  verdict?: ClaimSupportVerdict
}

/** `<messageId>` or `<messageId>:<partIndex>`. */
function splitSourceId(sourceId: string): { messageId: string; partIndex?: number } {
  const [messageId = "", rawIndex] = sourceId.split(":")
  const partIndex = rawIndex === undefined ? undefined : Number.parseInt(rawIndex, 10)
  return {
    messageId,
    ...(partIndex !== undefined && Number.isInteger(partIndex) ? { partIndex } : {}),
  }
}

async function verdictFor(
  evidence: MemoryEvidence,
  memory: Memory,
  deps: RevalidateClaimDeps
): Promise<MemoryEvidence["validationState"]> {
  const strategy = evidence.validationStrategy ?? "none"
  if (strategy === "none") return "unverifiable"
  if (strategy === "user-confirmation") {
    return memory.reviewStatus === "verified" ? "valid" : "unvalidated"
  }

  const { messageId, partIndex } = splitSourceId(evidence.sourceId)
  if (!messageId) return "unverifiable"
  const source = await deps.readExcerpt(messageId)
  // The message is gone. This is the case the whole sweep exists for: a claim
  // whose source was deleted must stop being injected.
  if (!source) return "revoked"
  if (strategy === "tool-result-hash" && partIndex !== undefined && !source.partIsTool(partIndex)) {
    return "revoked"
  }
  // Present but no longer minable (its text now names someone), or never
  // hashed. Neither is grounds for revocation.
  if (source.excerpt === undefined) return "unverifiable"
  if (!evidence.excerptHash) return "unvalidated"
  return hashContent(source.excerpt) === evidence.excerptHash ? "valid" : "revoked"
}

/**
 * Re-check every citation of `memoryId`, write each verdict, then fold them into
 * the row. Pure orchestration — all I/O is injected.
 */
export async function revalidateClaim(
  memoryId: string,
  deps: RevalidateClaimDeps
): Promise<RevalidateClaimResult> {
  const now = deps.now?.() ?? Date.now()
  const memory = await deps.getMemory(memoryId)
  if (!memory) return { status: "skipped", reason: "memory_missing" }
  // Personal memories have no citation model; running the sweep over them would
  // invalidate rows on evidence they were never expected to have.
  if (!memory.projectMemoryKind) return { status: "skipped", reason: "not_a_project_claim" }
  if (memory.status !== "active") return { status: "skipped", reason: "already_invalidated" }

  const evidence = await deps.listEvidence(memoryId)
  const checked: MemoryEvidence[] = []
  for (const item of evidence) {
    const validationState = await verdictFor(item, memory, deps)
    if (validationState !== item.validationState) {
      await deps.recordVerdict(item.id, { validationState, validatedAt: now })
    }
    checked.push({ ...item, validationState, validatedAt: now })
  }

  const verdict = assessClaimSupport(checked)
  if (verdict.counted === 0 && checked.length === 0) {
    return { status: "skipped", reason: "no_evidence", verdict }
  }
  if (verdict.invalidate) {
    await deps.invalidateMemory(memoryId)
    return { status: "invalidated", verdict }
  }
  await deps.patchMemory(memoryId, {
    staleness: verdict.staleness,
    validatedAt: now,
    // A claim that verified is no longer merely unjudged. Quarantine is lifted
    // ONLY by evidence — never by the passage of time — and only upward: a row
    // a human marked untrusted stays untrusted.
    ...(verdict.staleness === "fresh" && memory.trustState === "quarantined"
      ? { trustState: "trusted" as const }
      : {}),
  })
  return { status: "revalidated", verdict }
}

// ───────────────────────────────────────────────────────────────────────────
// Real wiring
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wire the sweep against Dexie.
 *
 * `readExcerpt` memoizes per run: a claim's citations very often name the same
 * message (its prose and its tool result), and each miss is a row read plus a
 * redaction pass.
 */
export async function buildClaimRevalidationDeps(): Promise<RevalidateClaimDeps> {
  const [memDb, governance, { getDb }, { allRootPaths }, { projectMiningMessageText }] =
    await Promise.all([
      import("@/lib/db/memories"),
      import("@/lib/db/memory-governance"),
      import("@/lib/db/schema"),
      import("@/lib/workspace/roots"),
      import("@/lib/memory/write/project-transcript-text"),
    ])

  const rootsByProject = new Map<string, readonly string[]>()
  const excerptCache = new Map<string, Awaited<ReturnType<RevalidateClaimDeps["readExcerpt"]>>>()

  async function rootsFor(projectId: string | undefined): Promise<readonly string[]> {
    if (!projectId) return []
    const cached = rootsByProject.get(projectId)
    if (cached) return cached
    const project = await getDb()
      .projects.get(projectId)
      .catch(() => undefined)
    const roots = project ? allRootPaths(project) : []
    rootsByProject.set(projectId, roots)
    return roots
  }

  return {
    getMemory: (id) => memDb.getMemory(id),
    listEvidence: (memoryId) => governance.listMemoryEvidence(memoryId),
    readExcerpt: async (messageId) => {
      if (excerptCache.has(messageId)) return excerptCache.get(messageId)
      const row = await getDb()
        .messages.get(messageId)
        .catch(() => undefined)
      if (!row) {
        excerptCache.set(messageId, undefined)
        return undefined
      }
      const roots = await rootsFor(row.projectId)
      const parts = Array.isArray(row.parts) ? row.parts : []
      const result = {
        // Re-derived through the SAME pair of functions mining used, so a
        // mismatch really means the source changed.
        excerpt: projectMiningExcerpt(projectMiningMessageText(parts), { roots }),
        partIsTool: (index: number) => {
          const part = parts[index]
          return Boolean(part && typeof part === "object" && isToolPart(part as { type?: unknown }))
        },
      }
      excerptCache.set(messageId, result)
      return result
    },
    recordVerdict: (id, verdict) => governance.recordMemoryEvidenceVerdict(id, verdict),
    patchMemory: (id, patch) => memDb.updateMemory(id, patch),
    invalidateMemory: (id) => memDb.invalidateMemory(id),
  }
}
