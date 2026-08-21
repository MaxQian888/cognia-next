import type {
  AllowedHostStateIntentV1,
  HostStateActionReceiptV1,
  HostStateActionV1,
  HostStateAppliedActionV1,
  HostStateSnapshotRequestV1,
  HostStateSnapshotV1,
  HostStateStatusV1,
  HostStateSubmitRequestV1,
  HostStateSubmitResponseV1,
} from "@cognia/agent-config-types/host-state"
import {
  isHostStateActionV1,
  isHostStateAppliedActionV1,
  isHostStateSnapshotV1,
  isHostStateStatusV1,
  isHostStateSubmitResponseV1,
} from "@cognia/agent-config-types/host-state"
import {
  isAgentEventEnvelope,
  type AgentEventEnvelope,
} from "@cognia/agent-config-types/agent-execution"

import { DEV_TOKEN_HEADER, type HandoffClientDeps } from "./client"
import type { BridgeEndpoint } from "./endpoint"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { detectDesktop } from "./client"
import { sessionIndexChannel, sessionStateChannel } from "@cognia/agent-config-types/host-state"
import { stringFlag, type ParsedArgs } from "../cli/args"
import { realOutput, type OutputSink } from "../cli/output"

const HOST_STATE_BASE_PATH = "/api/dev/host-state"

export interface LocalHostStateClient {
  snapshot(request: HostStateSnapshotRequestV1): Promise<HostStateSnapshotV1>
  submit(request: HostStateSubmitRequestV1): Promise<HostStateSubmitResponseV1>
  status(request: {
    protocolVersion: 1
    accountId: string
    runtimeTargetId: string
  }): Promise<HostStateStatusV1>
  nextEvents(afterHostSeq: number, signal?: AbortSignal): Promise<HostStateAppliedActionV1[]>
  subscribe(
    afterHostSeq: number,
    onEvent: (event: HostStateAppliedActionV1) => void,
    signal: AbortSignal,
    onResyncRequired?: () => Promise<number>
  ): Promise<void>
  nextAgentEvents(signal?: AbortSignal): Promise<AgentEventEnvelope[]>
  subscribeAgentEvents(
    onEvent: (event: AgentEventEnvelope) => void,
    signal: AbortSignal
  ): Promise<void>
}

export function createLocalHostStateClient(
  endpoint: BridgeEndpoint,
  deps: Pick<HandoffClientDeps, "fetch"> = {}
): LocalHostStateClient {
  const fetcher = deps.fetch ?? fetch

  const post = async <T>(path: string, payload: unknown): Promise<T> => {
    const response = await fetcher(`${endpoint.baseUrl}${HOST_STATE_BASE_PATH}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEV_TOKEN_HEADER]: endpoint.devToken,
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`host_state_bridge_http_${response.status}`)
    const envelope = (await response.json()) as { ok?: unknown; result?: unknown; error?: unknown }
    if (envelope.ok !== true || !("result" in envelope)) {
      if (typeof envelope.error === "string") throw new Error(envelope.error)
      throw new Error("host_state_bridge_malformed")
    }
    return envelope.result as T
  }

  const nextEvents = async (
    afterHostSeq: number,
    signal?: AbortSignal
  ): Promise<HostStateAppliedActionV1[]> => {
    const response = await fetcher(
      `${endpoint.baseUrl}${HOST_STATE_BASE_PATH}/events?afterHostSeq=${afterHostSeq}`,
      {
        headers: { [DEV_TOKEN_HEADER]: endpoint.devToken },
        signal,
      }
    )
    if (!response.ok) throw new Error(`host_state_events_http_${response.status}`)
    const envelope = (await response.json()) as {
      ok?: unknown
      events?: unknown
      gap?: unknown
    }
    if (envelope.ok !== true || !Array.isArray(envelope.events)) {
      throw new Error("host_state_events_malformed")
    }
    // The Host retains only a bounded replay window; past it, resuming from the
    // cursor would silently skip actions.
    if (envelope.gap === true) throw new Error("host_state_resync_required")
    if (!envelope.events.every(isHostStateAppliedActionV1)) {
      throw new Error("host_state_events_malformed")
    }
    return envelope.events
  }

  const pollAgentEvents = async (
    afterCursor: number,
    signal?: AbortSignal
  ): Promise<{ cursor: number; events: AgentEventEnvelope[] }> => {
    const response = await fetcher(
      `${endpoint.baseUrl}${HOST_STATE_BASE_PATH}/agent-events?afterCursor=${afterCursor}`,
      {
        headers: { [DEV_TOKEN_HEADER]: endpoint.devToken },
        signal,
      }
    )
    if (!response.ok) throw new Error(`host_state_agent_events_http_${response.status}`)
    const envelope = (await response.json()) as {
      ok?: unknown
      events?: unknown
      cursor?: unknown
      gap?: unknown
    }
    if (
      envelope.ok !== true ||
      !Array.isArray(envelope.events) ||
      typeof envelope.cursor !== "number" ||
      !Number.isSafeInteger(envelope.cursor) ||
      envelope.cursor < afterCursor ||
      !envelope.events.every(isAgentEventEnvelope)
    ) {
      throw new Error("host_state_agent_events_malformed")
    }
    if (envelope.gap === true) throw new Error("host_state_agent_events_resync_required")
    return { cursor: envelope.cursor, events: envelope.events }
  }

  const nextAgentEvents = async (signal?: AbortSignal): Promise<AgentEventEnvelope[]> =>
    (await pollAgentEvents(0, signal)).events

  return {
    async snapshot(request) {
      const result = await post<unknown>("snapshot", request)
      if (!isHostStateSnapshotV1(result)) throw new Error("host_state_snapshot_malformed")
      return result
    },
    async submit(request) {
      const result = await post<unknown>("submit", request)
      if (!isHostStateSubmitResponseV1(result)) throw new Error("host_state_submit_malformed")
      return result
    },
    async status(request) {
      const result = await post<unknown>("status", request)
      if (!isHostStateStatusV1(result)) throw new Error("host_state_status_malformed")
      return result
    },
    nextEvents,
    nextAgentEvents,
    async subscribe(afterHostSeq, onEvent, signal, onResyncRequired) {
      let cursor = afterHostSeq
      while (!signal.aborted) {
        let events: HostStateAppliedActionV1[]
        try {
          events = await nextEvents(cursor, signal)
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "host_state_resync_required" &&
            onResyncRequired
          ) {
            cursor = await onResyncRequired()
            continue
          }
          throw error
        }
        for (const event of events) {
          if (event.hostSeq <= cursor) continue
          // `hostSeq` is one global counter, so the bridge stream is contiguous.
          // A jump means events were lost; resuming would silently skip actions,
          // so surface it and let the caller re-snapshot.
          if (cursor > 0 && event.hostSeq !== cursor + 1) {
            if (onResyncRequired) {
              cursor = await onResyncRequired()
              break
            }
            throw new Error("host_state_sequence_gap")
          }
          cursor = event.hostSeq
          onEvent(event)
        }
      }
    },
    async subscribeAgentEvents(onEvent, signal) {
      let cursor = 0
      while (!signal.aborted) {
        const result = await pollAgentEvents(cursor, signal)
        cursor = result.cursor
        for (const event of result.events) onEvent(event)
      }
    },
  }
}

export interface AttachedHostStateRecord {
  protocolVersion: 1
  accountId: string
  runtimeTargetId: string
  hostId: string
  hostGeneration: number
  sessionId?: string
  attachedAt: number
}

export function attachedHostStatePath(home = os.homedir()): string {
  return path.join(home, ".cognia", "attached-host.json")
}

export interface HostStateCommandDeps extends HandoffClientDeps {
  out?: OutputSink
  home?: string
  writeFile?: (file: string, value: string) => void
  readFile?: (file: string) => string | null
  removeFile?: (file: string) => void
}

export type AttachedHostStateOutboxStatus =
  "pending" | "sending" | "sent" | "rejected" | "conflicted"

export interface AttachedHostStateOutboxRow {
  action: HostStateActionV1
  status: AttachedHostStateOutboxStatus
  receipt?: HostStateActionReceiptV1
  lastError?: string
}

interface AttachedHostStateOutboxFile {
  version: 1
  clientId: string
  nextClientSeq: number
  rows: AttachedHostStateOutboxRow[]
}

export interface QueueAttachedHostStateActionOptions extends HostStateCommandDeps {
  baseRevision?: number
  now?: () => number
  randomId?: () => string
}

const MAX_ATTACHED_PENDING_ACTIONS = 1_000
const MAX_ATTACHED_SUBMIT_BATCH = 50

export function attachedHostStateOutboxPath(home = os.homedir()): string {
  return path.join(home, ".cognia", "attached-host-outbox.json")
}

export function readAttachedHostStateOutbox(
  deps: HostStateCommandDeps = {}
): AttachedHostStateOutboxRow[] {
  return readOutboxFile(deps).rows
}

/**
 * Persist an attached-TUI intent before it can affect optimistic UI. This file
 * is deliberately separate from the standalone JSONL session store.
 */
export function queueAttachedHostStateAction(
  record: AttachedHostStateRecord,
  intent: AllowedHostStateIntentV1,
  options: QueueAttachedHostStateActionOptions = {}
): HostStateActionV1 {
  if (!record.sessionId) throw new Error("attached_session_required")
  const file = readOutboxFile(options)
  const activeRows = file.rows.filter((row) => row.status === "pending" || row.status === "sending")
  if (activeRows.length >= MAX_ATTACHED_PENDING_ACTIONS) {
    throw new Error("attached_host_outbox_full")
  }
  const action: HostStateActionV1 = {
    protocolVersion: 1,
    channel: sessionStateChannel(record.runtimeTargetId, record.sessionId),
    accountId: record.accountId,
    runtimeTargetId: record.runtimeTargetId,
    hostId: record.hostId,
    hostGeneration: record.hostGeneration,
    sessionId: record.sessionId,
    clientId: file.clientId,
    clientSeq: file.nextClientSeq,
    actionId: `tui-${(options.randomId ?? randomUUID)()}`,
    ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
    createdAt: (options.now ?? Date.now)(),
    action: intent,
  }
  if (!isHostStateActionV1(action)) throw new Error("attached_host_action_invalid")
  file.nextClientSeq += 1
  file.rows.push({ action, status: "pending" })
  writeOutboxFile(file, options)
  return action
}

/**
 * Reconcile only rows bound to the current account/target/generation. Rows for
 * an old target or fenced Host stay visible and are never replayed elsewhere.
 */
export async function flushAttachedHostStateOutbox(
  connection: Pick<AttachedHostConnection, "record" | "client">,
  deps: HostStateCommandDeps = {}
): Promise<AttachedHostStateOutboxRow[]> {
  const file = readOutboxFile(deps)
  const pending = file.rows
    .filter(
      (row) =>
        (row.status === "pending" || row.status === "sending") &&
        row.action.accountId === connection.record.accountId &&
        row.action.runtimeTargetId === connection.record.runtimeTargetId &&
        row.action.hostId === connection.record.hostId &&
        row.action.hostGeneration === connection.record.hostGeneration
    )
    .sort((left, right) => left.action.clientSeq - right.action.clientSeq)
  if (pending.length === 0) return file.rows

  const status = await connection.client.status({
    protocolVersion: 1,
    accountId: connection.record.accountId,
    runtimeTargetId: connection.record.runtimeTargetId,
  })
  if (
    status.hostId !== connection.record.hostId ||
    status.hostGeneration !== connection.record.hostGeneration
  ) {
    return file.rows
  }

  for (let offset = 0; offset < pending.length; offset += MAX_ATTACHED_SUBMIT_BATCH) {
    const batch = pending.slice(offset, offset + MAX_ATTACHED_SUBMIT_BATCH)
    for (const row of batch) {
      row.status = "sending"
      delete row.lastError
    }
    writeOutboxFile(file, deps)
    let response: HostStateSubmitResponseV1
    try {
      response = await connection.client.submit({
        protocolVersion: 1,
        accountId: connection.record.accountId,
        runtimeTargetId: connection.record.runtimeTargetId,
        actions: batch.map((row) => row.action),
      })
    } catch (error) {
      for (const row of batch) {
        row.status = "pending"
        row.lastError = error instanceof Error ? error.message : String(error)
      }
      writeOutboxFile(file, deps)
      throw error
    }
    const receipts = new Map(response.results.map((receipt) => [receipt.actionId, receipt]))
    for (const row of batch) {
      const receipt = receipts.get(row.action.actionId)
      if (!receipt) {
        row.status = "pending"
        row.lastError = "host_state_receipt_missing"
        continue
      }
      row.receipt = receipt
      delete row.lastError
      row.status =
        receipt.outcome === "rejected"
          ? "rejected"
          : receipt.outcome === "conflicted"
            ? "conflicted"
            : "sent"
    }
    writeOutboxFile(file, deps)
  }
  return file.rows
}

export interface AttachLocalHostOptions {
  targetId: string
  sessionId?: string
  accountId?: string
  signal?: AbortSignal
  onHostStateEvent?: (event: HostStateAppliedActionV1) => void
  onHostStateSnapshot?: (snapshot: HostStateSnapshotV1) => void
  onAgentEvent?: (event: AgentEventEnvelope) => void
}

export interface AttachedHostConnection {
  record: AttachedHostStateRecord
  client: LocalHostStateClient
  snapshot: HostStateSnapshotV1
  subscriptions: Promise<void>[]
}

export async function attachLocalHost(
  options: AttachLocalHostOptions,
  deps: HostStateCommandDeps = {}
): Promise<AttachedHostConnection> {
  const endpoint = await detectDesktop(deps)
  if (!endpoint) throw new Error("no_running_cognia_desktop")
  const accountId = options.accountId ?? "local-default"
  const client = createLocalHostStateClient(endpoint, deps)
  const status = await client.status({
    protocolVersion: 1,
    accountId,
    runtimeTargetId: options.targetId,
  })
  const channel = options.sessionId
    ? sessionStateChannel(options.targetId, options.sessionId)
    : sessionIndexChannel(options.targetId)
  const record: AttachedHostStateRecord = {
    protocolVersion: 1,
    accountId,
    runtimeTargetId: options.targetId,
    hostId: status.hostId,
    hostGeneration: status.hostGeneration,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    attachedAt: Date.now(),
  }
  const buffered: HostStateAppliedActionV1[] = []
  let snapshotReady = false
  const subscriptions: Promise<void>[] = []
  if (options.signal && options.onHostStateEvent) {
    subscriptions.push(
      client.subscribe(
        status.hostSeq,
        (event) => {
          if (event.channel !== channel) return
          if (snapshotReady) options.onHostStateEvent?.(event)
          else buffered.push(event)
        },
        options.signal,
        async () => {
          const fresh = await client.snapshot({
            protocolVersion: 1,
            accountId,
            runtimeTargetId: options.targetId,
            channel,
          })
          record.hostId = fresh.hostId
          record.hostGeneration = fresh.hostGeneration
          ;(deps.writeFile ?? defaultWriteFile)(
            attachedHostStatePath(deps.home),
            JSON.stringify(record, null, 2)
          )
          options.onHostStateSnapshot?.(fresh)
          return fresh.cutHostSeq
        }
      )
    )
  }
  if (options.signal && options.onAgentEvent && options.sessionId) {
    subscriptions.push(client.subscribeAgentEvents(options.onAgentEvent, options.signal))
  }
  const snapshot = await client.snapshot({
    protocolVersion: 1,
    accountId,
    runtimeTargetId: options.targetId,
    channel,
  })
  record.hostId = snapshot.hostId
  record.hostGeneration = snapshot.hostGeneration
  options.onHostStateSnapshot?.(snapshot)
  snapshotReady = true
  for (const event of buffered.sort((left, right) => left.hostSeq - right.hostSeq)) {
    if (event.hostGeneration === snapshot.hostGeneration && event.hostSeq > snapshot.cutHostSeq) {
      options.onHostStateEvent?.(event)
    }
  }
  ;(deps.writeFile ?? defaultWriteFile)(
    attachedHostStatePath(deps.home),
    JSON.stringify(record, null, 2)
  )
  return { record, client, snapshot, subscriptions }
}

export function detachLocalHost(deps: HostStateCommandDeps = {}): void {
  ;(deps.removeFile ?? defaultRemoveFile)(attachedHostStatePath(deps.home))
}

export function readAttachedHost(deps: HostStateCommandDeps = {}): AttachedHostStateRecord | null {
  const raw = (deps.readFile ?? defaultReadFile)(attachedHostStatePath(deps.home))
  if (!raw) return null
  const value = JSON.parse(raw) as Partial<AttachedHostStateRecord>
  if (
    value.protocolVersion !== 1 ||
    typeof value.accountId !== "string" ||
    typeof value.runtimeTargetId !== "string" ||
    typeof value.hostId !== "string" ||
    !Number.isSafeInteger(value.hostGeneration)
  ) {
    throw new Error("attached_host_record_malformed")
  }
  return value as AttachedHostStateRecord
}

export async function attachedHostStatus(
  deps: HostStateCommandDeps = {}
): Promise<{ record: AttachedHostStateRecord; status: HostStateStatusV1 } | null> {
  const record = readAttachedHost(deps)
  if (!record) return null
  const endpoint = await detectDesktop(deps)
  if (!endpoint) throw new Error("no_running_cognia_desktop")
  const status = await createLocalHostStateClient(endpoint, deps).status({
    protocolVersion: 1,
    accountId: record.accountId,
    runtimeTargetId: record.runtimeTargetId,
  })
  return { record, status }
}

export async function attachCommand(
  args: ParsedArgs,
  deps: HostStateCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const runtimeTargetId = stringFlag(args, "target")
  const sessionId = stringFlag(args, "session")
  const accountId = stringFlag(args, "account") ?? "local-default"
  if (!runtimeTargetId) {
    out.error("attach: --target <id> is required")
    return 2
  }
  let connection: AttachedHostConnection
  try {
    connection = await attachLocalHost({ targetId: runtimeTargetId, sessionId, accountId }, deps)
  } catch (error) {
    if (error instanceof Error && error.message === "no_running_cognia_desktop") {
      out.error("attach: no running Cognia desktop found")
      return 1
    }
    throw error
  }
  out.write(
    `attached to ${runtimeTargetId}${sessionId ? ` session ${sessionId}` : ""} (generation ${connection.record.hostGeneration})\n`
  )
  return 0
}

export async function detachCommand(
  _args: ParsedArgs,
  deps: HostStateCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  detachLocalHost(deps)
  out.write("detached; standalone JSONL sessions were not modified\n")
  return 0
}

export async function syncStatusCommand(
  args: ParsedArgs,
  deps: HostStateCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  if (args.subcommand !== "status") {
    out.error("sync: usage — cognia-agent sync status")
    return 2
  }
  const record = readAttachedHost(deps)
  if (!record) {
    out.write("standalone (not attached)\n")
    return 0
  }
  let connection: Awaited<ReturnType<typeof attachedHostStatus>>
  try {
    connection = await attachedHostStatus(deps)
  } catch (error) {
    if (error instanceof Error && error.message === "no_running_cognia_desktop") {
      out.write(`attached to ${record.runtimeTargetId}, Host offline\n`)
      return 1
    }
    throw error
  }
  if (!connection) return 0
  const { status } = connection
  const scopedRows = readAttachedHostStateOutbox(deps).filter(
    (row) =>
      row.action.accountId === record.accountId &&
      row.action.runtimeTargetId === record.runtimeTargetId
  )
  const pending = scopedRows.filter(
    (row) => row.status === "pending" || row.status === "sending"
  ).length
  const terminal = scopedRows.filter(
    (row) => row.status === "rejected" || row.status === "conflicted"
  ).length
  out.write(
    `attached to ${record.runtimeTargetId}; generation ${status.hostGeneration}; hostSeq ${status.hostSeq}; local pending ${pending}; local rejected/conflicted ${terminal}; pending dispatch ${status.pendingDispatch}; pending broadcast ${status.pendingBroadcast}\n`
  )
  return 0
}

function defaultWriteFile(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  )
  try {
    fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

function defaultReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function defaultRemoveFile(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function readOutboxFile(deps: HostStateCommandDeps): AttachedHostStateOutboxFile {
  const raw = (deps.readFile ?? defaultReadFile)(attachedHostStateOutboxPath(deps.home))
  if (!raw) {
    return { version: 1, clientId: `tui-${randomUUID()}`, nextClientSeq: 1, rows: [] }
  }
  const value = JSON.parse(raw) as Partial<AttachedHostStateOutboxFile>
  if (
    value.version !== 1 ||
    typeof value.clientId !== "string" ||
    !Number.isSafeInteger(value.nextClientSeq) ||
    !Array.isArray(value.rows) ||
    !value.rows.every(isAttachedOutboxRow)
  ) {
    throw new Error("attached_host_outbox_malformed")
  }
  return value as AttachedHostStateOutboxFile
}

function isAttachedOutboxRow(value: unknown): value is AttachedHostStateOutboxRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Partial<AttachedHostStateOutboxRow>
  return (
    isHostStateActionV1(row.action) &&
    (row.status === "pending" ||
      row.status === "sending" ||
      row.status === "sent" ||
      row.status === "rejected" ||
      row.status === "conflicted")
  )
}

function writeOutboxFile(file: AttachedHostStateOutboxFile, deps: HostStateCommandDeps): void {
  ;(deps.writeFile ?? defaultWriteFile)(
    attachedHostStateOutboxPath(deps.home),
    JSON.stringify(file, null, 2)
  )
}
