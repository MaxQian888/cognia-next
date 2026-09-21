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
import {
  parseAttachmentEvidenceSourceId,
  type ProjectAttachmentEvidenceSource,
} from "@cognia/memory/extract/project-attachment-evidence"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"

export interface RevalidateClaimDeps {
  readToolExcerpt?: (
    messageId: string,
    partIndex: number
  ) => Promise<{ excerpt?: string } | undefined>
  readAttachmentExcerpt?: (
    source: ProjectAttachmentEvidenceSource
  ) => Promise<{ excerpt?: string } | undefined>
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
  if (strategy === "attachment-content-hash") {
    const source = parseAttachmentEvidenceSourceId(evidence.sourceId)
    if (!source || !deps.readAttachmentExcerpt) return "unverifiable"
    const current = await deps.readAttachmentExcerpt(source)
    if (!current) return "revoked"
    // Failed/partial extraction of an unchanged source is not source deletion.
    if (current.excerpt === undefined || !evidence.excerptHash) return "unvalidated"
    return hashContent(current.excerpt) === evidence.excerptHash ? "valid" : "revoked"
  }

  // Message ids are opaque and may contain colons. Only tool evidence has a
  // numeric suffix, and malformed indices must never certify a prose message.
  const toolStrategy = strategy === "tool-result-hash" || strategy === "tool-output-hash"
  const toolAnchor = toolStrategy ? /^(.*):(\d+)$/.exec(evidence.sourceId) : null
  const partIndex = toolAnchor ? Number(toolAnchor[2]) : undefined
  if (toolStrategy && (!toolAnchor || !Number.isSafeInteger(partIndex))) {
    return "unverifiable"
  }
  const messageId = toolAnchor ? toolAnchor[1] : evidence.sourceId
  if (!messageId) return "unverifiable"
  if (strategy === "tool-output-hash") {
    if (!deps.readToolExcerpt || partIndex === undefined) return "unverifiable"
    const current = await deps.readToolExcerpt(messageId, partIndex)
    if (!current) return "revoked"
    if (current.excerpt === undefined || !evidence.excerptHash) return "unvalidated"
    return hashContent(current.excerpt) === evidence.excerptHash ? "valid" : "revoked"
  }
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
    // An unchanged source proves freshness, not that the mined claim or failed
    // consolidation judgment was correct. Only explicit review lifts quarantine.
    ...(verdict.staleness === "fresh" &&
    memory.trustState === "quarantined" &&
    memory.reviewStatus === "verified"
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
  const [
    memDb,
    governance,
    { getDb },
    { allRootPaths },
    { projectMiningMessageText, projectMiningToolText },
    { listSessionAssets },
  ] = await Promise.all([
    import("@/lib/db/memories"),
    import("@/lib/db/memory-governance"),
    import("@/lib/db/schema"),
    import("@/lib/workspace/roots"),
    import("@/lib/memory/write/project-transcript-text"),
    import("@/lib/db/session-assets"),
  ])

  const rootsByProject = new Map<string, readonly string[]>()
  const excerptCache = new Map<string, Awaited<ReturnType<RevalidateClaimDeps["readExcerpt"]>>>()
  const assetsBySession = new Map<string, Awaited<ReturnType<typeof listSessionAssets>>>()

  async function rootsFor(projectId: string | undefined): Promise<readonly string[]> {
    if (!projectId) return []
    const cached = rootsByProject.get(projectId)
    if (cached) return cached
    const project = await getDb().projects.get(projectId)
    const roots = project ? allRootPaths(project) : []
    rootsByProject.set(projectId, roots)
    return roots
  }

  return {
    getMemory: (id) => memDb.getMemory(id),
    listEvidence: (memoryId) => governance.listMemoryEvidence(memoryId),
    readToolExcerpt: async (messageId, partIndex) => {
      const row = await getDb().messages.get(messageId)
      if (!row) return undefined
      const text = projectMiningToolText(Array.isArray(row.parts) ? row.parts : [], partIndex)
      if (text === undefined) return undefined
      return { excerpt: projectMiningExcerpt(text, { roots: await rootsFor(row.projectId) }) }
    },
    readAttachmentExcerpt: async (source) => {
      const row = await getDb().messages.get(source.messageId)
      if (!row) return undefined
      const part = Array.isArray(row.parts) ? row.parts[source.partIndex] : undefined
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "file")
        return undefined
      const content = readAttachmentExtractedContent(
        (part as { extractedContent?: unknown }).extractedContent
      )
      if (
        !content ||
        content.attachmentId !== source.attachmentId ||
        content.contentHash !== source.contentHash
      )
        return undefined
      // The transcript is only a snapshot. Deleting an asset or replacing its
      // extraction must not leave that snapshot certifying removed evidence.
      if (!row.sessionId) return undefined
      let assets = assetsBySession.get(row.sessionId)
      if (!assets) {
        assets = await listSessionAssets(row.sessionId)
        assetsBySession.set(row.sessionId, assets)
      }
      const asset = assets.find((item) => item.assetId === source.attachmentId)
      if (!asset || asset.contentHash !== source.contentHash) return undefined
      const current = readAttachmentExtractedContent(asset.extractedContent)
      if (!current) return {}
      if (
        current.attachmentId !== source.attachmentId ||
        current.contentHash !== source.contentHash
      )
        return undefined
      const segment = current.segments.find((item) => item.id === source.segmentId)
      if (!segment) return current.status === "ready" ? undefined : {}
      if (JSON.stringify(segment.locator) !== source.locator || source.end > segment.text.length)
        return undefined
      if (current.status !== "ready" && current.status !== "partial") return {}
      return {
        excerpt: projectMiningExcerpt(segment.text.slice(source.start, source.end), {
          roots: await rootsFor(row.projectId),
        }),
      }
    },
    readExcerpt: async (messageId) => {
      if (excerptCache.has(messageId)) return excerptCache.get(messageId)
      // A failed read is not evidence of deletion. Propagate it to the job's
      // retry path rather than caching absence and revoking supported claims.
      const row = await getDb().messages.get(messageId)
      if (!row) {
        excerptCache.set(messageId, undefined)
        return undefined
      }
      const roots = await rootsFor(row.projectId)
      const parts = Array.isArray(row.parts) ? row.parts : []
      const result = {
        // Re-derived through the SAME pair of functions mining used, so a
        // mismatch really means the source changed.
        excerpt: projectMiningExcerpt(
          projectMiningMessageText(parts, { includeAttachments: false }),
          { roots }
        ),
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
