/**
 * Router + Fusion runs from a paired phone or browser (ADR-0188 D25, B2
 * companion RPC).
 *
 * The companion side of `execution_run_*`. A run is started from the mobile
 * remote-session composer and followed in the run view:
 *
 *  - **Start** is queued (`execution_run_create` is a `MOBILE_OUTBOUND_COMMANDS`
 *    entry): the row's key is the Run API's idempotency key, so a drain
 *    retried after a lost answer replays the same run instead of starting a
 *    second one.
 *  - **Read back.** Once the queue has delivered the row, the same request
 *    under the same key answers with the run it started (API-02) — the host's
 *    idempotency cache, or the Run API's own replay behind it — so the view
 *    learns the run id without the create ever running twice.
 *  - **Follow** pages `execution_run_events` by sequence number (REC-07). A
 *    page is taken only while it continues exactly where the view stopped: a
 *    duplicate is dropped, and a gap is never stepped over. History the host
 *    no longer holds is a `410 EVENT_HISTORY_EXPIRED`, after which the view
 *    reads the snapshot and says the timeline is incomplete rather than
 *    pretending it is not.
 *  - **Stop** is `execution_run_control` (ADR-0169's one control seam), with
 *    the admin lease its `interactive` approval requires, like the cockpit.
 *
 * Loaded by the UI with a dynamic `import()` once the host advertised the
 * `router-fusion.companion` operations, so a companion whose host has the
 * switch off never loads it.
 */

import type { RouterFusionRunSummary } from "@cognia/agent-config-types"
import {
  runTimelineOf,
  type RunAccepted,
  type RunEvent,
  type RunSnapshot,
} from "@cognia/router-fusion"
import { transport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

export type CompanionRunMode = "cascade" | "panel"

/** A refusal the host answered with, in the Run API's own words. */
export interface CompanionRunError {
  code: string
  message: string
  status?: number
}

export type CompanionOutcome<T> = { ok: true; value: T } | { ok: false; error: CompanionRunError }

export interface CompanionRunIo {
  call: <T>(
    command: string,
    args: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ) => Promise<T>
  enqueue: (input: {
    command: "execution_run_create"
    payload: Record<string, unknown>
    idempotencyKey: string
    label?: string
  }) => Promise<MobileOutboundJobRow>
  issueLease: (operations: string[], ttlSeconds: number) => Promise<{ token: string }>
  newId: () => string
  sleep: (ms: number) => Promise<void>
}

export const defaultCompanionRunIo: CompanionRunIo = {
  call: (command, args, options) => transport.call(command, args, options),
  enqueue: (input) => enqueue(input),
  issueLease: (operations, ttlSeconds) => issueHostAdminLease(operations, ttlSeconds),
  newId: () => globalThis.crypto.randomUUID(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function ioOf(io: Partial<CompanionRunIo> | undefined): CompanionRunIo {
  return { ...defaultCompanionRunIo, ...io }
}

/** The host's `{ ok, value | error }` envelope, or a transport failure in the same words. */
function outcomeOf<T>(answer: unknown): CompanionOutcome<T> {
  const envelope = answer as {
    ok?: unknown
    value?: unknown
    error?: { code?: unknown; message?: unknown; status?: unknown }
  } | null
  if (envelope && envelope.ok === true) return { ok: true, value: envelope.value as T }
  const error = envelope?.error
  return {
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "ROUTER_FUSION_UNAVAILABLE",
      message: typeof error?.message === "string" ? error.message : "no answer from the host",
      ...(typeof error?.status === "number" ? { status: error.status } : {}),
    },
  }
}

function transportFailure(error: unknown): CompanionOutcome<never> {
  const code = (error as { code?: unknown } | null)?.code
  return {
    ok: false,
    error: {
      code: typeof code === "string" ? code : "TRANSPORT_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

async function callOutcome<T>(
  io: CompanionRunIo,
  command: string,
  args: Record<string, unknown>,
  options?: { idempotencyKey?: string }
): Promise<CompanionOutcome<T>> {
  try {
    return outcomeOf<T>(await io.call<unknown>(command, args, options))
  } catch (error) {
    return transportFailure(error)
  }
}

// ── starting a run ────────────────────────────────────────────────────────────

/** A run the device asked for: its queue row, and the request the view reads it back by. */
export interface PendingCompanionRun {
  rowId: string
  idempotencyKey: string
  payload: { mode: CompanionRunMode; text: string; sessionId?: string; idempotencyKey: string }
  mode: CompanionRunMode
  sessionId: string | null
  createdAt: number
}

/**
 * Queue a Cascade or Panel run for the conversation the person is looking at.
 * The row's key and the Run API's idempotency key are one value, minted here
 * once, so every retry of the row is the same request.
 */
export async function enqueueCompanionFusionRun(
  input: { sessionId: string | null; text: string; mode: CompanionRunMode; label?: string },
  io?: Partial<CompanionRunIo>
): Promise<PendingCompanionRun> {
  const resolved = ioOf(io)
  const idempotencyKey = `companion-run:${resolved.newId()}`
  const payload = {
    mode: input.mode,
    text: input.text,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    idempotencyKey,
  }
  const row = await resolved.enqueue({
    command: "execution_run_create",
    payload,
    idempotencyKey,
    ...(input.label ? { label: input.label } : {}),
  })
  return {
    rowId: row.id,
    idempotencyKey,
    payload,
    mode: input.mode,
    sessionId: input.sessionId,
    createdAt: row.createdAt,
  }
}

/**
 * The run a delivered queue row started. The same request under the same key
 * is a replay (API-02): it answers with that run and never starts another.
 */
export async function readBackCompanionFusionRun(
  pending: Pick<PendingCompanionRun, "payload" | "idempotencyKey">,
  io?: Partial<CompanionRunIo>
): Promise<CompanionOutcome<RunAccepted>> {
  const outcome = await callOutcome<{ accepted: RunAccepted }>(
    ioOf(io),
    "execution_run_create",
    pending.payload,
    { idempotencyKey: pending.idempotencyKey }
  )
  return outcome.ok ? { ok: true, value: outcome.value.accepted } : outcome
}

// ── reading a run ─────────────────────────────────────────────────────────────

export interface CompanionRunSnapshot {
  snapshot: RunSnapshot
  resultExpired: boolean
}

export function getCompanionFusionRun(
  runId: string,
  io?: Partial<CompanionRunIo>
): Promise<CompanionOutcome<CompanionRunSnapshot>> {
  return callOutcome(ioOf(io), "execution_run_get", { runId })
}

export interface CompanionEventsPage {
  events: RunEvent[]
  lastSeq: number
  terminal: boolean
}

/** Events are paged by sequence number; a page is at most this long. */
export const COMPANION_EVENTS_PAGE = 200

export function listCompanionFusionRunEvents(
  runId: string,
  afterSeq: number,
  io?: Partial<CompanionRunIo>
): Promise<CompanionOutcome<CompanionEventsPage>> {
  return callOutcome(ioOf(io), "execution_run_events", {
    runId,
    afterSeq,
    maxEvents: COMPANION_EVENTS_PAGE,
  })
}

/** More input for a run waiting for it, or a decision, at the version the device saw. */
export function resumeCompanionFusionRun(
  runId: string,
  body: Record<string, unknown>,
  io?: Partial<CompanionRunIo>
): Promise<CompanionOutcome<RunSnapshot>> {
  return callOutcome(ioOf(io), "execution_run_resume", { runId, body })
}

// ── stopping a run ────────────────────────────────────────────────────────────

export interface CompanionControlAnswer {
  accepted: boolean
  reason?: string
  code?: string
  currentRevision?: number
}

/**
 * Stop the run through `execution_run_control`. The admin lease is minted for
 * this one gesture and used at once, never ahead of it, as the cockpit does.
 */
export async function cancelCompanionFusionRun(
  runId: string,
  expectedRevision: number,
  io?: Partial<CompanionRunIo>
): Promise<CompanionControlAnswer> {
  const resolved = ioOf(io)
  try {
    const lease = await resolved.issueLease(["execution_run_control"], 120)
    const answer = await resolved.call<CompanionControlAnswer | null>("execution_run_control", {
      runId,
      action: "stop",
      idempotencyKey: `companion-run:${runId}:stop:${expectedRevision}`,
      expectedRevision,
      adminLease: lease.token,
    })
    if (answer && typeof answer.accepted === "boolean") return answer
    return { accepted: false, reason: "invalid_command" }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return {
      accepted: false,
      reason: "control_failed",
      ...(typeof code === "string" ? { code } : {}),
    }
  }
}

// ── following a run (REC-07) ──────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"])

export interface CompanionRunFollow {
  runId: string
  /** Every event from the first one the host holds, contiguous by seq. */
  events: RunEvent[]
  /** The highest seq held with nothing missing below it. */
  lastSeq: number
  terminal: boolean
  snapshot: RunSnapshot | null
  resultExpired: boolean
  /** The host no longer holds part of this run's history: the timeline is incomplete. */
  historyExpired: boolean
  error: CompanionRunError | null
}

export function emptyCompanionRunFollow(runId: string): CompanionRunFollow {
  return {
    runId,
    events: [],
    lastSeq: 0,
    terminal: false,
    snapshot: null,
    resultExpired: false,
    historyExpired: false,
    error: null,
  }
}

/**
 * Take one page into the view. Only the run of events that continues exactly
 * at `lastSeq + 1` is kept: a duplicate (a replayed page, an overlapping
 * retry) is dropped, and the first gap stops the page, so the next request
 * starts at the gap again. A page that stopped short is never terminal.
 */
export function applyCompanionEventsPage(
  view: CompanionRunFollow,
  page: CompanionEventsPage
): CompanionRunFollow {
  const events = [...view.events]
  let lastSeq = view.lastSeq
  let gap = false
  for (const event of [...page.events].sort((a, b) => a.seq - b.seq)) {
    if (event.run_id !== view.runId) continue
    if (event.seq <= lastSeq) continue
    if (event.seq !== lastSeq + 1) {
      gap = true
      break
    }
    events.push(event)
    lastSeq = event.seq
  }
  return {
    ...view,
    events,
    lastSeq,
    terminal: !gap && page.terminal && lastSeq >= page.lastSeq,
  }
}

export interface FollowOptions {
  /** Called after every change to the view. */
  onUpdate: (view: CompanionRunFollow) => void
  signal?: AbortSignal
  /** Between polls while the run is caught up. */
  intervalMs?: number
  /** The longest wait after repeated transport failures. */
  maxBackoffMs?: number
  io?: Partial<CompanionRunIo>
}

/** Refusals no retry can change: the view stops and says why. */
const FINAL_REFUSALS = new Set([
  "ROUTER_FUSION_DISABLED",
  "RUN_NOT_FOUND",
  "COMPANION_ACTOR_REQUIRED",
  "SCOPE_REQUIRED",
  "SCHEMA_INVALID",
])

/**
 * Follow a run until it is terminal, polling its events by seq. Resolves with
 * the final view; an abort resolves with the view as it stood.
 */
export async function followCompanionFusionRun(
  runId: string,
  options: FollowOptions
): Promise<CompanionRunFollow> {
  const io = ioOf(options.io)
  const interval = options.intervalMs ?? 1_000
  const maxBackoff = options.maxBackoffMs ?? 8_000
  let view = emptyCompanionRunFollow(runId)
  let failures = 0
  const aborted = () => options.signal?.aborted === true
  const publish = (next: CompanionRunFollow) => {
    view = next
    options.onUpdate(view)
  }
  const readSnapshot = async (): Promise<boolean> => {
    const read = await getCompanionFusionRun(runId, io)
    if (!read.ok) {
      if (FINAL_REFUSALS.has(read.error.code)) {
        publish({ ...view, error: read.error, terminal: true })
        return true
      }
      return false
    }
    publish({
      ...view,
      snapshot: read.value.snapshot,
      resultExpired: read.value.resultExpired,
      error: null,
    })
    return true
  }

  await readSnapshot()
  while (!aborted() && !view.terminal) {
    if (view.historyExpired) {
      // Nothing after the gap can be read in order, so nothing after it is
      // read at all: the snapshot is the truth now, until the run ends.
      if (await readSnapshot()) {
        const status = view.snapshot?.status
        if (status && TERMINAL_STATUSES.has(status)) {
          publish({ ...view, terminal: true })
          break
        }
      }
      await io.sleep(interval)
      continue
    }
    const page = await listCompanionFusionRunEvents(runId, view.lastSeq, io)
    if (aborted()) break
    if (!page.ok) {
      if (page.error.code === "EVENT_HISTORY_EXPIRED") {
        publish({ ...view, historyExpired: true })
        continue
      }
      if (FINAL_REFUSALS.has(page.error.code)) {
        publish({ ...view, error: page.error, terminal: true })
        break
      }
      // Offline, a reconnecting transport, a busy host: wait longer each time,
      // and read again from the same seq. Nothing is skipped while waiting.
      failures += 1
      publish({ ...view, error: page.error })
      await io.sleep(Math.min(maxBackoff, interval * 2 ** Math.min(failures, 4)))
      continue
    }
    failures = 0
    const before = view.lastSeq
    const next = applyCompanionEventsPage({ ...view, error: null }, page.value)
    publish(next)
    if (next.terminal) {
      await readSnapshot()
      break
    }
    // More is waiting when the page moved and the host holds beyond it.
    const behind = next.lastSeq > before && next.lastSeq < page.value.lastSeq
    if (!behind) await io.sleep(interval)
  }
  return view
}

// ── what the run view shows ───────────────────────────────────────────────────

/** A contract event back as the journal wrote it (`contractEventOf` in reverse). */
function journalEvent(event: RunEvent): {
  type: string
  payload: Record<string, unknown>
  at: number
} {
  const payload = event.payload ?? {}
  if (event.event_type === "phase.changed" && typeof payload.event === "string") {
    const { event: type, ...rest } = payload
    return { type: type as string, payload: rest, at: Date.parse(event.timestamp) }
  }
  return { type: event.event_type, payload, at: Date.parse(event.timestamp) }
}

function lastPayload(
  journal: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
  type: string
): Record<string, unknown> | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    if (journal[index].type === type) return journal[index].payload
  }
  return null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * The run as the shared `FusionRunDetails` card reads it, folded from the
 * events the view holds and the snapshot. Like the desktop's summary it holds
 * counts, reasons and money, never anything a model wrote.
 */
export function companionRunSummaryOf(view: CompanionRunFollow): RouterFusionRunSummary {
  const journal = view.events.map(journalEvent)
  const route = lastPayload(journal, "route.selected") ?? {}
  const queued = lastPayload(journal, "run.queued") ?? {}
  const billing = lastPayload(journal, "billing.updated") ?? {}
  const completed = lastPayload(journal, "answer.completed") ?? {}
  const failed = lastPayload(journal, "run.failed") ?? {}
  const snapshot = view.snapshot
  const decisionAction = snapshot?.decision?.selected_action_id ?? null
  const roles =
    route.roles && typeof route.roles === "object"
      ? Object.fromEntries(
          Object.entries(route.roles as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : {}
  const mode = route.mode ?? snapshot?.decision?.mode_selected
  const lastEventStatus = [...journal]
    .reverse()
    .find((event) =>
      ["run.completed", "run.failed", "run.cancelled", "run.expired"].includes(event.type)
    )?.type
  const statusFromEvents =
    lastEventStatus === "run.completed"
      ? "succeeded"
      : lastEventStatus
        ? lastEventStatus.slice("run.".length)
        : null
  const quality = completed.quality_status ?? snapshot?.result?.quality_status
  const errorCode =
    snapshot?.error?.code ??
    (typeof failed.code === "string" ? failed.code : null) ??
    (typeof failed.error_code === "string" ? failed.error_code : null)
  return {
    runId: view.runId,
    mode: mode === "panel" ? "panel" : "cascade",
    actionId:
      (typeof route.action_id === "string" ? route.action_id : null) ?? decisionAction ?? "",
    ruleId: typeof route.rule_id === "string" ? route.rule_id : null,
    status: snapshot?.status ?? statusFromEvents ?? (view.events.length > 0 ? "running" : "queued"),
    qualityStatus: typeof quality === "string" ? quality : null,
    roles,
    capMicrousd: snapshot?.billing.budget_cap_microusd ?? num(queued.cap_microusd) ?? 0,
    spentMicrousd: num(billing.spent_microusd) ?? snapshot?.billing.spent_microusd ?? 0,
    modelCalls: num(billing.model_calls) ?? snapshot?.billing.model_calls ?? 0,
    costStatus:
      (typeof billing.cost_status === "string" ? billing.cost_status : null) ??
      snapshot?.billing.status ??
      "pending",
    errorCode,
    timeline: runTimelineOf(journal),
  }
}

/** The verified answer, once the run succeeded and its content is still held. */
export function companionRunAnswerOf(view: CompanionRunFollow): string | null {
  const answer = view.snapshot?.result?.answer
  return typeof answer === "string" && answer.length > 0 ? answer : null
}
