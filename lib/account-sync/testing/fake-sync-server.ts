/**
 * An in-memory sync server for client tests (not shipped). It answers the
 * protocol §5.6 API for one space and enforces the same rules as
 * `services/sync-server` through `@cognia/sync-protocol`: `validateAppend`,
 * complete envelope sets, atomic recovery batches, device proofs, revoked
 * devices refused first, and the commit-then-reveal request state machine.
 *
 * It is honest. Tests play a malicious server by wrapping `fetch` and
 * rewriting answers.
 */

import {
  DEVICE_PROOF_HEADER,
  DeviceProofError,
  EnvelopeError,
  MAX_PENDING_REQUESTS,
  RECOVERY_SIGNER,
  REQUEST_TTL_MS,
  RegistryError,
  SERVER_TIME_HEADER,
  bodyDigest,
  checkEnvelopeSet,
  checkSealedNames,
  ecdsaVerify,
  enrollRequestSigningBytes,
  expectedRecipients,
  fromBase64Url,
  matchesSasCommit,
  newRequestId,
  parseDeviceProof,
  transcriptHash,
  utf8,
  validateAppend,
  verifyDeviceProof,
  type DevicePlatform,
  type EpochEnvelope,
  type RegistryState,
  type SealedName,
  type SignedEntry,
} from "@cognia/sync-protocol"

type State =
  | "pending"
  | "nonce_set"
  | "revealed"
  | "approved"
  | "denied"
  | "mismatch"
  | "cancelled"
  | "expired"
const OPEN: readonly State[] = ["pending", "nonce_set", "revealed"]

interface FakeRequest {
  requestId: string
  deviceId: string
  platform: DevicePlatform
  signPub: string
  encPub: string
  commit: string
  names: SealedName[]
  state: State
  createdAt: number
  expiresAt: number
  approverDeviceId: string | null
  nonceA: string | null
  nonceR: string | null
  entrySeq: number | null
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

export interface FakeSyncServerOptions {
  spaceId: string
  now?: () => number
}

export interface FakeSyncServer {
  fetch: typeof fetch
  readonly entries: SignedEntry[]
  readonly envelopes: Map<string, EpochEnvelope>
  readonly requests: Map<string, FakeRequest>
  state(): RegistryState | null
  /** Calls answered so far, as `METHOD path`. */
  readonly calls: string[]
}

export function createFakeSyncServer(options: FakeSyncServerOptions): FakeSyncServer {
  const now = options.now ?? Date.now
  const spaceId = options.spaceId
  const entries: SignedEntry[] = []
  const envelopes = new Map<string, EpochEnvelope>()
  const requests = new Map<string, FakeRequest>()
  const calls: string[] = []
  let state: RegistryState | null = null

  function expire(): void {
    for (const request of requests.values()) {
      if (OPEN.includes(request.state) && request.expiresAt <= now()) request.state = "expired"
    }
  }

  function ready(): RegistryState {
    if (!state) throw new Refusal(409, "space_empty")
    return state
  }

  async function proven(
    request: Request,
    body: string,
    signPubFor: (id: string) => string | null
  ): Promise<string> {
    let parsed
    try {
      parsed = parseDeviceProof(request.headers.get(DEVICE_PROOF_HEADER))
    } catch (error) {
      if (error instanceof DeviceProofError) throw new Refusal(401, error.code)
      throw error
    }
    const signPub = signPubFor(parsed.payload.deviceId)
    if (!signPub) throw new Refusal(401, "device_unknown")
    const url = new URL(request.url)
    try {
      await verifyDeviceProof(parsed, signPub, {
        spaceId,
        method: request.method,
        path: url.pathname + url.search,
        bodySha256: await bodyDigest(utf8(body)),
        now: now(),
      })
    } catch (error) {
      if (error instanceof DeviceProofError) throw new Refusal(401, error.code)
      throw error
    }
    return parsed.payload.deviceId
  }

  async function active(request: Request, body: string): Promise<string> {
    const current = ready()
    const deviceId = await proven(request, body, (id) => current.devices[id]?.signPub ?? null)
    if (current.devices[deviceId]!.status === "revoked") throw new Refusal(403, "device_revoked")
    return deviceId
  }

  function requestOf(id: string): FakeRequest {
    expire()
    const found = requests.get(id)
    if (!found) throw new Refusal(404, "request_unknown")
    return found
  }

  function inState(request: FakeRequest, ...states: State[]): void {
    if (request.state === "expired") throw new Refusal(410, "request_expired")
    if (!states.includes(request.state)) throw new Refusal(409, "request_state")
  }

  async function append(
    before: RegistryState | null,
    elements: unknown[]
  ): Promise<{ next: RegistryState; signed: SignedEntry[] }> {
    let next = before
    const signed: SignedEntry[] = []
    for (const element of elements) {
      try {
        const result = await validateAppend(next, element, spaceId)
        next = result.state
        signed.push(result.signed)
      } catch (error) {
        if (error instanceof RegistryError) {
          throw new Refusal(
            error.code === "bad_link" ? 409 : 400,
            error.code === "bad_link" ? "head_moved" : "invalid_entry"
          )
        }
        throw error
      }
    }
    if (next!.pendingRecoveryRotate !== null) throw new Refusal(400, "invalid_entry")
    return { next: next!, signed }
  }

  function envelopeSet(
    values: unknown,
    epoch: number,
    recipients: { recipient: string; encPub: string }[]
  ): EpochEnvelope[] {
    try {
      if (!Array.isArray(values)) throw new EnvelopeError("envelopes must be an array")
      return checkEnvelopeSet(values, epoch, recipients)
    } catch (error) {
      if (error instanceof EnvelopeError) throw new Refusal(400, "envelopes_incomplete")
      throw error
    }
  }

  async function route(request: Request): Promise<unknown> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    const body = method === "GET" ? "" : await request.text()
    const json = () => JSON.parse(body) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!request.headers.get("authorization")?.startsWith("Bearer "))
      throw new Refusal(401, "unauthorized")
    const requestMatch =
      /^\/v1\/enroll\/requests\/(req_[0-9A-Z]{26})(\/(nonce|reveal|deny))?$/.exec(path)

    if (method === "GET" && path === "/v1/space") {
      return state
        ? {
            state: "ready",
            genesisHash: state.genesisHash,
            head: state.head,
            epoch: state.epoch,
            protocolVersion: 1,
          }
        : { state: "empty", protocolVersion: 1 }
    }
    if (method === "GET" && path === "/v1/registry") {
      const after = Number(url.searchParams.get("after") ?? "-1")
      return { entries: entries.slice(after + 1), head: state?.head ?? null, more: false }
    }
    if (method === "POST" && path === "/v1/space/genesis") {
      if (state) throw new Refusal(409, "space_exists")
      const { entry, envelopes: values } = json()
      const { next, signed } = await append(null, [entry])
      const list = envelopeSet(values, 1, expectedRecipients(next))
      entries.push(...signed)
      for (const envelope of list) envelopes.set(envelope.recipient, envelope)
      state = next
      return { head: next.head, epoch: next.epoch }
    }
    if (method === "POST" && path === "/v1/registry") {
      const current = ready()
      const parsed = json()
      const first = parsed.entries?.[0]?.entry
      const joining = first?.type === "add-device" && first.via === "recovery" ? first.device : null
      const deviceId = await proven(
        request,
        body,
        (id) => current.devices[id]?.signPub ?? (joining?.deviceId === id ? joining.signPub : null)
      )
      if (current.devices[deviceId]?.status === "revoked") throw new Refusal(403, "device_revoked")
      if (!Array.isArray(parsed.entries) || parsed.entries.length < 1 || parsed.entries.length > 2)
        throw new Refusal(400, "bad_request")
      const { next, signed } = await append(current, parsed.entries)
      const head = signed[0]!
      if (
        signed.length === 2 &&
        !(head.entry.type === "add-device" && head.entry.via === "recovery")
      )
        throw new Refusal(400, "invalid_entry")
      const signers = head.sigs
        .map((sig) => sig.signer)
        .filter((signer) => signer !== RECOVERY_SIGNER)
      if (!signers.includes(deviceId)) throw new Refusal(403, "bad_proof")
      const approval =
        head.entry.type === "add-device" && head.entry.via === "approval" ? head.entry : null
      if (approval) {
        const pending = requestOf(approval.requestId)
        inState(pending, "revealed")
        if (pending.approverDeviceId !== deviceId) throw new Refusal(409, "request_state")
        const expected = await transcriptHash({
          spaceId,
          genesisHash: current.genesisHash,
          requestId: pending.requestId,
          deviceId: pending.deviceId,
          platform: pending.platform,
          signPub: pending.signPub,
          encPub: pending.encPub,
          commit: pending.commit,
          approverDeviceId: deviceId,
        })
        if (
          approval.device.deviceId !== pending.deviceId ||
          approval.device.signPub !== pending.signPub ||
          approval.transcriptHash !== expected
        ) {
          throw new Refusal(400, "invalid_entry")
        }
      }
      const list =
        next.epoch > current.epoch
          ? envelopeSet(parsed.envelopes, next.epoch, expectedRecipients(next))
          : envelopeSet(parsed.envelopes, next.epoch, [
              { recipient: approval!.device.deviceId, encPub: approval!.device.encPub },
            ])
      entries.push(...signed)
      if (next.epoch > current.epoch) envelopes.clear()
      for (const envelope of list) envelopes.set(envelope.recipient, envelope)
      if (approval) {
        const pending = requests.get(approval.requestId)!
        pending.state = "approved"
        pending.entrySeq = head.entry.seq
      }
      state = next
      return { head: next.head, epoch: next.epoch }
    }
    if (method === "GET" && path === "/v1/envelopes/recovery") {
      ready()
      return { envelope: envelopes.get(RECOVERY_SIGNER) }
    }
    if (method === "GET" && path === "/v1/envelopes/self") {
      const deviceId = await active(request, body)
      const envelope = envelopes.get(deviceId)
      if (!envelope) throw new Refusal(404, "envelopes_incomplete")
      return { envelope }
    }
    if (method === "POST" && path === "/v1/enroll/requests") {
      const current = ready()
      expire()
      if (
        [...requests.values()].filter((r) => OPEN.includes(r.state)).length >= MAX_PENDING_REQUESTS
      ) {
        throw new Refusal(429, "too_many_requests")
      }
      const parsed = json()
      const { pop, ...rest } = parsed
      if (current.devices[parsed.deviceId] || current.usedKeys.includes(parsed.signPub))
        throw new Refusal(400, "bad_request")
      try {
        checkSealedNames(parsed.names, current)
      } catch {
        throw new Refusal(400, "bad_request")
      }
      if (
        !(await ecdsaVerify(
          fromBase64Url(parsed.signPub),
          fromBase64Url(pop),
          enrollRequestSigningBytes(rest)
        ))
      ) {
        throw new Refusal(401, "bad_proof")
      }
      const created: FakeRequest = {
        requestId: newRequestId(),
        deviceId: parsed.deviceId,
        platform: parsed.platform,
        signPub: parsed.signPub,
        encPub: parsed.encPub,
        commit: parsed.commit,
        names: parsed.names,
        state: "pending",
        createdAt: now(),
        expiresAt: now() + REQUEST_TTL_MS,
        approverDeviceId: null,
        nonceA: null,
        nonceR: null,
        entrySeq: null,
      }
      requests.set(created.requestId, created)
      return { requestId: created.requestId, expiresAt: created.expiresAt }
    }
    if (method === "GET" && path === "/v1/enroll/requests") {
      const viewer = await active(request, body)
      expire()
      return {
        requests: [...requests.values()].map((r) => ({
          requestId: r.requestId,
          deviceId: r.deviceId,
          platform: r.platform,
          signPub: r.signPub,
          encPub: r.encPub,
          commit: r.commit,
          name: r.names.find((name) => name.recipient === viewer) ?? null,
          state: r.state,
          open: OPEN.includes(r.state),
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          approverDeviceId: r.approverDeviceId,
          nonceR:
            r.approverDeviceId === viewer && (r.state === "revealed" || r.state === "approved")
              ? r.nonceR
              : null,
          entrySeq: r.entrySeq,
        })),
      }
    }
    if (requestMatch) {
      const pending = requestOf(requestMatch[1]!)
      const action = requestMatch[3]
      const own = () =>
        proven(request, body, (id) => (id === pending.deviceId ? pending.signPub : null))
      if (method === "GET" && !action) {
        await own()
        return {
          requestId: pending.requestId,
          state: pending.state,
          expiresAt: pending.expiresAt,
          approverDeviceId: pending.approverDeviceId,
          nonceA: ["nonce_set", "revealed", "approved"].includes(pending.state)
            ? pending.nonceA
            : null,
          entrySeq: pending.entrySeq,
        }
      }
      if (method === "DELETE" && !action) {
        await own()
        inState(pending, ...OPEN)
        pending.state = "cancelled"
        return { state: "cancelled" }
      }
      if (method === "POST" && action === "reveal") {
        await own()
        inState(pending, "nonce_set")
        const nonceR = json().nonceR as string
        if (!(await matchesSasCommit(fromBase64Url(nonceR), pending.commit)))
          throw new Refusal(400, "bad_request")
        pending.state = "revealed"
        pending.nonceR = nonceR
        return { state: "revealed" }
      }
      if (method === "POST" && action === "nonce") {
        const deviceId = await active(request, body)
        inState(pending, "pending")
        pending.state = "nonce_set"
        pending.approverDeviceId = deviceId
        pending.nonceA = json().nonceA
        return { state: "nonce_set" }
      }
      if (method === "POST" && action === "deny") {
        const deviceId = await active(request, body)
        const reason = json().reason as "denied" | "mismatch"
        if (reason === "mismatch") inState(pending, "revealed")
        else inState(pending, ...OPEN)
        if (pending.state !== "pending" && pending.approverDeviceId !== deviceId)
          throw new Refusal(409, "request_state")
        pending.state = reason
        return { state: reason }
      }
    }
    throw new Refusal(404, "not_found")
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
    const headers = { [SERVER_TIME_HEADER]: String(now()), "content-type": "application/json" }
    try {
      return new Response(JSON.stringify(await route(request)), { status: 200, headers })
    } catch (error) {
      if (error instanceof Refusal)
        return new Response(JSON.stringify({ error: error.code }), {
          status: error.status,
          headers,
        })
      throw error
    }
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    entries,
    envelopes,
    requests,
    calls,
    state: () => state,
  }
}
