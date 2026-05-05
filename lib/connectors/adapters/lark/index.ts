/**
 * Lark adapter factory — Task 89.
 *
 * Assembles parse + serialize + capability + transport into a PlatformAdapter.
 * Supports two transports:
 *   - long-connection (default): uses /im/v1/wsServer + WSS
 *   - webhook: subscribes to Tauri event channel from Rust HTTP proxy
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { LARK_CAPS } from "./capability"
import { parseLarkEventEnvelope } from "./parse"
import type { LarkEventEnvelope } from "./parse"
import { serializeOutbound, serializeEdit, serializeDelete, serializeReaction } from "./serialize"
import { getTenantAccessToken } from "./auth"
import { startLarkLongConn } from "./transport-long-conn"
import { startLarkWebhookTransport } from "./transport-webhook"

export interface LarkAdapterOptions {
  id: string
  displayName: string
  /** Resolves the App ID (cli_...) on each call. */
  appId: () => Promise<string>
  /** Resolves the App Secret on each call. */
  appSecret: () => Promise<string>
  /** Optional Encrypt Key; required when webhook+encryption is enabled. */
  encryptKey?: () => Promise<string>
  /** Verification Token for webhook header validation. */
  verificationToken: () => Promise<string>
  /** Bot's own open_id; used to detect self-mentions. */
  selfBotOpenId: string
  transport: "webhook" | "long-connection"
}

const LARK_API_BASE = "https://open.feishu.cn/open-apis"

const LARK_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["appId", "appSecret", "verificationToken", "transport"],
  properties: {
    appId: { type: "string", title: "App ID (cli_...)" },
    appSecret: { type: "string", title: "App Secret" },
    encryptKey: { type: "string", title: "Encrypt Key (optional)" },
    verificationToken: { type: "string", title: "Verification Token" },
    transport: {
      type: "string",
      enum: ["long-connection", "webhook"],
      title: "Transport",
      default: "long-connection",
    },
  },
  additionalProperties: false,
}

export function createLarkAdapter(opts: LarkAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false

  async function getTat(): Promise<string> {
    const [appId, appSecret] = await Promise.all([opts.appId(), opts.appSecret()])
    return getTenantAccessToken({ appId, appSecret })
  }

  async function doRequest(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    urlPath: string,
    body?: unknown
  ): Promise<unknown> {
    const tat = await getTat()
    const resp = await connectorsHttpRequest({
      url: `${LARK_API_BASE}${urlPath}`,
      method,
      headers: {
        Authorization: `Bearer ${tat}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (resp.status >= 400) {
      throw new Error(`Lark API ${method} ${urlPath} → ${resp.status}: ${resp.body}`)
    }
    const parsed = resp.body ? (JSON.parse(resp.body) as { code?: number; msg?: string }) : null
    if (parsed && typeof parsed.code === "number" && parsed.code !== 0) {
      throw new Error(`Lark API error: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`)
    }
    return parsed
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal

    healthState = "running"

    if (opts.transport === "long-connection") {
      ;(async () => {
        try {
          const generator = startLarkLongConn({
            tenantAccessToken: getTat,
            signal,
          })
          for await (const envelope of generator) {
            if (signal.aborted) break
            const event = parseLarkEventEnvelope(
              opts.id,
              opts.selfBotOpenId,
              envelope as LarkEventEnvelope
            )
            if (event) {
              lastActivityAt = Date.now()
              await ctx.emit(event)
            }
          }
          if (!stopCalled) {
            healthState = "down"
          }
        } catch {
          if (!stopCalled) {
            healthState = "degraded"
          }
        }
      })()
    } else {
      // webhook transport
      ;(async () => {
        try {
          const generator = startLarkWebhookTransport({
            adapterId: opts.id,
            signal,
          })
          for await (const envelope of generator) {
            if (signal.aborted) break
            const event = parseLarkEventEnvelope(
              opts.id,
              opts.selfBotOpenId,
              envelope as LarkEventEnvelope
            )
            if (event) {
              lastActivityAt = Date.now()
              await ctx.emit(event)
            }
          }
          if (!stopCalled) {
            healthState = "down"
          }
        } catch {
          if (!stopCalled) {
            healthState = "degraded"
          }
        }
      })()
    }
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
    try {
      const call = serializeOutbound(req)
      const urlPath = call.url.replace(LARK_API_BASE, "")
      await doRequest(call.method, urlPath, call.payload)
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

  async function edit(messageId: string, patch: OutboundRequest): Promise<OutboundResult> {
    try {
      const call = serializeEdit(messageId, patch)
      const urlPath = call.url.replace(LARK_API_BASE, "")
      await doRequest(call.method, urlPath, call.payload)
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

  async function deleteMessage(messageId: string): Promise<void> {
    const call = serializeDelete(messageId)
    const urlPath = call.url.replace(LARK_API_BASE, "")
    await doRequest(call.method, urlPath)
  }

  async function* fetchHistory(
    _conversationKey: string,
    _opts: { before?: string; after?: string; max?: number }
  ): AsyncIterable<import("@/types/connectors").NormalizedInboundEvent> {
    // TODO Phase 2: implement /im/v1/messages list with cursor pagination
  }

  async function setTyping(_conversationKey: string, _on: boolean): Promise<void> {
    // Lark has no native typing indicator for bots in Phase 1 — no-op.
  }

  async function refreshCredentials(): Promise<void> {
    // All token resolvers call fresh on each request; cache handles the rest.
  }

  async function addReaction(messageId: string, emojiType: string): Promise<void> {
    const call = serializeReaction(messageId, emojiType)
    const urlPath = call.url.replace(LARK_API_BASE, "")
    await doRequest(call.method, urlPath, call.payload)
  }

  const adapter: PlatformAdapter & { addReaction?: typeof addReaction } = {
    get meta() {
      return {
        type: "lark" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: LARK_CAPS,
        transportModes: [opts.transport === "long-connection" ? "gateway" : "webhook"] as const,
        configSchema: LARK_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    edit,
    delete: deleteMessage,
    fetchHistory,
    setTyping,
    refreshCredentials,
    addReaction,
  }

  return adapter
}
