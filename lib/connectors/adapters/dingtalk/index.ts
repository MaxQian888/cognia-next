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
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { DINGTALK_A2UI_CAPABILITY, DINGTALK_CAPS } from "./capability"
import { clearDingTalkTokenCache, DINGTALK_API_BASE, dingtalkAuthHeaders } from "./auth"
import { parseDingTalkBotMessage, type DingTalkBotMessage } from "./parse"
import {
  decodeDingTalkMessageId,
  encodeDingTalkMessageId,
  serializeOutbound,
  serializeRecall,
  type DingTalkSerialized,
} from "./serialize"
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

/** Consecutive register/ws-open failures before health degrades. */
const TRANSPORT_FAILURES_BEFORE_DEGRADED = 3

/** Stream union ids ($:LWCP_v1:$…) are not valid /oToMessages/batchSend userIds. */
const UNION_ID_PREFIX = "$:LWCP_v1:$"

/** Project the serialized message onto the classic robot-webhook payload shape. */
function toSessionWebhookPayload(serialized: DingTalkSerialized): Record<string, unknown> {
  if (serialized.msgKey === "sampleMarkdown") {
    return {
      msgtype: "markdown",
      markdown: { title: serialized.msgParam.title, text: serialized.msgParam.text },
    }
  }
  return { msgtype: "text", text: { content: serialized.msgParam.content } }
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
  let transportFailures = 0

  async function dingtalkPostOnce(
    path: string,
    payload: unknown
  ): Promise<Record<string, unknown>> {
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

  async function dingtalkPost(path: string, payload: unknown): Promise<Record<string, unknown>> {
    try {
      return await dingtalkPostOnce(path, payload)
    } catch (err) {
      // A 401/403 usually means the cached app access token outlived a secret
      // rotation — drop the cache entry and retry ONCE with a fresh token.
      // A second failure surfaces as auth_failed (non-retryable) upstream.
      if (err instanceof DingTalkApiError && (err.status === 401 || err.status === 403)) {
        const [appKey, appSecret] = await Promise.all([opts.appKey(), opts.appSecret()])
        clearDingTalkTokenCache(appKey, appSecret)
        return await dingtalkPostOnce(path, payload)
      }
      throw err
    }
  }

  /** POST to a transient sessionWebhook (classic robot-webhook shape, no token). */
  async function sessionWebhookPost(url: string, payload: Record<string, unknown>): Promise<void> {
    const resp = await connectorsHttpRequest({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    let body: Record<string, unknown>
    try {
      body = JSON.parse(resp.body) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new DingTalkApiError(
        `DingTalk session webhook failed: status ${resp.status}`,
        resp.status
      )
    }
    const errcode = typeof body.errcode === "number" ? body.errcode : 0
    if (errcode !== 0) {
      const msg = typeof body.errmsg === "string" ? body.errmsg : `errcode ${errcode}`
      throw new DingTalkApiError(`DingTalk session webhook failed: ${msg}`, 400)
    }
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal
    healthState = "running"
    healthReason = undefined
    transportFailures = 0
    if (!selfId) selfId = opts.selfId ?? ""

    const client = startDingTalkStream({
      clientId: opts.appKey,
      clientSecret: opts.appSecret,
      signal,
      // The stream generator retries register/ws-open failures silently
      // forever; this callback is the only signal that the transport is stuck
      // (e.g. wrong appKey/appSecret), so degrade health after N consecutive
      // failures and restore "running" once a connection lands.
      onTransportState: (state) => {
        if (stopCalled) return
        if (state.kind === "connected") {
          transportFailures = 0
          healthState = "running"
          healthReason = undefined
          return
        }
        transportFailures += 1
        if (transportFailures >= TRANSPORT_FAILURES_BEFORE_DEGRADED) {
          healthState = "degraded"
          healthReason = state.reason
        }
      },
    })
    ;(async () => {
      try {
        for await (const frame of client.frames) {
          if (signal.aborted) break
          if (frame.topic !== TOPIC_BOT_MESSAGE) continue
          const raw = frame.data as unknown as DingTalkBotMessage
          // Learn the bot's own user id from the first frame that carries it
          // (parse falls back per-event; this keeps adapter-level selfId set).
          if (!selfId && typeof raw?.chatbotUserId === "string" && raw.chatbotUserId) {
            selfId = raw.chatbotUserId
          }
          const normalized = parseDingTalkBotMessage(opts.id, selfId, raw)
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
      sessionWebhook?: string
      sessionWebhookExpiredTime?: number
    }
    const serialized = serializeOutbound(req)
    if (!serialized) return { ok: true }

    const robotCode = ref.robotCode || ""
    const msgParam = JSON.stringify(serialized.msgParam)
    const isGroup = ref.conversationType === "2"
    // The proactive-send endpoints answer with a `processQueryKey`; encoded
    // with the robot + scene it becomes the platformMessageId `delete()`
    // needs to route the recall. Session-webhook sends have no key.
    let platformMessageId: string | undefined

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
        const body = await dingtalkPost("/v1.0/robot/groupMessages/send", {
          robotCode,
          openConversationId,
          msgKey: serialized.msgKey,
          msgParam,
        })
        const processQueryKey = typeof body.processQueryKey === "string" ? body.processQueryKey : ""
        if (processQueryKey && robotCode) {
          platformMessageId = encodeDingTalkMessageId({
            scope: "group",
            robotCode,
            openConversationId,
            processQueryKey,
          })
        }
      } else {
        const rawUserId = ref.userId ?? ""
        // Union ids (external/inter-corp senders without a staffId) are
        // rejected by batchSend — fall back to the frame's session webhook.
        const staffId =
          rawUserId && !rawUserId.startsWith(UNION_ID_PREFIX) && rawUserId !== "unknown"
            ? rawUserId
            : ""
        if (staffId) {
          const body = await dingtalkPost("/v1.0/robot/oToMessages/batchSend", {
            robotCode,
            userIds: [staffId],
            msgKey: serialized.msgKey,
            msgParam,
          })
          const processQueryKey =
            typeof body.processQueryKey === "string" ? body.processQueryKey : ""
          if (processQueryKey && robotCode) {
            platformMessageId = encodeDingTalkMessageId({
              scope: "oto",
              robotCode,
              processQueryKey,
            })
          }
        } else {
          const webhook = ref.sessionWebhook ?? ""
          const webhookExpiry =
            typeof ref.sessionWebhookExpiredTime === "number" ? ref.sessionWebhookExpiredTime : 0
          if (webhook && webhookExpiry > Date.now()) {
            await sessionWebhookPost(webhook, toSessionWebhookPayload(serialized))
          } else {
            return {
              ok: false,
              error: {
                code: "validation",
                message:
                  "DingTalk 1:1 send: sender has no staffId (external/inter-corp user) and the session webhook is missing or expired",
                retryable: false,
              },
            }
          }
        }
      }
      lastActivityAt = Date.now()
      return { ok: true, platformMessageId }
    } catch (err) {
      return errorToResult(err)
    }
  }

  /**
   * Recall (撤回) a bot message. `messageId` must be the composite id
   * `send()` returned (robot + scene + processQueryKey); a bare / foreign id
   * cannot be routed and is rejected loudly. Session-webhook sends never get
   * an id and are therefore not recallable. Auth failures retry once through
   * `dingtalkPost` (token cache eviction), any other failure throws.
   */
  async function deleteMessage(messageId: string): Promise<void> {
    const decoded = decodeDingTalkMessageId(messageId)
    if (!decoded) {
      throw new Error(
        `DingTalk delete: expected a "dt:<scope>:<robotCode>:<openConversationId>:<processQueryKey>" id, got "${messageId}"`
      )
    }
    const call = serializeRecall(decoded)
    await dingtalkPost(call.path, call.payload)
    lastActivityAt = Date.now()
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
        // Stream mode is a persistent outbound WebSocket — a gateway transport.
        transportModes: ["gateway"] as const,
        configSchema: DINGTALK_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    delete: deleteMessage,
    refreshCredentials,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("dingtalk"),
    a2uiCapability: () => DINGTALK_A2UI_CAPABILITY,
    platformSkillCapabilities: () => [],
  }
}
