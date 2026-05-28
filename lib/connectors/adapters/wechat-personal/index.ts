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
import type { MessageSegment } from "@/types/connectors/segment"
import { buildConversationKey } from "@/types/connectors/event"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import {
  ILINK_DEFAULT_BASE_URL,
  ILINK_PATHS,
  ILINK_RET_SESSION_EXPIRED,
  ILINK_LONGPOLL_TIMEOUT_MS,
  buildIlinkHeaders,
  buildGetUpdatesBody,
  buildSendTextBody,
  type IlinkGetUpdatesResponse,
  type IlinkMessage,
} from "./protocol"
import {
  parseIlinkMessage,
  tryParseNumericCallback,
  type WechatPersonalConversationRef,
} from "./parse"
import { getBus } from "@/lib/connectors/bus"
import { serializeIlinkSegments } from "./serialize"
import { WECHAT_PERSONAL_CAPS, WECHAT_PERSONAL_A2UI_CAPABILITY } from "./capability"
import { fetchAndDecryptIlinkMedia, bytesToBase64 } from "./media"

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

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function resolveBaseUrl(): Promise<string> {
    return opts.baseUrl ? (await opts.baseUrl()) || ILINK_DEFAULT_BASE_URL : ILINK_DEFAULT_BASE_URL
  }

  /** Best-effort: decrypt the first inbound image and inline it as base64. */
  async function resolveInboundImage(segments: MessageSegment[], msg: IlinkMessage): Promise<void> {
    const img = msg.item_list?.find((i) => i.image_item?.url)?.image_item
    if (!img?.url) return
    try {
      const bytes = await fetchAndDecryptIlinkMedia(img.url, img.aes_key)
      const seg = segments.find((s) => s.type === "image")
      if (seg && seg.type === "image") {
        ;(seg as { dataBase64?: string; mimeType?: string }).dataBase64 = bytesToBase64(bytes)
        ;(seg as { mimeType?: string }).mimeType = "image/jpeg"
      }
    } catch {
      /* keep the URL marker */
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
      return "error"
    }
    if (parsed.ret === ILINK_RET_SESSION_EXPIRED || parsed.errcode === ILINK_RET_SESSION_EXPIRED) {
      return "expired"
    }
    if (parsed.ret !== 0) return "error"

    healthState = "running"
    healthReason = undefined
    lastActivityAt = Date.now()
    if (typeof parsed.get_updates_buf === "string") cursor = parsed.get_updates_buf
    for (const msg of parsed.msgs ?? []) {
      await handleMessage(msg)
    }
    return "ok"
  }

  async function pollLoop(): Promise<void> {
    while (!stopCalled) {
      try {
        const result = await pollOnce()
        if (stopCalled) return
        if (result === "expired") {
          healthState = "degraded"
          healthReason = "session_expired_rescan"
          return // requires a fresh QR scan; stop polling
        }
        if (result === "error") {
          attempts += 1
          healthState = "degraded"
          await delay(backoffBaseMs * Math.min(2 ** attempts, 16))
          continue
        }
        attempts = 0
      } catch {
        if (stopCalled) return
        attempts += 1
        healthState = "degraded"
        await delay(backoffBaseMs * Math.min(2 ** attempts, 16))
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
    if (serialized.textChunks.length === 0) {
      return {
        ok: false,
        error: { code: "validation", message: "empty message", retryable: false },
      }
    }

    try {
      const [token, baseUrl] = await Promise.all([opts.token(), resolveBaseUrl()])
      for (const chunk of serialized.textChunks) {
        const resp = await ctx!.tauri.httpRequest({
          url: `${baseUrl}${ILINK_PATHS.sendMessage}`,
          method: "POST",
          headers: buildIlinkHeaders(token),
          body: JSON.stringify(buildSendTextBody(ref.userId, contextToken, chunk)),
          timeoutMs: 15_000,
        })
        const parsed = JSON.parse(resp.body) as { ret?: number; errcode?: number; errmsg?: string }
        if ((parsed.ret ?? parsed.errcode ?? 0) !== 0) {
          return {
            ok: false,
            error: {
              code: "platform_4xx",
              message: parsed.errmsg ?? `ret ${parsed.ret ?? parsed.errcode}`,
              retryable: true,
            },
          }
        }
      }
      return { ok: true, downgrades: serialized.downgrades }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "network",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
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
      void pollLoop()
    },
    async stop(): Promise<void> {
      stopCalled = true
      contextTokens.clear()
      healthState = "down"
    },
    health(): AdapterHealth {
      return { state: healthState, reason: healthReason, lastActivityAt }
    },
    send,
    a2uiCapability: () => WECHAT_PERSONAL_A2UI_CAPABILITY,
  }
}
