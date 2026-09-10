/**
 * Personal WeChat (iLink) adapter factory.
 *
 * HTTP long-poll, not WebSocket: `start()` runs a loop that POSTs `getupdates`
 * (held ~35 s by the gateway) through the Rust HTTP proxy (`ctx.tauri.httpRequest`),
 * advancing the `get_updates_buf` cursor. Replies go through `sendmessage`,
 * echoing the inbound `context_token` — there is NO proactive send. On `ret
 * -14` (session expired) the adapter degrades and the operator must re-scan the
 * QR code from the settings form.
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildConversationKey } from "@/types/connectors/event"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import {
  ILINK_DEFAULT_BASE_URL,
  ilinkResultCode,
  ilinkMediaUrl,
  ILINK_PATHS,
  ILINK_RET_SESSION_EXPIRED,
  ILINK_LONGPOLL_TIMEOUT_MS,
  buildIlinkHeaders,
  buildGetUpdatesBody,
  buildSendTextBody,
  buildSendMediaBody,
  type IlinkGetUpdatesResponse,
  type IlinkMessage,
} from "./protocol"
import {
  parseIlinkMessage,
  tryParseNumericCallback,
  type WechatPersonalConversationRef,
} from "./parse"
import { getBus } from "@/lib/connectors/bus"
import { reconnectBackoffMs } from "@/lib/connectors/adapters/_shared/reconnect-backoff"
import { serializeIlinkSegments } from "./serialize"
import { WECHAT_PERSONAL_CAPS, WECHAT_PERSONAL_A2UI_CAPABILITY } from "./capability"
import {
  fetchAndDecryptIlinkMediaViaTauri,
  bytesToBase64,
  uploadIlinkMedia,
  IlinkMediaError,
} from "./media"
import { md5Hex } from "../wecom/md5"
import { sniffImageMediaType } from "../_shared/inbound-media"

export interface WechatPersonalAdapterOptions {
  id: string
  displayName: string
  /** Resolves the iLink bot_token from the keyring. */
  token: () => Promise<string>
  /** Resolves the per-session base URL (defaults to the public gateway). */
  baseUrl?: () => Promise<string>
  /** Test seam: backoff base ms (default 2000). */
  _backoffBaseMs?: number
}

const WECHAT_PERSONAL_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [],
  properties: {
    baseUrl: { type: "string", title: "iLink base URL" },
    accountId: { type: "string", title: "Account id" },
  },
  additionalProperties: true,
}

export function createWechatPersonalAdapter(opts: WechatPersonalAdapterOptions): PlatformAdapter {
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined
  let lastActivityAt: number | undefined
  let stopCalled = false
  let ctx: AdapterContext | null = null
  let cursor = ""
  let attempts = 0
  /** Latest context_token per conversation (reply anchor; reply-only channel). */
  const contextTokens = new Map<string, string>()

  const backoffBaseMs = opts._backoffBaseMs ?? 2000

  /** Wakes the pending backoff sleep early — set while a delay() is in flight. */
  let wakeDelay: (() => void) | null = null

  /** True once stop() ran or the runtime aborted this adapter's signal. */
  function shouldStop(): boolean {
    return stopCalled || ctx?.signal.aborted === true
  }

  /**
   * Abortable sleep: resolves early when stop() is called or `ctx.signal`
   * aborts, so a 30s+ backoff never outlives the adapter lifecycle.
   */
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = ctx?.signal
      if (shouldStop()) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", finish)
        if (wakeDelay === finish) wakeDelay = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      wakeDelay = finish
      signal?.addEventListener("abort", finish)
    })
  }

  async function resolveBaseUrl(): Promise<string> {
    const raw = opts.baseUrl
      ? (await opts.baseUrl()) || ILINK_DEFAULT_BASE_URL
      : ILINK_DEFAULT_BASE_URL
    // Persisted base URLs sometimes carry a trailing slash; the plain
    // `${baseUrl}${path}` join would then hit `https://host//ilink/...`.
    return raw.replace(/\/+$/, "")
  }

  /** Resolve each encrypted attachment independently, including quoted media. */
  async function resolveInboundImage(segments: MessageSegment[], msg: IlinkMessage): Promise<void> {
    const media = (msg.item_list ?? [])
      .flatMap((item) => [item.ref_msg?.message_item, item])
      .flatMap((item) => {
        const value = item?.image_item ?? item?.voice_item ?? item?.video_item ?? item?.file_item
        return value && ilinkMediaUrl(value) ? [value] : []
      })
    const mediaSegments = segments.filter(
      (segment) =>
        segment.type === "image" ||
        segment.type === "voice" ||
        segment.type === "video" ||
        segment.type === "file"
    )
    for (const [index, item] of media.entries()) {
      const seg = mediaSegments[index]
      if (!seg) continue
      try {
        if (item.aeskey && !/^[a-fA-F0-9]{32}$/.test(item.aeskey))
          throw new Error("Invalid image AES key")
        const key = item.aeskey
          ? bytesToBase64(
              Uint8Array.from(item.aeskey.match(/.{1,2}/g) ?? [], (hex) => Number.parseInt(hex, 16))
            )
          : (item.media?.aes_key ?? item.aes_key)
        const bytes = await fetchAndDecryptIlinkMediaViaTauri({
          adapterId: opts.id,
          url: ilinkMediaUrl(item)!,
          aesKeyBase64: key,
          fetchAttachment: (adapterId, remoteRef) =>
            ctx!.tauri.fetchAttachment(adapterId, remoteRef),
        })
        const dataBase64 = bytesToBase64(bytes)
        const voiceMime: Record<number, string> = {
          1: "audio/pcm",
          2: "audio/adpcm",
          4: "audio/speex",
          5: "audio/amr",
          6: "audio/silk",
          7: "audio/mpeg",
          8: "audio/ogg",
        }
        seg.mimeType =
          sniffImageMediaType(dataBase64) ??
          (seg.type === "video"
            ? "video/mp4"
            : seg.type === "voice"
              ? voiceMime[Number(item.encode_type)]
              : undefined) ??
          "application/octet-stream"
        if (seg.type === "image" || seg.type === "file") seg.dataBase64 = dataBase64
        seg.rawUrl = seg.url
        seg.url = `data:${seg.mimeType};base64,${dataBase64}`
      } catch (err) {
        ctx?.logger.warn(
          `ilink media resolve failed: ${err instanceof Error ? err.message : String(err)}`
        )
        seg.rawUrl = seg.url
        seg.url = ""
        if (seg.type === "image") seg.alt = "[unavailable image]"
      }
    }
  }

  async function handleMessage(msg: IlinkMessage): Promise<void> {
    // Numeric reply → A2UI callback short-circuit. When the registry has
    // a live binding for this conversation + digit we route to
    // dispatchConnectorCallback (which the bus then routes to the
    // wf_approve / generic callback handler depending on binding kind)
    // and DO NOT also emit a regular message — the user's "1" was a tap,
    // not a chat message.
    const callback = tryParseNumericCallback(opts.id, msg)
    if (callback) {
      // Stash the context_token so the eventual outbound reply
      // (workflow approval confirmation, assistant turn, etc.) has a
      // live reply anchor. `tryParseNumericCallback` always populates
      // `conversationKey`; narrow for the type system.
      if (callback.conversationKey) {
        contextTokens.set(callback.conversationKey, msg.context_token ?? "")
      }
      lastActivityAt = Date.now()
      await getBus().dispatchConnectorCallback(callback)
      return
    }
    const event = parseIlinkMessage(opts.id, msg)
    if (!event) return
    contextTokens.set(
      event.conversationKey,
      (event.conversationRef as WechatPersonalConversationRef).contextToken
    )
    await resolveInboundImage(event.segments, msg)
    if (!(await gateInboundEvent(opts.id, event))) return
    lastActivityAt = Date.now()
    await ctx?.emit(event)
  }

  async function pollOnce(): Promise<"ok" | "expired" | "error"> {
    const [token, baseUrl] = await Promise.all([opts.token(), resolveBaseUrl()])
    if (!token) {
      healthReason = "token_missing"
      ctx?.logger.warn("ilink poll skipped: bot token missing from keyring")
      return "error"
    }
    const resp = await ctx!.tauri.httpRequest({
      url: `${baseUrl}${ILINK_PATHS.getUpdates}`,
      method: "POST",
      headers: buildIlinkHeaders(token),
      body: JSON.stringify(buildGetUpdatesBody(cursor)),
      timeoutMs: ILINK_LONGPOLL_TIMEOUT_MS + 10_000,
    })
    let parsed: IlinkGetUpdatesResponse
    try {
      parsed = JSON.parse(resp.body) as IlinkGetUpdatesResponse
    } catch {
      healthReason = "bad_response"
      ctx?.logger.warn(`ilink getupdates returned a non-JSON body (status ${resp.status})`)
      return "error"
    }
    const resultCode = ilinkResultCode(parsed)
    if (resultCode === ILINK_RET_SESSION_EXPIRED) {
      return "expired"
    }
    if (resp.status >= 400 || resultCode !== 0) {
      healthReason = "bad_response"
      ctx?.logger.warn(
        `ilink getupdates failed: HTTP ${resp.status}, ret ${resultCode} ${parsed?.errmsg ?? ""}`.trim()
      )
      return "error"
    }

    healthState = "running"
    healthReason = undefined
    lastActivityAt = Date.now()
    // Process the batch BEFORE advancing the cursor — advancing first would
    // silently drop the unprocessed tail if a handler threw mid-batch. Process
    // the remaining messages, but retain the cursor if any delivery fails.
    let deliveryFailed = false
    for (const msg of parsed.msgs ?? []) {
      try {
        await handleMessage(msg)
      } catch (err) {
        deliveryFailed = true
        ctx?.logger.warn(
          `ilink message handling failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    if (deliveryFailed) {
      healthReason = "inbound_delivery_failed"
      return "error"
    }
    if (typeof parsed.get_updates_buf === "string") cursor = parsed.get_updates_buf
    return "ok"
  }

  async function pollLoop(): Promise<void> {
    while (!shouldStop()) {
      try {
        const result = await pollOnce()
        if (shouldStop()) return
        if (result === "expired") {
          healthState = "degraded"
          healthReason = "session_expired_rescan"
          return // requires a fresh QR scan; stop polling
        }
        if (result === "error") {
          attempts += 1
          healthState = "degraded"
          await delay(reconnectBackoffMs(backoffBaseMs, attempts))
          continue
        }
        attempts = 0
      } catch (err) {
        if (shouldStop()) return
        attempts += 1
        healthState = "degraded"
        healthReason = "network_error"
        ctx?.logger.warn(`ilink poll failed: ${err instanceof Error ? err.message : String(err)}`)
        await delay(reconnectBackoffMs(backoffBaseMs, attempts))
      }
    }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const ref = req.conversationRef as WechatPersonalConversationRef
    const conversationKey = ref.userId
      ? buildConversationKey("wechat-personal", opts.id, ref.userId)
      : undefined
    const contextToken =
      ref.contextToken || (conversationKey ? contextTokens.get(conversationKey) : undefined)

    if (!contextToken || !ref.userId) {
      // iLink cannot initiate a conversation — replies need a live context_token.
      return {
        ok: false,
        error: {
          code: "unsupported_segment",
          message: "personal WeChat is reply-only — no context_token for proactive send",
          retryable: false,
        },
      }
    }

    // ref.userId is non-null past the guard above, so conversationKey is
    // always defined here — TypeScript still wants the explicit narrow.
    if (!conversationKey) {
      return {
        ok: false,
        error: {
          code: "unsupported_segment",
          message: "missing conversation key",
          retryable: false,
        },
      }
    }
    const serialized = await serializeIlinkSegments(req.segments, {
      adapterId: opts.id,
      conversationKey,
    })
    if (serialized.parts.length === 0) {
      return {
        ok: false,
        error: { code: "validation", message: "empty message", retryable: false },
      }
    }

    let delivered = 0
    let lastClientId: string | undefined
    try {
      const [token, baseUrl] = await Promise.all([opts.token(), resolveBaseUrl()])
      const bodies = []
      // Finish every upload before publishing any part of the reply.
      for (const part of serialized.parts) {
        if (part.type === "text")
          bodies.push(buildSendTextBody(ref.userId, contextToken, part.text))
        else {
          const uploaded = await uploadIlinkMedia({
            adapterId: opts.id,
            baseUrl,
            token,
            userId: ref.userId,
            segment: part.segment,
            tauri: ctx!.tauri,
          })
          bodies.push(
            buildSendMediaBody(ref.userId, contextToken, uploaded.itemType, uploaded.mediaItem)
          )
        }
      }
      for (const [index, body] of bodies.entries()) {
        body.msg.client_id = `cognia-${md5Hex(`${opts.id}:${req.metadata.idempotencyKey}:${index}`)}`
        const resp = await ctx!.tauri.httpRequest({
          url: `${baseUrl}${ILINK_PATHS.sendMessage}`,
          method: "POST",
          headers: buildIlinkHeaders(token),
          body: JSON.stringify(body),
          timeoutMs: 15_000,
        })
        const parsed = JSON.parse(resp.body) as { ret?: number; errcode?: number; errmsg?: string }
        const ret = ilinkResultCode(parsed)
        if (ret === ILINK_RET_SESSION_EXPIRED) {
          // Dead session — retrying is useless until the operator re-scans
          // the QR code. Degrade health so the settings UI surfaces it and
          // return non-retryable so the outbound queue doesn't spin forever.
          healthState = "degraded"
          healthReason = "session_expired_rescan"
          return {
            ok: false,
            error: {
              code: "auth_failed",
              message: parsed.errmsg ?? `ret ${ret} (session expired — re-scan the QR code)`,
              retryable: false,
            },
          }
        }
        if (resp.status >= 400 || ret !== 0) {
          const code =
            resp.status === 401 || resp.status === 403
              ? "auth_failed"
              : resp.status === 429
                ? "rate_limited"
                : resp.status >= 500
                  ? "platform_5xx"
                  : resp.status >= 400 || ret !== undefined
                    ? "platform_4xx"
                    : "bad_response"
          return {
            ok: false,
            error: {
              code: delivered > 0 ? "reconciliation_required" : code,
              message: parsed?.errmsg ?? `HTTP ${resp.status}, ret ${ret ?? "missing"}`,
              retryable:
                delivered === 0 &&
                code !== "auth_failed" &&
                (resp.status < 400 || resp.status === 429 || resp.status >= 500),
            },
          }
        }
        delivered += 1
        lastClientId = body.msg.client_id
      }
      return { ok: true, platformMessageId: lastClientId, downgrades: serialized.downgrades }
    } catch (err) {
      if (err instanceof IlinkMediaError && err.sessionExpired) {
        healthState = "degraded"
        healthReason = "session_expired_rescan"
      }
      return {
        ok: false,
        platformMessageId: lastClientId,
        error: {
          code:
            delivered > 0
              ? "reconciliation_required"
              : err instanceof IlinkMediaError
                ? err.sessionExpired
                  ? "auth_failed"
                  : "validation"
                : "network",
          message: `${delivered > 0 ? `${delivered} message part(s) delivered; ` : ""}${err instanceof Error ? err.message : String(err)}`,
          retryable:
            delivered === 0 &&
            (err instanceof IlinkMediaError ? err.retryable && !err.sessionExpired : true),
        },
      }
    }
  }

  return {
    get meta() {
      return {
        type: "wechat-personal" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: WECHAT_PERSONAL_CAPS,
        transportModes: ["longpoll"] as const,
        configSchema: WECHAT_PERSONAL_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    async start(c: AdapterContext): Promise<void> {
      ctx = c
      stopCalled = false
      healthState = "starting"
      cursor = ""
      attempts = 0
      void pollLoop()
    },
    async stop(): Promise<void> {
      stopCalled = true
      // Wake a pending backoff sleep so the loop exits promptly instead of
      // outliving stop() by up to a full backoff window.
      wakeDelay?.()
      contextTokens.clear()
      healthState = "down"
    },
    health(): AdapterHealth {
      return { state: healthState, reason: healthReason, lastActivityAt }
    },
    send,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("wechat-personal"),
    a2uiCapability: () => WECHAT_PERSONAL_A2UI_CAPABILITY,
  }
}
