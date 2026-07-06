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
import { WECHAT_API_BASE } from "./auth"
import { parseWechatOaXml } from "./parse"
import { serializeOutbound } from "./serialize"
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
  required: ["appId", "appSecret", "token", "encodingAesKey"],
  properties: {
    appId: { type: "string", title: "App ID" },
    appSecret: { type: "string", title: "App Secret" },
    token: { type: "string", title: "Token" },
    encodingAesKey: { type: "string", title: "EncodingAESKey" },
  },
  additionalProperties: false,
}

export function createWechatOaAdapter(opts: WechatOaAdapterOptions): PlatformAdapter {
  const apiBase = opts.apiBase ?? WECHAT_API_BASE
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
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
          const event = parseWechatOaXml(opts.id, "", xml)
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
    return { state: healthState, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const msg = serializeOutbound(req)
    if (!msg) {
      return {
        ok: false,
        error: { code: "validation", message: "WeChat OA send: missing openId", retryable: false },
      }
    }
    try {
      const token = await opts.accessToken()
      const resp = await connectorsHttpRequest({
        url: `${apiBase}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // WeChat requires the raw UTF-8 JSON; emoji/Chinese must not be escaped
        // away — JSON.stringify keeps them as UTF-8 which the proxy forwards.
        body: JSON.stringify(msg),
      })
      let body: { errcode?: number; errmsg?: string }
      try {
        body = JSON.parse(resp.body)
      } catch {
        body = {}
      }
      if (body.errcode && body.errcode !== 0) {
        // 45015: response out of the 48h customer-service window (not retryable).
        const retryable = body.errcode !== 45015 && body.errcode !== 45047
        return {
          ok: false,
          error: {
            code: body.errcode === 45015 ? "validation" : "platform_4xx",
            message: `WeChat OA send failed: ${body.errmsg ?? body.errcode}`,
            retryable,
          },
        }
      }
      lastActivityAt = Date.now()
      return { ok: true }
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
    // No-op: accessToken is resolved fresh on each send.
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
