/**
 * OneBot adapter factory — assembles parse + serialize + capability +
 * transport into a PlatformAdapter.
 *
 * Transport (selected per instance via `transportMode`):
 *   - reverse-ws: the OneBot client (NapCat/Lagrange/LLOneBot) connects TO us;
 *     the Rust axum server accepts the WS upgrade on `/ws/onebot/:adapter_id`
 *     and bridges it through Tauri events.
 *   - forward-ws: cognia dials a NapCat WS server (`forwardWsUrl`, e.g.
 *     `ws://host:3001`) as a client via the generic Rust WS client.
 * Both carry the identical event stream + echo-matched RPC, so the parse /
 * serialise layers below are transport-agnostic.
 *
 * Outbound: routes through `transport.send` (echo-matched RPC), using the v11
 * or v12 serialiser based on the cached variant from the first inbound event.
 *
 * Edit: throws unsupported (OneBot has no edit API).
 * Delete: uses delete_msg (v11) / delete_message (v12).
 * setTyping: no-op (no typing indicator in OneBot).
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { ONEBOT_A2UI_CAPABILITY, ONEBOT_CAPS } from "./capability"
import { parseOneBotEvent, clearVariantCache } from "./parse"
import { parseV11Event, type OneBotV11Event } from "./v11"
import {
  serializeOutboundV11,
  serializeOutboundV12,
  serializeDeleteV11,
  serializeDeleteV12,
  serializeGetGroupMsgHistoryV11,
  serializeGetFriendMsgHistoryV11,
  serializeSetMsgEmojiLike,
  OneBotUnsupportedError,
} from "./serialize"
import { createReverseWsTransport } from "./transport-reverse-ws"
import { createForwardWsTransport } from "./transport-forward-ws"
import type { OneBotTransport } from "./transport"
import { gateInboundEvent } from "@/lib/connectors/at-gate"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OneBotAdapterOptions {
  id: string
  displayName: string
  /** Bot's QQ UIN (the account number). */
  selfBotUin: string
  /** Resolves the bearer token from the keyring on each check (optional). */
  bearerToken?: () => Promise<string>
  /** Hint for documentation display only. */
  expectedClient?: "napcat" | "lagrange" | "llonebot"
  /**
   * Connection direction. `reverse-ws` (default): NapCat dials cognia.
   * `forward-ws`: cognia dials the NapCat WS server at `forwardWsUrl`.
   */
  transportMode?: "reverse-ws" | "forward-ws"
  /** NapCat WS server URL — required when `transportMode === "forward-ws"`. */
  forwardWsUrl?: string
}

const ONEBOT_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["selfBotUin"],
  properties: {
    selfBotUin: { type: "string", title: "Bot UIN (QQ number)" },
    bearerToken: { type: "string", title: "Bearer Token (optional)" },
    expectedClient: {
      type: "string",
      enum: ["napcat", "lagrange", "llonebot"],
      title: "Expected Client",
    },
    forwardWsUrl: { type: "string", title: "Forward-WS URL (ws://host:3001)" },
  },
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOneBotAdapter(opts: OneBotAdapterOptions): PlatformAdapter {
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false
  let currentVariant: "v11" | "v12" | null = null

  // Pick the transport. Forward-WS needs a URL; a forward-ws row missing one is
  // misconfigured, so we fall back to the safe reverse-WS default.
  const useForwardWs = opts.transportMode === "forward-ws" && !!opts.forwardWsUrl
  const transport: OneBotTransport = useForwardWs
    ? createForwardWsTransport({
        adapterId: opts.id,
        url: opts.forwardWsUrl!,
        token: opts.bearerToken,
      })
    : createReverseWsTransport(opts.id)

  function getVariant(): "v11" | "v12" {
    return currentVariant ?? "v11"
  }

  /**
   * Probe upstream impl (NapCat / Lagrange / LLOneBot) via the OneBot
   * `get_version_info` action — added at ADR-0009 v41 / A5. Result is
   * persisted on `AdapterInstanceRow.implMetadata` (schema v41) so the
   * mapper layer can choose NapCat-only extension paths (markdown card
   * buttons, file upload, emoji like) and the capability matrix view
   * can show what the upstream supports.
   *
   * Best-effort: a probe failure (timeout, unsupported action, missing
   * impl field) MUST NOT block startup. We simply leave `implMetadata`
   * unset and the mapper falls back to the standards-only path.
   */
  async function probeUpstreamImpl(): Promise<void> {
    try {
      const resp = await transport.send({
        action: "get_version_info",
        params: {},
        echo: `${opts.id}:probe:${Date.now()}`,
      })
      if (resp.status !== "ok" || !resp.data || typeof resp.data !== "object") return
      const data = resp.data as Record<string, unknown>
      const rawImpl = typeof data["app_name"] === "string" ? (data["app_name"] as string) : ""
      const version = typeof data["app_version"] === "string" ? (data["app_version"] as string) : ""
      // Normalise the impl name. NapCat reports "NapCat.Onebot"; Lagrange
      // reports "Lagrange.Core" or "Lagrange.OneBot"; LLOneBot reports
      // "LLOneBot". We lowercase + strip everything from the first
      // non-alphanumeric so the mapper can do `if (impl === "napcat")`.
      const impl =
        rawImpl
          .toLowerCase()
          .split(/[.\-_:\s]/)[0]
          ?.replace(/[^a-z0-9]/g, "") || "unknown"

      // Capability features advertised by extensions of the OneBot spec
      // — `markdown-card` is what NapCat calls its QQ markdown card
      // protocol; `upload_group_file` and `set_msg_emoji_like` are the
      // action endpoints we feature-test for. Lagrange ships subset.
      const features: string[] = []
      if (impl === "napcat") {
        features.push("markdown-card", "upload_group_file", "set_msg_emoji_like")
      } else if (impl === "lagrange") {
        // Lagrange supports the file upload action; markdown cards are
        // hit-or-miss across versions so we leave the flag off until
        // B5 introduces an explicit behaviour probe.
        features.push("upload_group_file")
      }

      try {
        const { updateAdapterInstance } = await import("@/lib/db/adapter-instances")
        await updateAdapterInstance(opts.id, {
          implMetadata: { impl, version, features },
        })
      } catch {
        // Adapter row may not exist in the test harness or during a fresh
        // first start — non-fatal.
      }
    } catch {
      // Probe failed — leave implMetadata untouched.
    }
  }

  async function start(ctx: AdapterContext): Promise<void> {
    stopCalled = false
    healthState = "running"

    // The transport owns the socket lifecycle and the RPC response channel.
    // A5 — kick a `get_version_info` probe on every open so reconnects update
    // implMetadata if the user upgraded their upstream (NapCat → Lagrange swap,
    // version bump, …).
    await transport.start({
      onOpen: () => {
        healthState = "running"
        lastActivityAt = Date.now()
        // Fire-and-forget — the probe writes Dexie + returns. We don't await
        // so a slow client doesn't block other connection setup.
        void probeUpstreamImpl()
      },
      onClose: () => {
        if (!stopCalled) {
          healthState = "degraded"
        }
      },
      onEvent: async (rawEvent) => {
        const result = parseOneBotEvent(opts.id, rawEvent)
        if (result === null) return

        // Cache the detected variant
        currentVariant = result.variant

        if (result.parsed !== null) {
          // im-refactored-crayon — at-strategy + chat allow/blocklist gate.
          if (!(await gateInboundEvent(opts.id, result.parsed))) return
          lastActivityAt = Date.now()
          await ctx.emit(result.parsed)
        }
      },
    })
  }

  async function stop(): Promise<void> {
    stopCalled = true
    await transport.stop()
    clearVariantCache(opts.id)
    currentVariant = null
    healthState = "down"
  }

  function health(): AdapterHealth {
    return { state: healthState, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const variant = getVariant()
    const calls =
      variant === "v11"
        ? serializeOutboundV11(req, opts.selfBotUin)
        : serializeOutboundV12(req, opts.selfBotUin)

    if (calls.length === 0) {
      return {
        ok: false,
        error: { code: "validation", message: "no segments to send", retryable: false },
      }
    }

    let platformMessageId: string | undefined

    try {
      for (const call of calls) {
        const resp = await transport.send(call)
        if (resp.status === "ok" && resp.data && typeof resp.data === "object") {
          const data = resp.data as Record<string, unknown>
          if (data.message_id !== undefined) {
            platformMessageId = String(data.message_id)
          }
        }
      }
      return { ok: true, platformMessageId }
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

  async function edit(_messageId: string, _patch: OutboundRequest): Promise<OutboundResult> {
    // OneBot has no edit API
    return {
      ok: false,
      error: {
        code: "unsupported_segment",
        message: "OneBot does not support message editing",
        retryable: false,
      },
    }
  }

  async function deleteMessage(messageId: string): Promise<void> {
    const variant = getVariant()
    const call =
      variant === "v11"
        ? serializeDeleteV11(messageId, opts.selfBotUin)
        : serializeDeleteV12(messageId, opts.selfBotUin)

    await transport.send(call)
  }

  async function setTyping(_conversationKey: string, _on: boolean): Promise<void> {
    // OneBot has no typing indicator — no-op
  }

  async function refreshCredentials(): Promise<void> {
    // bearerToken is resolved on each call; nothing to refresh eagerly
  }

  /**
   * Add an emoji reaction to a message. The OneBot v11/v12 standard defines no
   * reaction action; NapCat ships the `set_msg_emoji_like` extension. We gate
   * on the upstream probe result (`implMetadata.features`, written by
   * `probeUpstreamImpl`) so a non-NapCat upstream fails honestly with
   * `OneBotUnsupportedError` rather than silently no-op'ing. `emojiId` is the
   * QQ face id.
   */
  async function addReaction(messageId: string, emojiId: string): Promise<void> {
    const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
    const row = await getAdapterInstance(opts.id)
    const features = row?.implMetadata?.features ?? []
    if (!features.includes("set_msg_emoji_like")) {
      throw new OneBotUnsupportedError("set_msg_emoji_like (reaction)")
    }
    await transport.send(serializeSetMsgEmojiLike(messageId, emojiId))
  }

  /**
   * Walk `get_group_msg_history` / `get_friend_msg_history` (NapCat /
   * go-cqhttp extension) with `message_seq` cursor pagination. Each returned
   * message is projected through `parseV11Event`, the same parser the live
   * reverse-WS path uses, so the consumer sees identical
   * `NormalizedInboundEvent` shapes.
   *
   * v12 has no portable history action — calling fetchHistory on a v12
   * adapter throws because there is no honest result to yield.
   *
   * Bounds:
   *   - per-page size = 20 (NapCat / go-cqhttp default cap)
   *   - max pages    = 50 (safety stop)
   *   - `opts.before` is forwarded as the starting `message_seq` (fetches
   *     older messages strictly before that seq).
   *   - `opts.max` further caps total events yielded.
   */
  async function* fetchHistory(
    conversationKey: string,
    historyOpts: { before?: string; after?: string; max?: number }
  ): AsyncIterable<NormalizedInboundEvent> {
    const variant = getVariant()
    if (variant !== "v11") {
      throw new Error(
        "OneBot v12 does not define a portable message-history action; fetchHistory is v11-only."
      )
    }

    // OneBot conversationKey shape: `onebot:<adapterId>:<chatType>:<chatId>`
    // where chatType ∈ {"g", "p"}. The chatKey segment itself contains a
    // colon, so we can't reuse `parseConversationKey` (it would put "g" into
    // remoteChatId and the id into threadId).
    const segs = conversationKey.split(":")
    if (segs.length !== 4 || segs[0] !== "onebot") {
      throw new Error(
        `OneBot conversationKey must encode chatType:chatId (got "${conversationKey}").`
      )
    }
    const chatType = segs[2]
    const chatId = segs[3]
    if (!chatId || (chatType !== "g" && chatType !== "p")) {
      throw new Error(
        `OneBot conversationKey must encode chatType:chatId (got "${conversationKey}").`
      )
    }

    const pageSize = 20
    const maxPages = 50
    const overallCap = historyOpts.max ?? Number.POSITIVE_INFINITY

    let cursor: number | undefined = historyOpts.before ? Number(historyOpts.before) : undefined
    let yielded = 0

    for (let page = 0; page < maxPages; page++) {
      const call =
        chatType === "g"
          ? serializeGetGroupMsgHistoryV11(chatId, cursor, pageSize)
          : serializeGetFriendMsgHistoryV11(chatId, cursor, pageSize)

      const resp = await transport.send(call)
      if (resp.status !== "ok") return

      const data = resp.data as { messages?: OneBotV11Event[] } | null
      const messages = data?.messages ?? []
      if (messages.length === 0) return

      for (const msg of messages) {
        if (yielded >= overallCap) return
        const event = parseV11Event(opts.id, msg)
        if (event) {
          yielded++
          yield event
        }
      }

      // Page returned in chronological order — oldest message's seq becomes
      // the new cursor for the next (older) page. NapCat exposes message_seq
      // alongside message_id; fall back to the oldest message_id if absent
      // (go-cqhttp legacy behaviour).
      const oldest = messages[0] as OneBotV11Event & { message_seq?: number }
      const nextCursor = oldest.message_seq ?? oldest.message_id
      if (nextCursor === undefined || nextCursor === cursor) return
      cursor = nextCursor as number
    }
  }

  const adapter: PlatformAdapter & { addReaction?: typeof addReaction } = {
    get meta() {
      return {
        type: "onebot" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: ONEBOT_CAPS,
        transportModes: ["reverse-ws", "forward-ws"] as const,
        configSchema: ONEBOT_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    edit,
    delete: deleteMessage,
    setTyping,
    refreshCredentials,
    a2uiCapability: () => ONEBOT_A2UI_CAPABILITY,
    fetchHistory,
    addReaction,
  }

  return adapter
}
