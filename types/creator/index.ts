/**
 * Creator workbench contracts (ADR-0117, Phase 3).
 *
 * Creator authors five kinds of first-party artifact from inside the app. It is
 * a developer-mode surface, and every capability it has is bounded by a
 * user-chosen *authoring root*: a single directory that all file and command
 * capability is confined to.
 *
 * These types are deliberately free of any runtime import so the state machine,
 * the containment check and the permission diff can be unit-tested without a
 * Dexie, a Tauri host, or React.
 */

/** What Creator can author. Each maps to an existing first-party subsystem. */
export type CreatorArtifactKind = "plugin" | "skill" | "hook" | "agent-preset" | "visual-workflow"

export const CREATOR_ARTIFACT_KINDS: readonly CreatorArtifactKind[] = [
  "plugin",
  "skill",
  "hook",
  "agent-preset",
  "visual-workflow",
]

/**
 * The nine steps, in order.
 *
 * The ids are stable and are used as `stepId` on workflow run events, so
 * renaming one breaks the ability to read back an older run's timeline.
 */
export type CreatorStepId =
  | "collect-requirements"
  | "survey-existing"
  | "plan-scaffold"
  | "approve-permissions"
  | "apply-changes"
  | "verify"
  | "preview"
  | "review"
  | "approve-delivery"

/**
 * Approvals that are deliberately *separate* gates.
 *
 * Bundling any two of these into one prompt would let a user who meant to
 * approve a file write also approve a publish. Each is requested, recorded and
 * revoked on its own.
 */
export type CreatorApprovalKind =
  "permission-widening" | "signature" | "install" | "publish" | "external-write"

export const CREATOR_APPROVAL_KINDS: readonly CreatorApprovalKind[] = [
  "permission-widening",
  "signature",
  "install",
  "publish",
  "external-write",
]

/** Lifecycle of one step within a Creator run. */
export type CreatorStepStatus =
  "pending" | "active" | "awaiting-approval" | "completed" | "failed" | "skipped"

export interface CreatorStepDefinition {
  id: CreatorStepId
  /**
   * Approval this step blocks on before it may complete. Absent means the step
   * completes on its own work finishing.
   */
  requiresApproval?: CreatorApprovalKind
  /**
   * True when the step may write inside the authoring root. Used to assert that
   * no write happens before the permission diff has been approved.
   */
  writes?: boolean
  /** True when the step may be re-run without undoing later steps. */
  repeatable?: boolean
}

/**
 * A directory the user explicitly chose or created as Creator's write scope.
 *
 * There is no implicit default. Creator refuses to act without one, because the
 * alternative — falling back to the current workspace — would let a prompt talk
 * Creator into editing the user's real project.
 */
export interface AuthoringRoot {
  /** Absolute path, normalized by `normalizeFsPath`. */
  path: string
  /** Display label; defaults to the last path segment. */
  label: string
  /** How the root came to be, for the audit trail. */
  origin: "selected" | "created"
  /** Epoch ms the user granted it. */
  grantedAt: number
}

/** One capability line in a permission diff. */
export interface CreatorCapabilityChange {
  /** Capability id as the target subsystem names it (e.g. a WASM capability). */
  capability: string
  change: "added" | "removed" | "unchanged"
  /** Why the artifact asks for it, when the generator supplied a reason. */
  rationale?: string
}

/**
 * The diff shown before any file is written.
 *
 * `requiresApproval` is true whenever anything is *added* — removals and
 * unchanged lines never need a gate, because narrowing is always safe.
 */
export interface CreatorPermissionDiff {
  changes: readonly CreatorCapabilityChange[]
  added: readonly string[]
  removed: readonly string[]
  requiresApproval: boolean
}

/** Verdict from the independent reviewer subagent. */
export interface CreatorReviewVerdict {
  approved: boolean
  /** Machine-stable finding ids the reviewer raised. */
  findings: readonly CreatorReviewFinding[]
  /** Reviewer's own resolved authority, recorded so a run can prove it was read-only. */
  reviewerAuthority: string
}

export interface CreatorReviewFinding {
  id: string
  severity: "blocker" | "warning" | "info"
  summary: string
  /** Path relative to the authoring root, when the finding is file-scoped. */
  path?: string
}

/** Result of tearing a preview down. A leak is a release blocker (ADR-0117). */
export interface CreatorPreviewTeardownReport {
  disposed: number
  /** Labels of resources that failed to dispose. Non-empty means a leak. */
  leaked: readonly string[]
  /** True when the scope reported nothing still active after disposal. */
  clean: boolean
}
