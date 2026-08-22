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
  ForwardMessageInput,
  ReactionRef,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
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
  serializeGetLoginInfoV11,
  serializeGetLoginInfoV12,
  serializeSendForwardMsgV11,
  OneBotUnsupportedError,
  OneBotValidationError,
  type SerializedOneBotCall,
} from "./serialize"
import { resolveForwardContent } from "./inbound-forward"
import { resolveReplySnippet } from "./inbound-reply"
import { createReverseWsTransport } from "./transport-reverse-ws"
import { createForwardWsTransport } from "./transport-forward-ws"
import type { OneBotTransport } from "./transport"
import { enrichOneBotInboundMedia } from "./inbound-media"
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
  /** Override the forward-WS reconnect backoff base ms (tests only). */
  _backoffBaseMs?: number
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
      enum: ["napcat", "lagrange", "llonebot", "other"],
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
  let healthReason: string | undefined = undefined
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
        _backoffBaseMs: opts._backoffBaseMs,
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
   *
   * Returns whether `get_version_info` itself succeeded — it is a OneBot v11
   * standard action, so the outcome doubles as the variant hint for
   * `probeIdentity` when no inbound event has revealed the variant yet.
   */
  async function probeUpstreamImpl(): Promise<boolean> {
    try {
      const resp = await transport.send({
        action: "get_version_info",
        params: {},
        echo: `${opts.id}:probe:${Date.now()}`,
      })
      if (resp.status !== "ok") return false
      if (!resp.data || typeof resp.data !== "object") return true
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
        // B5 introduces an explicit behaviour probe. set_msg_emoji_like is
        // also off — no evidence Lagrange implements it.
        features.push("upload_group_file")
      } else if (impl === "llonebot") {
        // LLOneBot originated the set_msg_emoji_like action (NapCat adopted
        // it), so reactions are safe to advertise there too.
        features.push("set_msg_emoji_like")
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
      return true
    } catch {
      // Probe failed — leave implMetadata untouched.
      return false
    }
  }

  /**
   * Probe the bot's own identity via `get_login_info` (v11) / `get_self_info`
   * (v12) on connect and persist it into `AdapterInstanceRow.lastWhoamiResult`
   * — the same field every other platform's identity probe writes (Telegram
   * getMe / Slack auth.test / Lark bot/v3/info). The generic whoami panel then
   * renders the connected bot's nickname + UIN without any operator action.
   *
   * Unlike the HTTP-based probes, OneBot identity is only reachable over the
   * live WS transport, so this rides the same open-handshake path as
   * `probeUpstreamImpl` rather than a Settings-page button.
   *
   * Best-effort: any failure leaves the prior whoami snapshot untouched.
   * When the reported `user_id` disagrees with the operator-entered
   * `selfBotUin`, we log a warning so the mismatch is visible in logs; the
   * panel surfaces it visually.
   */
  /** One identity RPC for the given variant; null on any failure/empty id. */
  async function fetchIdentityData(
    variant: "v11" | "v12"
  ): Promise<Record<string, unknown> | null> {
    try {
      const call = variant === "v12" ? serializeGetLoginInfoV12() : serializeGetLoginInfoV11()
      const resp = await transport.send(call)
      if (resp.status !== "ok" || !resp.data || typeof resp.data !== "object") return null
      const data = resp.data as Record<string, unknown>
      const userId = data["user_id"]
      if (userId === undefined || userId === null || userId === "") return null
      return data
    } catch {
      return null
    }
  }

  async function probeIdentity(ctx: AdapterContext, versionInfoOk: boolean): Promise<void> {
    // Variant choice: on a fresh connect no inbound event has revealed the
    // variant yet, and blindly defaulting to v11 sends `get_login_info` to a
    // v12 upstream (invalid action → whoami stays empty forever). Instead we
    // use the `get_version_info` outcome that just ran as the hint (v11
    // standard action: success ⇒ v11, failure ⇒ likely v12), and if the
    // hinted probe still yields nothing we retry ONCE with the other
    // variant's action.
    const known = currentVariant
    const first: "v11" | "v12" = known ?? (versionInfoOk ? "v11" : "v12")
    let data = await fetchIdentityData(first)
    if (data === null && known === null) {
      data = await fetchIdentityData(first === "v11" ? "v12" : "v11")
    }
    if (data === null) return // best-effort: leave lastWhoamiResult untouched

    const uin = String(data["user_id"])
    // v11 → `nickname`; v12 → `user_displayname` / `user_name`.
    const nickname =
      (typeof data["nickname"] === "string" && data["nickname"]) ||
      (typeof data["user_displayname"] === "string" && data["user_displayname"]) ||
      (typeof data["user_name"] === "string" && data["user_name"]) ||
      uin

    if (uin !== opts.selfBotUin) {
      ctx.logger.warn(
        `OneBot identity mismatch: configured selfBotUin=${opts.selfBotUin} but connected bot reports user_id=${uin}`
      )
    }

    try {
      const { updateAdapterInstance } = await import("@/lib/db/adapter-instances")
      await updateAdapterInstance(opts.id, {
        lastWhoamiResult: { botName: nickname, appId: uin, openId: uin },
        lastWhoamiAt: Date.now(),
      })
    } catch {
      // Adapter row may not exist in the test harness or during a fresh
      // first start — non-fatal.
    }
  }

  async function start(ctx: AdapterContext): Promise<void> {
    stopCalled = false
    // "starting" until the transport's onOpen confirms a live upstream.
    // Previously this set "running" unconditionally, so a forward-WS that
    // never managed to connect reported "running" forever (dial failures are
    // swallowed into the reconnect loop and onClose never fires for a socket
    // that never opened).
    healthState = "starting"
    healthReason = undefined

    // The transport owns the socket lifecycle and the RPC response channel.
    // A5 — kick a `get_version_info` probe on every open so reconnects update
    // implMetadata if the user upgraded their upstream (NapCat → Lagrange swap,
    // version bump, …).
    await transport.start({
      onOpen: () => {
        healthState = "running"
        healthReason = undefined
        lastActivityAt = Date.now()
        // Fire-and-forget — the probes write Dexie + return. We don't await so
        // a slow client doesn't block other connection setup. `probeUpstreamImpl`
        // records the NapCat/Lagrange/LLOneBot impl+features and its
        // `get_version_info` outcome doubles as the variant hint for
        // `probeIdentity`, which records the bot's own UIN + nickname into the
        // whoami snapshot — hence the sequential chain.
        void (async () => {
          const versionInfoOk = await probeUpstreamImpl()
          await probeIdentity(ctx, versionInfoOk)
        })()
      },
      onClose: () => {
        if (!stopCalled) {
          healthState = "degraded"
        }
      },
      onConnectFailed: (consecutiveFailures) => {
        // Forward-WS only: N dials in a row failed without ever opening —
        // stop pretending and surface a diagnosable health state.
        if (consecutiveFailures >= 3) {
          healthState = "degraded"
          healthReason = "connect_failed"
        }
      },
      onEvent: async (rawEvent) => {
        // Heartbeat / lifecycle meta events never produce a parsed event but
        // are proof of a live upstream — they count as inbound activity per
        // the health contract ("last successful inbound or outbound").
        if (rawEvent !== null && typeof rawEvent === "object") {
          const e = rawEvent as Record<string, unknown>
          if (e.post_type === "meta_event" || e.type === "meta") {
            lastActivityAt = Date.now()
          }
        }
        // Resolve any unresolved merged-forward (`get_forward_msg`) and empty
        // reply snippet (`get_msg`) before the synchronous parse so the mapper
        // renders the real bodies. Best-effort; leaves the raw event unchanged
        // on failure.
        const enriched = await resolveReplySnippet(
          await resolveForwardContent(rawEvent, transport),
          transport
        )
        const result = parseOneBotEvent(opts.id, enriched)
        if (result === null) return

        // Cache the detected variant
        currentVariant = result.variant

        if (result.parsed !== null) {
          // im-refactored-crayon — at-strategy + chat allow/blocklist gate.
          if (!(await gateInboundEvent(opts.id, result.parsed))) return
          lastActivityAt = Date.now()
          // Download what the parser could only reference, so a picture sent
          // into the group reaches the model as an image rather than as the
          // text `[image: …]`. After the gate: a message that is going to be
          // dropped costs no downloads.
          await enrichOneBotInboundMedia(result.parsed, {
            forwardWsUrl: opts.forwardWsUrl,
          })
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
    healthReason = undefined
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const variant = getVariant()
    let calls: SerializedOneBotCall[]
    try {
      calls =
        variant === "v11"
          ? serializeOutboundV11(req, opts.selfBotUin)
          : serializeOutboundV12(req, opts.selfBotUin)
    } catch (err) {
      // Requests that can never succeed on the wire (no chat target, v12
      // media without upload_file) — non-retryable, per OneBotValidationError.
      if (err instanceof OneBotValidationError || err instanceof OneBotUnsupportedError) {
        return {
          ok: false,
          error: { code: "validation", message: err.message, retryable: false },
        }
      }
      throw err
    }

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
      // Health contract: lastActivityAt = last successful inbound OR outbound.
      lastActivityAt = Date.now()
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
   * Merge-forward existing messages (`input.messageIds`, or a single
   * `input.messageId`) into `input.target` as one combined card, using the
   * NapCat `send_group_forward_msg` / `send_private_forward_msg` extension.
   * Mirrors the Lark adapter's `forwardMessage`; declared alongside the
   * `forward` capability. Each id becomes a `node` segment referencing the
   * original message.
   */
  async function forwardMessage(input: ForwardMessageInput): Promise<OutboundResult> {
    // GAP: send_group_forward_msg / send_private_forward_msg are v11-only
    // NapCat/go-cqhttp extensions; OneBot 12 defines no portable
    // merged-forward action, so fail honestly instead of sending an invalid
    // action to a v12 upstream.
    if (getVariant() === "v12") {
      return {
        ok: false,
        error: {
          code: "validation",
          message:
            "OneBot 12 has no merged-forward send action (send_*_forward_msg is a v11 extension); not supported yet",
          retryable: false,
        },
      }
    }
    const call = serializeSendForwardMsgV11(input)
    if (call === null) {
      return {
        ok: false,
        error: {
          code: "validation",
          message: "forwardMessage requires message ids and a group/private target",
          retryable: false,
        },
      }
    }
    try {
      const resp = await transport.send(call)
      let platformMessageId: string | undefined
      if (resp.status === "ok" && resp.data && typeof resp.data === "object") {
        const data = resp.data as Record<string, unknown>
        if (data.message_id !== undefined) platformMessageId = String(data.message_id)
      }
      // Health contract: lastActivityAt = last successful inbound OR outbound.
      lastActivityAt = Date.now()
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

  /** Shared feature gate for the reaction pair (see addReaction docs). */
  async function assertReactionSupported(): Promise<void> {
    const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
    const row = await getAdapterInstance(opts.id)
    const features = row?.implMetadata?.features ?? []
    if (!features.includes("set_msg_emoji_like")) {
      throw new OneBotUnsupportedError("set_msg_emoji_like (reaction)")
    }
  }

  /**
   * Add an emoji reaction to a message. The OneBot v11/v12 standard defines no
   * reaction action; LLOneBot originated and NapCat ships the
   * `set_msg_emoji_like` extension. We gate on the upstream probe result
   * (`implMetadata.features`, written by `probeUpstreamImpl`) so an
   * unsupported upstream fails honestly with `OneBotUnsupportedError` rather
   * than silently no-op'ing. `emojiId` is the QQ face id.
   *
   * Returns a {@link ReactionRef} whose `reactionId` is the emoji id itself —
   * `set_msg_emoji_like` has no server-side reaction handle; removal re-sends
   * the same message/emoji pair with `set: false`.
   */
  async function addReaction(messageId: string, emojiId: string): Promise<ReactionRef> {
    await assertReactionSupported()
    await transport.send(serializeSetMsgEmojiLike(messageId, emojiId, true))
    return { reactionId: emojiId }
  }

  /**
   * Remove a reaction previously added by {@link addReaction}. `reactionId`
   * is the emoji id from the returned ReactionRef; NapCat/LLOneBot remove via
   * `set_msg_emoji_like` with `set: false`. Same runtime feature gate as add.
   */
  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    await assertReactionSupported()
    await transport.send(serializeSetMsgEmojiLike(messageId, reactionId, false))
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
    forwardMessage,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("onebot"),
    a2uiCapability: () => ONEBOT_A2UI_CAPABILITY,
    fetchHistory,
    addReaction,
    removeReaction,
  }

  return adapter
}
