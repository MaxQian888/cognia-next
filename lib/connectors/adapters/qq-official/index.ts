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
import type { ReactionRef } from "@/types/connectors/adapter"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { QQ_OFFICIAL_A2UI_CAPABILITY, QQ_OFFICIAL_CAPS } from "./capability"
import { QQ_API_BASE, clearQQTokenCacheByToken, getQQGatewayUrl, qqAuthHeaders } from "./auth"
import { parseQQDispatch, type QQDispatch, type QQScene } from "./parse"
import {
  QQ_MAX_PASSIVE_REPLIES,
  QQ_PASSIVE_WINDOW_MS,
  decodeQQMessageId,
  encodeQQMessageId,
  qqPassiveMsgSeq,
  qqPassiveReplyCount,
  registerQQPassiveReply,
  serializeDelete,
  serializeOutbound,
  serializeReaction,
  serializeTyping,
} from "./serialize"
import { startQQGateway } from "./gateway-client"
import { startWebhookTransport } from "./transport-webhook"
import { enrichQQInboundMedia } from "./inbound-media"

export interface QQOfficialAdapterOptions {
  id: string
  displayName: string
  /** Resolves a fresh app access token (without the `QQBot ` prefix). */
  accessToken: () => Promise<string>
  /**
   * Evict the cached app access token for this row's credentials (injected
   * by `adapter-registry.buildQQOfficialAdapter`). Called from
   * `refreshCredentials()` and when the gateway reports OP 9
   * INVALID_SESSION, so the next resolve re-mints instead of re-using a
   * token the platform already rejected.
   */
  clearTokenCache?: () => void | Promise<void>
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

/**
 * Last inbound message per conversation — what `setTyping` needs to address
 * a C2C typing indicator (a passive `msg_type: 6` reply). `buildConversationKey`
 * drops the scene, so the key alone cannot tell c2c from group; the entry
 * carries the scene, the addressing id, the inbound msg_id and its receipt
 * time (for the passive-window check). Bounded per adapter instance.
 */
interface QQLastInbound {
  scene: QQScene
  sceneId: string
  msgId: string
  receivedAt: number
}

const LAST_INBOUND_CAP = 500

/**
 * A typing indicator consumes one passive-reply slot of the inbound msg_id.
 * Only fire while strictly fewer than this many slots are used, so the real
 * reply (slot 5) always still fits after the indicator (slot ≤4).
 * UNVERIFIED: QQ does not document whether `input_notify` counts against the
 * 5-reply cap; treating it as consuming is the conservative reading.
 */
const TYPING_MAX_USED_SLOTS = QQ_MAX_PASSIVE_REPLIES - 1

/** Extract `{ id, code, message }` from a QQ JSON body (tolerates non-JSON). */
function parseQQBody(raw: string): { id?: string; message?: string; code?: number } {
  try {
    return JSON.parse(raw) as { id?: string; message?: string; code?: number }
  } catch {
    return {}
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
  const lastInbound = new Map<string, QQLastInbound>()

  /** Shared per-dispatch pipeline: parse → at-gate → bus emit. */
  async function handleDispatch(
    ctx: AdapterContext,
    selfId: string,
    dispatch: QQDispatch
  ): Promise<void> {
    const event = parseQQDispatch(opts.id, selfId, dispatch)
    if (!event) return
    const ref = event.conversationRef as {
      scene?: QQScene
      sceneId?: string
      msgId?: string
      receivedAt?: number
    }
    if (ref.scene && ref.sceneId && ref.msgId) {
      rememberInbound(event.conversationKey, {
        scene: ref.scene,
        sceneId: ref.sceneId,
        msgId: ref.msgId,
        receivedAt: ref.receivedAt ?? Date.now(),
      })
    }
    if (!(await gateInboundEvent(opts.id, event))) return
    lastActivityAt = Date.now()
    // Download what the parser could only reference, so a picture sent to the
    // bot reaches the model as an image rather than as the text
    // `[image: https://gchat.qpic.cn/…]`. After the gate: a message that is
    // going to be dropped costs no downloads.
    await enrichQQInboundMedia(event)
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
      // OP 9 INVALID_SESSION: the platform rejected our IDENTIFY/RESUME —
      // evict the cached token so the reconnect re-mints instead of looping
      // on the same rejected credential.
      onAuthInvalid: () => opts.clearTokenCache?.(),
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

  function rememberInbound(conversationKey: string, ref: QQLastInbound): void {
    lastInbound.delete(conversationKey)
    lastInbound.set(conversationKey, ref)
    while (lastInbound.size > LAST_INBOUND_CAP) {
      const oldest = lastInbound.keys().next().value
      if (oldest === undefined) break
      lastInbound.delete(oldest)
    }
  }

  /**
   * One authenticated REST round-trip. Retries exactly once on 401/403 with
   * a re-minted token (the cached app token, ~2h TTL, may be stale after a
   * console-side secret rotation — without the retry every call stays
   * bricked for hours). Throws `QQApiError` for any non-2xx status.
   */
  async function qqRequest(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: { id?: string; message?: string; code?: number } }> {
    const doCall = (token: string) =>
      connectorsHttpRequest({
        url: `${apiBase}${path}`,
        method,
        headers: qqAuthHeaders(token),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    let token = await opts.accessToken()
    let resp = await doCall(token)
    if (resp.status === 401 || resp.status === 403) {
      clearQQTokenCacheByToken(token)
      await opts.clearTokenCache?.()
      token = await opts.accessToken()
      resp = await doCall(token)
    }
    const parsed = parseQQBody(resp.body)
    if (resp.status < 200 || resp.status >= 300) {
      // Surface the platform's numeric `code` and the X-Tps-trace-id
      // header — both are what QQ support asks for when triaging.
      const traceId = resp.headers["X-Tps-trace-id"] ?? resp.headers["x-tps-trace-id"]
      const detail = `${parsed.message ?? resp.body.slice(0, 200)}${
        parsed.code !== undefined ? ` (code ${parsed.code})` : ""
      }${traceId ? ` [trace ${traceId}]` : ""}`
      throw new QQApiError(`QQ ${method} ${path} failed: ${detail}`, resp.status, parsed.code)
    }
    return { status: resp.status, body: parsed }
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
    const ref = req.conversationRef as { scene?: QQScene; sceneId?: string }
    try {
      const { body } = await qqRequest("POST", call.path, call.payload)
      lastActivityAt = Date.now()
      if (healthState === "running") healthReason = undefined
      // Composite id: delete/reaction need the scene + addressing id later.
      const platformMessageId =
        body.id && ref.scene && ref.sceneId
          ? encodeQQMessageId(ref.scene, ref.sceneId, body.id)
          : body.id
      return { ok: true, platformMessageId }
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

  /**
   * Recall (撤回) a message this bot sent. `messageId` must be the composite
   * `${scene}:${sceneId}:${id}` that `send()` returned — a bare id cannot be
   * routed to a scene endpoint and is rejected loudly rather than guessed.
   */
  async function deleteMessage(messageId: string): Promise<void> {
    const decoded = decodeQQMessageId(messageId)
    if (!decoded) {
      throw new Error(
        `QQ delete: expected a composite "scene:sceneId:id" message id, got "${messageId}"`
      )
    }
    const call = serializeDelete(decoded)
    await qqRequest(call.method, call.path)
    lastActivityAt = Date.now()
  }

  /**
   * Typing indicator — C2C only (group / channel / direct have no typing
   * API). It is itself a passive reply, so it needs a cached inbound msg_id
   * that is still inside the 60-minute C2C window and has < 4 passive slots
   * used. Anything else is a silent no-op: the bus treats typing as
   * best-effort and a throw would only surface as noise.
   */
  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!on) return
    const last = lastInbound.get(conversationKey)
    if (!last || last.scene !== "c2c") return
    if (Date.now() - last.receivedAt > QQ_PASSIVE_WINDOW_MS.c2c) return
    if (qqPassiveReplyCount(last.msgId) >= TYPING_MAX_USED_SLOTS) return
    // Each indicator gets its own passive slot + a seq that cannot collide
    // with the reply's idempotency-derived seq (distinct key namespace).
    const key = `typing:${last.msgId}:${qqPassiveReplyCount(last.msgId) + 1}`
    registerQQPassiveReply(last.msgId, key)
    const call = serializeTyping(last.sceneId, last.msgId, qqPassiveMsgSeq(key))
    await qqRequest(call.method, call.path, call.payload)
    lastActivityAt = Date.now()
  }

  /**
   * Reactions exist only in the guild `channel` scene. `emojiType` is
   * `"<type>:<id>"` (QQ addresses emoji by type + id). Group / C2C / direct
   * ids throw `unsupported` so the bus surfaces it instead of a 404.
   */
  function requireChannelScene(messageId: string, op: string): { channelId: string; id: string } {
    const decoded = decodeQQMessageId(messageId)
    if (!decoded) {
      throw new Error(
        `QQ ${op}: expected a composite "scene:sceneId:id" message id, got "${messageId}"`
      )
    }
    if (decoded.scene !== "channel") {
      throw new Error(
        `QQ ${op}: unsupported — reactions only exist in the channel scene (got ${decoded.scene})`
      )
    }
    return { channelId: decoded.sceneId, id: decoded.id }
  }

  async function addReaction(messageId: string, emojiType: string): Promise<ReactionRef> {
    const { channelId, id } = requireChannelScene(messageId, "addReaction")
    const call = serializeReaction(channelId, id, emojiType, "add")
    await qqRequest(call.method, call.path)
    lastActivityAt = Date.now()
    // QQ has no reaction handle; the emoji type doubles as the removal id.
    return { reactionId: emojiType }
  }

  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const { channelId, id } = requireChannelScene(messageId, "removeReaction")
    const call = serializeReaction(channelId, id, reactionId, "remove")
    await qqRequest(call.method, call.path)
    lastActivityAt = Date.now()
  }

  async function refreshCredentials(): Promise<void> {
    // The access token is resolved fresh on each gateway connect / REST call;
    // refreshing means evicting the cached mint so the next resolve re-mints.
    await opts.clearTokenCache?.()
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
    delete: deleteMessage,
    setTyping,
    addReaction,
    removeReaction,
    refreshCredentials,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("qq-official"),
    a2uiCapability: () => QQ_OFFICIAL_A2UI_CAPABILITY,
  }
}
