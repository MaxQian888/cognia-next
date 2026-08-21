import {
  connectorsMatrixCryptoClose,
  connectorsMatrixCryptoDecryptEvent,
  connectorsMatrixCryptoEncryptEvent,
  connectorsMatrixCryptoGetMissingSessions,
  connectorsMatrixCryptoInit,
  connectorsMatrixCryptoMarkRequestSent,
  connectorsMatrixCryptoOutgoingRequests,
  connectorsMatrixCryptoReceiveSyncChanges,
  connectorsMatrixCryptoShareRoomKey,
  connectorsMatrixCryptoUpdateTrackedUsers,
  type MatrixCryptoOutgoingRequest,
} from "@/lib/connectors/tauri/commands"
import {
  countMatrixRecoveryRequired,
  deleteMatrixPendingEvent,
  listRetryableMatrixPendingEvents,
  markMatrixPendingEventFailed,
  persistMatrixPendingEncryptedEvent,
} from "@/lib/db/matrix-pending-events"
import type { MatrixSyncResponse, MatrixTimelineEvent } from "./parse"

type MatrixMethod = "GET" | "POST" | "PUT"
export type MatrixRequest = (
  method: MatrixMethod,
  path: string,
  payload?: unknown
) => Promise<Record<string, unknown>>

type RoomEncryptionState = "encrypted" | "unencrypted" | "unknown"

export interface MatrixPreparedEvent {
  eventType: string
  content: unknown
}

export interface MatrixE2EERuntimeOptions {
  adapterId: string
  userId: string
  deviceId: string
  request: MatrixRequest
  onRecoveredEvent: (roomId: string, event: MatrixTimelineEvent) => Promise<void>
  onDegraded: (reason: string) => void
  logger?: {
    warn: (message: string, fields?: Record<string, unknown>) => void
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true }
    )
  })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function retryDelay(error: unknown, attempt: number): number {
  const explicit =
    error &&
    typeof error === "object" &&
    typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number"
      ? (error as { retryAfterMs: number }).retryAfterMs
      : undefined
  return explicit ?? Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1))
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { status?: unknown }).status === 404
  )
}

function membershipFromEvent(event: MatrixTimelineEvent): string | undefined {
  const membership = event.content.membership
  return typeof membership === "string" ? membership : undefined
}

function unwrapDecryptedEvent(
  encrypted: MatrixTimelineEvent,
  response: unknown
): MatrixTimelineEvent {
  const envelope =
    response && typeof response === "object" ? (response as Record<string, unknown>) : {}
  const raw = envelope.event
  if (!raw || typeof raw !== "object") {
    throw new Error("Matrix decrypted event response is missing its nested timeline event")
  }
  const event = raw as Partial<MatrixTimelineEvent>
  if (typeof event.type !== "string" || !event.content || typeof event.content !== "object") {
    throw new Error("Matrix decrypted timeline event is invalid")
  }
  return {
    ...encrypted,
    ...event,
    event_id: event.event_id ?? encrypted.event_id,
    sender: event.sender ?? encrypted.sender,
    origin_server_ts: event.origin_server_ts ?? encrypted.origin_server_ts,
    content: event.content,
  }
}

export class MatrixE2EERuntime {
  private readonly abortController = new AbortController()
  private readonly roomEncryption = new Map<string, RoomEncryptionState>()
  private readonly roomMembers = new Map<string, Set<string>>()
  private readonly explicitRequests: MatrixCryptoOutgoingRequest[] = []
  private pumpRequested = false
  private forcePendingRetryRequested = false
  private pumpTask: Promise<void> | null = null
  private stopped = false
  private readonly cursorBlockedEventIds = new Set<string>()
  private initialized = false

  constructor(private readonly options: MatrixE2EERuntimeOptions) {}

  private request(
    method: MatrixMethod,
    path: string,
    payload?: unknown
  ): Promise<Record<string, unknown>> {
    return abortable(this.options.request(method, path, payload), this.abortController.signal)
  }

  async initialize(): Promise<void> {
    try {
      await connectorsMatrixCryptoInit({
        adapterId: this.options.adapterId,
        userId: this.options.userId,
        deviceId: this.options.deviceId,
      })
      this.initialized = true
      await this.wakePump(true)
    } catch (error) {
      await connectorsMatrixCryptoClose(this.options.adapterId).catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    this.abortController.abort()
    await this.pumpTask?.catch(() => undefined)
    if (this.initialized) await connectorsMatrixCryptoClose(this.options.adapterId)
    this.initialized = false
  }

  canAdvanceCursor(): boolean {
    return this.cursorBlockedEventIds.size === 0
  }

  async receiveSync(body: MatrixSyncResponse, hasGap: boolean): Promise<void> {
    if (this.stopped) return
    await connectorsMatrixCryptoReceiveSyncChanges({
      adapterId: this.options.adapterId,
      toDeviceEvents: body.to_device?.events ?? [],
      changedDevices: body.device_lists?.changed ?? [],
      leftDevices: body.device_lists?.left ?? [],
      oneTimeKeyCounts: body.device_one_time_keys_count ?? {},
      unusedFallbackKeys: body.unused_fallback_key_types ?? [],
      nextBatchToken: body.next_batch,
    })
    if (this.stopped) return

    const joined = body.rooms?.join ?? {}
    for (const [roomId, room] of Object.entries(joined)) {
      const hadAuthoritativeMembers = this.roomMembers.has(roomId)
      const stateEvents = [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])].filter(
        (event) => event.state_key !== undefined
      )
      for (const event of stateEvents) this.applyStateEvent(roomId, event)
      if (hasGap || !hadAuthoritativeMembers) await this.reconcileMembers(roomId)
      if (!this.roomEncryption.has(roomId)) await this.resolveRoomEncryption(roomId)
    }

    await this.wakePump((body.to_device?.events?.length ?? 0) > 0)
  }

  private applyStateEvent(roomId: string, event: MatrixTimelineEvent): void {
    if (event.type === "m.room.encryption" && event.state_key === "") {
      this.roomEncryption.set(roomId, "encrypted")
      return
    }
    if (event.type !== "m.room.member" || !event.state_key) return
    const members = this.roomMembers.get(roomId) ?? new Set<string>()
    const membership = membershipFromEvent(event)
    if (membership === "join") members.add(event.state_key)
    if (membership === "invite" || membership === "leave" || membership === "ban") {
      members.delete(event.state_key)
    }
    this.roomMembers.set(roomId, members)
  }

  private async resolveRoomEncryption(roomId: string): Promise<RoomEncryptionState> {
    try {
      await this.request(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`
      )
      this.roomEncryption.set(roomId, "encrypted")
    } catch (error) {
      if (isNotFound(error)) this.roomEncryption.set(roomId, "unencrypted")
      else this.roomEncryption.set(roomId, "unknown")
    }
    return this.roomEncryption.get(roomId) ?? "unknown"
  }

  private async reconcileMembers(roomId: string): Promise<Set<string>> {
    const response = await this.request(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
    )
    const joined = response.joined
    if (!joined || typeof joined !== "object") {
      throw new Error(`Matrix joined_members response is invalid for room ${roomId}`)
    }
    const members = new Set(Object.keys(joined as Record<string, unknown>))
    this.roomMembers.set(roomId, members)
    return members
  }

  async isRoomEncrypted(roomId: string): Promise<boolean> {
    const state = this.roomEncryption.get(roomId) ?? (await this.resolveRoomEncryption(roomId))
    if (state === "unknown") {
      throw new Error("Matrix room encryption state is unknown; refusing media upload")
    }
    return state === "encrypted"
  }

  async prepareRoomEvent(
    roomId: string,
    eventType: string,
    content: unknown
  ): Promise<MatrixPreparedEvent> {
    if (!this.initialized || this.stopped) {
      throw new Error("Matrix encryption runtime is not available")
    }
    const state = this.roomEncryption.get(roomId) ?? (await this.resolveRoomEncryption(roomId))
    if (state === "unencrypted") return { eventType, content }
    if (state === "unknown") {
      throw new Error("Matrix room encryption state is unknown; refusing plaintext send")
    }

    const members = this.roomMembers.get(roomId) ?? (await this.reconcileMembers(roomId))
    const userIds = [...members]
    await connectorsMatrixCryptoUpdateTrackedUsers({ adapterId: this.options.adapterId, userIds })
    this.enqueueExplicit(
      await connectorsMatrixCryptoGetMissingSessions({
        adapterId: this.options.adapterId,
        userIds,
      })
    )
    await this.wakePump()
    this.enqueueExplicit(
      await connectorsMatrixCryptoShareRoomKey({
        adapterId: this.options.adapterId,
        roomId,
        userIds,
      })
    )
    await this.wakePump()
    const encrypted = await connectorsMatrixCryptoEncryptEvent({
      adapterId: this.options.adapterId,
      roomId,
      eventType,
      content,
    })
    return { eventType: "m.room.encrypted", content: encrypted.content }
  }

  async decryptOrQueue(
    roomId: string,
    event: MatrixTimelineEvent
  ): Promise<MatrixTimelineEvent | null> {
    try {
      const decrypted = await this.decrypt(roomId, event)
      this.cursorBlockedEventIds.delete(event.event_id)
      return decrypted
    } catch (error) {
      const persisted = await persistMatrixPendingEncryptedEvent({
        adapterId: this.options.adapterId,
        roomId,
        event,
      })
      if (!persisted.ok) {
        this.cursorBlockedEventIds.add(event.event_id)
        this.options.onDegraded("encrypted_event_queue_full")
      } else {
        // A replayed batch can advance only after the exact event that failed
        // the capacity check is now durable. Deleting some unrelated pending
        // row is not sufficient because that would lose this raw event.
        this.cursorBlockedEventIds.delete(event.event_id)
      }
      this.options.logger?.warn("matrix:encrypted event queued for key recovery", {
        roomId,
        eventId: event.event_id,
        reason: errorMessage(error),
      })
      return null
    }
  }

  private async decrypt(roomId: string, event: MatrixTimelineEvent): Promise<MatrixTimelineEvent> {
    const response = await connectorsMatrixCryptoDecryptEvent({
      adapterId: this.options.adapterId,
      roomId,
      event,
    })
    return unwrapDecryptedEvent(event, response.event)
  }

  async retryPending(force = false): Promise<void> {
    if (!this.initialized || this.stopped) return
    const now = force ? Number.MAX_SAFE_INTEGER : Date.now()
    const rows = await listRetryableMatrixPendingEvents(this.options.adapterId, now)
    for (const row of rows) {
      if (this.stopped) return
      try {
        const decrypted = await this.decrypt(row.roomId, row.rawEvent)
        await this.options.onRecoveredEvent(row.roomId, decrypted)
        await deleteMatrixPendingEvent(row.id)
      } catch (error) {
        await markMatrixPendingEventFailed(row.id, errorMessage(error))
      }
    }
    if ((await countMatrixRecoveryRequired(this.options.adapterId)) > 0) {
      this.options.onDegraded("encrypted_event_recovery_required")
    }
  }

  private enqueueExplicit(requests: MatrixCryptoOutgoingRequest[]): void {
    const known = new Set(
      this.explicitRequests.map((request) => `${request.kind}\u0000${request.requestId}`)
    )
    for (const request of requests) {
      const key = `${request.kind}\u0000${request.requestId}`
      if (!known.has(key)) {
        known.add(key)
        this.explicitRequests.push(request)
      }
    }
  }

  wakePump(forcePendingRetry = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.pumpRequested = true
    this.forcePendingRetryRequested ||= forcePendingRetry
    if (!this.pumpTask) {
      this.pumpTask = this.drainPump()
        .then(() => {
          const force = this.forcePendingRetryRequested
          this.forcePendingRetryRequested = false
          return this.retryPending(force)
        })
        .catch((error) => {
          if (!this.stopped) {
            this.options.onDegraded("crypto_request_pump_failed")
            this.options.logger?.warn("matrix:crypto request pump failed", {
              reason: errorMessage(error),
            })
          }
          throw error
        })
        .finally(() => {
          this.pumpTask = null
          if (this.pumpRequested && !this.stopped) {
            void this.wakePump().catch(() => undefined)
          }
        })
    }
    return this.pumpTask
  }

  private async drainPump(): Promise<void> {
    while (this.pumpRequested && !this.stopped) {
      this.pumpRequested = false
      const generated = await connectorsMatrixCryptoOutgoingRequests(this.options.adapterId)
      const requests = [...this.explicitRequests.splice(0), ...generated]
      const seen = new Set<string>()
      for (const request of requests) {
        const key = `${request.kind}\u0000${request.requestId}`
        if (seen.has(key)) continue
        seen.add(key)
        await this.sendCryptoRequest(request)
      }
      if (requests.length > 0) this.pumpRequested = true
    }
  }

  private async sendCryptoRequest(request: MatrixCryptoOutgoingRequest): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= 5 && !this.stopped; attempt += 1) {
      try {
        const response = await this.request(
          request.method as MatrixMethod,
          request.path,
          request.body
        )
        await connectorsMatrixCryptoMarkRequestSent({
          adapterId: this.options.adapterId,
          requestId: request.requestId,
          kind: request.kind,
          response,
        })
        return
      } catch (error) {
        lastError = error
        if (attempt < 5) await delay(retryDelay(error, attempt), this.abortController.signal)
      }
    }
    if (this.stopped) return
    throw lastError
  }
}
