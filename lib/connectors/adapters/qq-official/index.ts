/**
 * QQ Official Bot adapter factory.
 *
 * Connects to the QQ gateway over the shared `connectors_ws_open` Tauri WS
 * passthrough (no dedicated Rust transport — same approach as Discord), parses
 * the four message scenes, and sends passive replies through the QQ REST API.
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
import { QQ_OFFICIAL_A2UI_CAPABILITY, QQ_OFFICIAL_CAPS } from "./capability"
import { QQ_API_BASE, getQQGatewayUrl, qqAuthHeaders } from "./auth"
import { parseQQDispatch } from "./parse"
import { serializeOutbound } from "./serialize"
import { startQQGateway } from "./gateway-client"

export interface QQOfficialAdapterOptions {
  id: string
  displayName: string
  /** Resolves a fresh app access token (without the `QQBot ` prefix). */
  accessToken: () => Promise<string>
  /** REST + gateway base; defaults to the production host. */
  apiBase?: string
}

const QQ_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["appId", "clientSecret"],
  properties: {
    appId: { type: "string", title: "App ID" },
    clientSecret: { type: "string", title: "Client Secret" },
  },
  additionalProperties: false,
}

class QQApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "QQApiError"
  }
}

export function createQQOfficialAdapter(opts: QQOfficialAdapterOptions): PlatformAdapter {
  const apiBase = opts.apiBase ?? QQ_API_BASE
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined
  let stopCalled = false
  let gatewaySelfId = ""

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal
    healthState = "running"

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
          const event = parseQQDispatch(opts.id, gatewaySelfId, dispatch)
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
  }

  function health(): AdapterHealth {
    return { state: healthState, lastActivityAt }
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
    try {
      const token = await opts.accessToken()
      const resp = await connectorsHttpRequest({
        url: `${apiBase}${call.path}`,
        method: "POST",
        headers: qqAuthHeaders(token),
        body: JSON.stringify(call.payload),
      })
      let body: { id?: string; message?: string; code?: number }
      try {
        body = JSON.parse(resp.body)
      } catch {
        body = {}
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new QQApiError(
          `QQ send failed: ${body.message ?? resp.body.slice(0, 200)}`,
          resp.status
        )
      }
      lastActivityAt = Date.now()
      return { ok: true, platformMessageId: body.id }
    } catch (err) {
      if (err instanceof QQApiError) {
        const code =
          err.status === 429
            ? "rate_limited"
            : err.status === 401 || err.status === 403
              ? "auth_failed"
              : err.status >= 500
                ? "platform_5xx"
                : "platform_4xx"
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
        transportModes: ["gateway"] as const,
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
