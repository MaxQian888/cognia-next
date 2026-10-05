/**
 * `SyncSpace`: one SQLite Durable Object per account space (`idFromName(spaceId)`).
 * It owns the device registry, the current epoch's envelopes and the
 * enrollment requests, and enforces protocol §4–5 on every write.
 *
 * Calls are serialized: each runs to completion before the next starts, so
 * a write validated against the head commits against the same head. Every
 * multi-row write is one `transactionSync`.
 */

import { DurableObject } from "cloudflare:workers"

import {
  DeviceProofError,
  randomBytes,
  toBase64Url,
  MAX_PENDING_REQUESTS,
  MAX_REQUESTS_PER_HOUR,
  PROTOCOL_VERSION,
  REQUEST_TTL_MS,
  RegistryError,
  bodyDigest,
  checkEnvelopeSet,
  EnvelopeError,
  expectedRecipients,
  foldRegistry,
  newRequestId,
  parseDeviceProof,
  utf8,
  validateAppend,
  verifyDeviceProof,
  type DeviceProofPayload,
  type RegistryState,
} from "@cognia/sync-protocol"

import { planAppend } from "./append"
import {
  approverView,
  expectedTranscriptHash,
  parseCreateRequest,
  parseDeny,
  parseNonce,
  pendingView,
  requireState,
  revealMatchesCommit,
} from "./enroll"
import type { Env } from "./env"
import {
  OPLOG_READONLY_BYTES,
  PULL_MAX_BATCHES,
  PULL_MAX_BYTES,
  parsePullQuery,
  planPush,
} from "./ops"
import { SyncHttpError, errorReply, reply, type SpaceReply } from "./http"
import type { RouteName } from "./routes"
import {
  OPEN_REQUEST_STATES,
  SpaceStore,
  type RequestRow,
  FINISHED_REQUEST_RETENTION_MS,
} from "./store"

/** One authenticated API call, as the Worker forwards it. */
export interface SpaceCall {
  route: RouteName
  requestId: string | null
  method: string
  /** Path and query exactly as requested (what a device proof signs). */
  path: string
  /** `?after=` of a registry read or an op pull. */
  after: string | null
  /** `?wait=` of an op pull, seconds. */
  wait?: string | null
  body: string | null
  proof: string | null
  spaceId: string
  now: number
}

export const REGISTRY_PAGE = 256
/** A socket ticket is good for one connection, within this long. */
export const TICKET_TTL_MS = 60 * 1000
/** Close code sent to a removed device's sockets. */
export const REVOKED_CLOSE_CODE = 4403

function parseJson(body: string | null): unknown {
  if (body === null || body === "")
    throw new SyncHttpError(400, "bad_request", "a JSON body is required")
  try {
    return JSON.parse(body)
  } catch {
    throw new SyncHttpError(400, "bad_request", "the body is not JSON")
  }
}

/** The device a recovery batch adds, read from the raw body before validation. */
function joiningDevice(body: unknown): { deviceId: string; signPub: string } | null {
  const entries = (body as { entries?: unknown })?.entries
  const entry = Array.isArray(entries)
    ? (entries[0] as { entry?: Record<string, unknown> })?.entry
    : undefined
  if (entry?.type !== "add-device" || entry.via !== "recovery") return null
  const device = entry.device as { deviceId?: unknown; signPub?: unknown } | undefined
  return typeof device?.deviceId === "string" && typeof device.signPub === "string"
    ? { deviceId: device.deviceId, signPub: device.signPub }
    : null
}

function proofRefusal(error: unknown): SyncHttpError {
  if (error instanceof DeviceProofError) return new SyncHttpError(401, error.code, error.message)
  throw error
}

export class SyncSpace extends DurableObject<Env> {
  private readonly store: SpaceStore
  private migrated = false
  /** The folded registry; undefined until loaded, null for an empty space. */
  private registryState: RegistryState | null | undefined
  private queue: Promise<unknown> = Promise.resolve()
  /** Pulls waiting for new ops or a registry change (in memory; a restart ends them early). */
  private readonly waiters = new Set<() => void>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new SpaceStore(ctx.storage.sql)
    // Keepalives are answered without waking a hibernated object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  private ensureSchema(): void {
    if (this.migrated) return
    this.store.migrate()
    this.migrated = true
  }

  handle(call: SpaceCall): Promise<SpaceReply> {
    if (call.route === "ops.pull") return this.pull(call)
    return this.guarded(call, () => this.dispatch(call))
  }

  /** One serialized step of a call, with errors turned into replies. */
  private guarded(call: SpaceCall, step: () => Promise<SpaceReply>): Promise<SpaceReply> {
    return this.serial(async () => {
      try {
        this.ensureSchema()
        this.bindSpace(call.spaceId)
        return await step()
      } catch (error) {
        if (error instanceof SyncHttpError) return errorReply(error)
        console.error("[sync] space call failed", call.route, error)
        return errorReply(new SyncHttpError(500, "internal_error"))
      }
    })
  }

  /** Wakes every waiting pull and tells every socket what changed. */
  private announce(
    message: { type: "ops"; lastSeq: number } | { type: "registry"; head: unknown }
  ) {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    const text = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text)
      } catch {
        // A socket closing under us is dropped by the runtime.
      }
    }
  }

  private closeSockets(deviceId: string | null, code: number, reason: string): void {
    const sockets = deviceId === null ? this.ctx.getWebSockets() : this.ctx.getWebSockets(deviceId)
    for (const socket of sockets) {
      try {
        socket.close(code, reason)
      } catch {
        // Already closed.
      }
    }
  }

  /** Deletes everything this space holds (account deletion, via `SyncAdmin`). */
  purge(): Promise<void> {
    return this.serial(async () => {
      this.closeSockets(null, 1000, "the account was deleted")
      for (const wake of this.waiters) wake()
      this.waiters.clear()
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.migrated = false
      this.registryState = undefined
    })
  }

  override alarm(): Promise<void> {
    return this.serial(async () => {
      this.ensureSchema()
      const now = Date.now()
      this.store.expireDue(now)
      this.store.deleteFinishedBefore(now - FINISHED_REQUEST_RETENTION_MS)
      await this.scheduleAlarm()
    })
  }

  private bindSpace(spaceId: string): void {
    const bound = this.store.meta("space_id")
    if (bound === null) this.store.setMeta("space_id", spaceId)
    else if (bound !== spaceId)
      throw new Error("a space object was addressed with another space id")
  }

  private async scheduleAlarm(): Promise<void> {
    const at = this.store.nextAlarmAt()
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(at)
  }

  private async state(spaceId: string): Promise<RegistryState | null> {
    if (this.registryState !== undefined) return this.registryState
    const head = this.store.head()
    if (!head) return (this.registryState = null)
    const cached = this.store.cachedState(head.hash)
    if (cached) return (this.registryState = cached)
    const folded = await foldRegistry(this.store.allElements(), { spaceId })
    this.store.cacheState(folded!.state)
    return (this.registryState = folded!.state)
  }

  private async readyState(spaceId: string): Promise<RegistryState> {
    const state = await this.state(spaceId)
    if (!state) throw new SyncHttpError(409, "space_empty", "this account has no sync devices yet")
    return state
  }

  /** Verifies the device proof against `signPubFor(deviceId)`. */
  private async proven(
    call: SpaceCall,
    signPubFor: (deviceId: string) => string | null
  ): Promise<DeviceProofPayload> {
    let parsed
    try {
      parsed = parseDeviceProof(call.proof)
    } catch (error) {
      throw proofRefusal(error)
    }
    const signPub = signPubFor(parsed.payload.deviceId)
    if (!signPub) throw new SyncHttpError(401, "device_unknown", "this device is not enrolled here")
    try {
      return await verifyDeviceProof(parsed, signPub, {
        spaceId: call.spaceId,
        method: call.method,
        path: call.path,
        bodySha256: await bodyDigest(utf8(call.body ?? "")),
        now: call.now,
      })
    } catch (error) {
      throw proofRefusal(error)
    }
  }

  /** An active device's proof; a revoked device is refused before anything is read. */
  private async activeDevice(call: SpaceCall, state: RegistryState): Promise<string> {
    const { deviceId } = await this.proven(call, (id) => state.devices[id]?.signPub ?? null)
    if (state.devices[deviceId]!.status === "revoked") {
      throw new SyncHttpError(403, "device_revoked", "this device was removed from sync")
    }
    return deviceId
  }

  private requestRow(call: SpaceCall): RequestRow {
    this.store.expireDue(call.now)
    const row = call.requestId ? this.store.request(call.requestId) : null
    if (!row) throw new SyncHttpError(404, "request_unknown", "no such enrollment request")
    return row
  }

  /** The pending device's own proof, by the key it put in its request. */
  private async pendingDevice(call: SpaceCall, row: RequestRow): Promise<void> {
    await this.proven(call, (id) => (id === row.device_id ? row.sign_pub : null))
  }

  private async dispatch(call: SpaceCall): Promise<SpaceReply> {
    switch (call.route) {
      case "space":
        return this.space(call)
      case "registry.read":
        return this.readRegistry(call)
      case "genesis":
        return this.genesis(call)
      case "registry.append":
        return this.append(call)
      case "envelopes.recovery": {
        await this.readyState(call.spaceId)
        return this.envelopeOf("recovery")
      }
      case "envelopes.self": {
        const deviceId = await this.activeDevice(call, await this.readyState(call.spaceId))
        return this.envelopeOf(deviceId)
      }
      case "requests.create":
        return this.createRequest(call)
      case "requests.list":
        return this.listRequests(call)
      case "requests.get": {
        const row = this.requestRow(call)
        await this.pendingDevice(call, row)
        return reply(pendingView(row))
      }
      case "requests.cancel":
        return this.cancelRequest(call)
      case "requests.nonce":
        return this.postNonce(call)
      case "requests.reveal":
        return this.reveal(call)
      case "requests.deny":
        return this.deny(call)
      case "ops.push":
        return this.push(call)
      case "ops.pull":
        return this.readOps(
          call,
          await this.activeDevice(call, await this.readyState(call.spaceId))
        )
      case "socket.ticket":
        return this.ticket(call)
      case "health":
        return reply({ ok: true, protocolVersion: PROTOCOL_VERSION })
    }
  }

  private async space(call: SpaceCall): Promise<SpaceReply> {
    const state = await this.state(call.spaceId)
    if (!state) return reply({ state: "empty", protocolVersion: PROTOCOL_VERSION })
    return reply({
      state: "ready",
      genesisHash: state.genesisHash,
      head: state.head,
      epoch: state.epoch,
      protocolVersion: PROTOCOL_VERSION,
    })
  }

  private readRegistry(call: SpaceCall): SpaceReply {
    const after = call.after === null || call.after === "" ? -1 : Number(call.after)
    if (
      !Number.isSafeInteger(after) ||
      after < -1 ||
      (call.after !== null && call.after !== String(after))
    ) {
      throw new SyncHttpError(400, "bad_request", "after must be an integer ≥ -1")
    }
    const rows = this.store.registry(after, REGISTRY_PAGE + 1)
    return reply({
      entries: rows.slice(0, REGISTRY_PAGE).map((row) => row.element),
      head: this.store.head(),
      more: rows.length > REGISTRY_PAGE,
    })
  }

  private envelopeOf(recipient: string): SpaceReply {
    const envelope = this.store.envelope(recipient)
    if (!envelope)
      throw new SyncHttpError(404, "envelopes_incomplete", `no envelope for ${recipient}`)
    return reply({ envelope })
  }

  private async genesis(call: SpaceCall): Promise<SpaceReply> {
    if (await this.state(call.spaceId))
      throw new SyncHttpError(409, "space_exists", "this account already has sync devices")
    const body = parseJson(call.body)
    if (
      typeof body !== "object" ||
      body === null ||
      Object.keys(body).some((key) => key !== "entry" && key !== "envelopes")
    ) {
      throw new SyncHttpError(400, "bad_request", "expected {entry, envelopes}")
    }
    const { entry, envelopes } = body as { entry?: unknown; envelopes?: unknown }
    let result
    try {
      result = await validateAppend(null, entry, call.spaceId)
    } catch (error) {
      if (error instanceof RegistryError)
        throw new SyncHttpError(400, "invalid_entry", `${error.code}: ${error.message}`)
      throw error
    }
    let list
    try {
      if (!Array.isArray(envelopes)) throw new EnvelopeError("envelopes must be an array")
      list = checkEnvelopeSet(envelopes, 1, expectedRecipients(result.state))
    } catch (error) {
      if (error instanceof EnvelopeError)
        throw new SyncHttpError(400, "envelopes_incomplete", error.message)
      throw error
    }
    this.ctx.storage.transactionSync(() => {
      this.store.appendEntry(0, result.hash, result.signed, call.now)
      this.store.replaceEnvelopes(list)
      this.store.cacheState(result.state)
    })
    this.registryState = result.state
    return reply({ head: result.state.head, epoch: result.state.epoch }, 201)
  }

  private async append(call: SpaceCall): Promise<SpaceReply> {
    const state = await this.readyState(call.spaceId)
    const body = parseJson(call.body)
    // The proof gates everything: a device joining with the recovery key is not
    // in the list yet, so its key is taken from the batch (and checked below
    // against the validated entry).
    const joining = joiningDevice(body)
    const { deviceId } = await this.proven(
      call,
      (id) => state.devices[id]?.signPub ?? (joining?.deviceId === id ? joining.signPub : null)
    )
    if (state.devices[deviceId]?.status === "revoked") {
      throw new SyncHttpError(403, "device_revoked", "this device was removed from sync")
    }
    const plan = await planAppend(state, body)
    const first = plan.entries[0]!.signed.entry
    const joined = first.type === "add-device" && first.via === "recovery" ? first.device : null
    if (
      !plan.deviceSigners.includes(deviceId) ||
      (!state.devices[deviceId] && joined?.signPub !== joining?.signPub)
    ) {
      throw new SyncHttpError(
        403,
        "bad_proof",
        "the proof must come from a device that signed the entry"
      )
    }

    let approvedRow: RequestRow | null = null
    if (plan.approval) {
      this.store.expireDue(call.now)
      const row = this.store.request(plan.approval.requestId)
      if (!row) throw new SyncHttpError(404, "request_unknown", "no such enrollment request")
      requireState(row, "revealed")
      if (row.approver_device_id !== deviceId) {
        throw new SyncHttpError(409, "request_state", "another device is approving this request")
      }
      const device = plan.approval.device
      if (
        device.deviceId !== row.device_id ||
        device.platform !== row.platform ||
        device.signPub !== row.sign_pub ||
        device.encPub !== row.enc_pub
      ) {
        throw new SyncHttpError(400, "invalid_entry", "the added device is not the one that asked")
      }
      if (plan.approval.transcriptHash !== (await expectedTranscriptHash(row, state))) {
        throw new SyncHttpError(
          400,
          "invalid_entry",
          "the approval does not match the request's transcript"
        )
      }
      approvedRow = row
    }

    this.ctx.storage.transactionSync(() => {
      const head = this.store.head()
      if (head?.hash !== state.head.hash)
        throw new SyncHttpError(409, "head_moved", "the device list changed")
      for (const entry of plan.entries)
        this.store.appendEntry(entry.seq, entry.hash, entry.signed, call.now)
      if (plan.envelopes.mode === "replace") this.store.replaceEnvelopes(plan.envelopes.list)
      else for (const envelope of plan.envelopes.list) this.store.putEnvelope(envelope)
      if (approvedRow) {
        this.store.updateRequest(approvedRow.request_id, {
          state: "approved",
          entry_seq: plan.entries[0]!.seq,
          finished_at: call.now,
        })
      }
      this.store.cacheState(plan.state)
    })
    this.registryState = plan.state
    if (approvedRow) await this.scheduleAlarm()
    for (const entry of plan.entries) {
      const appended = entry.signed.entry
      if (appended.type === "revoke-device")
        this.closeSockets(
          appended.deviceId,
          REVOKED_CLOSE_CODE,
          "this device was removed from sync"
        )
    }
    this.announce({ type: "registry", head: plan.state.head })
    return reply({ head: plan.state.head, epoch: plan.state.epoch })
  }

  private async createRequest(call: SpaceCall): Promise<SpaceReply> {
    const state = await this.readyState(call.spaceId)
    this.store.expireDue(call.now)
    if (this.store.countOpen() >= MAX_PENDING_REQUESTS) {
      throw new SyncHttpError(
        429,
        "too_many_requests",
        `at most ${MAX_PENDING_REQUESTS} devices can wait at once`
      )
    }
    if (this.store.countCreatedSince(call.now - 60 * 60 * 1000) >= MAX_REQUESTS_PER_HOUR) {
      throw new SyncHttpError(
        429,
        "too_many_requests",
        `at most ${MAX_REQUESTS_PER_HOUR} requests an hour`
      )
    }
    const body = await parseCreateRequest(parseJson(call.body), state)
    const open = this.store
      .requests()
      .some(
        (row) =>
          row.device_id === body.deviceId &&
          (OPEN_REQUEST_STATES as readonly string[]).includes(row.state)
      )
    if (open)
      throw new SyncHttpError(409, "request_state", "this device already has an open request")
    const row: RequestRow = {
      request_id: newRequestId(),
      device_id: body.deviceId,
      platform: body.platform,
      sign_pub: body.signPub,
      enc_pub: body.encPub,
      commit_hash: body.commit,
      names: JSON.stringify(body.names),
      state: "pending",
      created_at: call.now,
      expires_at: call.now + REQUEST_TTL_MS,
      approver_device_id: null,
      nonce_a: null,
      nonce_r: null,
      entry_seq: null,
      finished_at: null,
    }
    this.store.insertRequest(row)
    await this.scheduleAlarm()
    return reply({ requestId: row.request_id, expiresAt: row.expires_at }, 201)
  }

  private async listRequests(call: SpaceCall): Promise<SpaceReply> {
    const deviceId = await this.activeDevice(call, await this.readyState(call.spaceId))
    this.store.expireDue(call.now)
    return reply({ requests: this.store.requests().map((row) => approverView(row, deviceId)) })
  }

  private async postNonce(call: SpaceCall): Promise<SpaceReply> {
    const deviceId = await this.activeDevice(call, await this.readyState(call.spaceId))
    const row = this.requestRow(call)
    const nonceA = parseNonce(parseJson(call.body), "nonceA")
    requireState(row, "pending")
    this.store.updateRequest(row.request_id, {
      state: "nonce_set",
      approver_device_id: deviceId,
      nonce_a: nonceA,
    })
    return reply({ state: "nonce_set" })
  }

  private async reveal(call: SpaceCall): Promise<SpaceReply> {
    const row = this.requestRow(call)
    await this.pendingDevice(call, row)
    const nonceR = parseNonce(parseJson(call.body), "nonceR")
    requireState(row, "nonce_set")
    if (!(await revealMatchesCommit(nonceR, row))) {
      throw new SyncHttpError(
        400,
        "bad_request",
        "the revealed nonce does not match the commitment"
      )
    }
    this.store.updateRequest(row.request_id, { state: "revealed", nonce_r: nonceR })
    return reply({ state: "revealed" })
  }

  private async cancelRequest(call: SpaceCall): Promise<SpaceReply> {
    const row = this.requestRow(call)
    await this.pendingDevice(call, row)
    requireState(row, ...OPEN_REQUEST_STATES)
    this.store.updateRequest(row.request_id, { state: "cancelled", finished_at: call.now })
    await this.scheduleAlarm()
    return reply({ state: "cancelled" })
  }

  private async deny(call: SpaceCall): Promise<SpaceReply> {
    const deviceId = await this.activeDevice(call, await this.readyState(call.spaceId))
    const row = this.requestRow(call)
    const reason = parseDeny(parseJson(call.body))
    if (reason === "mismatch") {
      requireState(row, "revealed")
    } else {
      requireState(row, ...OPEN_REQUEST_STATES)
    }
    if (row.state !== "pending" && row.approver_device_id !== deviceId) {
      throw new SyncHttpError(409, "request_state", "another device is approving this request")
    }
    this.store.updateRequest(row.request_id, { state: reason, finished_at: call.now })
    await this.scheduleAlarm()
    return reply({ state: reason })
  }

  private async push(call: SpaceCall): Promise<SpaceReply> {
    const state = await this.readyState(call.spaceId)
    const deviceId = await this.activeDevice(call, state)
    if (this.store.oplogBytes() > OPLOG_READONLY_BYTES) {
      throw new SyncHttpError(413, "quota_readonly", "this account's sync storage is full")
    }
    const plan = await planPush({
      state,
      spaceId: call.spaceId,
      deviceId,
      lastDeviceSeq: this.store.lastDeviceSeq(deviceId),
      body: parseJson(call.body),
    })
    if (plan.ops.length === 0)
      return reply({ deviceSeq: plan.lastDeviceSeq, firstSeq: null, lastSeq: null })
    const stored = this.ctx.storage.transactionSync(() =>
      this.store.appendOps(deviceId, plan.ops, plan.lastDeviceSeq, call.now)
    )
    this.announce({ type: "ops", lastSeq: stored.lastSeq })
    return reply({
      deviceSeq: plan.lastDeviceSeq,
      firstSeq: stored.firstSeq,
      lastSeq: stored.lastSeq,
    })
  }

  /**
   * A pull reads inside the queue, and waits (if asked to and nothing is new)
   * outside it, so a waiting pull never holds up any other call.
   */
  private async pull(call: SpaceCall): Promise<SpaceReply> {
    let waitS = 0
    let deviceId = ""
    const first = await this.guarded(call, async () => {
      const state = await this.readyState(call.spaceId)
      deviceId = await this.activeDevice(call, state)
      waitS = parsePullQuery(call.after, call.wait ?? null).waitS
      return this.readOps(call, deviceId)
    })
    const body = first.body as { batches?: unknown[] }
    if (first.status !== 200 || waitS === 0 || (body.batches?.length ?? 0) > 0) return first
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, waitS * 1000)
      this.waiters.add(wake)
    })
    return this.guarded(call, async () => {
      const state = await this.readyState(call.spaceId)
      if (state.devices[deviceId]?.status !== "active")
        throw new SyncHttpError(403, "device_revoked", "this device was removed from sync")
      return this.readOps({ ...call, now: Date.now() }, deviceId)
    })
  }

  private readOps(call: SpaceCall, deviceId: string): SpaceReply {
    const { after } = parsePullQuery(call.after, call.wait ?? null)
    const { batches, more } = this.store.opsAfter(after, PULL_MAX_BYTES, PULL_MAX_BATCHES)
    this.store.recordAck(deviceId, after, call.now)
    return reply({
      batches,
      more,
      lastSeq: this.store.lastServerSeq(),
      registryHead: this.store.head(),
    })
  }

  private async ticket(call: SpaceCall): Promise<SpaceReply> {
    const deviceId = await this.activeDevice(call, await this.readyState(call.spaceId))
    const ticket = toBase64Url(randomBytes(32))
    const expiresAt = call.now + TICKET_TTL_MS
    this.store.issueTicket(ticket, deviceId, expiresAt, call.now)
    return reply({ ticket, expiresAt }, 201)
  }

  /** `GET /v1/socket?space=&ticket=` (protocol §6), forwarded by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return Response.json(
        { error: "bad_request", message: "expected a WebSocket" },
        { status: 426 }
      )
    const url = new URL(request.url)
    const spaceId = url.searchParams.get("space") ?? ""
    const ticket = url.searchParams.get("ticket") ?? ""
    const refused = (status: number, error: string, message: string) =>
      Response.json({ error, message }, { status })
    return this.serial(async () => {
      this.ensureSchema()
      if (this.store.meta("space_id") !== spaceId)
        return refused(401, "bad_ticket", "no such socket ticket")
      const deviceId = this.store.takeTicket(ticket, Date.now())
      if (!deviceId) return refused(401, "bad_ticket", "no such socket ticket")
      const state = await this.state(spaceId)
      if (state?.devices[deviceId]?.status !== "active")
        return refused(403, "device_revoked", "this device was removed from sync")
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      this.ctx.acceptWebSocket(server, [deviceId])
      server.send(
        JSON.stringify({
          type: "hello",
          lastSeq: this.store.lastServerSeq(),
          registryHead: state.head,
        })
      )
      return new Response(null, { status: 101, webSocket: client })
    })
  }

  /** Clients only send keepalives, answered by the auto-response; anything else is ignored. */
  override webSocketMessage(): void {}

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
