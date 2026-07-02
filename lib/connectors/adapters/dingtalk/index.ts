/**
 * DingTalk (钉钉) adapter factory.
 *
 * Assembles auth + parse + serialize + capability + the Stream-mode WebSocket
 * transport into a PlatformAdapter. Inbound flows over Stream mode (no public
 * server needed); outbound uses the OpenAPI proactive-send endpoints
 * (`/v1.0/robot/oToMessages/batchSend` for 1:1, `/v1.0/robot/groupMessages/send`
 * for group) authorised by the app access token.
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
import { DINGTALK_A2UI_CAPABILITY, DINGTALK_CAPS } from "./capability"
import { DINGTALK_API_BASE, dingtalkAuthHeaders } from "./auth"
import { parseDingTalkBotMessage, type DingTalkBotMessage } from "./parse"
import { serializeOutbound } from "./serialize"
import { startDingTalkStream, TOPIC_BOT_MESSAGE } from "./stream-client"

export interface DingTalkAdapterOptions {
  id: string
  displayName: string
  /** Resolves the AppKey (Stream clientId + default robotCode). */
  appKey: () => Promise<string>
  /** Resolves the AppSecret (Stream clientSecret). */
  appSecret: () => Promise<string>
  /** Resolves a fresh app access token for the OpenAPI send calls. */
  accessToken: () => Promise<string>
  /** Bot's own user id (chatbotUserId) when known. */
  selfId?: string
}

const DINGTALK_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["appKey", "appSecret"],
  properties: {
    appKey: { type: "string", title: "App Key" },
    appSecret: { type: "string", title: "App Secret" },
  },
  additionalProperties: false,
}

class DingTalkApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "DingTalkApiError"
  }
}

export function createDingTalkAdapter(opts: DingTalkAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  // Stable machine code for a non-running state; localized in the renderer
  // by `healthReasonLabel` (see the Lark adapter for the shared pattern).
  let healthReason: string | undefined = undefined
  let lastActivityAt: number | undefined
  let stopCalled = false
  let selfId = opts.selfId ?? ""

  async function dingtalkPost(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const token = await opts.accessToken()
    const resp = await connectorsHttpRequest({
      url: `${DINGTALK_API_BASE}${path}`,
      method: "POST",
      headers: dingtalkAuthHeaders(token),
      body: JSON.stringify(payload),
    })
    let body: Record<string, unknown>
    try {
      body = JSON.parse(resp.body) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (resp.status < 200 || resp.status >= 300) {
      const msg = typeof body.message === "string" ? body.message : `status ${resp.status}`
      throw new DingTalkApiError(`DingTalk POST ${path} failed: ${msg}`, resp.status)
    }
    return body
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal
    healthState = "running"
    healthReason = undefined
    if (!selfId) selfId = opts.selfId ?? ""

    const client = startDingTalkStream({
      clientId: opts.appKey,
      clientSecret: opts.appSecret,
      signal,
    })
    ;(async () => {
      try {
        for await (const frame of client.frames) {
          if (signal.aborted) break
          if (frame.topic !== TOPIC_BOT_MESSAGE) continue
          const normalized = parseDingTalkBotMessage(
            opts.id,
            selfId,
            frame.data as unknown as DingTalkBotMessage
          )
          if (!normalized) continue
          if (!(await gateInboundEvent(opts.id, normalized))) continue
          lastActivityAt = Date.now()
          await ctx.emit(normalized)
        }
        if (!stopCalled) {
          healthState = "down"
          healthReason = "no_data"
        }
      } catch {
        if (!stopCalled) {
          healthState = "degraded"
          healthReason = "transport_error"
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

  function errorToResult(err: unknown): OutboundResult {
    if (err instanceof DingTalkApiError) {
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

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const ref = req.conversationRef as {
      conversationType?: string
      userId?: string
      openConversationId?: string
      robotCode?: string
    }
    const serialized = serializeOutbound(req)
    if (!serialized) return { ok: true }

    const robotCode = ref.robotCode || ""
    const msgParam = JSON.stringify(serialized.msgParam)
    const isGroup = ref.conversationType === "2"

    try {
      if (isGroup) {
        const openConversationId = ref.openConversationId ?? ""
        if (!openConversationId) {
          return {
            ok: false,
            error: {
              code: "validation",
              message: "DingTalk group send: missing openConversationId",
              retryable: false,
            },
          }
        }
        await dingtalkPost("/v1.0/robot/groupMessages/send", {
          robotCode,
          openConversationId,
          msgKey: serialized.msgKey,
          msgParam,
        })
      } else {
        const userId = ref.userId ?? ""
        if (!userId) {
          return {
            ok: false,
            error: {
              code: "validation",
              message: "DingTalk 1:1 send: missing userId",
              retryable: false,
            },
          }
        }
        await dingtalkPost("/v1.0/robot/oToMessages/batchSend", {
          robotCode,
          userIds: [userId],
          msgKey: serialized.msgKey,
          msgParam,
        })
      }
      lastActivityAt = Date.now()
      return { ok: true }
    } catch (err) {
      return errorToResult(err)
    }
  }

  async function refreshCredentials(): Promise<void> {
    // No-op: appKey/appSecret/accessToken are resolvers called fresh per use.
  }

  return {
    get meta() {
      return {
        type: "dingtalk" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: DINGTALK_CAPS,
        transportModes: ["longpoll"] as const,
        configSchema: DINGTALK_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    refreshCredentials,
    a2uiCapability: () => DINGTALK_A2UI_CAPABILITY,
    platformSkillCapabilities: () => [],
  }
}
