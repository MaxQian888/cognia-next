/**
 * Creator progress, expressed as workflow run events (ADR-0117).
 *
 * Creator does not get its own project database. A Creator session *is* a
 * workflow run: `createRunLogger` already gives an append-only, ordered,
 * live-queryable per-step record, and the Runs UI already renders it. Adding a
 * second progress store would mean two timelines that can disagree about
 * whether a step completed — and the step that matters is the permission gate.
 *
 * Payload discipline: events carry step ids, capability ids and *root-relative*
 * paths. They never carry file contents or the user's prompt, so a run log can
 * be attached to a bug report without leaking the thing being authored.
 */

import { createRunLogger, listRunEvents } from "@/lib/workflow/runtime/event-log"
import { normalizeFsPath } from "@/lib/files/permissions"
import type {
  AuthoringRoot,
  CreatorApprovalKind,
  CreatorArtifactKind,
  CreatorPermissionDiff,
  CreatorReviewVerdict,
  CreatorStepId,
} from "@/types/creator"
import { CREATOR_STEP_IDS } from "./steps"

export type CreatorRunLogger = ReturnType<typeof createRunLogger>

/** Prefix that marks a workflow run as a Creator session. */
export const CREATOR_RUN_ID_PREFIX = "creator_"

export function isCreatorRunId(runId: string): boolean {
  return runId.startsWith(CREATOR_RUN_ID_PREFIX)
}

/**
 * Path relative to the authoring root, or `"<outside-root>"`.
 *
 * Logging the absolute path would put the user's home directory layout into a
 * record that is meant to be shareable; the relative path is what a reviewer
 * actually needs.
 */
export function relativeToAuthoringRoot(root: AuthoringRoot, path: string): string {
  const normalizedRoot = normalizeFsPath(root.path)
  const normalized = normalizeFsPath(path)
  if (normalized === normalizedRoot) return "."
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : "<outside-root>"
}

export interface CreatorRunStartInput {
  artifactKind: CreatorArtifactKind
  /** Root label only — never the absolute path. */
  rootLabel: string
}

/**
 * Creator-shaped wrapper over the run logger.
 *
 * Every method funnels into an existing run event type. No new `RunEventType`
 * member is introduced, so the existing Runs timeline renders a Creator session
 * without changes.
 */
export function createCreatorRunLog(
  runId: string,
  logger: CreatorRunLogger = createRunLogger(runId)
) {
  return {
    runId,

    started: (input: CreatorRunStartInput) =>
      logger.runStarted({
        trigger: { kind: "creator" },
        artifactKind: input.artifactKind,
        rootLabel: input.rootLabel,
        steps: CREATOR_STEP_IDS,
      }),

    stepStarted: (step: CreatorStepId) => logger.stepStarted(step),

    stepCompleted: (step: CreatorStepId, summary?: Record<string, unknown>) =>
      logger.stepCompleted(step, summary ?? {}),

    stepFailed: (step: CreatorStepId, message: string, retryable = true) =>
      logger.stepFailed(step, { message, retryable }),

    stepSkipped: (step: CreatorStepId, reason: string) => logger.stepSkipped(step, reason),

    /** The diff itself, recorded *before* the approval so both sides are auditable. */
    permissionDiff: (diff: CreatorPermissionDiff) =>
      logger.stepCompleted("approve-permissions:diff", {
        added: diff.added,
        removed: diff.removed,
        requiresApproval: diff.requiresApproval,
      }),

    approvalGranted: (kind: CreatorApprovalKind, scope: readonly string[] = []) =>
      logger.stepCompleted(`approval:${kind}`, { granted: true, scope }),

    approvalDenied: (kind: CreatorApprovalKind) => logger.stepSkipped(`approval:${kind}`, "denied"),

    /** One authored file. Root-relative path plus byte count, never contents. */
    fileWritten: (relativePath: string, bytes: number) =>
      logger.stepCompleted("apply-changes:file", { path: relativePath, bytes }),

    reviewVerdict: (verdict: CreatorReviewVerdict) =>
      logger.stepCompleted("review:verdict", {
        approved: verdict.approved,
        reviewerAuthority: verdict.reviewerAuthority,
        findings: verdict.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
        })),
      }),

    completed: () => logger.runCompleted({ steps: CREATOR_STEP_IDS }),

    failed: (message: string, step?: CreatorStepId) =>
      logger.runFailed({ message, ...(step ? { nodeId: step } : {}) }),
  }
}

export type CreatorRunLog = ReturnType<typeof createCreatorRunLog>

export interface CreatorRunProgress {
  completed: CreatorStepId[]
  failed: CreatorStepId[]
  approvals: CreatorApprovalKind[]
}

const STEP_ID_SET = new Set<string>(CREATOR_STEP_IDS)

/**
 * Rebuild progress from the durable log.
 *
 * This is what makes the log the source of truth rather than a mirror: a reload
 * (or a crash) reconstructs which steps completed and which approvals were
 * granted by replaying events, with no in-memory state to lose.
 */
export async function readCreatorProgress(runId: string): Promise<CreatorRunProgress> {
  const events = await listRunEvents(runId)
  const completed = new Set<CreatorStepId>()
  const failed = new Set<CreatorStepId>()
  const approvals = new Set<CreatorApprovalKind>()

  for (const event of events) {
    const stepId = event.stepId
    if (!stepId) continue

    if (stepId.startsWith("approval:")) {
      const kind = stepId.slice("approval:".length) as CreatorApprovalKind
      // A later denial revokes an earlier grant — the log is ordered, so the
      // last event for a kind wins.
      if (event.type === "step_completed") approvals.add(kind)
      else if (event.type === "step_skipped") approvals.delete(kind)
      continue
    }

    if (!STEP_ID_SET.has(stepId)) continue
    const step = stepId as CreatorStepId
    if (event.type === "step_completed") {
      completed.add(step)
      failed.delete(step)
    } else if (event.type === "step_failed") {
      failed.add(step)
      completed.delete(step)
    }
  }

  // Emit in canonical step order so callers can render without re-sorting.
  return {
    completed: CREATOR_STEP_IDS.filter((id) => completed.has(id)),
    failed: CREATOR_STEP_IDS.filter((id) => failed.has(id)),
    approvals: [...approvals],
  }
}
