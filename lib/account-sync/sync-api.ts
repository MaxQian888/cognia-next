/**
 * The sync Worker's API (protocol §5.6), for one person's space.
 *
 * - Every call carries the person's access token.
 * - Calls that act as a device also carry `Cognia-Device-Proof`, signed by the
 *   device key over the exact method, path, body and a time corrected by the
 *   server's clock: every answer's `Cognia-Server-Time` updates the offset,
 *   and a `clock_skew` refusal is retried once with the corrected time.
 * - Answers are data to verify, never to trust: registry entries go through
 *   `foldRegistry`, envelopes through the key commitment (`registry-sync.ts`).
 */

import {
  DEVICE_PROOF_HEADER,
  SERVER_TIME_HEADER,
  utf8,
  type EpochEnvelope,
  type Op,
  type SealedName,
  type SignedEntry,
  type SyncErrorCode,
} from "@cognia/sync-protocol"

import { deviceProofHeader, type DeviceKeys } from "@/lib/account-sync/crypto"
import { createPlatformFetch } from "@/lib/network/platform-fetch"

export type SyncApiErrorCode = SyncErrorCode | "signed_out" | "network" | "server"

export class SyncApiError extends Error {
  constructor(
    readonly code: SyncApiErrorCode,
    readonly status: number,
    message: string,
    /** The error body's other fields, e.g. `expected` for `seq_gap` or `epoch` for `epoch_stale`. */
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "SyncApiError"
  }
}

/** One stored push, as a pull returns it (protocol §7.5). */
export interface OpBatchView {
  firstSeq: number
  lastSeq: number
  deviceId: string
  /** Unchecked: the applier parses and verifies each op. */
  ops: unknown[]
}

export interface PullView {
  batches: OpBatchView[]
  more: boolean
  lastSeq: number
  registryHead: { seq: number; hash: string } | null
}

export interface PushView {
  deviceSeq: number
  firstSeq: number | null
  lastSeq: number | null
}

export interface SpaceInfo {
  state: "empty" | "ready"
  genesisHash?: string
  head?: { seq: number; hash: string }
  epoch?: number
  protocolVersion: number
}

export type RequestState =
  | "pending"
  | "nonce_set"
  | "revealed"
  | "approved"
  | "denied"
  | "mismatch"
  | "cancelled"
  | "expired"

/** What the new device sees of its own request. */
export interface PendingRequestView {
  requestId: string
  state: RequestState
  expiresAt: number
  approverDeviceId: string | null
  nonceA: string | null
  entrySeq: number | null
}

/** What an enrolled device sees in its poll. */
export interface IncomingRequestView {
  requestId: string
  deviceId: string
  platform: "desktop" | "mobile" | "web"
  signPub: string
  encPub: string
  commit: string
  name: SealedName | null
  state: RequestState
  open: boolean
  createdAt: number
  expiresAt: number
  approverDeviceId: string | null
  nonceR: string | null
  entrySeq: number | null
}

export interface CreateRequestBody {
  deviceId: string
  platform: "desktop" | "mobile" | "web"
  signPub: string
  encPub: string
  commit: string
  names: SealedName[]
  pop: string
}

export interface SyncApiOptions {
  baseUrl: string
  spaceId: string
  accessToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
  now?: () => number
}

type Signer = Pick<DeviceKeys, "deviceId" | "sign">

export class SyncApi {
  private clockOffset = 0
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: SyncApiOptions) {
    this.fetchImpl = options.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
    this.now = options.now ?? Date.now
  }

  get spaceId(): string {
    return this.options.spaceId
  }

  /** Server time minus local time, from the last answer. */
  get serverClockOffset(): number {
    return this.clockOffset
  }

  /** The local clock corrected to the server's. */
  serverNow(): number {
    return this.now() + this.clockOffset
  }

  private async send<T>(
    method: string,
    path: string,
    init: { body?: unknown; device?: Signer } = {},
    retried = false
  ): Promise<T> {
    const token = await this.options.accessToken()
    if (!token) throw new SyncApiError("signed_out", 401, "the official account is not signed in")
    const body = init.body === undefined ? undefined : JSON.stringify(init.body)
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (init.device) {
      headers[DEVICE_PROOF_HEADER] = await deviceProofHeader(init.device as DeviceKeys, {
        spaceId: this.options.spaceId,
        method,
        path,
        body: body === undefined ? undefined : utf8(body),
        now: this.serverNow(),
      })
    }
    let response: Response
    try {
      response = await this.fetchImpl(new URL(path, this.options.baseUrl).href, {
        method,
        headers,
        body,
      })
    } catch (error) {
      throw new SyncApiError(
        "network",
        0,
        error instanceof Error ? error.message : "the sync service is unreachable"
      )
    }
    const serverTime = Number(response.headers.get(SERVER_TIME_HEADER))
    if (Number.isFinite(serverTime) && serverTime > 0) this.clockOffset = serverTime - this.now()
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (response.ok) return payload as T
    const code = typeof payload?.error === "string" ? (payload.error as SyncErrorCode) : undefined
    const message =
      typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`
    if (code === "clock_skew" && init.device && !retried)
      return this.send<T>(method, path, init, true)
    if (code) {
      const { error: _error, message: _message, ...details } = payload ?? {}
      throw new SyncApiError(code, response.status, message, details)
    }
    throw new SyncApiError(
      response.status >= 500 ? "server" : "bad_request",
      response.status,
      message
    )
  }

  space(): Promise<SpaceInfo> {
    return this.send("GET", "/v1/space")
  }

  /** Every registry element after `after` (all pages). */
  async registry(after = -1): Promise<unknown[]> {
    const elements: unknown[] = []
    let cursor = after
    for (;;) {
      const page = await this.send<{ entries: unknown[]; more: boolean }>(
        "GET",
        `/v1/registry${cursor >= 0 ? `?after=${cursor}` : ""}`
      )
      if (!Array.isArray(page?.entries))
        throw new SyncApiError("server", 200, "the registry answer is malformed")
      elements.push(...page.entries)
      if (!page.more || page.entries.length === 0) return elements
      cursor = after + elements.length
    }
  }

  genesis(
    entry: SignedEntry,
    envelopes: EpochEnvelope[]
  ): Promise<{ head: { seq: number; hash: string } }> {
    return this.send("POST", "/v1/space/genesis", { body: { entry, envelopes } })
  }

  append(
    device: Signer,
    entries: SignedEntry[],
    envelopes: EpochEnvelope[]
  ): Promise<{ head: { seq: number; hash: string } }> {
    return this.send("POST", "/v1/registry", { body: { entries, envelopes }, device })
  }

  async selfEnvelope(device: Signer): Promise<EpochEnvelope> {
    return (await this.send<{ envelope: EpochEnvelope }>("GET", "/v1/envelopes/self", { device }))
      .envelope
  }

  async recoveryEnvelope(): Promise<EpochEnvelope> {
    return (await this.send<{ envelope: EpochEnvelope }>("GET", "/v1/envelopes/recovery")).envelope
  }

  createRequest(body: CreateRequestBody): Promise<{ requestId: string; expiresAt: number }> {
    return this.send("POST", "/v1/enroll/requests", { body })
  }

  getRequest(device: Signer, requestId: string): Promise<PendingRequestView> {
    return this.send("GET", `/v1/enroll/requests/${requestId}`, { device })
  }

  cancelRequest(device: Signer, requestId: string): Promise<{ state: RequestState }> {
    return this.send("DELETE", `/v1/enroll/requests/${requestId}`, { device })
  }

  reveal(device: Signer, requestId: string, nonceR: string): Promise<{ state: RequestState }> {
    return this.send("POST", `/v1/enroll/requests/${requestId}/reveal`, {
      body: { nonceR },
      device,
    })
  }

  async listRequests(device: Signer): Promise<IncomingRequestView[]> {
    return (
      await this.send<{ requests: IncomingRequestView[] }>("GET", "/v1/enroll/requests", { device })
    ).requests
  }

  postNonce(device: Signer, requestId: string, nonceA: string): Promise<{ state: RequestState }> {
    return this.send("POST", `/v1/enroll/requests/${requestId}/nonce`, { body: { nonceA }, device })
  }

  deny(
    device: Signer,
    requestId: string,
    reason: "denied" | "mismatch"
  ): Promise<{ state: RequestState }> {
    return this.send("POST", `/v1/enroll/requests/${requestId}/deny`, { body: { reason }, device })
  }

  pushOps(device: Signer, ops: Op[]): Promise<PushView> {
    return this.send("POST", "/v1/ops", { body: { ops }, device })
  }

  /** Batches after `after`; with `waitS`, the server holds the answer until ops arrive or time runs out. */
  async pullOps(device: Signer, after: number, waitS = 0): Promise<PullView> {
    const query = waitS > 0 ? `?after=${after}&wait=${waitS}` : `?after=${after}`
    const view = await this.send<PullView>("GET", `/v1/ops${query}`, { device })
    if (!Array.isArray(view?.batches))
      throw new SyncApiError("server", 200, "the op log answer is malformed")
    return view
  }

  socketTicket(device: Signer): Promise<{ ticket: string; expiresAt: number }> {
    return this.send("POST", "/v1/socket/ticket", { device })
  }

  /** The live socket's address for a ticket (protocol §6). */
  socketUrl(ticket: string): string {
    const url = new URL("/v1/socket", this.options.baseUrl)
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:"
    url.searchParams.set("space", this.options.spaceId)
    url.searchParams.set("ticket", ticket)
    return url.href
  }
}
