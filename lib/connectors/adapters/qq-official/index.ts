/**
 * QQ Official Bot adapter factory.
 *
 * Two inbound transports (QQ is deprecating the WebSocket gateway):
 *   - `gateway` (default): connects over the shared `connectors_ws_open`
 *     Tauri WS passthrough (no dedicated Rust transport — same approach as
 *     Discord).
 *   - `webhook`: DISPATCH envelopes arrive over the Rust-hosted HTTPS
 *     callback (`axum_app.rs::qq_official_webhook_handler` verifies the
 *     seeded-Ed25519 signature and answers the op-13 validation in-band).
 *
 * Both transports feed the same `parseQQDispatch → gate → emit` pipeline;
 * outbound always goes through the QQ REST API with passive replies.
 */

import type {
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
  PlatformAdapter,
  TransportMode,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { QQ_OFFICIAL_A2UI_CAPABILITY, QQ_OFFICIAL_CAPS } from "./capability"
import { QQ_API_BASE, clearQQTokenCacheByToken, getQQGatewayUrl, qqAuthHeaders } from "./auth"
import { parseQQDispatch, type QQDispatch } from "./parse"
import { serializeOutbound } from "./serialize"
import { startQQGateway } from "./gateway-client"
import { startWebhookTransport } from "./transport-webhook"

export interface QQOfficialAdapterOptions {
  id: string
  displayName: string
  /** Resolves a fresh app access token (without the `QQBot ` prefix). */
  accessToken: () => Promise<string>
  /** REST + gateway base; defaults to the production host. */
  apiBase?: string
  /**
   * Active inbound transport for this row. `"gateway"` (default) dials the
   * WebSocket gateway; `"webhook"` receives DISPATCH envelopes via the
   * Rust-hosted callback endpoint (requires the connectors server + a public
   * tunnel URL pasted into the QQ console).
   */
  transportMode?: TransportMode
}

const QQ_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["appId", "clientSecret"],
  properties: {
    appId: { type: "string", title: "App ID" },
    clientSecret: { type: "string", title: "Client Secret" },
    transport: {
      type: "string",
      title: "Transport",
      description:
        "gateway = WebSocket (deprecated by QQ); webhook = HTTPS callback via the local connectors server",
      enum: ["gateway", "webhook"],
      default: "gateway",
    },
  },
  additionalProperties: false,
}

/**
 * Platform code for "msg limit exceed" — QQ's rejection when a passive
 * msg_id has expired (group/channel/direct 5 min, C2C 60 min) or has hit
 * its 5-reply cap. Non-retryable: the msg_id will never become valid again.
 */
const QQ_CODE_MSG_LIMIT_EXCEED = 22009

class QQApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly platformCode?: number
  ) {
    super(message)
    this.name = "QQApiError"
  }
}

export function createQQOfficialAdapter(opts: QQOfficialAdapterOptions): PlatformAdapter {
  const apiBase = opts.apiBase ?? QQ_API_BASE
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined
  let lastActivityAt: number | undefined
  let stopCalled = false
  let gatewaySelfId = ""

  /** Shared per-dispatch pipeline: parse → at-gate → bus emit. */
  async function handleDispatch(
    ctx: AdapterContext,
    selfId: string,
    dispatch: QQDispatch
  ): Promise<void> {
    const event = parseQQDispatch(opts.id, selfId, dispatch)
    if (!event) return
    if (!(await gateInboundEvent(opts.id, event))) return
    lastActivityAt = Date.now()
    await ctx.emit(event)
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal
    healthState = "running"
    healthReason = undefined

    // Webhook mode: verified DISPATCH envelopes arrive from the Rust callback
    // endpoint (op 13 is answered in-band Rust-side and never seen here). The
    // generator ends only on abort, so — unlike the gateway — a stream end is
    // not an error condition.
    if (opts.transportMode === "webhook") {
      ;(async () => {
        try {
          for await (const dispatch of startWebhookTransport({ adapterId: opts.id, signal })) {
            if (signal.aborted) break
            // Webhook mode has no READY event, so selfId stays "" unless a
            // prior gateway run populated it.
            await handleDispatch(ctx, gatewaySelfId, dispatch)
          }
        } catch (err) {
          if (!stopCalled) {
            healthState = "degraded"
            healthReason = `QQ webhook loop error: ${err instanceof Error ? err.message : String(err)}`
          }
        }
      })()
      return
    }

    const gateway = startQQGateway({
      accessToken: opts.accessToken,
      gatewayUrl: async () => getQQGatewayUrl(await opts.accessToken(), apiBase),
      signal,
    })
    ;(async () => {
      try {
        for await (const dispatch of gateway.dispatches) {
          if (signal.aborted) break
          gatewaySelfId = gateway.selfId
          await handleDispatch(ctx, gatewaySelfId, dispatch)
        }
        if (!stopCalled) {
          healthState = "down"
          healthReason = "QQ gateway dispatch stream ended unexpectedly"
        }
      } catch (err) {
        if (!stopCalled) {
          healthState = "degraded"
          healthReason = `QQ gateway loop error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    })()
  }

  async function stop(): Promise<void> {
    stopCalled = true
    abortController?.abort()
    abortController = null
    healthState = "down"
    healthReason = undefined
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const call = serializeOutbound(req)
    if (!call) {
      return {
        ok: false,
        error: {
          code: "validation",
          message: "QQ send: unaddressable conversationRef",
          retryable: false,
        },
      }
    }
    const post = (token: string) =>
      connectorsHttpRequest({
        url: `${apiBase}${call.path}`,
        method: "POST",
        headers: qqAuthHeaders(token),
        body: JSON.stringify(call.payload),
      })
    try {
      let token = await opts.accessToken()
      let resp = await post(token)
      if (resp.status === 401 || resp.status === 403) {
        // The cached app token (~2h TTL) may be stale after a console-side
        // secret rotation. Evict it, re-mint once, and retry before
        // surfacing auth_failed — otherwise sends stay bricked for hours.
        clearQQTokenCacheByToken(token)
        token = await opts.accessToken()
        resp = await post(token)
      }
      let body: { id?: string; message?: string; code?: number }
      try {
        body = JSON.parse(resp.body)
      } catch {
        body = {}
      }
      if (resp.status < 200 || resp.status >= 300) {
        // Surface the platform's numeric `code` and the X-Tps-trace-id
        // header — both are what QQ support asks for when triaging.
        const traceId = resp.headers["X-Tps-trace-id"] ?? resp.headers["x-tps-trace-id"]
        const detail = `${body.message ?? resp.body.slice(0, 200)}${
          body.code !== undefined ? ` (code ${body.code})` : ""
        }${traceId ? ` [trace ${traceId}]` : ""}`
        throw new QQApiError(`QQ send failed: ${detail}`, resp.status, body.code)
      }
      lastActivityAt = Date.now()
      if (healthState === "running") healthReason = undefined
      return { ok: true, platformMessageId: body.id }
    } catch (err) {
      if (err instanceof QQApiError) {
        if (err.platformCode === QQ_CODE_MSG_LIMIT_EXCEED && "msg_id" in call.payload) {
          // Distinct, non-retryable: the passive reply window elapsed (group
          // 5 min / C2C 60 min) or the 5-reply cap was hit — this msg_id can
          // never be replied to again.
          return {
            ok: false,
            error: {
              code: "platform_4xx",
              message: `QQ passive reply rejected: the reply window for msg_id has closed (group 5 min / C2C 60 min, max 5 replies). ${err.message}`,
              retryable: false,
            },
          }
        }
        const code =
          err.status === 429
            ? "rate_limited"
            : err.status === 401 || err.status === 403
              ? "auth_failed"
              : err.status >= 500
                ? "platform_5xx"
                : "platform_4xx"
        if (code === "auth_failed") healthReason = err.message
        return {
          ok: false,
          error: {
            code,
            message: err.message,
            retryable: code !== "platform_4xx" && code !== "auth_failed",
          },
        }
      }
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
    // No-op: accessToken is resolved fresh on each gateway connect / send.
  }

  return {
    get meta() {
      return {
        type: "qq-official" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: QQ_OFFICIAL_CAPS,
        transportModes: ["gateway", "webhook"] as const,
        configSchema: QQ_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    refreshCredentials,
    a2uiCapability: () => QQ_OFFICIAL_A2UI_CAPABILITY,
  }
}
