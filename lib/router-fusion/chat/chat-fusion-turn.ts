/**
 * A chat turn that runs as a cascade or a panel (ADR-0188 B3, D7/D10/D11/D38).
 *
 * A direct chat turn streams from the sidecar with the agent's tools. A fusion
 * turn is a different kind of work: several model calls, checked before
 * anything is shown (verified_buffered), executed here in the renderer by the
 * orchestrator. The composer asks for one explicitly, or Auto picks one when
 * the user approved a cascade or panel rule row and the turn needs no agent
 * tools (a fusion run has only its own read-only evidence tools).
 *
 * Two steps, like the direct chat route:
 *
 * 1. `selectChatFusionRun` — at the routing block of the send pipeline. The
 *    Run API's router (`routeRunRequest`) decides across the modes the turn
 *    allows. Auto that lands on direct hands the turn back to the direct path.
 * 2. `startChatFusionTurn` — right before dispatch. The run is created (the
 *    person's message is already in the transcript, so the run writes only
 *    its verified answer), executed, and the answer handed back to the chat,
 *    which shows it at once; the outbox has made it durable in the same step.
 */

import type {
  AppSettings,
  RouterFusionRunStamp,
  RouterFusionRunSummary,
} from "@cognia/agent-config-types"
import {
  CONTRACT_SCHEMA_VERSION,
  microusdToUsd,
  usdToMicrousd,
  type ExecutionMode,
  type Message,
  type RouteDecision,
  type RunRequest,
} from "@cognia/router-fusion"
import type { RouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { liveSettingsReader } from "../calls/live-settings"
import { accountDatabaseAppliers } from "../db/outbox-appliers"
import { encodeRunInput } from "../db/run-input"
import { fusionRunSummaryOf } from "../db/run-summary"
import { answerMessage, type TranscriptMessage } from "../db/session-transcript"
import { RouterFusionInfrastructureError } from "../gate/faults"
import { routeRunRequest, type RunRoute } from "../routing/run-route"
import { webEvidenceAvailable } from "../tools/web-evidence"
import { executeFusionRun } from "../runtime/orchestrator-host"
import { windowLeaseOwner } from "./chat-run-deps"
import type { ChatRouteHost } from "./route-chat-turn"
import { currentFusionStore } from "./store-provider"
import { tightestTenantLimit } from "./tenant-budget"

/** What the composer asked for. `direct` never reaches this module. */
export type ChatFusionRequest = "auto" | "cascade" | "panel"

/** The rule rows whose actions are fusion work. */
const FUSION_RULE_ROWS = new Set(["cascade_verifiable", "panel_research"])
const CHAT_MODES: readonly ExecutionMode[] = ["direct", "cascade", "panel"]
/** How often a running turn's card is refreshed from the journal. */
export const CHAT_FUSION_PROGRESS_MS = 700
/** Sealed routes waiting for their send; a send that never comes is pushed out. */
export const MAX_PREPARED_FUSION_RUNS = 32

/**
 * Whether Auto should ask the fusion router at all. Only when the user
 * approved a fusion rule row, and only for a turn that needs no agent tools:
 * answering a tool-using turn with a panel would silently drop the tools.
 */
export function chatAutoConsidersFusion(
  settings: RouterFusionSettings,
  needsTools: boolean
): boolean {
  if (needsTools) return false
  return settings.approvedRuleRows.some((row) => FUSION_RULE_ROWS.has(row))
}

export interface ChatFusionSelectionInput {
  requested: ChatFusionRequest
  sessionId: string
  promptText: string
  /** Fusion runs read text; a turn with images stays on the direct path. */
  hasImages: boolean
  /** Whether this host can run the panel's web evidence tools; detected when omitted. */
  webToolsAvailable?: boolean
  /** The conversation's project: a workspace may raise the data class (D30). */
  workspaceId?: string | null
}

export type ChatFusionSelection =
  | { kind: "fusion"; stamp: RouterFusionRunStamp }
  /** Auto chose direct (or nothing): the direct path routes the turn as before. */
  | { kind: "direct" }
  | { kind: "refused"; code: string; reasons: string[]; decision: RouteDecision | null }

interface PreparedFusionRun {
  stamp: RouterFusionRunStamp
  route: Extract<RunRoute, { kind: "selected" }>
  sessionId: string
  budgetMode: "tracked" | "strict"
}

const prepared = new Map<string, PreparedFusionRun>()

function remember(run: PreparedFusionRun): void {
  prepared.delete(run.stamp.runId)
  prepared.set(run.stamp.runId, run)
  while (prepared.size > MAX_PREPARED_FUSION_RUNS) {
    const oldest = prepared.keys().next().value
    if (oldest === undefined) break
    prepared.delete(oldest)
  }
}

export function __resetChatFusionTurnsForTesting(): void {
  prepared.clear()
  active.clear()
}

/** The largest run cap among the modes a request may land on: the action's own cap still applies. */
function requestCap(settings: RouterFusionSettings, modes: readonly ExecutionMode[]): string {
  return microusdToUsd(
    Math.max(0, ...modes.map((mode) => usdToMicrousd(settings.runCapUsdByMode[mode])))
  )
}

export async function selectChatFusionRun(
  host: ChatRouteHost,
  input: ChatFusionSelectionInput
): Promise<ChatFusionSelection> {
  const explicit = input.requested !== "auto"
  if (input.hasImages) {
    return explicit
      ? {
          kind: "refused",
          code: "FUSION_TEXT_ONLY",
          reasons: ["attachments:image"],
          decision: null,
        }
      : { kind: "direct" }
  }
  const modes: ExecutionMode[] = explicit ? [input.requested as ExecutionMode] : [...CHAT_MODES]
  const request: RunRequest = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    input_messages: [{ role: "user", content: input.promptText.trim() || "(no text)" }],
    mode: explicit ? (input.requested as ExecutionMode) : "auto",
    allowed_modes: modes,
    profile: "balanced",
    // The action's own cap and deadline bound the run; the request lowers neither.
    budget: { max_cost_usd: requestCap(host.settings, modes), mode: host.settings.budgetMode },
    deadline_ms: 3_600_000,
    // A degraded answer is labelled on the card; a chat that asked for a panel
    // gets the one candidate that survived rather than nothing.
    allow_degraded: true,
    delivery: "verified_buffered",
  }
  const runId = host.newId()
  const route = await routeRunRequest(host, {
    runId,
    decisionId: host.newId(),
    request,
    messages: request.input_messages.map((message) => ({ role: "user", content: message.content })),
    jsonSchema: null,
    sessionId: input.sessionId,
    webToolsAvailable: input.webToolsAvailable ?? webEvidenceAvailable(),
    executableModes: CHAT_MODES,
    workspaceId: input.workspaceId ?? null,
  })
  if (route.kind === "refused") {
    return explicit
      ? { kind: "refused", code: route.code, reasons: [...route.reasons], decision: route.decision }
      : { kind: "direct" }
  }
  if (route.mode !== "cascade" && route.mode !== "panel") return { kind: "direct" }
  const stamp: RouterFusionRunStamp = {
    runId,
    decisionId: route.decision.decision_id,
    actionId: route.actionId,
    mode: route.mode,
    ruleId: route.ruleId,
    requested: input.requested,
    roles: { ...route.roles } as Record<string, string>,
    budgetMode: host.settings.budgetMode,
    capMicrousd: route.capMicrousd,
    acceptanceProfile: route.acceptanceProfile,
  }
  remember({ stamp, route, sessionId: input.sessionId, budgetMode: host.settings.budgetMode })
  return { kind: "fusion", stamp }
}

export interface ChatFusionTurnInput {
  sessionId: string
  stamp: RouterFusionRunStamp
  /** The conversation the run answers, oldest first, the new message last. */
  messages: Message[]
  /** The directory the conversation works in; the panel may read files there. */
  workspaceRoot: string | null
  appSettings: AppSettings
  onProgress?: (summary: RouterFusionRunSummary) => void
  signal?: AbortSignal
}

export type ChatFusionTurnOutcome =
  | { kind: "succeeded"; answer: TranscriptMessage; summary: RouterFusionRunSummary }
  | { kind: "failed"; code: string; message: string; summary: RouterFusionRunSummary | null }
  | { kind: "cancelled"; summary: RouterFusionRunSummary | null }
  /** The run was never created: nothing was spent. */
  | { kind: "refused"; code: string; activeRunId?: string }

/** Sessions with a fusion turn in flight in this window, and the run each is on. */
const active = new Map<string, string>()

export function activeChatFusionRun(sessionId: string): string | undefined {
  return active.get(sessionId)
}

async function summaryOf(runId: string): Promise<RouterFusionRunSummary | null> {
  const store = await currentFusionStore()
  const run = await store.getRun(runId)
  if (!run) return null
  return fusionRunSummaryOf(run, await store.listEvents(runId))
}

export async function startChatFusionTurn(
  input: ChatFusionTurnInput
): Promise<ChatFusionTurnOutcome> {
  const route = prepared.get(input.stamp.runId)
  if (!route || route.sessionId !== input.sessionId) {
    return { kind: "refused", code: "ROUTE_EXPIRED" }
  }
  prepared.delete(input.stamp.runId)
  // The conversation leaves this device for models the router chose: it passes
  // the same gate a direct send does (`lib/claude/ipc.ts`) before anything is
  // stored or reserved.
  if (!hasNoLeakingPiiDeep(input.messages)) return { kind: "refused", code: "PII_BLOCKED" }
  const selected = route.route
  const store = await currentFusionStore()
  const runId = input.stamp.runId

  const inputArtifact = await store
    .artifactStore(null)
    .put(
      encodeRunInput({ messages: input.messages, allowDegraded: true, jsonSchema: null }),
      "application/json",
      `chat-input/${runId}`
    )
  const tenantRemaining = await tightestTenantLimit(
    input.appSettings.costBudget,
    Object.values(selected.roles) as string[]
  )
  const created = await store.createRun({
    runId,
    inputArtifactId: inputArtifact.artifactId,
    sessionId: input.sessionId,
    surface: "chat",
    origin: "chat",
    decision: selected.decision,
    actionId: selected.actionId,
    ruleId: selected.ruleId,
    roleDeployments: { ...selected.roles } as Record<string, string>,
    config: selected.config,
    capMicrousd: selected.capMicrousd,
    maxModelCalls: selected.maxModelCalls,
    deadlineMs: selected.deadlineMs,
    budgetMode: route.budgetMode,
    tenantLimitRemainingMicrousd: tenantRemaining,
    // The chat wrote the person's message; the run writes only its answer.
    writesSessionAnswer: true,
    task: selected.task,
    acceptanceProfile: selected.acceptanceProfile,
    dataClass: selected.dataClass,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    driver: "orchestrator",
  })
  if (!created.ok) {
    return {
      kind: "refused",
      code: created.code,
      ...(created.activeRunId ? { activeRunId: created.activeRunId } : {}),
    }
  }
  await store.db.fusionArtifacts.update(inputArtifact.artifactId, { runId })

  active.set(input.sessionId, runId)
  let lastSeq = -1
  const progress = input.onProgress
    ? setInterval(() => {
        void store
          .getRun(runId)
          .then(async (run) => {
            if (!run || run.lastSeq === lastSeq) return
            lastSeq = run.lastSeq
            input.onProgress?.(fusionRunSummaryOf(run, await store.listEvents(runId)))
          })
          .catch(() => {})
      }, CHAT_FUSION_PROGRESS_MS)
    : null
  try {
    const outcome = await executeFusionRun(
      {
        store: async () => store,
        appliers: accountDatabaseAppliers,
        leaseOwner: windowLeaseOwner(),
        appSettings: liveSettingsReader(input.appSettings),
      },
      {
        runId,
        messages: input.messages,
        ...(input.signal ? { signal: input.signal } : {}),
      }
    )
    const summary = await summaryOf(runId)
    switch (outcome.kind) {
      case "succeeded":
        if (!summary) {
          // The run was sealed a moment ago in this same database.
          throw new RouterFusionInfrastructureError(
            "db_transaction",
            `Router + Fusion run ${runId} vanished after its seal`
          )
        }
        return {
          kind: "succeeded",
          summary,
          answer: answerMessage(
            {
              runId,
              mode: outcome.result.mode_executed,
              origin: "chat",
              ...(summary ? { summary } : {}),
            },
            outcome.result.answer
          ),
        }
      case "cancelled":
        return { kind: "cancelled", summary }
      case "busy":
        // Only this window creates a chat run, under its own lease owner.
        return {
          kind: "failed",
          code: "RUN_BUSY",
          message: "another worker holds this run",
          summary,
        }
      default:
        return { kind: "failed", code: outcome.code, message: outcome.message, summary }
    }
  } finally {
    if (progress) clearInterval(progress)
    active.delete(input.sessionId)
  }
}

/** The person stopped the turn: the run moves to cancelling and its worker stops. */
export async function cancelChatFusionTurn(sessionId: string): Promise<boolean> {
  const runId = active.get(sessionId)
  if (!runId) return false
  const store = await currentFusionStore()
  await store.cancelRun(runId)
  return true
}
