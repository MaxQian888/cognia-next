/**
 * The `chat-tool` channel's projection — the largest approval producer, and
 * one that wrote no `ActionReviewReceipt` at all before this.
 *
 * Two seams, both in `lib/claude/ipc.ts`:
 *
 * - `onClaudeMessage` sees every `permission_request` and calls
 *   {@link openChatToolReview}, which is where the tool name, arguments and
 *   session are known;
 * - `approveTool` is the documented funnel every resolution path goes through
 *   (modal, allowlist, auto-mode, plugin firewall, remote device, backstop
 *   deny) and calls {@link settleChatToolReview}.
 *
 * ## Why authority is a required argument
 *
 * `ActionReviewAuthority` is a closed set that answers "who authorized this",
 * and the receipt is a 90-day audit record. Because every path funnels through
 * one call, the settle site cannot tell a human's click from an auto-mode rule
 * — so it does not guess. A caller that does not state an authority gets NO
 * receipt rather than a fabricated `"human"` one. Missing audit rows are
 * recoverable by wiring the caller; false attribution is not.
 */

import type {
  ActionReviewActorKind,
  ActionReviewAuthority,
  ActionReviewOutcome,
  ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"
import { ACTION_REVIEW_CONTRACT_VERSION } from "@cognia/agent-config-types/action-review"
import { classifyRisk } from "@/lib/policy/risk/classify-risk"
import { projectActionReviewOpened, projectActionReviewSettled } from "./projection"

export interface ChatToolReviewOpenInput {
  sessionId: string
  requestId: string
  toolName: string
}

export interface ChatToolReviewSettleInput {
  sessionId: string
  requestId: string
  outcome: ActionReviewOutcome
  authority: ActionReviewAuthority
  /** Free-text rationale already produced by the deciding path. */
  reason?: string
  actor?: { kind: ActionReviewActorKind; id?: string; label?: string }
}

/**
 * In-flight requests, keyed by session+request.
 *
 * Bounded because a wedged session could otherwise accumulate entries for the
 * life of the tab: the sidecar's `canUseTool` has no timeout of its own, so an
 * unanswered ask is a real state, not a hypothetical one.
 */
const MAX_PENDING = 500
const pending = new Map<string, Promise<ActionReviewRequest>>()

const key = (sessionId: string, requestId: string) => `${sessionId}:${requestId}`

/**
 * Risk for a single tool call, reusing the deterministic classifier that until
 * now only the Agent Team and Goal runtimes consulted.
 *
 * `sandboxEnabled: false` is deliberate: the classifier uses it only to
 * DOWNGRADE `native-command`, and the approval seam cannot see whether this
 * particular call is sandboxed. Declining the downgrade over-reports rather
 * than under-reports, which is the correct direction for an advisory tier.
 */
function assess(toolName: string) {
  return classifyRisk({
    objective: "",
    taskDescriptions: [],
    toolIds: [toolName],
    capabilityIds: [],
    sandboxEnabled: false,
  })
}

/** Remember the ask and park the owning run on a pending interrupt. */
export async function openChatToolReview(
  input: ChatToolReviewOpenInput,
  now: number = Date.now()
): Promise<void> {
  // `onClaudeMessage` opens one transport subscription PER caller, so a single
  // `permission_request` frame reaches this capture once for each of them —
  // synchronously, in the same tick. The reservation below therefore has to
  // happen BEFORE the first `await`: checking the map and then filling it after
  // a round-trip lets every one of those N calls past the guard, which is the
  // N run-lookups and N duplicate interrupt inserts it exists to prevent.
  const mapKey = key(input.sessionId, input.requestId)
  if (pending.has(mapKey)) return

  const assessment = assess(input.toolName)
  const request: ActionReviewRequest = {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: input.requestId,
    origin: {
      channel: "chat-tool",
      scope: "chat",
      id: input.requestId,
      sessionId: input.sessionId,
    },
    // The tool ARGUMENTS are deliberately omitted. `ActionReviewSubject.input`
    // must be JSON-safe and PII-redacted, and a raw `canUseTool` payload is
    // neither — it is the command line, the file path, the request body.
    subject: { kind: "tool-call", ref: input.toolName },
    // The sidecar only emits `permission_request` when no explicit rule
    // resolved the call, which is exactly `ask` / not-explicit.
    verdict: "ask",
    verdictExplicit: false,
    tier: assessment.tier,
    surfaces: assessment.surfaces,
    requestedAt: now,
  }

  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next()
    if (!oldest.done) pending.delete(oldest.value)
  }
  const opening: Promise<ActionReviewRequest> = Promise.resolve().then(async () => {
    const runId = await resolveSessionRunId(input.sessionId)
    // Evicted while the run lookup was in flight. Projecting now would park an
    // interrupt nothing will ever come back to resolve.
    if (pending.get(mapKey) !== opening) return request
    if (runId) request.origin.runId = runId
    await projectActionReviewOpened(request, now)
    return request
  })
  pending.set(mapKey, opening)
  try {
    await opening
  } catch (error) {
    if (pending.get(mapKey) === opening) pending.delete(mapKey)
    throw error
  }
}

/** Resolve the interrupt and write the receipt. No-op for an unknown ask. */
export async function settleChatToolReview(
  input: ChatToolReviewSettleInput,
  now: number = Date.now()
): Promise<void> {
  const mapKey = key(input.sessionId, input.requestId)
  const opening = pending.get(mapKey)
  if (!opening) return
  const request = await opening
  if (pending.get(mapKey) !== opening) return

  await projectActionReviewSettled(request, {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: input.requestId,
    outcome: input.outcome,
    authority: input.authority,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    decidedAt: now,
  })
  if (pending.get(mapKey) === opening) pending.delete(mapKey)
}

/**
 * The run this session is currently executing, if any.
 *
 * Chat turns project as `agent-turn` runs carrying `sessionId`, so the ask can
 * be parked on the run the user is actually watching. A session with no live
 * run still records a receipt — it just has no run to block.
 */
async function resolveSessionRunId(sessionId: string): Promise<string | undefined> {
  try {
    const { listExecutionRuns } = await import("@/lib/db/execution-runs")
    const runs = await listExecutionRuns({
      sessionId,
      statuses: ["running", "waiting", "queued", "paused"],
      limit: 1,
    })
    return runs[0]?.id
  } catch {
    return undefined
  }
}

/**
 * Record a decision a PERSON made in an approval dialog.
 *
 * Exists as its own helper because the modal is the one path that cannot ride
 * `approveTool`'s attribution argument: since ADR-0090 it resolves through
 * `AgentExecutionHandle.resolvePermission` whenever a handle exists, which
 * goes straight to `agent_resolve_permission` and never reaches `approveTool`.
 * Calling this first covers both branches, and {@link settleChatToolReview} is
 * idempotent, so the `approveTool` fallback branch cannot double-record.
 *
 * It also preserves `allow_always`, which the wire call collapses to `"allow"`
 * — the audit trail should show that a standing rule was created, not just
 * that this one call was let through.
 */
export async function recordChatToolApprovalDecision(
  approval: { sessionId: string; requestId: string },
  decision: "allow" | "allow_always" | "deny"
): Promise<void> {
  await settleChatToolReview({
    sessionId: approval.sessionId,
    requestId: approval.requestId,
    outcome: decision,
    authority: "human",
    actor: { kind: "local-user" },
  })
}

/** Test-only: drop in-flight asks so suites do not leak into each other. */
export function __resetChatToolReviewsForTesting(): void {
  pending.clear()
}

/** Test-only: how many asks are awaiting a decision. */
export function __pendingChatToolReviewCount(): number {
  return pending.size
}
