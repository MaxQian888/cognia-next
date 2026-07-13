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
  buildStreamWithTemplateCardFrame,
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

/** Ack carried a non-zero errcode; `retryable` mirrors the outbound queue's semantics. */
class WeComAckError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = "WeComAckError"
  }
}

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
  /** Test seam: heartbeat interval ms (default {@link WECOM_PING_INTERVAL_MS}). */
  _pingIntervalMs?: number
  /** Test seam: per-ping ack timeout ms (default 10 000). */
  _pingTimeoutMs?: number
  /** Test seam: observe reconnect attempts (called with the attempt counter). */
  _onReconnectAttempt?: (attempt: number) => void
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

// Reply-window bookkeeping. Per the protocol doc: a STREAMED reply must
// complete within 10 minutes of its FIRST stream frame, while welcome
// (enter_chat) and template-card-update replies must land within 5 seconds of
// the callback. We keep a req_id addressable for the 10-minute stream budget;
// the 5 s SLAs are met by replying inline in the event handler.
const REQ_TTL_MS = 10 * 60 * 1000

/** Consecutive heartbeat-ack misses before the socket is declared half-dead. */
const PING_MISS_LIMIT = 2

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
  let pingMisses = 0
  let attempts = 0
  let selfId = ""

  /** echo(req_id) → resolver for in-flight outbound RPCs we await. */
  const pending = new Map<string, (resp: WeComFrameEnvelope) => void>()
  /** Live reply windows: req_id → expiry epoch ms. */
  const activeReqIds = new Map<string, number>()
  /**
   * chatId → most recent live req_id. Fallback addressing for turns whose
   * outbound `conversationRef` carries no (or a stale) `reqId` — e.g. A2UI
   * card callbacks, whose `ConnectorCallbackEvent` has no conversationRef
   * field — so their replies still ride the live reply window instead of
   * degrading to a proactive push.
   */
  const liveReqByChat = new Map<string, string>()
  /**
   * req_id → cumulative text of an open (unfinished) stream preview. Lets
   * `send()` close the stream (`finish:true`) even when the final message
   * carries no text (card/media-only), so the platform preview never hangs
   * in "generating".
   */
  const openStreams = new Map<string, string>()
  /**
   * Ack aliasing guard (fire-and-forget frames vs awaited requests).
   *
   * The protocol's ack frames echo ONLY `headers.req_id` — there is no
   * per-frame nonce — and `streamReply()` / the card-update ack send frames
   * under the SAME req_id that `send()` later awaits via `request()`. A late
   * ack for one of those earlier frames would otherwise resolve `send()`'s
   * pending entry with the wrong result. The WS delivers acks in frame order,
   * so we count the acks still owed to fire-and-forget frames per req_id and
   * swallow exactly that many before letting an ack resolve `pending`.
   */
  const ackDebts = new Map<string, number>()

  const wsUrl = opts._wsUrl ?? WECOM_WS_URL
  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  const pingIntervalMs = opts._pingIntervalMs ?? WECOM_PING_INTERVAL_MS
  const pingTimeoutMs = opts._pingTimeoutMs ?? 10_000

  // ── low-level send ────────────────────────────────────────────────────
  async function rawSend(frame: WeComFrameEnvelope): Promise<void> {
    const id = handleId
    if (!id) throw new Error("wecom WS not connected")
    await connectorsWsSend(id, JSON.stringify(frame))
  }

  /**
   * Fire-and-forget send on a req_id that may later carry an awaited
   * `request()` — records the owed ack so it cannot alias (see `ackDebts`).
   * The debt is recorded only after the transport accepted the frame; the
   * server round-trip is orders of magnitude slower, so the ack cannot beat
   * the increment.
   */
  async function rawSendCounted(reqId: string, frame: WeComFrameEnvelope): Promise<void> {
    await rawSend(frame)
    ackDebts.set(reqId, (ackDebts.get(reqId) ?? 0) + 1)
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

  /**
   * `request()` + errcode gate: a resolved ack with `errcode !== 0` is a
   * FAILURE, not a delivery. `errcode -1` is retryable — it is both our
   * synthetic connection-loss envelope (`rejectAllPending`) and WeCom's
   * generic "system busy, try again" code; every other non-zero code is a
   * definitive platform rejection surfaced with its errmsg.
   */
  async function requestOk(
    frame: WeComFrameEnvelope,
    timeoutMs?: number
  ): Promise<WeComFrameEnvelope> {
    const resp = await request(frame, timeoutMs)
    if (typeof resp.errcode === "number" && resp.errcode !== 0) {
      throw new WeComAckError(
        `wecom ${frame.cmd ?? "frame"} rejected: ${resp.errcode} ${resp.errmsg ?? ""}`.trim(),
        resp.errcode === -1
      )
    }
    return resp
  }

  function recordActiveReq(reqId: string | undefined, chatId?: string): void {
    if (!reqId) return
    const now = Date.now()
    activeReqIds.set(reqId, now + REQ_TTL_MS)
    if (chatId) liveReqByChat.set(chatId, reqId)
    // Opportunistic prune (both maps stay tiny).
    for (const [k, exp] of activeReqIds) if (exp < now) activeReqIds.delete(k)
    for (const [chat, rid] of liveReqByChat) if (!activeReqIds.has(rid)) liveReqByChat.delete(chat)
  }

  function isReqLive(reqId: string | undefined): boolean {
    if (!reqId) return false
    const exp = activeReqIds.get(reqId)
    return exp !== undefined && exp > Date.now()
  }

  /**
   * Resolve the live req_id an outbound should reply on: the ref's own
   * `reqId` when still live, else the chat's most recent live req (covers
   * A2UI card callbacks / menu clicks whose triggering ref is stale).
   */
  function resolveLiveReqId(ref: WeComConversationRef): string | undefined {
    if (isReqLive(ref.reqId)) return ref.reqId
    const byChat = ref.chatId ? liveReqByChat.get(ref.chatId) : undefined
    return isReqLive(byChat) ? byChat : undefined
  }

  // ── inbound frame routing ───────────────────────────────────────────────
  async function routeFrame(payload: string): Promise<void> {
    const frame = classifyInboundFrame(payload)
    if (frame.kind === "ack") {
      const debtReqId = frame.reqId
      if (debtReqId) {
        const debt = ackDebts.get(debtReqId) ?? 0
        if (debt > 0) {
          // Ack for an earlier fire-and-forget frame (stream preview /
          // card-update) on this req_id — swallow it so it cannot resolve a
          // later `request()`'s pending entry (acks arrive in frame order).
          if (debt === 1) ackDebts.delete(debtReqId)
          else ackDebts.set(debtReqId, debt - 1)
          return
        }
      }
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
    recordActiveReq(reqId, body.chatid)
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
      // Every card click opens a fresh reply window — record it (keyed to
      // the chat too) BEFORE dispatching, so the triggered turn replies
      // through the live req instead of degrading to a proactive push.
      recordActiveReq(reqId, body.chatid)
      // Ack the card within 5 s so the user sees the click registered.
      // Counted: its ack shares the (now-active) req_id a later reply may
      // await via `request()` — see `ackDebts`.
      if (reqId) {
        await rawSendCounted(
          reqId,
          buildUpdateCardFrame(reqId, buildAckUpdateCard(body, "✓"))
        ).catch(() => undefined)
      }
      // Quick-command (menu) buttons live in the `qc:` namespace — check
      // them BEFORE falling through to the generic A2UI callback dispatch
      // so the resolver doesn't try to look up a non-existent binding.
      const menuClick = parseMenuButtonClick(body)
      if (menuClick) {
        const cmd = resolveQuickCommand(quickCommands, menuClick.triggerKey)
        if (cmd) {
          const event = buildMenuClickInboundEvent(opts.id, selfId, body, cmd, reqId)
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
        // `ConnectorCallbackEvent` carries no conversationRef (shared type),
        // so the reply window recorded above is recovered at send() time via
        // the `liveReqByChat` chat-level fallback.
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
    try {
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
    } catch (err) {
      // A failed handshake must NOT leak the Rust-side socket: WeCom allows
      // exactly ONE connection per bot, so a leaked handle fights the next
      // (re)connect attempt. Detach listeners first so our own close does
      // not double-schedule a reconnect.
      cleanupListeners()
      handleId = null
      await connectorsWsClose(id).catch(() => undefined)
      throw err
    }
    // Reset the backoff only AFTER a successful subscribe — resetting on
    // socket-open would hammer bad credentials at base backoff forever.
    attempts = 0
    pingMisses = 0
    pingTimer = setInterval(() => {
      void heartbeat()
    }, pingIntervalMs)
  }

  /**
   * Heartbeat with ack-miss detection: each ping is correlated through the
   * pending-request plumbing; {@link PING_MISS_LIMIT} consecutive misses mean
   * a half-dead socket (TCP up, peer gone) — force-close and reconnect
   * instead of zombie-ing with health "running".
   */
  async function heartbeat(): Promise<void> {
    try {
      await requestOk(buildPingFrame(newReqId(opts.id)), pingTimeoutMs)
      pingMisses = 0
    } catch {
      pingMisses += 1
      if (pingMisses < PING_MISS_LIMIT || stopCalled) return
      // Socket already gone (close event owns reconnection) — don't race it.
      if (handleId === null) return
      pingMisses = 0
      healthState = "degraded"
      healthReason = "heartbeat lost"
      cleanupListeners()
      rejectAllPending("heartbeat lost")
      const id = handleId
      handleId = null
      if (id) await connectorsWsClose(id).catch(() => undefined)
      void scheduleReconnect()
    }
  }

  function rejectAllPending(reason: string): void {
    for (const [, resolve] of pending) {
      // Resolve with an error envelope so awaiting callers fail cleanly.
      resolve({ errcode: -1, errmsg: reason })
    }
    pending.clear()
    // Acks owed by the dead socket will never arrive; the next socket
    // starts with no in-flight frames.
    ackDebts.clear()
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function scheduleReconnect(): Promise<void> {
    cleanupListeners()
    if (stopCalled) return
    attempts += 1
    opts._onReconnectAttempt?.(attempts)
    // `reconnectBackoffMs` caps at the shared jittered max (base × 32).
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
      // `requestOk` so a rejected upload step (errcode != 0) throws and the
      // media degrades instead of silently referencing a bogus media_id.
      return await uploadWeComMedia(requestOk, opts.id, bytes, name, seg.type)
    } catch {
      return null
    }
  }

  // ── outbound: send ────────────────────────────────────────────────────────
  function streamIdFor(reqId: string): string {
    return `wecom-stream:${reqId}`
  }

  async function streamReply(req: StreamReplyRequest): Promise<void> {
    const ref = req.conversationRef as WeComConversationRef
    const reqId = resolveLiveReqId(ref)
    if (!reqId || !req.text) return
    try {
      // Counted: this fire-and-forget frame's ack shares the req_id that
      // `send()` later awaits — see `ackDebts`.
      await rawSendCounted(
        reqId,
        buildStreamRespondFrame(reqId, streamIdFor(reqId), req.text, false)
      )
      openStreams.set(reqId, req.text)
    } catch {
      /* preview only — the durable send() path is authoritative */
    }
  }

  /** Proactive media body — the payload object is keyed BY msgtype. */
  function mediaProactiveBody(
    chatid: string,
    chatType: 0 | 1 | 2,
    m: { type: WeComMediaSegment["type"]; mediaId: string }
  ): WeComProactiveBody {
    const media = { media_id: m.mediaId }
    switch (m.type) {
      case "image":
        return { chatid, chat_type: chatType, msgtype: "image", image: media }
      case "voice":
        return { chatid, chat_type: chatType, msgtype: "voice", voice: media }
      case "video":
        return { chatid, chat_type: chatType, msgtype: "video", video: media }
      case "file":
        return { chatid, chat_type: chatType, msgtype: "file", file: media }
    }
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
    // The A2UI card (if any) leads; pass-through template_card payloads from
    // generic card segments follow as extra card frames.
    const allCards = templateCard ? [templateCard, ...serialized.cards] : serialized.cards
    const primaryCard = allCards[0]
    const extraCards = allCards.slice(1)

    // Upload any media segments to obtain media_ids.
    const mediaIds: Array<{ type: WeComMediaSegment["type"]; mediaId: string }> = []
    for (const m of serialized.media) {
      const id = await uploadMedia(m)
      if (id) mediaIds.push({ type: m.type, mediaId: id })
    }

    const hasContent = Boolean(serialized.markdown) || allCards.length > 0 || mediaIds.length > 0
    const liveReqId = resolveLiveReqId(ref)
    try {
      if (liveReqId) {
        const reqId = liveReqId
        const streamId = streamIdFor(reqId)
        const openStreamText = openStreams.get(reqId)
        if (primaryCard && (serialized.markdown || openStreamText !== undefined)) {
          // Text + card must go out as ONE combined frame: the platform only
          // accepts a card on a streamed reply via msgtype
          // "stream_with_template_card" — a separate template_card respond
          // after a finished stream is dropped. A card-only final after
          // streamed frames folds in here too, closing the stream with the
          // last previewed text so the preview never hangs in "generating".
          await requestOk(
            buildStreamWithTemplateCardFrame(
              reqId,
              streamId,
              serialized.markdown || openStreamText || "",
              primaryCard
            )
          )
        } else if (serialized.markdown) {
          // Finalise the (possibly already-streamed) text as a finished stream.
          await requestOk(buildStreamRespondFrame(reqId, streamId, serialized.markdown, true))
        } else if (openStreamText !== undefined) {
          // Media-only (or empty) final while a stream preview is open —
          // close it explicitly or the platform preview sticks "generating".
          await requestOk(buildStreamRespondFrame(reqId, streamId, openStreamText, true))
        } else if (primaryCard) {
          await requestOk(buildTemplateCardRespondFrame(reqId, primaryCard))
        }
        openStreams.delete(reqId)
        for (const card of extraCards) {
          await requestOk(buildTemplateCardRespondFrame(reqId, card))
        }
        // UNVERIFIED: the doc does not state whether media respond frames are
        // accepted on a req_id after a finished stream reply; kept as-is.
        for (const m of mediaIds) {
          await requestOk({
            cmd: "aibot_respond_msg",
            headers: { req_id: reqId },
            body: { msgtype: m.type, [m.type]: { media_id: m.mediaId } },
          })
        }
        if (!hasContent) {
          return {
            ok: false,
            error: { code: "validation", message: "empty reply", retryable: false },
          }
        }
        lastActivityAt = Date.now()
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
      for (const card of allCards) {
        frames.push({
          chatid,
          chat_type: chatType,
          msgtype: "template_card",
          template_card: card,
        })
      }
      for (const m of mediaIds) {
        frames.push(mediaProactiveBody(chatid, chatType, m))
      }
      if (frames.length === 0) {
        return {
          ok: false,
          error: { code: "validation", message: "empty message", retryable: false },
        }
      }
      for (const body of frames) {
        await requestOk(buildSendMsgFrame(newReqId(opts.id), body))
      }
      lastActivityAt = Date.now()
      return { ok: true, downgrades: serialized.downgrades }
    } catch (err) {
      const retryable = err instanceof WeComAckError ? err.retryable : true
      return {
        ok: false,
        error: {
          code: retryable ? "platform_5xx" : "platform_4xx",
          message: err instanceof Error ? err.message : String(err),
          retryable,
        },
      }
    }
  }

  // ── PlatformAdapter surface ────────────────────────────────────────────────
  async function start(c: AdapterContext): Promise<void> {
    ctx = c
    stopCalled = false
    healthState = "starting"
    // Honour the runtime's abort signal: abort tears the adapter down just
    // like stop() — reconnect loop halted, Rust-side handle closed.
    if (c.signal.aborted) {
      await stop()
      return
    }
    c.signal.addEventListener(
      "abort",
      () => {
        void stop()
      },
      { once: true }
    )
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
    liveReqByChat.clear()
    openStreams.clear()
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
