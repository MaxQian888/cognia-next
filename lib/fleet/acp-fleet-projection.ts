"use client"

/**
 * Project external-agent-manager ACP sessions into the Fleet read model.
 *
 * The fleet surface was built on two inputs — the Rust registry snapshot and
 * the canonical `agent://message` journal — neither of which an ACP session
 * ever touches: an ACP agent's events, sessions and blocking asks all live in
 * the in-renderer `ExternalAgentManager`. This module is the third source:
 * it listens on the manager's per-agent event bus, keeps one FleetSession per
 * live ACP session, and owns the answer paths for the decisions the island
 * can resolve (permission asks, schema-bound elicitations, blocking async
 * questions, interrupts and prompt injection).
 *
 * The island never sees this module. It renders the `IslandRowProjection`
 * built from the FleetSession rows this file emits, and its intents re-enter
 * through `lib/island/actions.ts` where the owner ref carries `agentId` — the
 * marker that a row is manager-controlled rather than Rust-controlled.
 */

import type { PendingApproval } from "@cognia/agent-config-types"

import {
  deliverExternalElicitation,
  externalApprovalRequestId,
  getExternalApprovalTarget,
  resolveExternalApproval,
  resolveExternalQuestion,
  toPermissionResponse,
  type ExternalApprovalTarget,
} from "@/lib/ai/agent/external/session/chat-decision-bridge"
import {
  externalAgentPresetIdOf,
  isDevinAgentConfig,
} from "@/lib/ai/agent/external/config/preset-identity"
import type {
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpElicitationValue,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPermissionResponse,
  ExternalAgentAsyncQuestionsEvent,
  ExternalAgentConfig,
  ExternalAgentElicitationRequestEvent,
  ExternalAgentEvent,
  ExternalAgentPermissionRequestEvent,
  ExternalAgentPermissionResponseEvent,
  ExternalAgentSession,
} from "@/types/agent/external-agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useExternalElicitationStore } from "@/stores/agent/external-elicitation-store"
import { useChatStore } from "@/stores/chat/chat-store"
import type {
  ExternalAgentLifecycleEvent,
  ExternalAgentManager,
} from "@/lib/ai/agent/external/manager"
import {
  registerAcpSession,
  unregisterAcpSession,
  __resetAcpSessionRegistryForTests,
} from "./acp-session-registry"
import {
  CANONICAL_SESSION_LINGER_MS,
  canonicalSessionExpired,
  projectNameOf,
} from "./canonical-projection"
import type {
  FleetActivity,
  FleetAgent,
  FleetError,
  FleetSession,
  FleetStatus,
  PendingPermission,
  PendingQuestion,
  PendingQuestionRequest,
} from "./types"

/** Prefix for the island-side request id of an ACP elicitation. */
const ELICITATION_REQUEST_PREFIX = "external-elicitation:"

export function acpElicitationFleetRequestId(
  agentId: string,
  elicitationRequestId: string
): string {
  return `${ELICITATION_REQUEST_PREFIX}${agentId}:${elicitationRequestId}`
}

/** How long a "send" may wait for the agent to accept the prompt. */
const ACP_SEND_CONFIRM_MS = 15_000

/**
 * The fleet identity an ACP config maps to. Devin wins on the shared binary
 * check (preset or launch command), matching the adapter factory; the other
 * named presets fold onto their hook-observed siblings so a session run
 * through ACP reads as the same product. Everything else is generic `acp`.
 */
export function acpFleetAgentOf(
  config: Pick<ExternalAgentConfig, "metadata" | "process">
): FleetAgent {
  if (isDevinAgentConfig(config)) return "devin"
  switch (externalAgentPresetIdOf(config)) {
    case "claude-code":
      return "claude-code"
    case "codex":
    case "codex-acp":
      return "codex"
    case "opencode-acp":
      return "opencode"
    default:
      return "acp"
  }
}

/* -- Session rows ---------------------------------------------------------- */

interface AcpSessionRow {
  agentId: string
  sessionId: string
  agent: FleetAgent
  agentLabel?: string
  chatSessionId?: string
  status: FleetStatus
  /** A turn is in flight; resolved by `done` / `error` / `session_end`. */
  turnOpen: boolean
  cwd: string | null
  projectName: string | null
  lastPrompt: string | null
  activity: FleetActivity | null
  permissionMode: string | null
  model: string | null
  pendingPermission: PendingPermission | null
  pendingQuestions: PendingQuestion[]
  pendingQuestionRequest: PendingQuestionRequest | null
  /** The pending question blocks the turn (elicitation) vs rides it (async). */
  questionBlocking: boolean
  /**
   * Every elicitation id shown on this row (`request.id` and the wire
   * `elicitationId`). `elicitation_complete` carries only the wire id and the
   * store watch only knows the local one — the row must match either to learn
   * the ask is gone, whether or not a decision was ever registered for it.
   */
  elicitationIds: Set<string>
  /**
   * `external-agent:` request ids of blocking asks the row displays but the
   * island cannot answer (a `requestUserInput` with no options-only mapping).
   * Tracked so a `permission_response` settles the row even though no
   * `AcpPendingDecision` was ever registered for it.
   */
  unanswerableRequestIds: Set<string>
  startedAt: number
  lastEventAt: number
  endedAt?: number
  lastError: FleetError | null
  toolUseCount: number
  turnCount: number
}

/* -- Pending decisions ----------------------------------------------------- */

interface ElicitationOptionMap {
  label: string
  value: AcpElicitationValue
}

interface ElicitationPropertyMap {
  name: string
  multiSelect: boolean
  options: ElicitationOptionMap[]
}

type AcpPendingDecision =
  | {
      kind: "permission"
      agentId: string
      sessionId: string
      responseRequestId: string
      options?: AcpPermissionOption[]
    }
  | {
      kind: "elicitation"
      agentId: string
      sessionId?: string
      request: AcpElicitationRequest
      properties: ElicitationPropertyMap[]
    }
  | {
      /**
       * Any ask answered by a `{requestId, granted, answers}` wire reply:
       * non-blocking `async_questions` and blocking `requestUserInput` asks
       * (Codex `item/tool/requestUserInput`, OpenCode `question.*`, and Codex
       * MCP elicitations all share that metadata surface).
       */
      kind: "questions"
      agentId: string
      sessionId?: string
      responseRequestId: string
      questions: Array<{ id: string; options: string[] }>
    }

const pendingDecisions = new Map<string, AcpPendingDecision>()

/* -- Store state ------------------------------------------------------------ */

const rows = new Map<string, AcpSessionRow>()
const listeners = new Set<() => void>()
const agentUnsubscribes = new Map<string, () => void>()
const sweeps = new Map<string, ReturnType<typeof setTimeout>>()
let snapshot: ReadonlyMap<string, FleetSession> = new Map()
let lifecycleOff: (() => void) | undefined
let storeOff: (() => void) | undefined
let elicitationStoreOff: (() => void) | undefined
/**
 * Elicitation request ids present in the chat-side store on the last sync.
 * An id that disappears was settled elsewhere (the pane's dialog answered or
 * cancelled it) — the only signal for form elicitations, whose adapter emits
 * no event when `respondToElicitation` resolves the waiter.
 */
let seenStoreElicitations = new Set<string>()
let attached = false

const rowKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

function emit(): void {
  const next = new Map<string, FleetSession>()
  for (const row of rows.values()) {
    next.set(`${row.agent}:${row.sessionId}`, toFleetSession(row))
  }
  snapshot = next
  listeners.forEach((listener) => listener())
}

function blocked(row: AcpSessionRow): boolean {
  return Boolean(row.pendingPermission) || row.questionBlocking
}

function recomputeStatus(row: AcpSessionRow): FleetStatus {
  if (row.status === "ended") return "ended"
  if (row.pendingPermission) return "waiting-permission"
  if (row.questionBlocking) return "waiting-input"
  return row.turnOpen ? "working" : "idle"
}

function toFleetSession(row: AcpSessionRow): FleetSession {
  return {
    agent: row.agent,
    origin: "local-external",
    lifecycleConfidence: "native",
    sessionId: row.sessionId,
    status: recomputeStatus(row),
    cwd: row.cwd,
    projectName: row.projectName,
    lastPrompt: row.lastPrompt,
    activity: row.activity,
    permissionMode: row.permissionMode,
    model: row.model,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: row.pendingPermission,
    pendingPlan: null,
    pendingQuestions: row.pendingQuestions,
    pendingQuestionRequest: row.pendingQuestionRequest,
    capabilities: {
      approvePermission: true,
      // A blocked turn cannot take a prompt; the ask is answered first.
      sendMessage: !blocked(row),
      focusTerminal: false,
      openTranscript: false,
      interrupt: true,
    },
    startedAt: row.startedAt,
    lastEventAt: row.lastEventAt,
    ...(row.endedAt != null ? { endedAt: row.endedAt } : {}),
    lastError: row.lastError,
    toolUseCount: row.toolUseCount,
    turnCount: row.turnCount,
    externalAgentId: row.agentId,
    ...(row.chatSessionId ? { chatSessionId: row.chatSessionId } : {}),
    ...(row.agentLabel ? { agentLabel: row.agentLabel } : {}),
  }
}

/* -- Row lifecycle ---------------------------------------------------------- */

function acpAgentLabel(config: Pick<ExternalAgentConfig, "name"> | undefined): string | undefined {
  return config?.name || undefined
}

function rowFromExternalSession(
  agentId: string,
  agent: FleetAgent,
  session: ExternalAgentSession
): AcpSessionRow {
  const cwd = typeof session.metadata?.cwd === "string" ? session.metadata.cwd : null
  const chatSessionId =
    typeof session.metadata?.cogniaSessionId === "string"
      ? session.metadata.cogniaSessionId
      : undefined
  const status: FleetStatus =
    session.status === "executing"
      ? "working"
      : session.status === "waiting"
        ? "waiting-input"
        : session.status === "closed" || session.status === "closing"
          ? "ended"
          : "idle"
  return {
    agentId,
    sessionId: session.id,
    agent,
    chatSessionId,
    status,
    turnOpen: status === "working",
    cwd,
    projectName: projectNameOf(cwd),
    lastPrompt: session.context?.parentTask ?? null,
    activity: null,
    permissionMode: session.permissionMode ?? null,
    model: null,
    pendingPermission: null,
    pendingQuestions: [],
    pendingQuestionRequest: null,
    questionBlocking: false,
    elicitationIds: new Set(),
    unanswerableRequestIds: new Set(),
    startedAt: session.createdAt?.getTime?.() ?? Date.now(),
    lastEventAt: session.lastActivityAt?.getTime?.() ?? Date.now(),
    ...(status === "ended" ? { endedAt: Date.now() } : {}),
    lastError: session.error ? { kind: "turn", detail: session.error, at: Date.now() } : null,
    toolUseCount: 0,
    turnCount: 0,
  }
}

function ensureRow(agentId: string, sessionId: string): AcpSessionRow {
  const existing = rows.get(rowKey(agentId, sessionId))
  if (existing) return existing
  const store = useExternalAgentStore.getState()
  const config = store.agents[agentId]
  const agent = config ? acpFleetAgentOf(config) : "acp"
  const external = managerRef?.getSession(agentId, sessionId)
  const row: AcpSessionRow = external
    ? rowFromExternalSession(agentId, agent, external)
    : {
        agentId,
        sessionId,
        agent,
        status: "idle" as FleetStatus,
        turnOpen: false,
        cwd: null,
        projectName: null,
        lastPrompt: null,
        activity: null,
        permissionMode: null,
        model: null,
        pendingPermission: null,
        pendingQuestions: [],
        pendingQuestionRequest: null,
        questionBlocking: false,
        elicitationIds: new Set(),
        unanswerableRequestIds: new Set(),
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        lastError: null,
        toolUseCount: 0,
        turnCount: 0,
      }
  row.agentLabel = acpAgentLabel(config)
  rows.set(rowKey(agentId, sessionId), row)
  registerAcpSession(sessionId, {
    agent: row.agent,
    agentId,
    agentLabel: row.agentLabel,
    ...(row.chatSessionId ? { chatSessionId: row.chatSessionId } : {}),
  })
  return row
}

function dropRow(row: AcpSessionRow): void {
  rows.delete(rowKey(row.agentId, row.sessionId))
  unregisterAcpSession(row.sessionId)
  for (const [requestId, decision] of pendingDecisions) {
    if (decision.agentId === row.agentId && decision.sessionId === row.sessionId) {
      pendingDecisions.delete(requestId)
    }
  }
}

function sweepEnded(row: AcpSessionRow): void {
  const key = rowKey(row.agentId, row.sessionId)
  const existing = sweeps.get(key)
  if (existing) clearTimeout(existing)
  sweeps.set(
    key,
    setTimeout(() => {
      sweeps.delete(key)
      const current = rows.get(key)
      if (current && canonicalSessionExpired(toFleetSession(current), Date.now())) {
        dropRow(current)
        emit()
      }
    }, CANONICAL_SESSION_LINGER_MS + 100)
  )
}

/* -- Event fold -------------------------------------------------------------- */

function clearSessionDecisions(row: AcpSessionRow): void {
  for (const [requestId, decision] of pendingDecisions) {
    if (decision.agentId === row.agentId && decision.sessionId === row.sessionId) {
      pendingDecisions.delete(requestId)
    }
  }
  row.pendingPermission = null
  row.pendingQuestions = []
  row.pendingQuestionRequest = null
  row.questionBlocking = false
  row.elicitationIds.clear()
  row.unanswerableRequestIds.clear()
}

/**
 * The blocking user-input payload adapters stamp on a `permission_request`:
 * Codex `item/tool/requestUserInput`, OpenCode `question.*` and Codex MCP
 * elicitations all share `metadata.codexUserInput.questions`. Their wire
 * reply is `{requestId, granted, answers}` — the same one async questions
 * take — so the row shows questions, not an approve/deny pair.
 */
interface UserInputQuestion {
  id: string
  prompt: string
  options: string[]
  multiSelect: boolean
  secret: boolean
}

function userInputQuestions(request: AcpPermissionRequest): UserInputQuestion[] | null {
  const raw = request.metadata?.codexUserInput as { questions?: unknown } | undefined
  if (!Array.isArray(raw?.questions)) return null
  const questions: UserInputQuestion[] = []
  for (const item of raw.questions) {
    if (!item || typeof item !== "object") return null
    const question = item as {
      id?: unknown
      header?: unknown
      question?: unknown
      title?: unknown
      options?: unknown
      multiple?: unknown
      isSecret?: unknown
      secret?: unknown
    }
    if (typeof question.id !== "string" || !question.id) return null
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (typeof option === "string") return [option]
          if (option && typeof option === "object") {
            const label = (option as { label?: unknown }).label
            if (typeof label === "string" && label) return [label]
          }
          return []
        })
      : []
    questions.push({
      id: question.id,
      prompt:
        (typeof question.header === "string" && question.header) ||
        (typeof question.question === "string" && question.question) ||
        (typeof question.title === "string" && question.title) ||
        question.id,
      options,
      multiSelect: question.multiple === true,
      secret: question.isSecret === true || question.secret === true,
    })
  }
  return questions
}

/** Row state for an ask the island can display but not answer. */
function showUnanswerableQuestion(row: AcpSessionRow, prompt: string, requestId?: string): void {
  row.pendingQuestions = [{ question: prompt, options: [], multiSelect: false }]
  row.pendingQuestionRequest = null
  row.questionBlocking = true
  if (requestId) row.unanswerableRequestIds.add(requestId)
  row.status = "waiting-input"
}

function onPermissionRequest(agentId: string, event: ExternalAgentPermissionRequestEvent): void {
  const sessionId = event.sessionId || event.request.sessionId
  if (!sessionId) return
  const responseRequestId = event.request.requestId || event.request.id
  if (!responseRequestId) return
  const row = ensureRow(agentId, sessionId)
  const requestId = externalApprovalRequestId(agentId, responseRequestId)

  const hasUserInput = Array.isArray(
    (event.request.metadata?.codexUserInput as { questions?: unknown } | undefined)?.questions
  )
  const userInput = hasUserInput ? userInputQuestions(event.request) : null
  if (hasUserInput) {
    const answerable = (userInput ?? []).filter(
      (question) => question.options.length > 0 && !question.secret
    )
    if (!userInput || answerable.length === 0) {
      // Free-text, secret-only or malformed asks have no options-only mapping —
      // an approve/deny pair would send empty answers. Show the wait and point
      // the user at the main window's full question dialog.
      showUnanswerableQuestion(
        row,
        event.request.title || userInput?.[0]?.prompt || "Input requested",
        requestId
      )
      return
    }
    pendingDecisions.set(requestId, {
      kind: "questions",
      agentId,
      sessionId,
      responseRequestId,
      questions: answerable.map((question) => ({
        id: question.id,
        options: question.options,
      })),
    })
    row.pendingQuestions = answerable.map((question) => ({
      question: question.prompt,
      options: question.options,
      multiSelect: question.multiSelect,
    }))
    row.pendingQuestionRequest = { requestId, requestedAt: Date.now() }
    row.questionBlocking = true
    row.status = "waiting-input"
    return
  }

  pendingDecisions.set(requestId, {
    kind: "permission",
    agentId,
    sessionId,
    responseRequestId,
    options: event.request.options,
  })
  row.pendingPermission = {
    requestId,
    toolName: event.request.toolInfo?.name ?? null,
    detail: event.request.title ?? event.request.reason ?? null,
    requestedAt: Date.now(),
  }
  row.status = "waiting-permission"
}

function onPermissionResponse(agentId: string, event: ExternalAgentPermissionResponseEvent): void {
  const sessionId = event.sessionId
  if (!sessionId) return
  const row = rows.get(rowKey(agentId, sessionId))
  const responseRequestId = event.response.requestId
  const requestId = responseRequestId
    ? externalApprovalRequestId(agentId, responseRequestId)
    : undefined
  // The same response event settles every kind of ask the session had —
  // approvals, async questions and blocking user input all funnel through
  // `respondToPermission` on the adapter.
  pendingDecisions.forEach((decision, key) => {
    if (
      (decision.kind === "permission" || decision.kind === "questions") &&
      decision.agentId === agentId &&
      decision.sessionId === sessionId &&
      (requestId === undefined || key === requestId)
    ) {
      pendingDecisions.delete(key)
    }
  })
  if (row) {
    const settlesAll = requestId === undefined
    if (settlesAll || row.pendingPermission?.requestId === requestId) {
      row.pendingPermission = null
    }
    if (settlesAll || row.pendingQuestionRequest?.requestId === requestId) {
      row.pendingQuestions = []
      row.pendingQuestionRequest = null
      row.questionBlocking = false
    }
    const settledUnanswerable = settlesAll
      ? row.unanswerableRequestIds.size > 0
      : requestId !== undefined && row.unanswerableRequestIds.delete(requestId)
    if (settlesAll) row.unanswerableRequestIds.clear()
    if (settledUnanswerable && row.questionBlocking && !row.pendingQuestionRequest) {
      row.pendingQuestions = []
      row.questionBlocking = false
    }
    row.status = recomputeStatus(row)
  }
}

/** Map a form-mode elicitation to the island's options-only question model. */
function mapElicitation(
  request: AcpElicitationRequest
): { questions: PendingQuestion[]; properties: ElicitationPropertyMap[] } | null {
  if (request.mode !== "form") return null
  const schema = request.requestedSchema
  if (!schema?.properties) return null
  const entries = Object.entries(schema.properties)
  if (entries.length === 0) return null

  const questions: PendingQuestion[] = []
  const properties: ElicitationPropertyMap[] = []
  for (const [name, property] of entries) {
    const options = propertyOptions(property)
    if (!options || options.length === 0) return null
    properties.push({ name, multiSelect: property.type === "array", options })
    questions.push({
      question: property.title || property.description || name,
      options: options.map((option) => option.label),
      multiSelect: property.type === "array",
    })
  }
  if (request.message) {
    if (questions.length === 1) {
      // A single-field form reads as the question itself.
      questions[0].header = questions[0].question
      questions[0].question = request.message
    } else {
      questions[0].header = request.message
    }
  }
  return { questions, properties }
}

function propertyOptions(property: {
  type?: string
  enum?: string[]
  oneOf?: Array<{ const: string; title?: string }>
  items?: { type?: string; enum?: string[]; oneOf?: Array<{ const: string; title?: string }> }
}): ElicitationOptionMap[] | null {
  if (property.type === "boolean") {
    return [
      { label: "true", value: true },
      { label: "false", value: false },
    ]
  }
  if (property.type === "array") {
    const items = property.items
    if (items?.oneOf?.length) {
      return items.oneOf.map((option) => ({
        label: option.title ?? option.const,
        value: option.const,
      }))
    }
    if (items?.enum?.length) {
      return items.enum.map((value) => ({ label: value, value }))
    }
    return null
  }
  if (property.oneOf?.length) {
    return property.oneOf.map((option) => ({
      label: option.title ?? option.const,
      value: option.const,
    }))
  }
  if (property.enum?.length) {
    return property.enum.map((value) => ({ label: value, value }))
  }
  return null
}

function onElicitationRequest(agentId: string, event: ExternalAgentElicitationRequestEvent): void {
  const request = event.request
  const sessionId = event.sessionId || request.sessionId
  const row = sessionId ? ensureRow(agentId, sessionId) : undefined
  if (row) {
    row.elicitationIds.add(request.id)
    if (request.elicitationId) row.elicitationIds.add(request.elicitationId)
  }
  const mapped = mapElicitation(request)
  if (!mapped) {
    // Not answerable from the options-only model — still show the wait and
    // point the user at the main window's form UI. The tracked ids are what
    // settle the row when the ask completes elsewhere.
    if (row) showUnanswerableQuestion(row, request.message || "Input requested")
    return
  }
  const requestId = acpElicitationFleetRequestId(agentId, request.id)
  pendingDecisions.set(requestId, {
    kind: "elicitation",
    agentId,
    sessionId,
    request,
    properties: mapped.properties,
  })
  if (row) {
    row.pendingQuestions = mapped.questions
    row.pendingQuestionRequest = { requestId, requestedAt: Date.now() }
    row.questionBlocking = true
    row.status = "waiting-input"
  }
}

/** Clear the question state a settled elicitation left on a row. */
function clearElicitationOnRow(row: AcpSessionRow): void {
  row.elicitationIds.clear()
  const pendingId = row.pendingQuestionRequest?.requestId
  if (pendingId) pendingDecisions.delete(pendingId)
  row.pendingQuestions = []
  row.pendingQuestionRequest = null
  row.questionBlocking = false
  row.status = recomputeStatus(row)
}

function onElicitationComplete(agentId: string, elicitationId: string): void {
  for (const [requestId, decision] of pendingDecisions) {
    if (
      decision.kind === "elicitation" &&
      decision.agentId === agentId &&
      (decision.request.id === elicitationId || decision.request.elicitationId === elicitationId)
    ) {
      pendingDecisions.delete(requestId)
    }
  }
  for (const row of rows.values()) {
    if (row.agentId !== agentId || !row.elicitationIds.delete(elicitationId)) continue
    if (!row.questionBlocking) {
      row.elicitationIds.clear()
      continue
    }
    clearElicitationOnRow(row)
  }
}

function onAsyncQuestions(agentId: string, event: ExternalAgentAsyncQuestionsEvent): void {
  if (!event.requestId) return
  const answerable = event.questions.filter(
    (question) => question.id && question.options?.length && !question.secret
  )
  if (answerable.length === 0) return
  const sessionId = event.sessionId
  const requestId = externalApprovalRequestId(agentId, event.requestId)
  pendingDecisions.set(requestId, {
    kind: "questions",
    agentId,
    sessionId,
    responseRequestId: event.requestId,
    questions: answerable.map((question) => ({
      id: question.id as string,
      options: question.options as string[],
    })),
  })
  const row = sessionId ? ensureRow(agentId, sessionId) : undefined
  if (row) {
    row.pendingQuestions = answerable.map((question) => ({
      question: question.title,
      options: question.options as string[],
      multiSelect: false,
    }))
    row.pendingQuestionRequest = { requestId, requestedAt: Date.now() }
    // Async questions ride the turn rather than blocking it — the row keeps
    // its status and simply gains answer controls.
    row.status = recomputeStatus(row)
  }
}

/** Events that settle or end an ask never prove a session exists on their own. */
const NON_CREATING_EVENTS = new Set(["permission_response", "elicitation_complete", "session_end"])

function onEvent(agentId: string, event: ExternalAgentEvent): void {
  const sessionId = event.sessionId
  const row = sessionId
    ? NON_CREATING_EVENTS.has(event.type)
      ? rows.get(rowKey(agentId, sessionId))
      : ensureRow(agentId, sessionId)
    : undefined
  const now = Date.now()

  switch (event.type) {
    case "permission_request":
      onPermissionRequest(agentId, event)
      break
    case "permission_response":
      onPermissionResponse(agentId, event)
      break
    case "elicitation_request":
      onElicitationRequest(agentId, event)
      break
    case "elicitation_complete":
      onElicitationComplete(agentId, event.elicitationId)
      break
    case "async_questions":
      onAsyncQuestions(agentId, event)
      break
    case "session_start":
      if (row) {
        row.turnOpen = true
        row.lastError = null
        row.status = recomputeStatus(row)
      }
      break
    case "message_start":
      if (row) {
        row.turnOpen = true
        if (event.role === "user") row.turnCount += 1
        row.status = recomputeStatus(row)
      }
      break
    case "tool_use_start":
      if (row) {
        row.turnOpen = true
        row.toolUseCount += 1
        row.activity = { toolName: event.toolName, detail: null }
        row.status = recomputeStatus(row)
      }
      break
    case "tool_call_update":
      if (row && event.title) row.activity = { toolName: event.title, detail: null }
      break
    case "tool_result":
      if (row && event.isError) {
        row.lastError = {
          kind: "tool",
          detail: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          at: now,
        }
      }
      break
    case "done":
      if (row) {
        row.turnOpen = false
        row.activity = null
        clearSessionDecisions(row)
        row.status = "idle"
      }
      break
    case "error":
      if (row) {
        row.turnOpen = false
        row.lastError = { kind: "turn", detail: event.error, at: now }
        clearSessionDecisions(row)
        row.status = "idle"
      }
      break
    case "session_end":
      if (row) {
        row.turnOpen = false
        clearSessionDecisions(row)
        row.status = "ended"
        row.endedAt = now
        if (event.reason === "error" && event.error) {
          row.lastError = { kind: "turn", detail: event.error, at: now }
        }
        sweepEnded(row)
      }
      break
    case "mode_update":
      if (row) row.permissionMode = event.modeId
      break
    case "session_info_update":
      break
    default:
      // Streaming narration (deltas, thinking, commentary, plan/usage/progress
      // updates, hook notices): liveness only — a turn is in flight.
      if (row && row.status !== "ended") {
        row.turnOpen = true
        row.status = recomputeStatus(row)
      }
      break
  }
  if (row) row.lastEventAt = now
  emit()
}

/* -- Attach ------------------------------------------------------------------ */

function acpAgentIds(): string[] {
  const agents = useExternalAgentStore.getState().agents
  return Object.values(agents)
    .filter((config) => config.protocol === "acp" && config.enabled)
    .map((config) => config.id)
}

function seedAgentSessions(agentId: string): void {
  const config = useExternalAgentStore.getState().agents[agentId]
  const agent = config ? acpFleetAgentOf(config) : "acp"
  for (const session of managerRef?.liveSessions(agentId) ?? []) {
    const key = rowKey(agentId, session.id)
    if (!rows.has(key)) {
      const row = rowFromExternalSession(agentId, agent, session)
      row.agentLabel = acpAgentLabel(config)
      rows.set(key, row)
    } else {
      // Rebind facts the stream cannot carry: chat binding may be stamped
      // after the first events arrived.
      const row = rows.get(key) as AcpSessionRow
      const chatSessionId =
        typeof session.metadata?.cogniaSessionId === "string"
          ? session.metadata.cogniaSessionId
          : undefined
      if (chatSessionId && row.chatSessionId !== chatSessionId) row.chatSessionId = chatSessionId
      if (session.status === "closed" || session.status === "closing") {
        row.status = "ended"
        row.endedAt = row.endedAt ?? Date.now()
      }
    }
    const row = rows.get(key) as AcpSessionRow
    registerAcpSession(session.id, {
      agent: row.agent,
      agentId,
      agentLabel: row.agentLabel,
      ...(row.chatSessionId ? { chatSessionId: row.chatSessionId } : {}),
    })
  }
}

function attachAgent(agentId: string): void {
  if (agentUnsubscribes.has(agentId) || !managerRef) return
  agentUnsubscribes.set(
    agentId,
    managerRef.addEventListener(agentId, (event) => onEvent(agentId, event))
  )
  seedAgentSessions(agentId)
}

function detachAgent(agentId: string): void {
  agentUnsubscribes.get(agentId)?.()
  agentUnsubscribes.delete(agentId)
}

/**
 * End every live row an agent hosted. The adapter is gone, so the sessions are
 * unreachable: leaving a phantom "working" line is exactly what a reconnect's
 * reseed is for — whatever the new adapter still lists comes back.
 */
function endAgentRows(agentId: string): boolean {
  let changed = false
  for (const row of rows.values()) {
    if (row.agentId !== agentId || row.status === "ended") continue
    clearSessionDecisions(row)
    row.turnOpen = false
    row.status = "ended"
    row.endedAt = Date.now()
    sweepEnded(row)
    changed = true
  }
  return changed
}

function onLifecycle(event: ExternalAgentLifecycleEvent): void {
  if (!attached) return
  const { agentId } = event
  const connected =
    event.connectionStatus === "connected" ||
    event.status === "executing" ||
    event.status === "ready"
  if (!connected) {
    if (endAgentRows(agentId)) emit()
    return
  }
  if (useExternalAgentStore.getState().agents[agentId]?.protocol === "acp") {
    seedAgentSessions(agentId)
    emit()
  }
}

function syncAgentListeners(): void {
  const wanted = new Set(acpAgentIds())
  for (const agentId of wanted) attachAgent(agentId)
  let changed = false
  for (const agentId of [...agentUnsubscribes.keys()]) {
    if (wanted.has(agentId)) continue
    // The config was removed or disabled: drop the listener and end the rows
    // it was feeding — an agent that no longer exists cannot be controlled.
    detachAgent(agentId)
    changed = endAgentRows(agentId) || changed
  }
  if (changed) emit()
}

/**
 * Settle rows whose elicitation vanished from the chat-side store. Only ids
 * the store HAS shown can settle this way — an unbound session's elicitation
 * never registers there, so its absence proves nothing.
 */
function syncElicitationStore(): void {
  const bySession = useExternalElicitationStore.getState().bySession
  const present = new Set<string>()
  for (const entries of Object.values(bySession)) {
    for (const entry of entries) {
      present.add(entry.request.id)
      if (entry.request.elicitationId) present.add(entry.request.elicitationId)
    }
  }
  const vanished = new Set([...seenStoreElicitations].filter((id) => !present.has(id)))
  seenStoreElicitations = present
  if (vanished.size === 0) return
  let changed = false
  for (const [requestId, decision] of pendingDecisions) {
    if (
      decision.kind === "elicitation" &&
      (vanished.has(decision.request.id) ||
        (decision.request.elicitationId !== undefined &&
          vanished.has(decision.request.elicitationId)))
    ) {
      pendingDecisions.delete(requestId)
    }
  }
  for (const row of rows.values()) {
    if (!row.questionBlocking) continue
    if (![...row.elicitationIds].some((id) => vanished.has(id))) continue
    clearElicitationOnRow(row)
    changed = true
  }
  if (changed) emit()
}

function attach(): void {
  if (attached) return
  attached = true
  void resolveManager().then((manager) => {
    // A detach that landed while the import resolved must not re-arm listeners.
    if (!attached) return
    syncAgentListeners()
    lifecycleOff = manager.addLifecycleListener(onLifecycle)
    emit()
  })
  // Agent configs can be added while the island is mounted — pick them up.
  storeOff = useExternalAgentStore.subscribe(() => syncAgentListeners())
  seenStoreElicitations = new Set()
  syncElicitationStore()
  elicitationStoreOff = useExternalElicitationStore.subscribe(() => syncElicitationStore())
  emit()
}

function detach(): void {
  if (!attached) return
  attached = false
  lifecycleOff?.()
  storeOff?.()
  elicitationStoreOff?.()
  lifecycleOff = undefined
  storeOff = undefined
  elicitationStoreOff = undefined
  seenStoreElicitations = new Set()
  for (const agentId of [...agentUnsubscribes.keys()]) detachAgent(agentId)
}

/* -- Lazy manager access ----------------------------------------------------- */

let managerRef: ExternalAgentManager | undefined

/**
 * The manager is a singleton behind a module that pulls the whole adapter
 * registry; resolving it lazily keeps this projection off the import cycle
 * between stores, chat and the runtime adapters (the same reason
 * `chat-decision-bridge` reaches it through a dynamic import).
 */
async function resolveManager(): Promise<ExternalAgentManager> {
  if (!managerRef) {
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    managerRef = getExternalAgentManager()
  }
  return managerRef
}

/* -- Public store ------------------------------------------------------------ */

export const acpFleetProjection = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (listeners.size === 1) attach()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) detach()
    }
  },
  getSnapshot(): ReadonlyMap<string, FleetSession> {
    return snapshot
  },
  attach,
  detach,
  resetForTests(): void {
    listeners.clear()
    detach()
    for (const timer of sweeps.values()) clearTimeout(timer)
    sweeps.clear()
    rows.clear()
    pendingDecisions.clear()
    seenStoreElicitations = new Set()
    snapshot = new Map()
    __resetAcpSessionRegistryForTests()
  },
}

/* -- Decision + control APIs (island action side) ---------------------------- */

function findChatApproval(requestId: string): PendingApproval | undefined {
  const store = useChatStore.getState()
  for (const slice of Object.values(store.sessions)) {
    const found = slice.pendingApprovals?.find(
      (approval) => approval.requestId === requestId && approval.status === "pending"
    )
    if (found) return found
  }
  return store.pendingApprovals.find(
    (approval) => approval.requestId === requestId && approval.status === "pending"
  )
}

function findElicitationEntry(requestId: string) {
  const bySession = useExternalElicitationStore.getState().bySession
  for (const [chatSessionId, entries] of Object.entries(bySession)) {
    const found = entries.find(
      (entry) => entry.request.id === requestId || entry.request.elicitationId === requestId
    )
    if (found) return { ...found, chatSessionId }
  }
  return undefined
}

/**
 * Answer an ACP permission ask. Prefers the chat-decision-bridge path so a
 * chat-bound ask clears the pane card and a host-run ask travels as the
 * remote RPC; falls back to the manager for asks only the island has seen.
 */
export async function respondAcpFleetPermission(
  requestId: string,
  decision: "allow" | "deny"
): Promise<boolean> {
  const pending = pendingDecisions.get(requestId)
  if (!pending || pending.kind !== "permission") return false
  const manager = await resolveManager()
  try {
    const remoteDecisionId = getExternalApprovalTarget(requestId)?.remoteDecisionId
    const respond = remoteDecisionId
      ? async () => {
          const { resolveRemotePermission } =
            await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
          const outcome = await resolveRemotePermission(remoteDecisionId, decision)
          if (!outcome.resolved && outcome.reason === "wrong-device") {
            throw new Error("This device is not the one that was asked.")
          }
        }
      : async (agentId: string, agentSessionId: string, response: AcpPermissionResponse) => {
          await manager.respondToPermission(agentId, agentSessionId, response)
        }
    const answered = await resolveExternalApproval(requestId, decision, respond)
    if (!answered) {
      const target: ExternalApprovalTarget = {
        agentId: pending.agentId,
        externalSessionId: pending.sessionId,
        responseRequestId: pending.responseRequestId,
        chatSessionId: "",
        ...(pending.options ? { options: pending.options } : {}),
      }
      await manager.respondToPermission(
        pending.agentId,
        pending.sessionId,
        toPermissionResponse(decision, target)
      )
    }
    const chatApproval = findChatApproval(requestId)
    if (chatApproval) {
      const { recordChatToolApprovalDecision } =
        await import("@/lib/policy/action-review/chat-tool-channel")
      await recordChatToolApprovalDecision(chatApproval, decision)
      useChatStore.getState().clearApproval(requestId, chatApproval.sessionId)
    }
    pendingDecisions.delete(requestId)
    const row = rows.get(rowKey(pending.agentId, pending.sessionId))
    if (row) {
      row.pendingPermission = null
      row.status = recomputeStatus(row)
    }
    emit()
    return true
  } catch {
    return false
  }
}

/** Build the `content` map an `accept` elicitation response carries. */
function elicitationContent(
  decision: Extract<AcpPendingDecision, { kind: "elicitation" }>,
  selections: number[][]
): Record<string, AcpElicitationValue> | null {
  const required = new Set(decision.request.requestedSchema?.required ?? [])
  if (selections.length !== decision.properties.length) return null
  const content: Record<string, AcpElicitationValue> = {}
  for (const [index, property] of decision.properties.entries()) {
    const picked = selections[index] ?? []
    if (property.multiSelect) {
      const values = picked
        .map((k) => property.options[k]?.value)
        .filter((value): value is AcpElicitationValue => value !== undefined)
        .map((value) => String(value))
      if (required.has(property.name) && values.length === 0) return null
      content[property.name] = values
    } else {
      const value = picked.length ? property.options[picked[0]]?.value : undefined
      if (value === undefined) {
        if (required.has(property.name)) return null
        continue
      }
      content[property.name] = value
    }
  }
  return content
}

/**
 * Answer a pending ACP question (elicitation form or blocking async
 * questions). `selections` are option indices per question, matching the
 * `pendingQuestions` order the projection emitted.
 */
export async function respondAcpFleetQuestion(
  requestId: string,
  selections: number[][]
): Promise<boolean> {
  const pending = pendingDecisions.get(requestId)
  if (!pending) return false
  const manager = await resolveManager()
  try {
    if (pending.kind === "elicitation") {
      const content = elicitationContent(pending, selections)
      if (!content) return false
      const response: AcpElicitationResponse = {
        requestId: pending.request.id,
        action: "accept",
        content,
      }
      const storeEntry = findElicitationEntry(pending.request.id)
      await deliverExternalElicitation(
        storeEntry ?? {
          agentId: pending.agentId,
          chatSessionId: pending.sessionId
            ? (rows.get(rowKey(pending.agentId, pending.sessionId))?.chatSessionId ?? "")
            : "",
          request: pending.request,
        },
        response,
        { strict: true }
      )
      if (storeEntry) {
        useExternalElicitationStore.getState().remove(storeEntry.chatSessionId, pending.request.id)
      }
    } else if (pending.kind === "questions") {
      if (selections.length !== pending.questions.length) return false
      const answers: Record<string, string[]> = {}
      for (const [index, question] of pending.questions.entries()) {
        const picked = (selections[index] ?? []).map((k) => question.options[k])
        answers[question.id] = picked.filter((value): value is string => Boolean(value))
      }
      const resolved = await resolveExternalQuestion(requestId, answers)
      if (!resolved) {
        const sessionId =
          pending.sessionId ?? getExternalApprovalTarget(requestId)?.externalSessionId
        if (!sessionId) return false
        await manager.respondToPermission(pending.agentId, sessionId, {
          requestId: pending.responseRequestId,
          granted: true,
          answers,
        })
      }
    } else {
      return false
    }
    pendingDecisions.delete(requestId)
    if (pending.sessionId) {
      const row = rows.get(rowKey(pending.agentId, pending.sessionId))
      if (row) {
        row.pendingQuestions = []
        row.pendingQuestionRequest = null
        row.questionBlocking = false
        row.status = recomputeStatus(row)
      }
    }
    emit()
    return true
  } catch {
    return false
  }
}

/**
 * Decline a pending ACP question. Elicitations decline in their own protocol
 * (`action: "decline"`); async questions resolve with `granted: false`.
 */
export async function rejectAcpFleetQuestion(requestId: string): Promise<boolean> {
  const pending = pendingDecisions.get(requestId)
  if (!pending) return false
  const manager = await resolveManager()
  try {
    if (pending.kind === "elicitation") {
      const storeEntry = findElicitationEntry(pending.request.id)
      await deliverExternalElicitation(
        storeEntry ?? {
          agentId: pending.agentId,
          chatSessionId: pending.sessionId
            ? (rows.get(rowKey(pending.agentId, pending.sessionId))?.chatSessionId ?? "")
            : "",
          request: pending.request,
        },
        { requestId: pending.request.id, action: "decline" },
        { strict: true }
      )
      if (storeEntry) {
        useExternalElicitationStore.getState().remove(storeEntry.chatSessionId, pending.request.id)
      }
    } else if (pending.kind === "questions") {
      const sessionId = pending.sessionId ?? getExternalApprovalTarget(requestId)?.externalSessionId
      if (!sessionId) return false
      await manager.respondToPermission(pending.agentId, sessionId, {
        requestId: pending.responseRequestId,
        granted: false,
      })
    } else {
      return false
    }
    pendingDecisions.delete(requestId)
    if (pending.sessionId) {
      const row = rows.get(rowKey(pending.agentId, pending.sessionId))
      if (row) {
        row.pendingQuestions = []
        row.pendingQuestionRequest = null
        row.questionBlocking = false
        row.status = recomputeStatus(row)
      }
    }
    emit()
    return true
  } catch {
    return false
  }
}

/** Interrupt an ACP session's in-flight turn via the manager's cancel. */
export async function interruptAcpFleetSession(
  agentId: string,
  sessionId: string
): Promise<{ ok: boolean; reason?: string }> {
  const manager = await resolveManager().catch(() => undefined)
  if (!manager) return { ok: false, reason: "callFailed" }
  try {
    await manager.cancel(agentId, sessionId)
    return { ok: true }
  } catch {
    return { ok: false, reason: "callFailed" }
  }
}

/**
 * Send a prompt into an existing ACP session.
 *
 * `executeStreaming` is the manager's only managed prompt path — it owns the
 * canonical journal, hooks and the `executing` instance state — so this must
 * drive the generator, not just open it. The island only waits for the first
 * yielded event (proof the prompt was accepted); the rest of the turn is
 * drained in the background so manager events keep reaching every listener.
 */
export async function sendAcpFleetMessage(
  agentId: string,
  sessionId: string,
  text: string
): Promise<boolean> {
  const manager = await resolveManager().catch(() => undefined)
  if (!manager) return false
  let iterator: AsyncIterator<ExternalAgentEvent>
  try {
    iterator = manager.executeStreaming(agentId, text, { sessionId })[Symbol.asyncIterator]()
  } catch {
    return false
  }
  let first: IteratorResult<ExternalAgentEvent> | "timeout"
  try {
    first = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), ACP_SEND_CONFIRM_MS)
      ),
    ])
  } catch {
    return false
  }
  // An accepted prompt proves the session exists — materialize its row so the
  // sent text shows on the hover detail even before stream events arrive.
  const row = ensureRow(agentId, sessionId)
  row.lastPrompt = text.trim() || text
  emit()
  void (async () => {
    try {
      let result = first === "timeout" ? await iterator.next() : first
      while (!result.done) result = await iterator.next()
    } catch {
      // A mid-stream failure surfaces as the session's own error event.
    }
  })()
  return true
}
