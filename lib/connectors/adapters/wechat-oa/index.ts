/**
 * WeChat Official Account adapter factory.
 *
 * Inbound: the Rust webhook handler (`wechat_oa_handler`) verifies + decrypts
 * the safe-mode callback and emits `{ xml }`; this adapter subscribes, parses,
 * and emits normalized events. The webhook route resolves `wechat-oa` because
 * `ConnectorBusProvider` registers every inbound-server adapter with the Rust
 * connectors server before starting its transport (see `bootAdapter`).
 *
 * Outbound: replies go through the 客服 message API (`custom/send`). WeChat's
 * 48-hour customer-service window means sends outside it are rejected by the
 * platform (errcode 45015) — surfaced as a non-retryable error.
 */

import type {
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
  PlatformAdapter,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { WECHAT_OA_A2UI_CAPABILITY, WECHAT_OA_CAPS } from "./capability"
import { WECHAT_API_BASE, clearWechatOaTokenCache } from "./auth"
import { extractXmlField, parseWechatOaXml } from "./parse"
import { serializeOutbound, type WechatCustomMessage } from "./serialize"
import { startWechatOaWebhook } from "./transport-webhook"

export interface WechatOaAdapterOptions {
  id: string
  displayName: string
  /** Resolves a fresh access token for the 客服 message API. */
  accessToken: () => Promise<string>
  apiBase?: string
}

const WECHAT_OA_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  // encodingAesKey is intentionally NOT required: the Rust webhook handler
  // fully supports plaintext-mode callbacks. It is only needed when the OA is
  // configured for safe (encrypted) mode.
  required: ["appId", "appSecret", "token"],
  properties: {
    appId: { type: "string", title: "App ID" },
    appSecret: { type: "string", title: "App Secret" },
    token: { type: "string", title: "Token" },
    encodingAesKey: {
      type: "string",
      title: "EncodingAESKey",
      description: "Required only for safe (encrypted) callback mode; plaintext mode omits it.",
    },
  },
  additionalProperties: false,
}

/** invalid access_token (40001) / invalid appid credential (40014) / token expired (42001). */
const AUTH_ERRCODES = new Set([40001, 40014, 42001])

/**
 * Permanent send failures the outbound queue must never retry:
 * 45015 response out of the 48h customer-service window,
 * 45047 customer-service message count over limit for this user,
 * 48001 api unauthorized (unverified / subscription accounts lack 客服 permission),
 * 50002 user blacklisted / blocked by the user.
 */
const NON_RETRYABLE_ERRCODES = new Set([45015, 45047, 48001, 50002])

/** Outcome of a single 客服 send attempt, before retry / health handling. */
type SendAttempt =
  | { kind: "ok" }
  | { kind: "auth"; errcode: number; errmsg?: string }
  | { kind: "errcode"; errcode: number; errmsg?: string }
  | { kind: "transport"; status: number; bodySnippet: string; unparseable: boolean }

export function createWechatOaAdapter(opts: WechatOaAdapterOptions): PlatformAdapter {
  const apiBase = opts.apiBase ?? WECHAT_API_BASE
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined
  let lastActivityAt: number | undefined
  let stopCalled = false

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal
    healthState = "running"

    // Registration with the Rust connectors server (so the GET echostr
    // handshake + POST decrypt route resolve to `wechat-oa`) is done centrally
    // by `ConnectorBusProvider.bootAdapter` before this transport starts.
    const feed = startWechatOaWebhook({ adapterId: opts.id, signal })
    ;(async () => {
      try {
        for await (const xml of feed) {
          if (signal.aborted) break
          // ToUserName on an inbound push is the OA's own gh_ account id.
          const event = parseWechatOaXml(opts.id, extractXmlField(xml, "ToUserName") ?? "", xml)
          if (event) {
            if (!(await gateInboundEvent(opts.id, event))) continue
            lastActivityAt = Date.now()
            await ctx.emit(event)
          }
        }
        if (!stopCalled) healthState = "down"
      } catch {
        if (!stopCalled) healthState = "degraded"
      }
    })()
  }

  async function stop(): Promise<void> {
    stopCalled = true
    abortController?.abort()
    abortController = null
    healthState = "down"
    // Unregistration from the Rust connectors server is done centrally by
    // `ConnectorBusProvider`'s teardown (see `serverAdapterIds`).
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  /** POST one 客服 message and classify the platform response. */
  async function attemptSend(msg: WechatCustomMessage): Promise<SendAttempt> {
    const token = await opts.accessToken()
    const resp = await connectorsHttpRequest({
      url: `${apiBase}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // WeChat requires the raw UTF-8 JSON; emoji/Chinese must not be escaped
      // away — JSON.stringify keeps them as UTF-8 which the proxy forwards.
      body: JSON.stringify(msg),
      timeoutMs: 15_000,
    })
    let body: { errcode?: number; errmsg?: string } | undefined
    try {
      body = JSON.parse(resp.body) as { errcode?: number; errmsg?: string }
    } catch {
      body = undefined
    }
    if (body && typeof body.errcode === "number" && body.errcode !== 0) {
      if (AUTH_ERRCODES.has(body.errcode)) {
        return { kind: "auth", errcode: body.errcode, errmsg: body.errmsg }
      }
      return { kind: "errcode", errcode: body.errcode, errmsg: body.errmsg }
    }
    // Non-2xx status or an unparseable body (gateway HTML, truncated proxy
    // response) means the message was NOT delivered — never report success.
    if (resp.status >= 400 || body === undefined) {
      return {
        kind: "transport",
        status: resp.status,
        bodySnippet: resp.body.slice(0, 200),
        unparseable: body === undefined,
      }
    }
    return { kind: "ok" }
  }

  /** Map a non-auth attempt outcome to the OutboundResult, updating health. */
  function settleAttempt(attempt: Exclude<SendAttempt, { kind: "auth" }>): OutboundResult {
    if (attempt.kind === "ok") {
      lastActivityAt = Date.now()
      // A successful send clears a previous send-path degradation.
      healthState = "running"
      healthReason = undefined
      return { ok: true }
    }
    if (attempt.kind === "errcode") {
      const retryable = !NON_RETRYABLE_ERRCODES.has(attempt.errcode)
      return {
        ok: false,
        error: {
          // 45015: response out of the 48h customer-service window.
          code: attempt.errcode === 45015 ? "validation" : "platform_4xx",
          message: `WeChat OA send failed: ${attempt.errmsg ?? attempt.errcode} (errcode ${attempt.errcode})`,
          retryable,
        },
      }
    }
    return {
      ok: false,
      error: {
        code: attempt.status >= 500 ? "platform_5xx" : "platform_4xx",
        message: attempt.unparseable
          ? `WeChat OA send returned a non-JSON body (status ${attempt.status}): ${attempt.bodySnippet}`
          : `WeChat OA send failed with HTTP ${attempt.status}: ${attempt.bodySnippet}`,
        retryable: true,
      },
    }
  }

  // GAP: typing indicator (/cgi-bin/message/custom/typing) is not implemented.
  // GAP: passive-reply fast path (replying inside the webhook HTTP response
  // within 5s) is not implemented — every reply goes through the 客服 send API.
  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const msg = serializeOutbound(req)
    if (!msg) {
      return {
        ok: false,
        error: { code: "validation", message: "WeChat OA send: missing openId", retryable: false },
      }
    }
    try {
      let attempt = await attemptSend(msg)
      if (attempt.kind === "auth") {
        // Invalid / expired access token: drop the cached token and retry
        // exactly once with a freshly minted one.
        clearWechatOaTokenCache()
        attempt = await attemptSend(msg)
        if (attempt.kind === "auth") {
          // Still rejected with a fresh token → credentials are bad; retrying
          // cannot help. Degrade health until a send succeeds again.
          healthState = "degraded"
          healthReason = "auth_failed"
          return {
            ok: false,
            error: {
              code: "auth_failed",
              message: `WeChat OA send auth failed after token refresh: ${attempt.errmsg ?? attempt.errcode} (errcode ${attempt.errcode})`,
              retryable: false,
            },
          }
        }
      }
      return settleAttempt(attempt)
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "platform_5xx",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
      }
    }
  }

  async function refreshCredentials(): Promise<void> {
    // Drop cached access tokens so the next send re-fetches with the
    // (possibly rotated) keyring credentials.
    clearWechatOaTokenCache()
  }

  return {
    get meta() {
      return {
        type: "wechat-oa" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: WECHAT_OA_CAPS,
        transportModes: ["webhook"] as const,
        configSchema: WECHAT_OA_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    refreshCredentials,
    a2uiCapability: () => WECHAT_OA_A2UI_CAPABILITY,
  }
}
