// Notification V2 Feishu one-way webhook executor.
//
// A `feishu-webhook` target is a one-way custom-bot webhook — no app
// credentials, no adapter instance, just the signed URL. It does NOT ride
// the governed outbound queue (that lane is for bound-conversation
// connector targets); this executor is the delivery path the webhook's
// intents run through, with the same intent/attempt durability contract.
//
// Secret handling is strict: `endpointSecretRef` is a `{service}:{account}`
// keyring REFERENCE resolved to the webhook URL at send time — the URL
// itself (which carries the bot secret) is never persisted on the target,
// logged, or exported. The optional `signingSecretRef` resolves to the
// Feishu signing secret for the timestamp+HMAC-SHA256 `sign` field.
//
// The HTTP call goes through `connectorsHttpRequest` — the governed outbound
// HTTP path — so TLS, timeout, and the connector audit trail stay uniform.
// The executor is DI-shaped (`sendHttp`, `resolveSecret`, `now`) so it's
// unit-testable with no Tauri and no network.

import type { NotificationTarget } from "@/types/notifications/target"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationAttemptOutcome } from "@/types/notifications/delivery"
import type { TauriHttpRequest, TauriHttpResponse } from "@/types/connectors/adapter"

/** The deps the executor needs — injected for testability + shell swaps. */
export interface FeishuWebhookDeps {
  /** POST a governed outbound HTTP request (the Tauri connector path). */
  sendHttp: (req: TauriHttpRequest) => Promise<TauriHttpResponse>
  /** Resolve a `{service}:{account}` secret ref to its value. */
  resolveSecret: (ref: string) => Promise<string | null>
  /** Wall-clock ms — injected for deterministic tests. */
  now?: () => number
  /** Optional HMAC-SHA256 hex signer — injected; defaults to Web Crypto. */
  hmacSha256Base64?: (key: string, message: string) => Promise<string>
}

export interface FeishuWebhookResult {
  outcome: NotificationAttemptOutcome
  /** Feishu's `code`/`StatusCode` — 0 means accepted. */
  platformCode?: number
  platformMessage?: string
  errorCode?: string
  /** Feishu's message id when the response carries one. */
  platformMessageId?: string
}

/** The `{service}:{account}` secret-ref split. `null` on a malformed ref. */
export function splitSecretRef(ref: string): { service: string; account: string } | null {
  const idx = ref.indexOf(":")
  if (idx <= 0 || idx === ref.length - 1) return null
  return { service: ref.slice(0, idx), account: ref.slice(idx + 1) }
}

/**
 * Compute the Feishu webhook `sign` — Base64(HMAC-SHA256(key=`{ts}\n{secret}`,
 * message="")) . Feishu's documented scheme signs the EMPTY message with a
 * key derived from timestamp+secret. Injected `hmacSha256Base64` lets tests
 * pin the value; the default uses Web Crypto.
 */
export async function feishuSign(
  timestampSec: string,
  secret: string,
  signer?: (key: string, message: string) => Promise<string>
): Promise<string> {
  const hmac = signer ?? defaultHmacSha256Base64
  return hmac(`${timestampSec}\n${secret}`, "")
}

async function defaultHmacSha256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message))
  // Base64 of the raw digest bytes.
  let bin = ""
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** The Feishu webhook request body for a rendered payload. */
export function buildFeishuWebhookBody(input: {
  payload: NotificationRenderedPayload
  timestampSec?: string
  sign?: string
}): Record<string, unknown> {
  const { payload } = input
  // An interactive card when there's structure (actions), else plain text.
  // `+N more` clipped facts are already folded into `payload.body` upstream.
  const text = `${payload.title}\n\n${payload.body}`.trim()
  const body: Record<string, unknown> =
    payload.actions && payload.actions.length > 0
      ? {
          msg_type: "interactive",
          card: {
            config: { wide_screen_mode: true },
            header: {
              title: { tag: "plain_text", content: payload.title },
              template: feishuTemplateForLevel(payload.level),
            },
            elements: [
              { tag: "div", text: { tag: "lark_md", content: payload.body } },
              {
                tag: "action",
                actions: payload.actions.map((a) => ({
                  tag: "button",
                  text: { tag: "plain_text", content: a.label },
                  type: "primary",
                  url: a.ref,
                })),
              },
            ],
          },
        }
      : { msg_type: "text", content: { text } }
  if (input.timestampSec) body.timestamp = input.timestampSec
  if (input.sign) body.sign = input.sign
  return body
}

function feishuTemplateForLevel(level: string): string {
  switch (level) {
    case "error":
      return "red"
    case "warning":
      return "orange"
    case "success":
      return "green"
    default:
      return "blue"
  }
}

/**
 * Deliver ONE rendered payload to a `feishu-webhook` target. Resolves the
 * endpoint + signing secrets, POSTs the card/text, and classifies the
 * result into an attempt outcome. Never throws for a platform refusal —
 * refusals are `rejected`/`rate-limited` outcomes, not exceptions; only a
 * transport-level fault (or a missing secret, which is a local validation
 * failure) surfaces as a non-`accepted` outcome.
 */
export async function deliverFeishuWebhook(input: {
  target: NotificationTarget
  payload: NotificationRenderedPayload
  deps: FeishuWebhookDeps
}): Promise<FeishuWebhookResult> {
  const { target, payload, deps } = input
  if (target.address.kind !== "feishu-webhook") {
    return { outcome: "invalid-target", errorCode: "not-a-webhook-target" }
  }
  const address = target.address
  const now = deps.now?.() ?? Date.now()

  // Resolve the endpoint URL — the secret ref is `{service}:{account}`. A
  // keyring fault is a local dependency failure (the send never reached the
  // platform), so it surfaces as a retryable `internal-error`, never a throw.
  const endpoint = splitSecretRef(address.endpointSecretRef)
  if (!endpoint) {
    return { outcome: "invalid-target", errorCode: "endpoint-ref-malformed" }
  }
  let url: string | null
  try {
    url = await deps.resolveSecret(address.endpointSecretRef)
  } catch {
    return { outcome: "internal-error", errorCode: "endpoint-secret-fault" }
  }
  if (!url) {
    // A missing endpoint credential is a local validation failure — the send
    // never happened, so it's retryable `network-error` classified as a
    // not-sent, NOT a platform refusal.
    return { outcome: "invalid-target", errorCode: "endpoint-secret-missing" }
  }

  // Optional signature — resolve the signing secret and stamp `sign`.
  let timestampSec: string | undefined
  let sign: string | undefined
  if (address.signingSecretRef) {
    let signSecret: string | null
    try {
      signSecret = await deps.resolveSecret(address.signingSecretRef)
    } catch {
      return { outcome: "internal-error", errorCode: "signing-secret-fault" }
    }
    if (signSecret) {
      timestampSec = Math.floor(now / 1000).toString()
      sign = await feishuSign(timestampSec, signSecret, deps.hmacSha256Base64)
    }
    // A missing signing secret means "send unsigned" — Feishu accepts
    // unsigned webhooks when signature verification isn't enforced on the bot.
  }

  const body = buildFeishuWebhookBody({
    payload,
    ...(timestampSec ? { timestampSec } : {}),
    ...(sign ? { sign } : {}),
  })

  let response: TauriHttpResponse
  try {
    response = await deps.sendHttp({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 10_000,
    })
  } catch {
    // Transport fault — the send may or may not have landed. Timeout/abort is
    // `timeout-unknown` (outcome genuinely unknown); a clean refused
    // connection is `network-error`. We can't tell which here, so classify
    // conservatively as unknown — the reconciler reconciles, never re-sends.
    return { outcome: "timeout-unknown", errorCode: "transport-fault" }
  }

  // HTTP-level classification before parsing the body.
  if (response.status === 429) {
    return { outcome: "rate-limited", errorCode: "http-429" }
  }
  if (response.status === 401 || response.status === 403) {
    return { outcome: "auth-failed", errorCode: `http-${response.status}` }
  }
  if (response.status === 404 || response.status === 410) {
    return { outcome: "invalid-target", errorCode: `http-${response.status}` }
  }
  if (response.status >= 500) {
    return { outcome: "network-error", errorCode: `http-${response.status}` }
  }
  if (response.status < 200 || response.status >= 300) {
    return { outcome: "rejected", errorCode: `http-${response.status}` }
  }

  // 2xx — parse Feishu's `{ code, msg }` envelope. `code === 0` (or legacy
  // `StatusCode === 0`) is the platform's acceptance.
  let parsed: { code?: number; StatusCode?: number; msg?: string; data?: { message_id?: string } }
  try {
    parsed = JSON.parse(response.body)
  } catch {
    // A 2xx with an unparseable body is treated as accepted-but-unverified —
    // the platform acknowledged the request; we just can't read its message id.
    return { outcome: "accepted" }
  }
  const code = parsed.code ?? parsed.StatusCode ?? -1
  if (code === 0) {
    return {
      outcome: "accepted",
      platformCode: 0,
      ...(parsed.data?.message_id ? { platformMessageId: parsed.data.message_id } : {}),
    }
  }
  // Feishu business errors — 19021 (signature), 11232 (rate), etc. Classify
  // by the code's known meaning; unknown codes are `rejected`.
  const msg = parsed.msg ?? ""
  if (
    code === 11232 ||
    msg.toLowerCase().includes("rate") ||
    msg.toLowerCase().includes("frequency")
  ) {
    return { outcome: "rate-limited", platformCode: code, platformMessage: msg }
  }
  if (code === 19021 || code === 19022 || msg.toLowerCase().includes("sign")) {
    return { outcome: "auth-failed", platformCode: code, platformMessage: msg }
  }
  if (
    code === 23027 ||
    msg.toLowerCase().includes("not found") ||
    msg.toLowerCase().includes("invalid")
  ) {
    return { outcome: "invalid-target", platformCode: code, platformMessage: msg }
  }
  return { outcome: "rejected", platformCode: code, platformMessage: msg }
}
