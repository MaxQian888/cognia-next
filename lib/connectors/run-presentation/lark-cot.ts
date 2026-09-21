/**
 * Feishu/Lark native chain-of-thought support (`im/v1/message_cot`) for the
 * run presentation driver.
 *
 * A COT message is a standalone IM message whose body renders an AG-UI event
 * stream as the process timeline. The driver creates it right before the
 * CardKit card so the process sits above the status card in the chat, then
 * keeps writing snapshot diffs into it until the run terminates.
 *
 * Two halves, both pure/injectable so tests never touch the network:
 *
 * - `projectLarkCotEvents` — a stateful diff over successive
 *   `RunProjectionSnapshot`s. The state is plain JSON so the driver can
 *   persist it inside `ref.opaqueState` between mutations and stay correct
 *   across crashes and retries.
 * - `createLarkCotClient` — the I/O wrapper over the driver's request
 *   function: create / batched write (≤50 events, ≥65ms apart, one retry)
 *   / complete.
 *
 * PII boundary: every emitted string comes from
 * `runActivitiesForPresentation` (already sanitized), sanitized step titles,
 * or fixed i18n strings. Raw tool args, raw errors, and reasoning text never
 * cross into a COT event — `TOOL_CALL_ARGS` is deliberately never sent (it is
 * invisible to clients anyway) and the failed-tool RESULT is a fixed label.
 */
import { runActivitiesForPresentation } from "@/lib/connectors/activity/activity-to-a2ui"
import type { ActivityI18n } from "@/lib/connectors/activity/i18n"
import { safeStableActivityId, sanitizeActivityLabel } from "@/lib/execution/run-activity"
import type { RunActivityCategory, RunProjectionSnapshot } from "@/types/execution/run"
import type { LarkRunRequest } from "./lark-driver"

export interface LarkCotEvent {
  event_type: string
  /** JSON string; the API caps it at 4096 characters. */
  content: string
  /** Milliseconds; must be strictly increasing within one COT. */
  timestamp: number
}

/**
 * The diff state between two snapshots. Persisted verbatim in
 * `ref.opaqueState.cot.projection`, so every field stays JSON-safe.
 */
export interface LarkCotProjectionState {
  version: 1
  /** RUN_STARTED has been emitted. */
  started: boolean
  /** Last emitted timestamp; events must be strictly increasing. */
  lastTimestamp: number
  /** The `reasoning` container block has been opened. */
  reasoningStarted: boolean
  /** Running counter behind `reasoning_N` segment message ids. */
  reasoningSequence: number
  /** The currently open narrative segment, if any. */
  openReasoning?: { sourceId: string; messageId: string; label: string }
  /** Activity ids with a TOOL_CALL_START not yet closed by TOOL_CALL_END. */
  openTools: string[]
  /** stepId → stepName for STEP_STARTED rows not yet STEP_FINISHED. */
  openSteps: Record<string, string>
  /** Ids fully emitted; never re-emit them when they linger in the window. */
  settled: string[]
  /** Pending interrupt currently represented by a `waiting:` step. */
  waitingInterruptId?: string
  /** Terminal events emitted; the projector is a no-op afterwards. */
  finished: boolean
}

export function createLarkCotProjectionState(): LarkCotProjectionState {
  return {
    version: 1,
    started: false,
    lastTimestamp: 0,
    reasoningStarted: false,
    reasoningSequence: 0,
    openTools: [],
    openSteps: {},
    settled: [],
    finished: false,
  }
}

/**
 * Validate a persisted projection before the driver trusts it for a diff.
 * Anything short of the full shape degrades to a disabled COT — replaying a
 * corrupt state would emit duplicate or out-of-order rows.
 */
export function isLarkCotProjectionState(value: unknown): value is LarkCotProjectionState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<LarkCotProjectionState>
  const open = state.openReasoning
  return (
    state.version === 1 &&
    typeof state.started === "boolean" &&
    typeof state.lastTimestamp === "number" &&
    Number.isFinite(state.lastTimestamp) &&
    typeof state.reasoningStarted === "boolean" &&
    typeof state.reasoningSequence === "number" &&
    Number.isSafeInteger(state.reasoningSequence) &&
    (open === undefined ||
      (!!open &&
        typeof open === "object" &&
        typeof open.sourceId === "string" &&
        typeof open.messageId === "string" &&
        typeof open.label === "string")) &&
    Array.isArray(state.openTools) &&
    state.openTools.every((id) => typeof id === "string") &&
    !!state.openSteps &&
    typeof state.openSteps === "object" &&
    !Array.isArray(state.openSteps) &&
    Object.values(state.openSteps).every((name) => typeof name === "string") &&
    Array.isArray(state.settled) &&
    state.settled.every((id) => typeof id === "string") &&
    (state.waitingInterruptId === undefined || typeof state.waitingInterruptId === "string") &&
    typeof state.finished === "boolean"
  )
}

const MAX_CONTENT_LENGTH = 4_096
const MAX_TEXT_FIELD_LENGTH = 4_000
/** Free-text fields the API renders verbatim; everything else is an id or enum. */
const TEXT_FIELDS = ["delta", "title", "stepName", "text"] as const

function stringifyCotContent(content: Record<string, unknown>): string {
  const safe: Record<string, unknown> = { ...content }
  for (const key of TEXT_FIELDS) {
    const value = safe[key]
    if (typeof value === "string" && value.length > MAX_TEXT_FIELD_LENGTH) {
      safe[key] = `${value.slice(0, MAX_TEXT_FIELD_LENGTH - 1)}…`
    }
  }
  let json = JSON.stringify(safe)
  // A 4000-char field plus keys/escapes can still exceed the 4096 envelope —
  // shave the longest string field until the payload fits.
  while (json.length > MAX_CONTENT_LENGTH) {
    let key: string | undefined
    let length = 0
    for (const [name, value] of Object.entries(safe)) {
      if (typeof value === "string" && value.length > length) {
        key = name
        length = value.length
      }
    }
    if (!key) break
    safe[key] = (safe[key] as string).slice(
      0,
      Math.max(0, length - (json.length - MAX_CONTENT_LENGTH) - 8)
    )
    json = JSON.stringify(safe)
  }
  return json
}

/** Activity category → the nine TOOL_CALL_START icon enum values. */
const COT_TOOL_ICON: Record<RunActivityCategory, string> = {
  search: "search",
  read: "read",
  write: "write",
  command: "bash",
  integration: "default",
  skill: "doc",
  artifact: "doc",
  approval: "task",
  status: "default",
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"])
const STEP_CLOSED_STATUSES = new Set(["completed", "failed", "skipped"])
const TOOL_CLOSED_STATUSES = new Set(["completed", "failed", "skipped", "blocked"])

/**
 * Project one snapshot into the incremental COT events since `state`.
 *
 * Choreography mirrors the proven timeline writer: narrative status rows
 * become numbered REASONING segments (fresh `reasoning_N` per source so text
 * interleaves with tool rows instead of aggregating into one block), tools
 * become START/END rows with a RESULT row only on failure, durable steps and
 * pending interrupts become STEP rows, and a terminal status closes every
 * open row before RUN_FINISHED / RUN_ERROR. `parentMessageId` is never sent —
 * it has no layout effect on the client.
 *
 * Pure and deterministic: same (state, snapshot, i18n, now) → same events,
 * which is what lets the driver re-derive a diff after a failed write.
 */
export function projectLarkCotEvents(
  state: LarkCotProjectionState,
  snapshot: RunProjectionSnapshot,
  i18n: ActivityI18n,
  now: number
): { events: LarkCotEvent[]; state: LarkCotProjectionState; terminalReason?: "done" | "error" } {
  if (state.finished) return { events: [], state }
  const events: LarkCotEvent[] = []
  // Clone-on-write: `next` stays === `state` until something actually changes,
  // so callers can tell "no diff" apart from "diff written" by identity.
  let next = state
  const edit = (): LarkCotProjectionState => {
    if (next === state) {
      next = {
        ...state,
        openTools: [...state.openTools],
        openSteps: { ...state.openSteps },
        settled: [...state.settled],
      }
    }
    return next
  }
  const push = (eventType: string, content: Record<string, unknown>): void => {
    const working = edit()
    const timestamp = Math.max(now, working.lastTimestamp + 1)
    working.lastTimestamp = timestamp
    events.push({ event_type: eventType, content: stringifyCotContent(content), timestamp })
  }
  const settle = (id: string): void => {
    const working = edit()
    if (!working.settled.includes(id)) working.settled.push(id)
  }
  const closeReasoning = (): void => {
    const open = next.openReasoning
    if (!open) return
    push("REASONING_MESSAGE_END", { messageId: open.messageId })
    edit().openReasoning = undefined
  }
  const finishStep = (stepId: string): void => {
    const stepName = next.openSteps[stepId]
    if (stepName === undefined) return
    push("STEP_FINISHED", { stepId, stepName })
    delete edit().openSteps[stepId]
  }
  const endTool = (toolCallId: string): void => {
    if (!next.openTools.includes(toolCallId)) return
    push("TOOL_CALL_END", { toolCallId })
    edit().openTools = next.openTools.filter((id) => id !== toolCallId)
  }

  if (!next.started) {
    push("RUN_STARTED", { threadId: snapshot.runId, runId: snapshot.runId })
    edit().started = true
  }

  const activities = runActivitiesForPresentation(snapshot)
  const activityIds = new Set(activities.map((activity) => activity.id))

  for (const activity of activities) {
    if (next.settled.includes(activity.id)) continue
    if (activity.kind === "step" && activity.category === "status") {
      // Agent commentary → a reasoning segment. A segment belongs to one
      // activity (sourceId); a different source closes the previous segment
      // so rows interleave instead of aggregating into a single block.
      if (!next.reasoningStarted) {
        push("REASONING_START", { messageId: "reasoning" })
        edit().reasoningStarted = true
      }
      const open = next.openReasoning
      if (!open || open.sourceId !== activity.id) {
        closeReasoning()
        const sequence = edit().reasoningSequence + 1
        edit().reasoningSequence = sequence
        const messageId = `reasoning_${sequence}`
        push("REASONING_MESSAGE_START", { messageId, role: "reasoning" })
        push("REASONING_MESSAGE_CONTENT", { messageId, delta: activity.label })
        edit().openReasoning = { sourceId: activity.id, messageId, label: activity.label }
      } else if (activity.label !== open.label) {
        // Streaming growth sends just the suffix; a rewritten label starts a
        // new visual line inside the same segment.
        const delta = activity.label.startsWith(open.label)
          ? activity.label.slice(open.label.length)
          : `\n${activity.label}`
        push("REASONING_MESSAGE_CONTENT", { messageId: open.messageId, delta })
        edit().openReasoning = { ...open, label: activity.label }
      }
      if (STEP_CLOSED_STATUSES.has(activity.status)) {
        closeReasoning()
        settle(activity.id)
      }
      continue
    }
    if (activity.kind === "tool") {
      // A pending activity has not started; a blocked/ended one is over.
      if (activity.status === "pending") continue
      if (!next.openTools.includes(activity.id)) {
        push("TOOL_CALL_START", {
          toolCallId: activity.id,
          toolCallName: activity.label,
          title: activity.target ? `${activity.label} · ${activity.target.label}` : activity.label,
          icon: COT_TOOL_ICON[activity.category] ?? "default",
        })
        edit().openTools.push(activity.id)
      }
      if (TOOL_CLOSED_STATUSES.has(activity.status)) {
        endTool(activity.id)
        if (activity.status === "failed") {
          // RESULT is the only row that renders under a tool line; keep it for
          // real failures. The payload is a fixed localized string, never the
          // raw error.
          push("TOOL_CALL_RESULT", {
            messageId: `result_${activity.id}`,
            toolCallId: activity.id,
            role: "tool",
            content: JSON.stringify({ type: "text", text: i18n.cotToolFailed }),
          })
        }
        settle(activity.id)
      }
      continue
    }
    if (activity.kind === "artifact") {
      // Artifact creation is instantaneous — START+FINISH renders one ✓ row.
      push("STEP_STARTED", { stepId: activity.id, stepName: activity.label })
      push("STEP_FINISHED", { stepId: activity.id, stepName: activity.label })
      settle(activity.id)
      continue
    }
    if (activity.kind === "step") {
      if (activity.status === "pending") continue
      if (!(activity.id in next.openSteps)) {
        push("STEP_STARTED", { stepId: activity.id, stepName: activity.label })
        edit().openSteps[activity.id] = activity.label
      }
      if (STEP_CLOSED_STATUSES.has(activity.status)) {
        finishStep(activity.id)
        settle(activity.id)
      }
      continue
    }
    // lifecycle + approval rows stay on the card; the COT ignores them.
  }

  // Plan milestones: in-progress durable steps with no activity row of their
  // own get a STEP row keyed `step:<id>` so the running node is visible even
  // when the rolling activity window has not produced an entry for it.
  const represented = new Set<string>()
  for (const activity of activities) {
    represented.add(activity.id)
    if (activity.id.startsWith("step:")) represented.add(activity.id.slice(5))
    if (activity.id.startsWith("legacy-step:")) represented.add(activity.id.slice(12))
  }
  for (const step of snapshot.activeSteps) {
    if (step.status !== "in_progress") continue
    if (represented.has(step.id) || represented.has(safeStableActivityId(step.id))) continue
    const stepId = `step:${safeStableActivityId(step.id)}`
    if (next.settled.includes(stepId) || stepId in next.openSteps) continue
    const stepName = sanitizeActivityLabel(step.title, "Step")
    push("STEP_STARTED", { stepId, stepName })
    edit().openSteps[stepId] = stepName
  }

  // A pending interrupt is a waiting STEP row — "任务进行中" until resolved.
  const waitingKey = snapshot.pendingInterrupt
    ? safeStableActivityId(snapshot.pendingInterrupt.id)
    : undefined
  if (next.waitingInterruptId !== waitingKey) {
    if (next.waitingInterruptId !== undefined) {
      finishStep(`waiting:${next.waitingInterruptId}`)
    }
    if (waitingKey !== undefined) {
      const stepId = `waiting:${waitingKey}`
      push("STEP_STARTED", { stepId, stepName: i18n.cotWaitingForAction })
      edit().openSteps[stepId] = i18n.cotWaitingForAction
    }
    edit().waitingInterruptId = waitingKey
  }

  // Anything still open but gone from the rolling window is treated as ended —
  // the alternative is a spinner row that never resolves.
  for (const toolCallId of [...next.openTools]) {
    if (!activityIds.has(toolCallId)) {
      endTool(toolCallId)
      settle(toolCallId)
    }
  }
  const activeStepIds = new Set(
    snapshot.activeSteps.map((step) => `step:${safeStableActivityId(step.id)}`)
  )
  for (const stepId of Object.keys(next.openSteps)) {
    if (stepId.startsWith("waiting:")) continue
    const stillPresent = stepId.startsWith("step:")
      ? activeStepIds.has(stepId) || activityIds.has(stepId)
      : activityIds.has(stepId)
    if (!stillPresent) {
      finishStep(stepId)
      settle(stepId)
    }
  }

  let terminalReason: "done" | "error" | undefined
  if (TERMINAL_RUN_STATUSES.has(snapshot.status)) {
    closeReasoning()
    for (const toolCallId of [...next.openTools]) endTool(toolCallId)
    for (const stepId of Object.keys(next.openSteps)) finishStep(stepId)
    edit().waitingInterruptId = undefined
    if (next.reasoningStarted) push("REASONING_END", { messageId: "reasoning" })
    if (snapshot.status === "failed") {
      // RUN_ERROR does not auto-complete; the driver must POST complete
      // with reason=error or the client keeps the spinner forever.
      push("RUN_ERROR", { message: i18n.runStatus("failed"), code: "RUN_FAILED" })
      terminalReason = "error"
    } else {
      // "paused" is never sent — it renders as "任务已停止", which misstates a
      // cancel; interrupted is the honest terminal word for a cancelled run.
      push("RUN_FINISHED", {
        threadId: snapshot.runId,
        runId: snapshot.runId,
        status: snapshot.status === "cancelled" ? "interrupted" : "done",
      })
      terminalReason = "done"
    }
    edit().finished = true
  }

  return { events, state: next, ...(terminalReason !== undefined ? { terminalReason } : {}) }
}

// ---------------------------------------------------------------------------
// I/O client over the driver's request function
// ---------------------------------------------------------------------------

const MAX_EVENTS_PER_WRITE = 50
/** 50/s + 1000/min rate limit → stay under it with a floor between PUTs. */
const MIN_WRITE_INTERVAL_MS = 65
const WRITE_RETRY_DELAY_MS = 300
/** message_cot 230001 = param invalid; retrying the same batch cannot help. */
const COT_PARAM_INVALID_CODE = 230001

export interface LarkCotClientOptions {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface LarkCotHandle {
  cotId: string
  messageId: string
}

function cotErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "number" ? code : undefined
}

export function createLarkCotClient(
  request: LarkRunRequest,
  options: LarkCotClientOptions = {}
): {
  create(input: { chatId: string; originMessageId?: string }): Promise<LarkCotHandle>
  write(handle: LarkCotHandle, events: LarkCotEvent[]): Promise<void>
  complete(handle: LarkCotHandle, reason: "done" | "error" | "timeout"): Promise<void>
} {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  // -Infinity keeps the very first write unthrottled; any real `now()` still
  // measures the gap since the previous request correctly.
  let lastWriteAt = Number.NEGATIVE_INFINITY

  const put = (handle: LarkCotHandle, events: LarkCotEvent[]): Promise<unknown> =>
    request("PUT", "/im/v1/message_cot", {
      cot_id: handle.cotId,
      message_id: handle.messageId,
      events,
    })

  return {
    async create({ chatId, originMessageId }) {
      const response = (await request("POST", "/im/v1/message_cot?receive_id_type=chat_id", {
        receive_id: chatId,
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
      })) as { data?: { cot_id?: string; message_id?: string } }
      const cotId = response.data?.cot_id
      const messageId = response.data?.message_id
      if (!cotId || !messageId) {
        throw new Error("Lark message_cot create response omitted cot_id/message_id")
      }
      return { cotId, messageId }
    },

    async write(handle, events) {
      for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_WRITE) {
        const chunk = events.slice(offset, offset + MAX_EVENTS_PER_WRITE)
        const waitMs = Math.max(0, MIN_WRITE_INTERVAL_MS - (now() - lastWriteAt))
        if (waitMs > 0) await sleep(waitMs)
        lastWriteAt = now()
        try {
          await put(handle, chunk)
        } catch (error) {
          if (cotErrorCode(error) === COT_PARAM_INVALID_CODE) throw error
          await sleep(WRITE_RETRY_DELAY_MS)
          lastWriteAt = now()
          await put(handle, chunk)
        }
      }
    },

    async complete(handle, reason) {
      await request(
        "POST",
        `/im/v1/message_cot/complete/${encodeURIComponent(handle.cotId)}` +
          `?message_id=${encodeURIComponent(handle.messageId)}&reason=${reason}`,
        {}
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Unsupported-probe classification + per-adapter cache
// ---------------------------------------------------------------------------

/**
 * Codes that mean the tenant/app cannot serve message_cot at all:
 * 230001 param-invalid on a well-formed probe, and the 9999166x/9999167x
 * scope & permission family (missing scope, no permission, invalid token).
 */
const COT_UNSUPPORTED_CODES = new Set([230001, 99991661, 99991663, 99991672])

/**
 * True when the failure means "this deployment does not have COT" rather than
 * a transient error — the signal the driver uses to fall back to card-only
 * presentation for the rest of the run (and the next 6 hours of runs).
 */
export function isLarkCotUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ((error as { status?: unknown }).status === 404) return true
  const code = cotErrorCode(error)
  if (code !== undefined && COT_UNSUPPORTED_CODES.has(code)) return true
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && /not\s*found|no permission|scope/i.test(message)
}

const COT_UNSUPPORTED_TTL_MS = 6 * 60 * 60 * 1_000
const unsupportedProbes = new Map<string, { reason: string; at: number }>()

/**
 * Remember that `adapterId` failed the COT probe. Keyed by adapter (not by
 * run or chat): support is a property of the app + tenant deployment, so one
 * 404 spares every later run the doomed create call.
 */
export function rememberLarkCotUnsupported(adapterId: string, reason: string, now: number): void {
  unsupportedProbes.set(adapterId, { reason, at: now })
}

export function isLarkCotKnownUnsupported(adapterId: string, now: number): boolean {
  const entry = unsupportedProbes.get(adapterId)
  if (!entry) return false
  if (now - entry.at >= COT_UNSUPPORTED_TTL_MS) {
    unsupportedProbes.delete(adapterId)
    return false
  }
  return true
}

export function __resetLarkCotSupportCacheForTesting(): void {
  unsupportedProbes.clear()
}
