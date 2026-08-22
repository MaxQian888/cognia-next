/**
 * Telegram adapter factory — Task 35.
 *
 * Assembles parse + serialize + capability + transport into a PlatformAdapter.
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
  ReactionRef,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { TELEGRAM_A2UI_CAPABILITY, TELEGRAM_CAPS } from "./capability"
import { createTelegramAlbumBuffer, type TelegramAlbumBuffer } from "./album"
import {
  albumGroupIdOf,
  parseTelegramUpdate,
  parseTelegramCallbackQuery,
  parseTelegramForceReplyCorrelation,
  type TelegramUpdate,
} from "./parse"
import { serializeOutboundAsync, serializeReaction } from "./serialize"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { startLongPoll } from "./transport-longpoll"
import { startWebhookTransport } from "./transport-webhook"
import { getBus } from "@/lib/connectors/bus"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "@/lib/connectors/audit"

export interface TelegramAdapterOptions {
  id: string
  displayName: string
  transport: "longpoll" | "webhook"
  /** Resolves the bot token from the keyring on each call. */
  botToken: () => Promise<string>
  /** Bot's own user id as a string (from getMe at startup). */
  selfId: string
}

const TELEGRAM_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["botToken"],
  properties: {
    botToken: { type: "string", title: "Bot Token" },
    // The adapter builder reads `row.transportMode` — declare the selector
    // in the schema so generic config UIs surface it (audited fix #14).
    transportMode: {
      type: "string",
      title: "Transport",
      enum: ["longpoll", "webhook"],
      default: "longpoll",
    },
    // Keyring key the Rust webhook verifier reads (axum_app.rs).
    secretToken: { type: "string", title: "Webhook Secret Token" },
    // Legacy alias for secretToken — kept for rows created before the
    // keyring key was aligned with the Rust side.
    webhookSecret: { type: "string", title: "Webhook Secret Token (legacy)" },
  },
  additionalProperties: false,
}

const TELEGRAM_API_BASE = "https://api.telegram.org"

/**
 * Split the `"chatId:messageId"` composite this adapter's `send()` returns as
 * `platformMessageId`. Message-scoped ops (delete / edit / reactions) need
 * both ids, but the {@link PlatformAdapter} contract threads only a single
 * string — the chat rides in the composite, mirroring the Discord adapter's
 * `"channelId:messageId"` convention. Telegram chat ids never contain a
 * colon (they are signed integers), so the first colon is the separator.
 *
 * Throws on malformed input — a silent best-effort call would 400 on the
 * platform anyway (deleteMessage & co. require chat_id).
 */
function splitChatMessage(composite: string): [chatId: string, messageId: string] {
  const idx = composite.indexOf(":")
  if (idx <= 0 || idx === composite.length - 1) {
    throw new Error(`Telegram message ops require a "chatId:messageId" id, got "${composite}"`)
  }
  return [composite.slice(0, idx), composite.slice(idx + 1)]
}

/**
 * Chat allow/blocklist gate for the callback channel (audited fix #12).
 * Regular messages flow through `gateInboundEvent`, but callback_query and
 * ForceReply-correlation events are `ConnectorCallbackEvent`s and used to
 * bypass it entirely. Mirror the allow/blocklist half of the at-gate here —
 * the at-mention strategy deliberately does NOT apply, because a press on
 * the bot's own inline keyboard is always directed at the bot.
 *
 * Fails open on a missing row / Dexie error, same as `gateInboundEvent`.
 */
async function callbackChatAllowed(
  adapterId: string,
  chatId: string,
  conversationKey: string
): Promise<boolean> {
  const row = await getAdapterInstance(adapterId).catch(() => undefined)
  if (!row) return true
  const reason = row.chatBlocklist?.includes(chatId)
    ? "chat_blocklist"
    : row.chatAllowlist && row.chatAllowlist.length > 0 && !row.chatAllowlist.includes(chatId)
      ? "chat_allowlist"
      : null
  if (!reason) return true
  await appendAudit({
    adapterId,
    kind: "inbound.policy_blocked",
    at: Date.now(),
    conversationKey,
    reason,
  }).catch(() => undefined)
  return false
}

export function createTelegramAdapter(opts: TelegramAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined = undefined
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false
  /**
   * Album assembly for this run. Replaced on every `start`; the initial value
   * exists so `stop()` before a `start()` has something inert to flush.
   */
  let albums: TelegramAlbumBuffer = createTelegramAlbumBuffer({ onFlush: () => {} })

  /**
   * Custom error wrapper carrying the Telegram-side `retry_after`. The
   * outbound runner inspects this on platform_5xx codes to backoff
   * beyond the default exponential — Telegram is explicit about how long
   * a client should wait before retrying after a 429.
   */
  class TelegramApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly retryAfterMs: number | undefined
    ) {
      super(message)
      this.name = "TelegramApiError"
    }
  }

  async function doSend(
    method: string,
    payload: Record<string, unknown>
  ): Promise<{ message_id?: number }> {
    const token = await opts.botToken()
    const resp = await connectorsHttpRequest({
      url: `${TELEGRAM_API_BASE}/bot${token}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    let body: {
      ok: boolean
      result?: { message_id?: number }
      description?: string
      error_code?: number
      parameters?: { retry_after?: number; migrate_to_chat_id?: number }
    }
    try {
      body = JSON.parse(resp.body)
    } catch {
      throw new TelegramApiError(
        `Telegram ${method} returned non-JSON body: ${resp.body.slice(0, 200)}`,
        resp.status,
        undefined
      )
    }
    if (!body.ok) {
      // Telegram returns `parameters.retry_after` in seconds whenever
      // the bot is rate-limited (HTTP 429) — surface it as ms so the
      // caller / outbound runner can honour the cool-down.
      const retryAfterMs =
        typeof body.parameters?.retry_after === "number"
          ? body.parameters.retry_after * 1000
          : resp.status === 429
            ? extractRetryAfter(resp.headers)
            : undefined
      throw new TelegramApiError(
        `Telegram ${method} failed: ${body.description ?? resp.body}`,
        resp.status,
        retryAfterMs
      )
    }
    return body.result ?? {}
  }

  function extractRetryAfter(headers: Record<string, string>): number | undefined {
    // Normalise header lookup — Tauri returns lower-cased keys, but be safe.
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "retry-after") {
        const secs = Number(v)
        if (Number.isFinite(secs) && secs > 0) return secs * 1000
      }
    }
    return undefined
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal

    // Rebuilt per start so a restart never inherits parts of an album whose
    // conversation may no longer be routed the same way.
    albums = createTelegramAlbumBuffer({
      onFlush: async (event) => {
        if (!(await gateInboundEvent(opts.id, event))) return
        await ctx.emit(event)
      },
      onError: (error) => {
        ctx.logger.warn("telegram:album flush failed", {
          reason: error instanceof Error ? error.message : String(error),
        })
      },
    })

    healthState = "running"
    healthReason = undefined

    // Persistent-failure classification for the long-poll transport
    // (audited fix #9): 401 (invalid token) and 409 (another getUpdates /
    // webhook consumer) degrade immediately; anything else degrades after
    // three consecutive failures. A successful poll recovers to running.
    let consecutivePollErrors = 0
    const feed: AsyncGenerator<TelegramUpdate> =
      opts.transport === "longpoll"
        ? startLongPoll({
            botToken: opts.botToken,
            signal,
            onPollError: (info) => {
              consecutivePollErrors += 1
              const reason =
                info.status === 401
                  ? `getUpdates 401: bot token rejected — ${info.message}`
                  : info.status === 409
                    ? `getUpdates 409: another getUpdates client or webhook is active — ${info.message}`
                    : consecutivePollErrors >= 3
                      ? `getUpdates failing (${consecutivePollErrors} consecutive): ${info.message}`
                      : undefined
              if (reason && !stopCalled) {
                healthState = "degraded"
                healthReason = reason
                ctx.logger.warn("telegram:longpoll degraded", {
                  status: info.status,
                  consecutiveErrors: consecutivePollErrors,
                  reason,
                })
              }
            },
            onPollSuccess: () => {
              consecutivePollErrors = 0
              if (!stopCalled && healthState === "degraded") {
                healthState = "running"
                healthReason = undefined
              }
            },
          })
        : startWebhookTransport({ adapterId: opts.id, signal })

    // Drive the transport in the background
    ;(async () => {
      try {
        for await (const update of feed) {
          if (signal.aborted) break

          // Inline-keyboard / callback_query → route through the
          // ConnectorBus callback channel (G4). The bus dedups via
          // namespace="callback", recovers surfaceId/componentId via
          // `connectorCallbackBindings`, and forwards through the
          // a2ui-bridge MCP server to drive the next assistant turn.
          if (update.callback_query !== undefined) {
            const callback = parseTelegramCallbackQuery(opts.id, opts.selfId, update)
            if (callback) {
              // Chat allow/blocklist gate (audited fix #12) — callback
              // events used to bypass gateInboundEvent entirely.
              const cbChatId = String(update.callback_query.message?.chat.id ?? "")
              if (!(await callbackChatAllowed(opts.id, cbChatId, callback.conversationKey ?? ""))) {
                continue
              }
              lastActivityAt = Date.now()
              await getBus().dispatchConnectorCallback(callback)
              // Best-effort ack so the Telegram client stops the
              // "loading" spinner on the button. Failure is logged but
              // does not block — the callback was already processed.
              try {
                await doSend("answerCallbackQuery", {
                  callback_query_id: update.callback_query.id,
                })
              } catch (err) {
                ctx.logger.warn("telegram:answerCallbackQuery failed", {
                  reason: err instanceof Error ? err.message : String(err),
                })
              }
            }
            continue
          }

          // B2 — ForceReply correlation (ADR-0009 v41). If the inbound
          // message is a reply to one of our outstanding ForceReply
          // prompts, route it as a callback (actionType="input")
          // instead of an ordinary message — that way the assistant's
          // next turn sees the user's free-text input wired straight
          // onto the A2UI surface's TextField/TextArea component.
          try {
            const forceReplyCallback = await parseTelegramForceReplyCorrelation(
              opts.id,
              opts.selfId,
              update
            )
            if (forceReplyCallback) {
              // Same allow/blocklist gate as the callback_query path
              // (audited fix #12).
              const frMsg = update.message ?? update.channel_post
              const frChatId = String(frMsg?.chat.id ?? "")
              if (
                !(await callbackChatAllowed(
                  opts.id,
                  frChatId,
                  forceReplyCallback.conversationKey ?? ""
                ))
              ) {
                continue
              }
              lastActivityAt = Date.now()
              await getBus().dispatchConnectorCallback(forceReplyCallback)
              continue
            }
          } catch (err) {
            ctx.logger.warn("telegram:force_reply correlation failed", {
              reason: err instanceof Error ? err.message : String(err),
            })
          }

          // Regular message / edit / reaction → message event.
          const event = parseTelegramUpdate(opts.id, opts.selfId, update)
          if (event) {
            lastActivityAt = Date.now()
            // An album arrives as N updates sharing a media_group_id. Buffer
            // them so the bot answers the message the user sent instead of
            // once per photo; the gate runs on the assembled event, because
            // the caption (what the gate reads) is on only one part.
            if (albums.offer(event, albumGroupIdOf(update))) continue
            // im-refactored-crayon — at-strategy + chat allow/blocklist gate.
            if (!(await gateInboundEvent(opts.id, event))) continue
            await ctx.emit(event)
          }
        }
        if (!stopCalled) {
          healthState = "down"
          healthReason = "transport feed ended unexpectedly"
        }
      } catch (err) {
        // Transport crash — record WHY the adapter degraded instead of
        // silently flipping the flag (audited fix #9).
        if (!stopCalled) {
          healthState = "degraded"
          healthReason = err instanceof Error ? err.message : String(err)
          ctx.logger.warn("telegram:transport crashed", { reason: healthReason })
        }
      }
    })()
  }

  async function stop(): Promise<void> {
    stopCalled = true
    abortController?.abort()
    abortController = null
    // A half-assembled album is a message the user sent. Emit what arrived
    // rather than dropping it on the floor at shutdown.
    await albums.flushAll()
    healthState = "down"
    healthReason = undefined
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const calls = await serializeOutboundAsync(req, opts.id)
    let platformMessageId: string | undefined

    try {
      for (const call of calls) {
        const result = await doSend(call.method, call.payload as Record<string, unknown>)
        if (result.message_id !== undefined) {
          // Composite "chatId:messageId" (audited fix #1) — message-scoped
          // ops (delete / edit / reactions) receive only this one string
          // back from callers, and Telegram requires chat_id + message_id.
          // Same convention as the Discord adapter's "channelId:messageId".
          const sentChatId = String(call.payload["chat_id"] ?? "")
          platformMessageId = `${sentChatId}:${result.message_id}`
          // B2 — post-send ForceReply binding. The mapper signals which
          // A2UI surface + component asked for input; we couldn't know
          // the platform message_id until Telegram echoed it back. The
          // parser will use this row when the user replies to the prompt.
          // NOTE: the binding key stays the BARE message id — the parser
          // correlates against inbound reply_to_message.message_id, which
          // Telegram delivers without a chat prefix.
          if (call.forceReplyBinding) {
            try {
              await recordCallbackBinding({
                adapterId: opts.id,
                actionId: String(result.message_id),
                kind: "force_reply",
                surfaceId: call.forceReplyBinding.surfaceId,
                componentId: call.forceReplyBinding.componentId,
                conversationKey: call.forceReplyBinding.conversationKey,
              })
            } catch {
              // Binding persistence is best-effort — a Dexie outage
              // shouldn't fail the platform send.
            }
          }
        }
      }
      return { ok: true, platformMessageId }
    } catch (err) {
      // Surface rate-limit retryAfter so the outbound runner's circuit
      // breaker + backoff honour Telegram's explicit cool-down.
      if (err instanceof TelegramApiError) {
        const code =
          err.status === 429 ? "rate_limited" : err.status >= 500 ? "platform_5xx" : "platform_4xx"
        return {
          ok: false,
          error: {
            code,
            message: err.message,
            retryable: code !== "platform_4xx",
            retryAfterMs: err.retryAfterMs,
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

  async function edit(messageId: string, patch: OutboundRequest): Promise<OutboundResult> {
    const ref = patch.conversationRef as Record<string, unknown>

    // Accept the composite "chatId:messageId" this adapter's send() returns;
    // fall back to the conversationRef chatId for legacy bare message ids.
    let chatId: unknown
    let msgId = messageId
    if (messageId.includes(":")) {
      const [c, m] = splitChatMessage(messageId)
      chatId = c
      msgId = m
    } else {
      chatId = ref["chatId"]
    }

    // Reuse send()'s serializer so markdown keeps its parse_mode and inline
    // keyboards keep their reply_markup (audited fix #8) — the old path sent
    // the raw markdown source as plain text and dropped any markup.
    const calls = await serializeOutboundAsync(patch, opts.id)
    const textCall = calls.find(
      (c) => c.method === "sendMessage" && typeof c.payload["text"] === "string"
    )
    const text = textCall ? (textCall.payload["text"] as string) : ""

    try {
      await doSend("editMessageText", {
        chat_id: chatId,
        message_id: Number(msgId),
        text,
        ...(textCall?.payload["parse_mode"] ? { parse_mode: textCall.payload["parse_mode"] } : {}),
        ...(textCall?.payload["reply_markup"]
          ? { reply_markup: textCall.payload["reply_markup"] }
          : {}),
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof TelegramApiError) {
        // "message is not modified" is Telegram's way of saying the target
        // already shows this content — a success no-op, not a retryable
        // failure (retrying would 400 forever).
        if (err.status === 400 && /message is not modified/i.test(err.message)) {
          return { ok: true }
        }
        // Same classification as send(): 429 → rate_limited (+retryAfter),
        // 5xx retryable, other 4xx permanent (audited fix #8).
        const code =
          err.status === 429 ? "rate_limited" : err.status >= 500 ? "platform_5xx" : "platform_4xx"
        return {
          ok: false,
          error: {
            code,
            message: err.message,
            retryable: code !== "platform_4xx",
            retryAfterMs: err.retryAfterMs,
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

  async function deleteMessage(messageId: string): Promise<void> {
    // deleteMessage requires chat_id + message_id (audited fix #1) — the
    // chat rides in the "chatId:messageId" composite send() returned.
    // splitChatMessage throws on malformed input; never a silent 400.
    const [chatId, msgId] = splitChatMessage(messageId)
    await doSend("deleteMessage", { chat_id: chatId, message_id: Number(msgId) })
  }

  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!on) return // Telegram doesn't have a "stop typing" command
    // Extract chatId from conversationKey: "telegram:<adapterId>:<chatId>[:<threadId>]"
    const parts = conversationKey.split(":")
    const chatId = parts[2]
    await doSend("sendChatAction", { chat_id: chatId, action: "typing" })
  }

  /**
   * Push a bot reaction onto a message via `setMessageReaction` (Bot API
   * 7.0+, ADR-0009 v41 / A1), conforming to the {@link PlatformAdapter}
   * 2-arg contract `addReaction(messageId, emojiType)` the connector bus
   * calls (audited fix #1 — the old 4-arg shape received the message id as
   * chat_id and the emoji as message_id). `messageId` is the
   * `"chatId:messageId"` composite from send(); `emojiType` is a unicode
   * emoji (the only ReactionType bots may push without admin-granted
   * custom-emoji rights).
   *
   * Telegram reactions have no addressable id (setMessageReaction replaces
   * the bot's reaction list), so the emoji itself rides back as
   * `reactionId` for a later {@link removeReaction} — same convention as
   * the Discord adapter.
   */
  async function addReaction(messageId: string, emojiType: string): Promise<ReactionRef> {
    const [chatId, msgId] = splitChatMessage(messageId)
    const call = serializeReaction(chatId, msgId, emojiType)
    await doSend(call.method, call.payload)
    return { reactionId: emojiType }
  }

  /**
   * Retract the bot's reaction previously added with {@link addReaction}.
   * `setMessageReaction` REPLACES the bot's reaction list on the message,
   * and this adapter only ever sets a single emoji per add — so removing
   * "our" reaction means setting the empty list (which clears all of the
   * bot's reactions; correct for the single-emoji case we add). The
   * `reactionId` (the emoji) is accepted per contract but not needed on
   * the wire.
   */
  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    void reactionId
    const [chatId, msgId] = splitChatMessage(messageId)
    const call = serializeReaction(chatId, msgId, [])
    await doSend(call.method, call.payload)
  }

  async function refreshCredentials(): Promise<void> {
    // No-op: botToken is a resolver function called fresh on each request
  }

  return {
    get meta() {
      return {
        type: "telegram" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: TELEGRAM_CAPS,
        transportModes: [opts.transport] as readonly ("longpoll" | "webhook")[],
        configSchema: TELEGRAM_CONFIG_SCHEMA,
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
    addReaction,
    removeReaction,
    refreshCredentials,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("telegram"),
    a2uiCapability: () => TELEGRAM_A2UI_CAPABILITY,
  } as PlatformAdapter & {
    addReaction: typeof addReaction
    removeReaction: typeof removeReaction
  }
}
