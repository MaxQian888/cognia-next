/**
 * Background fan-out: Dexie `workflowRunEvents` → IM `enqueueOutbound`.
 *
 * Two render modes coexist on a per-channel basis. The choice is made at
 * watcher creation by the destination adapter's `edit()` capability:
 *
 *   **cumulative-card** (Lark / Telegram / Slack / Discord / OneBot —
 *   adapters with `adapter.edit`) — fold every event into one in-memory
 *   `CumulativeStatusState` and dispatch a SINGLE A2UI surface that the
 *   outbound runner edits in place. First event sends; subsequent events
 *   resolve the entry job's `platformMessageId` (the outbound runner
 *   persists it on `markSent`) and dispatch through
 *   `editTargetMessageId`. The chat shows ONE card that updates.
 *
 *   **append** (WeCom / wechat-personal — no native edit) — emit one
 *   markdown line per step event plus a terminal summary card. Re-sending
 *   a fresh cumulative card every event would spam those chats.
 *
 * Each run can be mirrored into N channels. The originator's channel +
 * every live `workflowFanoutSubscriptions` row for the workflow gets one
 * `ChannelState` entry on the watcher. Per-channel state isolates mode,
 * entry-job tracking, and the in-flight flush guard so a slow Lark
 * cumulative dispatch doesn't stall an append-mode WeCom mirror.
 *
 * Originator + subscriptions are deduped by `(adapterId, conversationKey)`
 * so the operator who configured "always mirror to #ops" doesn't see two
 * messages when they themselves are in #ops and trigger the run there.
 *
 * Pattern still mirrors `lib/workflow/runtime/run-status-bridge.ts` —
 * `liveQuery` watches `workflowRuns` for IM-triggered active rows and
 * subscribes to each run's `workflowRunEvents` stream. Cold-start
 * re-attaches subscriptions for non-terminal IM runs; per-run
 * `lastEmittedTs` lives in memory so a small replay window on restart is
 * the worst case (acceptable because each fan-out is idempotency-keyed
 * at the `enqueueOutbound` layer).
 */

import { liveQuery, type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { listForWorkflow as listFanoutForWorkflow } from "@/lib/db/workflow-fanout-subscriptions"
import { parseConversationKey } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getBus } from "@/lib/connectors/bus"
import type {
  RunStatus,
  WorkflowRunEventRow,
  WorkflowRunRow,
  WorkflowTriggeredFrom,
} from "@/types/workflow/visual"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import {
  buildCumulativeStatusSurface,
  buildFinalSurface,
  buildProgressSegment,
  buildWorkflowRunDeepLink,
  type CumulativeStatusState,
  type CumulativeStepEntry,
} from "./workflow-to-a2ui"
import { buildA2UISegment } from "./a2ui-to-segments"
import type { MessageSegment } from "@/types/connectors/segment"

const ACTIVE_STATUSES: ReadonlyArray<RunStatus> = ["pending", "running", "waiting", "paused"]
const TERMINAL_STATUSES: ReadonlyArray<RunStatus> = ["succeeded", "failed", "cancelled"]

/**
 * Per-channel state. One per (adapterId, conversationKey) pair on a
 * watcher. Holds the render mode + the in-place-edit tracking that goes
 * with it. The cumulative builder reads from the watcher's shared
 * step-state because the same cumulative view is rendered to every
 * cumulative channel — only the dispatch + messageId tracking is
 * per-channel.
 */
interface ChannelState {
  channelKey: string
  adapterId: string
  conversationKey: string
  mode: "cumulative" | "append"
  /** ID of the FIRST enqueue's outbound job (cumulative mode only). */
  entryJobId: string | null
  /** Cached `platformMessageId` for the entry card (cumulative mode only). */
  entryPlatformMessageId: string | null
  /** True while a cumulative flush is in flight on this channel. */
  flushing: boolean
  /** Set when a flush was attempted while another was in flight. */
  flushQueued: boolean
  /** Per-channel step-start timestamps for the append-mode duration tag. */
  appendStartedAtByStepId: Map<string, number>
  /** True once the terminal final-surface emit fired on this channel. */
  finalEmitted: boolean
}

interface RunWatcher {
  runId: string
  workflowId: string
  triggeredBy: WorkflowTriggeredFrom
  workflowName: string
  startedAt: number
  /** label map: stepId → human label, pulled from workflowSnapshot once. */
  labelByStepId: Map<string, string>
  lastEmittedTs: number
  /** Shared cumulative per-step state — same view rendered to every cumulative channel. */
  steps: Map<string, CumulativeStepEntry>
  status: "running" | "succeeded" | "failed" | "cancelled"
  terminalBody?: string
  eventsSub: Subscription | null
  finalEmitted: boolean
  /** Per-channel render state keyed by `${adapterId}::${conversationKey}`. */
  channels: Map<string, ChannelState>
}

const watchers = new Map<string, RunWatcher>()
/**
 * Outstanding `createWatcher` promises keyed by runId so two
 * `reconcileWatchers` invocations can't race-create duplicate watchers
 * (each invocation `await`s the in-flight promise instead of starting a
 * second one).
 */
const creatingWatchers = new Map<string, Promise<RunWatcher | null>>()
let runsSub: Subscription | null = null
let started = false

export interface StartWorkflowProgressRunnerOptions {
  /** Test seam — replaces the production `enqueueOutbound`. */
  enqueue?: typeof enqueueOutbound
  /**
   * Test seam — override per-adapter edit-support detection. Default
   * looks the adapter up via the bus and checks `typeof adapter.edit ===
   * "function"`. Returning `false` forces append-mode for that adapter.
   */
  adapterSupportsEdit?: (adapterId: string) => boolean
  /** Test seam — replaces the production fan-out subscription reader. */
  listSubscriptions?: typeof listFanoutForWorkflow
}

function defaultSupportsEdit(adapterId: string): boolean {
  const adapter = getBus().getAdapter(adapterId)
  return typeof adapter?.edit === "function"
}

function channelKey(adapterId: string, conversationKey: string): string {
  return `${adapterId}::${conversationKey}`
}

export function startWorkflowProgressRunner(
  opts: StartWorkflowProgressRunnerOptions = {}
): () => void {
  if (started) return stop
  started = true
  const enqueue = opts.enqueue ?? enqueueOutbound
  const supportsEdit = opts.adapterSupportsEdit ?? defaultSupportsEdit
  const listSubs = opts.listSubscriptions ?? listFanoutForWorkflow

  const runsObservable = liveQuery(async () => {
    return getDb().workflowRuns.toArray()
  })

  runsSub = runsObservable.subscribe({
    next(rows) {
      void reconcileWatchers(rows, enqueue, supportsEdit, listSubs)
    },
    error(err) {
      console.error("[workflow-progress-runner] runs subscription error", err)
    },
  })

  return stop
}

function stop(): void {
  for (const watcher of watchers.values()) {
    watcher.eventsSub?.unsubscribe()
  }
  watchers.clear()
  // In-flight createWatcher promises check `started` after they resolve;
  // clearing the map is belt-and-braces so the post-await `set` is a
  // no-op (still set, but immediately dropped on the next reconcile).
  creatingWatchers.clear()
  runsSub?.unsubscribe()
  runsSub = null
  started = false
}

async function reconcileWatchers(
  rows: WorkflowRunRow[],
  enqueue: typeof enqueueOutbound,
  supportsEdit: (adapterId: string) => boolean,
  listSubs: typeof listFanoutForWorkflow
): Promise<void> {
  const seen = new Set<string>()
  for (const row of rows) {
    const tb = row.triggeredBy
    if (!tb || tb.source !== "im") continue
    if (!tb.adapterId || !tb.conversationKey) continue
    seen.add(row.id)

    let watcher = watchers.get(row.id)
    if (!watcher) {
      // Dedup concurrent reconciles racing to create the same watcher
      // (createWatcher is async because it reads the fan-out
      // subscription table). The second caller awaits the first
      // caller's promise rather than starting a second createWatcher.
      let creating = creatingWatchers.get(row.id)
      if (!creating) {
        creating = (async () => {
          const w = await createWatcher(row, tb, supportsEdit, listSubs)
          // The runner may have been stopped while we were awaiting
          // the subscription read. Drop the watcher on the floor in
          // that case so we don't leak a Dexie liveQuery subscription
          // onto a torn-down singleton.
          if (!started) return null
          watchers.set(row.id, w)
          subscribeRunEvents(w, enqueue)
          return w
        })().finally(() => {
          creatingWatchers.delete(row.id)
        })
        creatingWatchers.set(row.id, creating)
      }
      const created = await creating
      if (!created) continue
      watcher = created
    }

    if (TERMINAL_STATUSES.includes(row.status) && !watcher.finalEmitted) {
      watcher.finalEmitted = true
      watcher.status =
        row.status === "succeeded" ? "succeeded" : row.status === "failed" ? "failed" : "cancelled"
      watcher.terminalBody = extractTerminalBody(row)
      await emitFinal(row, watcher, enqueue)
      watcher.eventsSub?.unsubscribe()
      watchers.delete(row.id)
    }
  }

  for (const id of [...watchers.keys()]) {
    if (!seen.has(id)) {
      const w = watchers.get(id)
      w?.eventsSub?.unsubscribe()
      watchers.delete(id)
    }
  }
}

async function createWatcher(
  row: WorkflowRunRow,
  triggeredBy: WorkflowTriggeredFrom,
  supportsEdit: (adapterId: string) => boolean,
  listSubs: typeof listFanoutForWorkflow
): Promise<RunWatcher> {
  const labelByStepId = new Map<string, string>()
  const snapshot = row.workflowSnapshot
  if (snapshot && Array.isArray(snapshot.nodes)) {
    for (const node of snapshot.nodes) {
      if (node && typeof node === "object" && typeof node.id === "string") {
        const label =
          typeof node.data?.label === "string" && node.data.label.length > 0
            ? node.data.label
            : node.id
        labelByStepId.set(node.id, label)
      }
    }
  }

  const channels = new Map<string, ChannelState>()

  function addChannel(adapterId: string, conversationKey: string): void {
    const key = channelKey(adapterId, conversationKey)
    if (channels.has(key)) return
    channels.set(key, {
      channelKey: key,
      adapterId,
      conversationKey,
      mode: supportsEdit(adapterId) ? "cumulative" : "append",
      entryJobId: null,
      entryPlatformMessageId: null,
      flushing: false,
      flushQueued: false,
      appendStartedAtByStepId: new Map(),
      finalEmitted: false,
    })
  }

  // 1. Originator is always a channel. Inferred from triggeredBy.
  addChannel(triggeredBy.adapterId!, triggeredBy.conversationKey!)

  // 2. Live fan-out subscriptions for this workflow. The `addChannel`
  // dedup absorbs the case where the operator subscribed the channel
  // that also happens to be the originator.
  try {
    const subs = await listSubs(row.workflowId)
    for (const sub of subs) {
      addChannel(sub.adapterId, sub.conversationKey)
    }
  } catch (err) {
    console.error(`[workflow-progress-runner] listSubs failed for ${row.workflowId}`, err)
  }

  return {
    runId: row.id,
    workflowId: row.workflowId,
    triggeredBy,
    workflowName: snapshot?.name ?? "workflow",
    startedAt: row.startedAt,
    labelByStepId,
    lastEmittedTs: 0,
    steps: new Map(),
    status: "running",
    eventsSub: null,
    finalEmitted: false,
    channels,
  }
}

function subscribeRunEvents(watcher: RunWatcher, enqueue: typeof enqueueOutbound): void {
  const events$ = liveQuery(async () => {
    return getDb()
      .workflowRunEvents.where("[runId+ts]")
      .between([watcher.runId, 0], [watcher.runId, Number.POSITIVE_INFINITY])
      .toArray()
  })
  watcher.eventsSub = events$.subscribe({
    next(events) {
      void emitForAllChannels(watcher, events, enqueue)
    },
    error(err) {
      console.error(
        `[workflow-progress-runner] events subscription error for ${watcher.runId}`,
        err
      )
    },
  })
}

// ── cumulative state folding ──────────────────────────────────────────────

function foldEventIntoState(watcher: RunWatcher, ev: WorkflowRunEventRow): void {
  if (!ev.stepId) return
  const existing = watcher.steps.get(ev.stepId)
  const label = watcher.labelByStepId.get(ev.stepId) ?? ev.stepId
  switch (ev.type) {
    case "step_started": {
      const entry: CumulativeStepEntry = existing ?? {
        stepId: ev.stepId,
        label,
        status: "running",
      }
      entry.status = "running"
      entry.startedAt = ev.ts
      watcher.steps.set(ev.stepId, entry)
      break
    }
    case "step_completed": {
      const entry: CumulativeStepEntry = existing ?? {
        stepId: ev.stepId,
        label,
        status: "succeeded",
      }
      entry.status = "succeeded"
      entry.endedAt = ev.ts
      watcher.steps.set(ev.stepId, entry)
      break
    }
    case "step_failed": {
      const entry: CumulativeStepEntry = existing ?? {
        stepId: ev.stepId,
        label,
        status: "failed",
      }
      entry.status = "failed"
      entry.endedAt = ev.ts
      const payload = ev.payload as { message?: unknown } | undefined
      if (payload && typeof payload.message === "string") {
        entry.errorMessage = payload.message
      }
      watcher.steps.set(ev.stepId, entry)
      break
    }
    case "step_skipped": {
      const entry: CumulativeStepEntry = existing ?? {
        stepId: ev.stepId,
        label,
        status: "skipped",
      }
      entry.status = "skipped"
      entry.endedAt = ev.ts
      watcher.steps.set(ev.stepId, entry)
      break
    }
    default:
      break
  }
}

function buildStateSnapshot(watcher: RunWatcher): CumulativeStatusState {
  const deepLink = buildWorkflowRunDeepLink({
    id: watcher.runId,
    workflowId: watcher.workflowId,
  } as never)
  return {
    workflowId: watcher.workflowId,
    runId: watcher.runId,
    workflowName: watcher.workflowName,
    steps: Array.from(watcher.steps.values()),
    status: watcher.status,
    startedAt: watcher.startedAt,
    deepLink,
    terminalBody: watcher.terminalBody,
  }
}

// ── event router ──────────────────────────────────────────────────────────

async function emitForAllChannels(
  watcher: RunWatcher,
  events: WorkflowRunEventRow[],
  enqueue: typeof enqueueOutbound
): Promise<void> {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  // 1. Fold every new event into the shared cumulative state — applies
  //    to every cumulative channel and is cheap.
  const newEvents: WorkflowRunEventRow[] = []
  let cumulativeUpdated = false
  for (const ev of sorted) {
    if (ev.ts <= watcher.lastEmittedTs) continue
    newEvents.push(ev)
    foldEventIntoState(watcher, ev)
    cumulativeUpdated = true
  }
  if (newEvents.length === 0) return
  watcher.lastEmittedTs = newEvents[newEvents.length - 1].ts

  // 2. Per-channel dispatch.
  for (const channel of watcher.channels.values()) {
    if (channel.mode === "cumulative") {
      if (cumulativeUpdated) {
        await flushCumulativeOnChannel(watcher, channel, enqueue)
      }
    } else {
      await emitAppendOnChannel(watcher, channel, newEvents, enqueue)
    }
  }
}

// ── append mode (per-channel) ─────────────────────────────────────────────

async function emitAppendOnChannel(
  watcher: RunWatcher,
  channel: ChannelState,
  events: WorkflowRunEventRow[],
  enqueue: typeof enqueueOutbound
): Promise<void> {
  for (const ev of events) {
    if (ev.type === "step_started" && ev.stepId) {
      channel.appendStartedAtByStepId.set(ev.stepId, ev.ts)
    }
    const label = ev.stepId ? watcher.labelByStepId.get(ev.stepId) : undefined
    const segment = buildProgressSegment(ev, {
      label,
      previousStepStartedAt: ev.stepId ? channel.appendStartedAtByStepId.get(ev.stepId) : undefined,
    })
    if (!segment) continue
    await dispatch(
      watcher,
      channel,
      [segment],
      `progress:${watcher.runId}:${channel.channelKey}:${ev.id}`,
      ev.stepId ?? "",
      enqueue,
      null
    )
  }
}

// ── cumulative mode (per-channel) ─────────────────────────────────────────

async function flushCumulativeOnChannel(
  watcher: RunWatcher,
  channel: ChannelState,
  enqueue: typeof enqueueOutbound
): Promise<void> {
  if (channel.flushing) {
    channel.flushQueued = true
    return
  }
  channel.flushing = true
  try {
    const snapshot = buildStateSnapshot(watcher)
    const surface = buildCumulativeStatusSurface(snapshot)
    const surfaceId = `wf-status:${watcher.runId}:${channel.channelKey}`
    const segment = buildA2UISegment(surfaceId, surface)

    if (!channel.entryJobId) {
      const job = await dispatch(
        watcher,
        channel,
        [segment],
        `wf-status-entry:${watcher.runId}:${channel.channelKey}`,
        "",
        enqueue,
        null
      )
      if (job) channel.entryJobId = job.id
    } else {
      if (!channel.entryPlatformMessageId) {
        const entryJob = await getDb().outboundQueue.get(channel.entryJobId)
        if (entryJob?.platformMessageId) {
          channel.entryPlatformMessageId = entryJob.platformMessageId
        }
      }
      await dispatch(
        watcher,
        channel,
        [segment],
        `wf-status:${watcher.runId}:${channel.channelKey}:${watcher.lastEmittedTs}`,
        "",
        enqueue,
        channel.entryPlatformMessageId
      )
    }
  } finally {
    channel.flushing = false
    if (channel.flushQueued) {
      channel.flushQueued = false
      void Promise.resolve().then(() => flushCumulativeOnChannel(watcher, channel, enqueue))
    }
  }
}

// ── final emission (per-channel, mode-aware) ──────────────────────────────

function extractTerminalBody(row: WorkflowRunRow): string | undefined {
  if (row.status === "failed") {
    return row.error?.message ?? "Unknown error"
  }
  if (row.status === "succeeded") {
    if (row.output === undefined || row.output === null) return undefined
    if (typeof row.output === "string") return row.output
    try {
      return JSON.stringify(row.output, null, 2)
    } catch {
      return String(row.output)
    }
  }
  return undefined
}

async function emitFinal(
  row: WorkflowRunRow,
  watcher: RunWatcher,
  enqueue: typeof enqueueOutbound
): Promise<void> {
  for (const channel of watcher.channels.values()) {
    if (channel.finalEmitted) continue
    channel.finalEmitted = true
    if (channel.mode === "cumulative") {
      // Bump watcher.lastEmittedTs first so any duplicate event from a
      // late runs-row republish won't re-trigger this flush.
      watcher.lastEmittedTs = Math.max(watcher.lastEmittedTs, row.completedAt ?? Date.now())
      await flushCumulativeOnChannel(watcher, channel, enqueue)
    } else {
      const surface = buildFinalSurface({ run: row })
      const surfaceId = `wf-final:${row.id}:${channel.channelKey}`
      const segment = buildA2UISegment(surfaceId, surface)
      await dispatch(
        watcher,
        channel,
        [segment],
        `final:${row.id}:${channel.channelKey}`,
        "",
        enqueue,
        null
      )
    }
  }
}

// ── dispatch (per-channel) ────────────────────────────────────────────────

async function dispatch(
  watcher: RunWatcher,
  channel: ChannelState,
  segments: MessageSegment[],
  idempotencyKey: string,
  nodeId: string,
  enqueue: typeof enqueueOutbound,
  editTargetMessageId: string | null
): Promise<OutboundJobRow | null> {
  let platform: PlatformKind
  try {
    platform = parseConversationKey(channel.conversationKey).platform
  } catch {
    return null
  }
  try {
    const job = await enqueue({
      adapterId: channel.adapterId,
      conversationKey: channel.conversationKey,
      request: {
        conversationRef: { platform, adapterId: channel.adapterId },
        segments,
        metadata: { idempotencyKey },
        ...(editTargetMessageId ? { editTargetMessageId } : {}),
      },
      source: "workflow",
      sourceWorkflow: {
        workflowId: watcher.workflowId,
        runId: watcher.runId,
        nodeId,
      },
    })
    return job
  } catch (err) {
    console.error(
      `[workflow-progress-runner] enqueue failed for run=${watcher.runId} channel=${channel.channelKey}`,
      err
    )
    return null
  }
}

// ── test seams ────────────────────────────────────────────────────────────

export function __resetWorkflowProgressRunnerForTesting(): void {
  for (const watcher of watchers.values()) watcher.eventsSub?.unsubscribe()
  watchers.clear()
  runsSub?.unsubscribe()
  runsSub = null
  started = false
}

export { ACTIVE_STATUSES, TERMINAL_STATUSES }
