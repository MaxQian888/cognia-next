/**
 * Shared types for the GitHub Delivery subsystem.
 *
 * These types describe the contract between the lib/github/ core layer and the
 * github-delivery plugin shell. They are intentionally framework-agnostic — no
 * Octokit, no Dexie, no React imports — so the same types can be used in the
 * plugin manifest, workflow nodes, settings UI, and audit log.
 */

// ============================================================================
// Repository configuration
// ============================================================================

export type CredentialMode = "app" | "pat"

export type WorktreeMode = "local" | "e2b"

export type PushTarget =
  | { kind: "source-branch"; branchPrefix?: string }
  | { kind: "fork"; ownerLogin: string }

export type TriggerMode = "webhook" | "polling"

export interface GhRepoEntry {
  /** "owner/name" — canonical full name. */
  fullName: string
  /** Which credential strategy this repo uses. */
  credentialMode: CredentialMode
  /** App installation id (only when credentialMode === "app"). */
  installationId?: number
  /** GitHub App numeric id (only when credentialMode === "app"). */
  appId?: number
  /**
   * App private key (PEM). Stored in the IndexedDB row directly. On desktop
   * builds, the plugin runtime mirrors this to the OS keyring on first
   * activation and clears it from the row; on web builds it stays here.
   * IndexedDB is per-origin so the blast radius is one user / one browser
   * profile.
   */
  appPrivateKey?: string
  /** PAT keyring slot id (only when credentialMode === "pat"). */
  patKeyringId?: string
  /** Raw PAT value, same trade-off as appPrivateKey above. */
  patToken?: string
  /** How AI changes get pushed. */
  pushTarget: PushTarget
  /** Where the AI runs work — locally or in an E2B sandbox. */
  worktreeMode: WorktreeMode
  /** Whether this repo prefers webhook or polling for inbound events. */
  triggerMode: TriggerMode
  /** Optional repo-level policy override; merged onto global default. */
  policy?: GhPolicy
  /** Last polling cursor (etag header value). */
  pollEtag?: string
  /** Last webhook delivery seen — for receipt UI / debugging. */
  lastDeliveryAt?: number
  createdAt: number
}

// ============================================================================
// Policy
// ============================================================================

export type AllowedAuthors =
  | { kind: "collaborators" }
  | { kind: "members" }
  | { kind: "explicit"; logins: string[] }

export interface QuietHoursWindow {
  /** "HH:MM" 24h. */
  from: string
  /** "HH:MM" 24h. */
  to: string
  /** IANA tz, e.g. "Asia/Shanghai". */
  tz: string
}

export interface GhPolicy {
  /** Required label set. PR/Issue must contain at least one. */
  allowedLabels?: string[]
  /** Block actions until CI green. */
  requireGreenCi: boolean
  /** Need a human ✅ before merge / release. */
  requireHumanApproval: boolean
  /** Hard cap on bot-driven merges per UTC day. */
  maxDailyMerges: number
  /** Suspend bot actions during this window. */
  quietHours?: QuietHoursWindow
  /** Regex list — never push directly to these branches. */
  branchProtection: string[]
  /** Who is allowed to author PRs / Issues that the bot acts on. */
  allowedAuthors: AllowedAuthors
}

export const DEFAULT_GH_POLICY: GhPolicy = {
  requireGreenCi: true,
  requireHumanApproval: true,
  maxDailyMerges: 5,
  branchProtection: ["^main$", "^master$", "^release/"],
  allowedAuthors: { kind: "collaborators" },
}

// ============================================================================
// Action universe (every GhAction maps to one policy decision)
// ============================================================================

export interface PrRef {
  repo: string
  prNumber: number
}

export interface IssueRef {
  repo: string
  issueNumber: number
}

export type GhAction =
  | { kind: "merge"; pr: PrRef; mergeMethod?: "merge" | "squash" | "rebase" }
  | { kind: "push"; repo: string; branch: string }
  | { kind: "release"; repo: string; tag: string; draft: boolean }
  | { kind: "comment"; pr?: PrRef; issue?: IssueRef; body: string }
  | { kind: "label"; target: PrRef | IssueRef; labels: string[] }
  | { kind: "close"; target: PrRef | IssueRef }

export type PolicyDecision =
  | { allow: true }
  | {
      allow: false
      reason: string
      mustWait?: { until: number }
      /**
       * When true, the deny is recoverable via human approval — the caller
       * (typically the GitHub Delivery draft-bridge) should suspend the
       * workflow step, surface an Inbox draft to the user, and resume once
       * `approveDraft` flips the row. When undefined/false the deny is
       * permanent and the step should abort.
       */
      needsApproval?: boolean
    }

export interface GhPolicyContext {
  policy: GhPolicy
  /** For maxDailyMerges. UTC day epoch ms. */
  now: number
  /** Count of merges already done by the bot today (UTC). */
  mergesTodayCount: number
  /** Author login of the PR/Issue being acted on, when available. */
  authorLogin?: string
  /** CI status string, when relevant ("success" | other). */
  ciStatus?: string
  /** Whether a human has explicitly approved. */
  humanApproved?: boolean
  /** Allowed-authors lookup (collaborators / members) when needed. */
  knownAllowedLogins?: string[]
}

// ============================================================================
// Normalized event
// ============================================================================

export type NormalizedGhEventKind =
  | "pull_request.opened"
  | "pull_request.synchronize"
  | "pull_request.closed"
  | "pull_request.review_requested"
  | "issues.opened"
  | "issues.closed"
  | "issues.assigned"
  | "issues.labeled"
  | "issue_comment.created"
  | "check_run.completed"
  | "release.published"

export interface NormalizedGhEvent {
  /** Stable id used for dedup. From x-github-delivery (webhook) or computed (polling). */
  deliveryId: string
  /** Event kind (action included). */
  kind: NormalizedGhEventKind
  /** "owner/name". */
  repoFullName: string
  /** Original webhook event name, e.g. "pull_request". */
  rawEvent: string
  /** Original action, e.g. "opened". */
  rawAction?: string
  /** Sender login — the user who triggered the event. */
  senderLogin?: string
  /** Most-relevant ref ("head" sha, tag name, branch). */
  ref?: string
  /** Pull request reference, when this event has one. */
  pr?: PrRef & { headSha?: string; baseRef?: string; authorLogin?: string }
  /** Issue reference, when this event has one. */
  issue?: IssueRef & { authorLogin?: string }
  /** Tag/release fields. */
  release?: { tag: string; name?: string; draft: boolean }
  /** Check-run fields. */
  checkRun?: { name: string; conclusion?: string }
  /** Wall-clock when the event was received. */
  seenAt: number
  /** Source: webhook or polling. */
  source: "webhook" | "polling"
}

// ============================================================================
// Audit
// ============================================================================

export interface GhAuditEntry {
  id?: number
  /** "owner/name". */
  repoFullName: string
  /** Workflow run that took the action (when within a workflow). */
  runId?: string
  stepId?: string
  /** Action attempted. JSON-serialized GhAction discriminant. */
  action: GhAction
  /** Decision outcome. */
  decision: PolicyDecision
  /** Free-form notes (provider response, error code, etc.). */
  reason?: string
  /** Wall-clock. */
  at: number
}

// ============================================================================
// Work order (Issue → PR loop state machine)
// ============================================================================

export type WorkOrderStatus =
  | "open"
  | "in_progress"
  | "pr_opened"
  | "awaiting_review"
  | "merged"
  | "failed"

export interface GhWorkOrder {
  id?: number
  repoFullName: string
  issueNumber: number
  status: WorkOrderStatus
  /** Path to the local worktree (or sandbox id when worktreeMode === "e2b"). */
  worktreePath?: string
  /** Branch the bot is pushing to. */
  branch?: string
  /** PR number once opened. */
  prNumber?: number
  /** AI driver tag, e.g. "claude-code". */
  aiDriver?: string
  /** Last error if the order failed. */
  lastError?: string
  createdAt: number
  updatedAt: number
}
