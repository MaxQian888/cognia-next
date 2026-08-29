/**
 * The extension's client for a paired Cognia Host.
 *
 * Everything below the DPoP layer comes from `@cognia/companion-client`, which
 * the desktop app and the CLI worker use too — the proof format is not RFC 9449
 * and a hand-written second implementation would drift on the details that
 * matter (no `jwk` header, bare-path `htu`, dual-purpose nonce).
 *
 * What is here is the part specific to this client: redeeming a pairing code,
 * and the four RPC calls the panel makes.
 */
import {
  createCompanionSession,
  createDeviceProof,
  decodeBrowserEnrollmentPayload,
  expectCompanionJson,
  signerFromCryptoKey,
  type BrowserCompanionCapabilityV1,
  type BrowserContextResultV1,
  type BrowserContextSubmissionStatusV1,
  type BrowserContextSubmissionSummaryPageV1,
  type BrowserContextSubmitRequestV1,
  type BrowserContextSubmitResponseV1,
  type CompanionFetch,
  type CompanionSession,
  type DeviceSigner,
} from "@cognia/companion-client"

import { createDeviceKey, loadDeviceKey } from "./device-key"

/** The public half of a pairing, safe to keep in `chrome.storage.local`. */
export interface PairingRecord {
  baseUrl: string
  tenantId: string
  deviceId: string
  extensionOrigin: string
  pairedAt: number
}

export type PairFailure =
  | { code: "wrong_format" }
  | { code: "version_mismatch"; got: number }
  | { code: "invalid"; message: string }
  | { code: "permission_denied" }
  | { code: "rejected"; message: string }

export type PairOutcome = { ok: true; pairing: PairingRecord } | { ok: false; failure: PairFailure }

export interface PairInput {
  code: string
  extensionOrigin: string
  /** Must already be granted; the caller asks inside the user's gesture. */
  hasPermission: boolean
  displayName: string
  fetchImpl?: CompanionFetch
  now?: () => number
}

/**
 * Redeem a pairing code.
 *
 * The order matters. The code is decoded *before* a key is generated, so a
 * mistyped or expired code does not leave an orphaned identity in IndexedDB;
 * and the host permission is checked before anything is sent, because a fetch
 * without it fails with a network error that says nothing about the cause.
 */
export async function pairWithHost({
  code,
  extensionOrigin,
  hasPermission,
  displayName,
  fetchImpl = (input, init) => fetch(input, init),
  now = () => Date.now(),
}: PairInput): Promise<PairOutcome> {
  const decoded = decodeBrowserEnrollmentPayload(code, now())
  if (decoded.kind === "wrong_format") return { ok: false, failure: { code: "wrong_format" } }
  if (decoded.kind === "version_mismatch") {
    return { ok: false, failure: { code: "version_mismatch", got: decoded.got } }
  }
  if (decoded.kind === "invalid") {
    return { ok: false, failure: { code: "invalid", message: decoded.message } }
  }
  if (!hasPermission) return { ok: false, failure: { code: "permission_denied" } }

  const { baseUrl, tenantId, enrollment } = decoded.payload
  const origin = baseUrl.replace(/\/+$/, "")
  try {
    const challenge = await expectCompanionJson(
      fetchImpl(`${origin}/api/auth/device/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      })
    )
    if (typeof challenge.challengeId !== "string" || typeof challenge.nonce !== "string") {
      return { ok: false, failure: { code: "rejected", message: "malformed challenge" } }
    }

    const key = await createDeviceKey()
    const deviceId = crypto.randomUUID()
    const proof = await createDeviceProof({
      signer: signerFromCryptoKey(deviceId, key.privateKey),
      nonce: challenge.nonce,
      method: "POST",
      path: "/api/auth/browser/register",
    })
    const registered = await expectCompanionJson(
      fetchImpl(`${origin}/api/auth/browser/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          enrollment,
          challengeId: challenge.challengeId,
          challengeNonce: challenge.nonce,
          deviceId,
          displayName,
          publicKeyPem: key.publicKeyPem,
          proof,
          extensionOrigin,
        }),
      })
    )
    if (registered.deviceId !== deviceId) {
      return { ok: false, failure: { code: "rejected", message: "device id mismatch" } }
    }
    return {
      ok: true,
      pairing: { baseUrl: origin, tenantId, deviceId, extensionOrigin, pairedAt: now() },
    }
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: "rejected",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/** The six calls the panel makes, over one authenticated session. */
export interface HostClient {
  /**
   * What the Host can do, and how it looks.
   *
   * `preferredMode` is the panel's light/dark override, or the mode it resolved
   * from `prefers-color-scheme` for a Host that follows the system. It is the
   * Host that re-resolves the palette: this panel can toggle a class, but the
   * custom properties underneath it are a palette only the Host can build, so
   * flipping locally would paint a light layout in dark colours.
   */
  capability(preferredMode?: "light" | "dark"): Promise<BrowserCompanionCapabilityV1>
  submit(request: BrowserContextSubmitRequestV1): Promise<BrowserContextSubmitResponseV1>
  list(limit?: number): Promise<BrowserContextSubmissionSummaryPageV1>
  /**
   * One submission, by id.
   *
   * The list is deliberately thin and carries no `errorCode`; this is the only
   * call that answers *why* a submission failed. The Host answers a submission
   * belonging to another device exactly as it answers a missing one, so a
   * rejection here says nothing about whether the id exists.
   */
  get(submissionId: string): Promise<BrowserContextSubmissionStatusV1>
  /** The status, plus what the task said, when it has said anything. */
  result(submissionId: string): Promise<BrowserContextResultV1>
  /**
   * Stop the task a submission started.
   *
   * Refuses with `session_driven_elsewhere` when another device is holding the
   * wheel — the run is fine and the desktop is driving it, which the panel says
   * rather than reporting a failure the user cannot act on from here.
   */
  cancel(submissionId: string): Promise<BrowserContextSubmissionStatusV1>
  invalidate(): void
}

export interface HostClientOptions {
  pairing: PairingRecord
  signer: DeviceSigner
  fetchImpl?: CompanionFetch
}

export function createHostClient({
  pairing,
  signer,
  fetchImpl = (input, init) => fetch(input, init),
}: HostClientOptions): HostClient {
  const session: CompanionSession = createCompanionSession({
    baseUrl: pairing.baseUrl,
    tenantId: pairing.tenantId,
    signer,
    fetchImpl,
  })

  async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const path = `/api/_rpc/${command}`
    const headers: Record<string, string> = {
      ...(await session.authorizationHeaders("POST", path)),
      "Content-Type": "application/json",
    }
    // Only the write declares `idempotency: required`. Sending a key on a read
    // is refused with `idempotency_key_forbidden`, so this is not "always send
    // one to be safe" — the header is as much a declaration as a value.
    if (command === "browser_context_submit" && typeof args.submissionId === "string") {
      headers["Idempotency-Key"] = args.submissionId
    }
    // `cancel` declares `idempotency: required` too, and the Host parses the
    // header as a UUID. A fresh one per press rather than the submission id: a
    // person may stop the same task twice, and replaying the first receipt
    // would make the second press do nothing while reporting success.
    if (command === "browser_context_cancel") {
      headers["Idempotency-Key"] = crypto.randomUUID()
    }
    const body = await expectCompanionJson(
      fetchImpl(`${pairing.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      })
    )
    return unwrapRpcResult<T>(body)
  }

  return {
    capability: (preferredMode) =>
      call<BrowserCompanionCapabilityV1>(
        "browser_companion_capability",
        preferredMode ? { preferredMode } : {}
      ),
    submit: (request) =>
      call<BrowserContextSubmitResponseV1>(
        "browser_context_submit",
        request as unknown as Record<string, unknown>
      ),
    list: (limit) =>
      call<BrowserContextSubmissionSummaryPageV1>("browser_context_list", limit ? { limit } : {}),
    get: (submissionId) =>
      call<BrowserContextSubmissionStatusV1>("browser_context_get", { submissionId }),
    result: (submissionId) =>
      call<BrowserContextResultV1>("browser_context_result", { submissionId }),
    cancel: (submissionId) =>
      call<BrowserContextSubmissionStatusV1>("browser_context_cancel", { submissionId }),
    invalidate: () => session.invalidate(),
  }
}

/**
 * Rebuild a signer from what survived a service-worker restart.
 *
 * The pairing record is public and lives in `chrome.storage.local`; the key is
 * the unreadable `CryptoKey` in IndexedDB. Either being absent means this
 * browser is not paired — a different state from "paired and offline", which
 * the panel renders differently.
 *
 * Nothing is recomputed here, and that is the point: a non-extractable private
 * key cannot yield its public half (WebCrypto offers no derivation, and export
 * is exactly what `extractable: false` forbids), so anything derived from the
 * public key has to have been kept at pairing time or not at all. Since the
 * proof carries no key material, nothing needs to be.
 */
export async function restoreSigner(pairing: PairingRecord): Promise<DeviceSigner | null> {
  const privateKey = await loadDeviceKey()
  if (!privateKey) return null
  return signerFromCryptoKey(pairing.deviceId, privateKey)
}

/**
 * The `result` out of a Companion RPC envelope.
 *
 * `POST /api/_rpc/<name>` does not answer with the command's result; it answers
 * with `{ requestId, result }` (and `operationId` on a command that went
 * through the durable operation ledger, which `browser_context_submit` does).
 * Returning the envelope as if it were the result is not a type error anywhere
 * — every field simply reads back `undefined` — so the first symptom is the
 * panel deciding the Host speaks an unsupported schema version and refusing to
 * do anything, which describes neither the cause nor the fix.
 *
 * The check is for the key rather than for its type: `result` may legitimately
 * be `null`, and a command that answers with a bare value is still a value the
 * envelope wraps. Anything without the key is passed through, which keeps this
 * honest against a plane that does not wrap — `lib/tauri/transport-companion.ts`
 * makes the same allowance for the same reason.
 */
function unwrapRpcResult<T>(body: Record<string, unknown>): T {
  return (Object.hasOwn(body, "result") ? body.result : body) as T
}
