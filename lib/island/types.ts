/**
 * Contracts shared by the island overlay window, the main window that feeds
 * it, and the settings card that configures it (unified task control island).
 *
 * Deliberately pure and dependency-light so the projection, the owner routing
 * and the privacy policy can all be tested in the fast `node` Jest project
 * without a Tauri shim. The island window renders ONLY what these types carry.
 * It never reaches into a store, Dexie, or a business control plane, and the
 * regular projection never carries a prompt, a path, a command, a plan or the
 * full text of an error.
 */

import type { FleetAgent, FleetStatus, TerminalSource } from "@/lib/fleet/types"

/* -- Privacy policy ------------------------------------------------------ */

/**
 * How much the island is allowed to show without an explicit click.
 *
 * `click-to-reveal` (the default) means hover shows the safe summary only and
 * the sensitive detail is fetched on demand once the user pins a row.
 * `hover` opts into redacted, truncated detail on hover. `summary-only` means
 * the island never receives sensitive detail at all. The detail request is
 * refused by the main window rather than merely hidden in the overlay.
 */
export type IslandDetailVisibility = "click-to-reveal" | "hover" | "summary-only"

export const ISLAND_DETAIL_VISIBILITIES: readonly IslandDetailVisibility[] = [
  "click-to-reveal",
  "hover",
  "summary-only",
]

export const DEFAULT_ISLAND_DETAIL_VISIBILITY: IslandDetailVisibility = "click-to-reveal"

/** Coerce a persisted or pushed value. Anything unknown migrates to the default. */
export function normalizeDetailVisibility(raw: unknown): IslandDetailVisibility {
  return ISLAND_DETAIL_VISIBILITIES.includes(raw as IslandDetailVisibility)
    ? (raw as IslandDetailVisibility)
    : DEFAULT_ISLAND_DETAIL_VISIBILITY
}

export interface IslandPreferencesV1 {
  detailVisibility: IslandDetailVisibility
}

export const DEFAULT_ISLAND_PREFERENCES: IslandPreferencesV1 = {
  detailVisibility: DEFAULT_ISLAND_DETAIL_VISIBILITY,
}

export function mergeIslandPreferences(raw: unknown): IslandPreferencesV1 {
  const source = (raw ?? {}) as Partial<IslandPreferencesV1>
  return { detailVisibility: normalizeDetailVisibility(source.detailVisibility) }
}

/* -- Owner --------------------------------------------------------------- */

/** Which task or approval surface a row belongs to. */
export type IslandSource = "chat" | "team" | "run" | "external" | "gate"

/**
 * The surface that actually owns a task, meaning where "open" must land, and
 * the authority that owns any state machine the island refuses to duplicate.
 *
 * Carries the precise ids rather than a pre-built URL so the merge can key on
 * identity and the main window can re-derive the route at dispatch time.
 */
export type FleetOwnerRef =
  | { kind: "chat"; sessionId: string; requestId?: string }
  | { kind: "team"; teamId?: string; runId?: string }
  | { kind: "run"; runId: string; interruptId?: string }
  | { kind: "gate"; gateKey: { scope: string; id: string }; sessionId?: string }
  | {
      kind: "external"
      agent: FleetAgent
      sessionId: string
      transcriptPath?: string
      /**
       * `ExternalAgentManager` agent id for renderer-managed (ACP) sessions.
       * Present only on those rows, and it is what makes their decisions,
       * interrupts and prompts routable through the manager instead of the
       * Rust fleet commands.
       */
      agentId?: string
      /** The chat session an external run is bound to — its owner route. */
      chatSessionId?: string
    }

/* -- Rows ---------------------------------------------------------------- */

/**
 * Coarse presentation status. Deliberately NOT `FleetStatus`. The island ranks
 * "does a human have to do something" above every runtime nuance, and the
 * sources do not share a status vocabulary.
 */
export type IslandRowStatus = "blocked" | "failed" | "working" | "done" | "idle" | "stale"

/** Fixed ordering. Lower sorts first. */
export const ISLAND_STATUS_RANK: Record<IslandRowStatus, number> = {
  blocked: 0,
  failed: 1,
  working: 2,
  done: 3,
  idle: 4,
  stale: 5,
}

/**
 * What the island is allowed to offer for this row. Every flag is proven at
 * projection time against the underlying capability, so a button that exists
 * here is a button whose intent the main window will actually accept.
 *
 * Who can be answered from here:
 *   - External sessions (Claude Code, Codex, OpenCode, ACP agents): the
 *     decisions, answers, replies and interrupts their integration proves.
 *   - A Cognia conversation: its live tool approvals (allow once, always
 *     allow unless the ask forbids a standing rule, deny), a stop while a turn
 *     is in flight, and a reply that steers a running turn or starts the next.
 *   - A plan-step or cost-budget gate: approve or reject.
 *   - A durable run approval whose answer carries no payload (plan, delegation,
 *     bot, fusion, capability audit, connector tool asks).
 *
 * Still decided in the main window, and labelled so on the row
 * (`fleet.island.decideInMain`): Squad reviews that need a typed answer
 * (budget extension, deadlock, repair, re-plan, recovery), a human handoff,
 * an ask-user question, a workflow approval, and free-form external asks.
 */
export interface IslandRowCapabilities {
  openOwner: boolean
  permissionDecision: boolean
  questionResponse: boolean
  reply: boolean
  interrupt: boolean
  focusTerminal: boolean
  openTranscript: boolean
  dismissStale: boolean
  /** Whether a detail request for this row can be satisfied at all. */
  detail: boolean
}

export const NO_ISLAND_CAPABILITIES: IslandRowCapabilities = {
  openOwner: false,
  permissionDecision: false,
  questionResponse: false,
  reply: false,
  interrupt: false,
  focusTerminal: false,
  openTranscript: false,
  dismissStale: false,
  detail: false,
}

/**
 * What a pending decision is about, which is what decides its wording: a
 * tool permission, a plan step, spending past a budget, or any other durable
 * run approval.
 */
export type IslandDecisionKind = "tool" | "plan" | "budget" | "review"

/**
 * How a decision may be answered. `allow_always` also records a standing rule
 * and is only accepted where the row's permission says the ask allows one.
 */
export type IslandDecisionBehavior = "allow" | "allow_always" | "deny"

/**
 * When an unanswered ask stops waiting. `at` is epoch ms. `fallback` says what
 * happens then: an external hook hands the prompt back to the agent's own
 * terminal, anything else simply lapses.
 */
export interface IslandAnswerDeadline {
  at: number
  fallback: "terminal" | "lapse"
}

/** A parked question, redacted and length-capped by the projection. */
export interface IslandQuestion {
  question: string
  header?: string
  options: string[]
  multiSelect: boolean
}

/**
 * One task or pending item, as the island sees it.
 *
 * Everything here is safe for a hover: a title, a coarse status, tool names
 * and timestamps. Prompts, working directories, commands, plans and full
 * error text are NOT in this type by construction. They only ever travel in
 * an {@link IslandDetailResponse}, on demand, and are never persisted.
 */
export interface IslandRowProjection {
  /** Stable identity across revisions, produced by `taskIdentity(owner)`. */
  id: string
  source: IslandSource
  owner: FleetOwnerRef
  agent?: FleetAgent
  /** Configured agent display name, for generic `acp` rows. */
  agentLabel?: string
  status: IslandRowStatus
  /** Precomputed sort rank so the overlay never re-derives policy. */
  priority: number
  /** Project, team or tool name. Redacted and truncated. */
  title: string
  /** Safe one-line summary, or empty when only `statusKey` applies. */
  summary: string
  /** `fleet.island.state.*` key rendered when `summary` is empty. */
  statusKey?: string
  startedAt: number
  updatedAt: number
  /** When the human wait began. Drives the "waiting 4m12s" label. */
  waitingSince?: number
  capabilities: IslandRowCapabilities
  permission?: {
    requestId: string
    kind: IslandDecisionKind
    /** Tool name for a `tool` ask. Redacted and truncated. */
    toolName: string | null
    requestedAt: number
    /** `null` when the ask waits for the user indefinitely. */
    deadline: IslandAnswerDeadline | null
    /** Whether "always allow" is honoured for this ask. */
    allowAlways: boolean
  }
  question?: {
    requestId: string
    requestedAt: number
    deadline: IslandAnswerDeadline | null
    questions: IslandQuestion[]
  }
  hostRef?: string
  /** Which terminal launched it. An app id and a product name, both safe. */
  terminal?: TerminalSource
  /** True when the underlying waiter is gone. Render muted, sort last. */
  stale: boolean
}

/**
 * The whole island projection. `revision` is monotonic per main-window
 * session: an overlay that receives an older revision than the one it holds
 * discards it, and every action or detail request echoes the revision it was
 * built from so the main window can refuse a stale click.
 *
 * `epoch` identifies that main-window session. The island window outlives a
 * main-webview reload, and the reload restarts `revision` at 1; without the
 * epoch the island would discard every push from the new session as
 * out-of-order and every click would be refused as stale until the counter
 * climbed past the old one. A push carrying a different epoch is always taken.
 */
export interface IslandState {
  epoch: number
  revision: number
  generatedAt: number
  activeCount: number
  attentionCount: number
  detailVisibility: IslandDetailVisibility
  rows: IslandRowProjection[]
}

export const EMPTY_ISLAND_STATE: IslandState = {
  epoch: 0,
  revision: 0,
  generatedAt: 0,
  activeCount: 0,
  attentionCount: 0,
  detailVisibility: DEFAULT_ISLAND_DETAIL_VISIBILITY,
  rows: [],
}

/* -- Actions ------------------------------------------------------------- */

/**
 * `Omit` over a discriminated union, applied to each member.
 *
 * A plain `Omit` on a union collapses to the keys every member shares, which
 * for an intent means only `kind` survives and every payload field becomes an
 * excess property.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Fields every intent carries so the main window can re-validate it. */
export interface IslandActionEnvelope {
  requestId: string
  /** The projection revision the user was looking at when they clicked. */
  revision: number
  rowId: string
}

export type IslandActionIntent = IslandActionEnvelope &
  (
    | { kind: "open-owner" }
    | {
        kind: "permission-decision"
        permissionRequestId: string
        behavior: IslandDecisionBehavior
      }
    | { kind: "question-response"; questionRequestId: string; selections: number[][] }
    | { kind: "question-reject"; questionRequestId: string }
    | { kind: "reply"; text: string }
    | { kind: "interrupt" }
    | { kind: "focus-terminal" }
    | { kind: "open-transcript" }
    | { kind: "dismiss-stale" }
  )

export type IslandActionOutcome = "completed" | "rejected" | "failed"

export interface IslandActionResult {
  requestId: string
  /** Revision the main window validated against, meaning its current one. */
  revision: number
  outcome: IslandActionOutcome
  /** `fleet.island.actionError.*` key. Present for rejected and failed. */
  reason?: string
}

/** How long the island waits for a result before offering a retry. */
export const ISLAND_ACTION_TIMEOUT_MS = 20_000

/** How long a finished row lingers in its result state before it is swept. */
export const ISLAND_DONE_LINGER_MS = 10_000

/* -- Detail -------------------------------------------------------------- */

export interface IslandDetailRequest {
  requestId: string
  revision: number
  rowId: string
}

/**
 * Redacted, truncated detail for one pinned row.
 *
 * Structurally a subset of `FleetSession` on purpose. `SessionDetail` and
 * `SessionMetaChips` render it directly, so the island has one renderer for
 * these facts rather than two that drift.
 */
export interface IslandRowDetail {
  cwd: string | null
  gitBranch?: string | null
  terminal?: { sessionRef?: string } | null
  startSource?: string | null
  toolUseCount: number
  turnCount: number
  agentPid: number | null
  startedAt: number
  endedAt?: number
  status: FleetStatus
  model: string | null
  permissionMode: string | null
  /** Redacted and capped. */
  prompt?: string
  plan?: string
  errorDetail?: string
  /** Tool name plus its redacted argument. Named apart from `FleetSession.activity`,
   * which is an object, so a whole session stays assignable to this type. */
  activityLabel?: string
  /**
   * What the pending decision would let happen — the tool's redacted target,
   * the gate's body. Revealed only on request, so the person deciding can see
   * what they are approving without the hover projection carrying it.
   */
  decisionDetail?: string
}

export interface IslandDetailResponse {
  requestId: string
  revision: number
  rowId: string
  detail: IslandRowDetail | null
  /** `fleet.island.detailError.*` key when `detail` is null. */
  reason?: string
}
