/**
 * WeCom 智能机器人 (AI bot) adapter factory.
 *
 * Transport: the generic Rust WS bridge (`connectors_ws_*`) — the same
 * socket OneBot's forward-WS uses. WeCom frames are plain JSON text, so no
 * bespoke Rust handler (unlike Lark's protobuf `lark_ws.rs`). The Rust side
 * owns the socket lifecycle (survives webview reloads); this module manages
 * the `aibot_subscribe` handshake, the 30 s `ping`, exponential-backoff
 * reconnect, req_id↔response correlation, and the reply/proactive split.
 *
 * Reply vs proactive: an `aibot_respond_msg` reply must reuse the triggering
 * callback's `req_id` (valid ~10 min). `send()` inspects the outbound
 * `conversationRef.reqId` — when it's still live we reply (streaming or
 * template_card); otherwise we push proactively via `aibot_send_msg`.
 * `streamReply()` drives the live preview by reusing the same stream id.
 */

import { listen } from "@tauri-apps/api/event"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
  StreamReplyRequest,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildConversationKey } from "@/types/connectors/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { getBus } from "@/lib/connectors/bus"
import { WECOM_CAPS, WECOM_A2UI_CAPABILITY } from "./capability"
import {
  WECOM_WS_URL,
  WECOM_PING_INTERVAL_MS,
  classifyInboundFrame,
  buildSubscribeFrame,
  buildPingFrame,
  buildStreamRespondFrame,
  buildTemplateCardRespondFrame,
  buildWelcomeFrame,
  buildWelcomeCardFrame,
  buildUpdateCardFrame,
  buildSendMsgFrame,
  newReqId,
  type WeComFrameEnvelope,
  type WeComInboundMsgBody,
  type WeComInboundEventBody,
  type WeComProactiveBody,
} from "./protocol"
import { parseWeComMessage, type WeComConversationRef } from "./parse"
import { serializeSegments, type WeComMediaSegment } from "./serialize"
import { buildWeComTemplateCard, parseTemplateCardEvent, buildAckUpdateCard } from "./a2ui-mapper"
import { uploadWeComMedia, fetchAndDecryptMedia, bytesToBase64 } from "./media"
import { resolveWelcomeMessage, type WeComAdapterSettings } from "./welcome"
import { buildMenuClickInboundEvent, buildWeComMenuCard, parseMenuButtonClick } from "./menu-card"
import { normalizeQuickCommandList, resolveQuickCommand } from "@/lib/connectors/quick-commands"
import type { IMQuickCommand } from "@/lib/connectors/quick-commands/types"

type UnlistenFn = () => void

export interface WeComAdapterOptions {
  id: string
  displayName: string
  /** Resolves the bot_id from the keyring. */
  botId: () => Promise<string>
  /** Resolves the long-connection secret from the keyring. */
  secret: () => Promise<string>
  /** Non-secret per-instance settings (welcome message, etc.). */
  settings?: WeComAdapterSettings
  /** Test seam: override the WS endpoint. */
  _wsUrl?: string
  /** Test seam: reconnect backoff base ms (default 1000). */
  _backoffBaseMs?: number
}

const WECOM_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [],
  properties: {
    welcomeMessage: { type: "string", title: "Welcome message (enter_chat)" },
    quickCommands: {
      type: "array",
      title: "Quick commands (menu card buttons)",
      items: {
        type: "object",
        required: ["triggerKey", "action"],
        properties: {
          triggerKey: { type: "string" },
          label: { type: "string" },
          action: {
            type: "object",
            required: ["type", "value"],
            properties: {
              type: { enum: ["prompt", "slash"] },
              value: { type: "string" },
            },
          },
        },
      },
    },
  },
  additionalProperties: true,
}

const REQ_TTL_MS = 10 * 60 * 1000 // reply window per the protocol

export function createWeComAdapter(opts: WeComAdapterOptions): PlatformAdapter {
  // Normalise persisted quick-commands at factory time so the inbound
  // menu-button lookup runs against canonical `triggerKey` rows even when
  // older Dexie rows still carry the legacy `eventKey` field.
  const quickCommands: IMQuickCommand[] = normalizeQuickCommandList(opts.settings?.quickCommands)
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined
  let lastActivityAt: number | undefined
  let stopCalled = false

  let ctx: AdapterContext | null = null
  let handleId: string | null = null
  let unlistenMessage: UnlistenFn | null = null
  let unlistenClose: UnlistenFn | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let attempts = 0
  let selfId = ""

  /** echo(req_id) → resolver for in-flight outbound RPCs we await. */
  const pending = new Map<string, (resp: WeComFrameEnvelope) => void>()
  /** Live reply windows: req_id → expiry epoch ms. */
  const activeReqIds = new Map<string, number>()

  const wsUrl = opts._wsUrl ?? WECOM_WS_URL
  const backoffBaseMs = opts._backoffBaseMs ?? 1000

  // ── low-level send ────────────────────────────────────────────────────
  async function rawSend(frame: WeComFrameEnvelope): Promise<void> {
    const id = handleId
    if (!id) throw new Error("wecom WS not connected")
    await connectorsWsSend(id, JSON.stringify(frame))
  }

  /** Send a frame and await the matching `req_id` ack/response. */
  function request(frame: WeComFrameEnvelope, timeoutMs = 10_000): Promise<WeComFrameEnvelope> {
    const reqId = frame.headers?.req_id
    if (!reqId) return Promise.reject(new Error("request frame missing req_id"))
    return new Promise<WeComFrameEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId)
        reject(new Error(`wecom RPC timeout: ${frame.cmd}`))
      }, timeoutMs)
      pending.set(reqId, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })
      rawSend(frame).catch((err) => {
        clearTimeout(timer)
        pending.delete(reqId)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  function recordActiveReq(reqId: string | undefined): void {
    if (!reqId) return
    const now = Date.now()
    activeReqIds.set(reqId, now + REQ_TTL_MS)
    // Opportunistic prune.
    for (const [k, exp] of activeReqIds) if (exp < now) activeReqIds.delete(k)
  }

  function isReqLive(reqId: string | undefined): boolean {
    if (!reqId) return false
    const exp = activeReqIds.get(reqId)
    return exp !== undefined && exp > Date.now()
  }

  // ── inbound frame routing ───────────────────────────────────────────────
  async function routeFrame(payload: string): Promise<void> {
    const frame = classifyInboundFrame(payload)
    if (frame.kind === "ack") {
      if (frame.reqId && pending.has(frame.reqId)) {
        const resolve = pending.get(frame.reqId)!
        pending.delete(frame.reqId)
        // Re-parse the full envelope so callers can read body fields
        // (upload_id / media_id) the classifier discards.
        let env: WeComFrameEnvelope = { errcode: frame.errcode, errmsg: frame.errmsg }
        try {
          env = JSON.parse(payload) as WeComFrameEnvelope
        } catch {
          /* keep the minimal envelope */
        }
        resolve(env)
      }
      return
    }
    if (frame.kind === "message") {
      await handleMessage(frame.body, frame.reqId)
      return
    }
    if (frame.kind === "event") {
      await handleEvent(frame.body, frame.reqId)
      return
    }
    // unknown — ignore.
  }

  async function handleMessage(body: WeComInboundMsgBody, reqId?: string): Promise<void> {
    if (!selfId && body.aibotid) selfId = body.aibotid
    recordActiveReq(reqId)
    const event = parseWeComMessage(opts.id, selfId, body, reqId)
    if (!event) return
    // Best-effort: decrypt + inline an image so the model receives it.
    await resolveInboundImage(event.segments, body)
    if (!(await gateInboundEvent(opts.id, event))) return
    lastActivityAt = Date.now()
    await ctx?.emit(event)
  }

  async function handleEvent(body: WeComInboundEventBody, reqId?: string): Promise<void> {
    if (!selfId && body.aibotid) selfId = body.aibotid
    const type = body.event.eventtype
    if (type === "enter_chat") {
      // Quick-commands have priority over the plain-text welcome — they
      // give the user something to TAP, which is the whole point. Falls
      // back to the text welcome when no commands are configured.
      if (quickCommands.length > 0 && reqId) {
        const card = buildWeComMenuCard(quickCommands, {
          desc: resolveWelcomeMessage(opts.settings) ?? undefined,
        })
        if (card) {
          await rawSend(buildWelcomeCardFrame(reqId, card)).catch(() => undefined)
          return
        }
      }
      const welcome = resolveWelcomeMessage(opts.settings)
      if (welcome && reqId) {
        await rawSend(buildWelcomeFrame(reqId, welcome)).catch(() => undefined)
      }
      return
    }
    if (type === "template_card_event") {
      // Ack the card within 5 s so the user sees the click registered.
      if (reqId) {
        await rawSend(buildUpdateCardFrame(reqId, buildAckUpdateCard(body, "✓"))).catch(
          () => undefined
        )
      }
      // Quick-command (menu) buttons live in the `qc:` namespace — check
      // them BEFORE falling through to the generic A2UI callback dispatch
      // so the resolver doesn't try to look up a non-existent binding.
      const menuClick = parseMenuButtonClick(body)
      if (menuClick) {
        recordActiveReq(reqId)
        const cmd = resolveQuickCommand(quickCommands, menuClick.triggerKey)
        if (cmd) {
          const event = buildMenuClickInboundEvent(opts.id, selfId, body, cmd)
          if (event && (await gateInboundEvent(opts.id, event))) {
            lastActivityAt = Date.now()
            await ctx?.emit(event)
          }
        }
        return
      }
      const callback = parseTemplateCardEvent(opts.id, selfId, body)
      if (callback) {
        lastActivityAt = Date.now()
        await getBus().dispatchConnectorCallback(callback)
      }
      return
    }
    // feedback_event / disconnected_event — no action beyond activity stamp.
    lastActivityAt = Date.now()
  }

  /**
   * Decrypt the first inbound image and inline it as base64 on the segment so
   * `inboundEventToSendContent` hands the model a real image. Best-effort: any
   * fetch / decrypt failure leaves the URL marker untouched.
   */
  async function resolveInboundImage(
    segments: MessageSegment[],
    body: WeComInboundMsgBody
  ): Promise<void> {
    if (body.msgtype !== "image" || !body.image?.url) return
    try {
      const bytes = await fetchAndDecryptMedia(body.image.url, body.image.aeskey)
      const seg = segments.find((s) => s.type === "image")
      if (seg && seg.type === "image") {
        ;(seg as { dataBase64?: string; mimeType?: string }).dataBase64 = bytesToBase64(bytes)
        ;(seg as { mimeType?: string }).mimeType = "image/png"
      }
    } catch {
      /* keep the URL marker — Inbox still shows [image] */
    }
  }

  // ── connection lifecycle ────────────────────────────────────────────────
  function cleanupListeners(): void {
    unlistenMessage?.()
    unlistenMessage = null
    unlistenClose?.()
    unlistenClose = null
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  async function subscribe(): Promise<void> {
    const [botId, secret] = await Promise.all([opts.botId(), opts.secret()])
    const resp = await request(buildSubscribeFrame(newReqId(opts.id), botId, secret), 15_000)
    if (typeof resp.errcode === "number" && resp.errcode !== 0) {
      healthState = "degraded"
      healthReason = `subscribe failed: ${resp.errcode} ${resp.errmsg ?? ""}`.trim()
      throw new Error(healthReason)
    }
    healthState = "running"
    healthReason = undefined
    lastActivityAt = Date.now()
  }

  async function connectOnce(): Promise<void> {
    const id = await connectorsWsOpen(wsUrl)
    handleId = id
    attempts = 0
    unlistenMessage = await listen<string>(`connectors://ws/${id}/message`, (e) => {
      void routeFrame(e.payload)
    })
    unlistenClose = await listen<void>(`connectors://ws/${id}/close`, () => {
      handleId = null
      rejectAllPending("connection closed")
      if (!stopCalled) {
        healthState = "degraded"
        healthReason = "connection closed"
        void scheduleReconnect()
      }
    })
    await subscribe()
    // Heartbeat — fire-and-forget; the close event drives reconnection.
    pingTimer = setInterval(() => {
      void rawSend(buildPingFrame(newReqId(opts.id))).catch(() => undefined)
    }, WECOM_PING_INTERVAL_MS)
  }

  function rejectAllPending(reason: string): void {
    for (const [, resolve] of pending) {
      // Resolve with an error envelope so awaiting callers fail cleanly.
      resolve({ errcode: -1, errmsg: reason })
    }
    pending.clear()
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function scheduleReconnect(): Promise<void> {
    cleanupListeners()
    if (stopCalled) return
    attempts += 1
    await delay(reconnectBackoffMs(backoffBaseMs, attempts))
    if (stopCalled) return
    try {
      await connectOnce()
    } catch {
      void scheduleReconnect()
    }
  }

  // ── outbound: media upload ────────────────────────────────────────────────
  async function uploadMedia(seg: WeComMediaSegment): Promise<string | null> {
    try {
      const resp = await fetch(seg.url)
      if (!resp.ok) return null
      const bytes = new Uint8Array(await resp.arrayBuffer())
      const name = seg.name ?? `media.${seg.type === "image" ? "png" : "bin"}`
      return await uploadWeComMedia(request, opts.id, bytes, name, seg.type)
    } catch {
      return null
    }
  }

  // ── outbound: send ────────────────────────────────────────────────────────
  function streamIdFor(ref: WeComConversationRef): string {
    return `wecom-stream:${ref.reqId ?? ref.sourceMsgId ?? ref.chatId}`
  }

  async function streamReply(req: StreamReplyRequest): Promise<void> {
    const ref = req.conversationRef as WeComConversationRef
    if (!isReqLive(ref.reqId) || !ref.reqId) return
    if (!req.text) return
    await rawSend(buildStreamRespondFrame(ref.reqId, streamIdFor(ref), req.text, false)).catch(
      () => undefined
    )
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const ref = req.conversationRef as WeComConversationRef
    const serialized = serializeSegments(req.segments)

    // Map the first interactive A2UI surface to a template_card (records
    // callback bindings). Subsequent surfaces degrade via their mirror text
    // already folded into `serialized.markdown`.
    const conversationKey = ref.chatId
      ? buildConversationKey("wecom", opts.id, ref.chatId)
      : undefined
    let templateCard = null as Awaited<ReturnType<typeof buildWeComTemplateCard>>
    for (const surface of serialized.a2uiSurfaces) {
      templateCard = await buildWeComTemplateCard(opts.id, surface, conversationKey)
      if (templateCard) break
    }

    // Upload any media segments to obtain media_ids.
    const mediaIds: Array<{ type: WeComMediaSegment["type"]; mediaId: string }> = []
    for (const m of serialized.media) {
      const id = await uploadMedia(m)
      if (id) mediaIds.push({ type: m.type, mediaId: id })
    }

    const isReply = isReqLive(ref.reqId)
    try {
      if (isReply && ref.reqId) {
        const reqId = ref.reqId
        // Finalise the (possibly already-streamed) text as a finished stream.
        if (serialized.markdown) {
          await request(buildStreamRespondFrame(reqId, streamIdFor(ref), serialized.markdown, true))
        }
        if (templateCard) {
          await request(buildTemplateCardRespondFrame(reqId, templateCard))
        }
        for (const m of mediaIds) {
          await request({
            cmd: "aibot_respond_msg",
            headers: { req_id: reqId },
            body: { msgtype: m.type, [m.type]: { media_id: m.mediaId } },
          })
        }
        if (!serialized.markdown && !templateCard && mediaIds.length === 0) {
          return {
            ok: false,
            error: { code: "validation", message: "empty reply", retryable: false },
          }
        }
        return { ok: true, downgrades: serialized.downgrades }
      }

      // Proactive push (no live reply window). WeCom only delivers these to a
      // chat the user has previously messaged the bot in.
      const chatType: 0 | 1 | 2 = ref.chatType === "group" ? 2 : ref.chatType === "single" ? 1 : 0
      const chatid = ref.chatId
      if (!chatid) {
        return {
          ok: false,
          error: { code: "validation", message: "no chatid for proactive send", retryable: false },
        }
      }
      const frames: WeComProactiveBody[] = []
      if (serialized.markdown) {
        frames.push({
          chatid,
          chat_type: chatType,
          msgtype: "markdown",
          markdown: { content: serialized.markdown },
        })
      }
      if (templateCard) {
        frames.push({
          chatid,
          chat_type: chatType,
          msgtype: "template_card",
          template_card: templateCard,
        })
      }
      for (const m of mediaIds) {
        frames.push({
          chatid,
          chat_type: chatType,
          msgtype: m.type,
          media: { media_id: m.mediaId },
        })
      }
      if (frames.length === 0) {
        return {
          ok: false,
          error: { code: "validation", message: "empty message", retryable: false },
        }
      }
      for (const body of frames) {
        await request(buildSendMsgFrame(newReqId(opts.id), body))
      }
      return { ok: true, downgrades: serialized.downgrades }
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

  // ── PlatformAdapter surface ────────────────────────────────────────────────
  async function start(c: AdapterContext): Promise<void> {
    ctx = c
    stopCalled = false
    healthState = "starting"
    try {
      await connectOnce()
    } catch {
      healthState = "degraded"
      void scheduleReconnect()
    }
  }

  async function stop(): Promise<void> {
    stopCalled = true
    cleanupListeners()
    rejectAllPending("adapter stopped")
    activeReqIds.clear()
    const id = handleId
    handleId = null
    if (id) {
      await connectorsWsClose(id).catch(() => undefined)
    }
    healthState = "down"
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  return {
    get meta() {
      return {
        type: "wecom" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: WECOM_CAPS,
        transportModes: ["gateway"] as const,
        configSchema: WECOM_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    streamReply,
    a2uiCapability: () => WECOM_A2UI_CAPABILITY,
  }
}
