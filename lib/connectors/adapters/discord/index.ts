/**
 * Discord adapter factory — Task 64.
 *
 * Assembles parse + serialize + capability + gateway-client into a PlatformAdapter.
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
  ReactionRef,
  TransportMode,
} from "@/types/connectors/adapter"
import type { OutboundError, OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import type { MessageSegment } from "@/types/connectors/segment"
import { connectorsHttpRequest, connectorsDiscordUpload } from "@/lib/connectors/tauri/commands"
import { DISCORD_A2UI_CAPABILITY, DISCORD_CAPS } from "./capability"
import { buildDiscordModalData, type DiscordModalPayload } from "./a2ui-mapper"
import { resolveCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import {
  parseDiscordDispatch,
  parseDiscordInteraction,
  type DiscordInteraction,
  type DiscordMessage,
} from "./parse"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import {
  discordNonce,
  serializeOutboundAsync,
  serializeDelete,
  serializeEdit,
  serializeReaction,
  serializeReactionRemoval,
  serializeFetchHistory,
  renderDiscordContentRun,
} from "./serialize"
import { sendDiscordVoiceMessage } from "./voice-upload"
import { startGatewayClient } from "./gateway-client"
import type { GatewayClient } from "./gateway-client"
import { startWebhookTransport, type WebhookTransportHandle } from "./transport-webhook"
import { getBus } from "@/lib/connectors/bus"
import { gateInboundEvent } from "@/lib/connectors/at-gate"

export interface DiscordAdapterOptions {
  id: string
  displayName: string
  /** Resolves the bot token from the keyring on each call. */
  botToken: () => Promise<string>
  /**
   * Bot's own user id (from READY event). Can be "" before start();
   * start() refreshes this from the gateway READY event automatically.
   */
  selfId: string
  /**
   * Gateway intent bitmask (from the row's `settings.intents`). Falls back to
   * DEFAULT_GATEWAY_INTENTS when unset. MESSAGE_CONTENT (privileged) must also
   * be enabled in the Developer Portal.
   */
  intents?: number
  /**
   * Active transport for this row. `"gateway"` (default) receives messages +
   * interactions over the WebSocket gateway; `"webhook"` receives interactions
   * only via the Rust-hosted Interactions Endpoint (no message events).
   */
  transportMode?: TransportMode
  /** Test-only override forwarded to the gateway client's reconnect backoff. */
  _backoffBaseMs?: number
}

const DISCORD_API_BASE = "https://discord.com/api/v10"

/** InteractionResponse type — ACK a component/modal without a visible edit. */
const INTERACTION_RESPONSE_DEFERRED_UPDATE = 6
/** InteractionResponse type — pop a modal (TextInput two-hop). */
const INTERACTION_RESPONSE_MODAL = 9
/** Interaction types that require a callback ACK within 3s. */
const INTERACTION_TYPE_MESSAGE_COMPONENT = 3
const INTERACTION_TYPE_MODAL_SUBMIT = 5

const DISCORD_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["botToken"],
  properties: {
    botToken: { type: "string", title: "Bot Token" },
    publicKey: { type: "string", title: "Public Key (for webhook verification)" },
    intents: { type: "number", title: "Gateway Intents", default: 46593 },
  },
  additionalProperties: false,
}

/** Consecutive failed gateway connects before health() degrades. */
const DEGRADE_AFTER_CONSECUTIVE_CONNECT_FAILURES = 3

/**
 * Upper bound on the modal-binding Dexie lookup that runs before the
 * interaction ACK. Discord voids the interaction after 3s; a wedged
 * IndexedDB read must fall back to the deferred ACK path instead of
 * blowing that deadline.
 */
const MODAL_BINDING_LOOKUP_TIMEOUT_MS = 1500

/** HTTP error thrown by `doRequest`, carrying the status + rate-limit hint. */
class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = "DiscordApiError"
  }
}

/**
 * Extract Discord's rate-limit hint from a 429 response: the JSON body's
 * `retry_after` (seconds, may be fractional) wins; the `Retry-After` header
 * (integer seconds) is the fallback.
 */
function parseRetryAfterMs(headers: Record<string, string>, body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown }
    if (typeof parsed?.retry_after === "number" && Number.isFinite(parsed.retry_after)) {
      return Math.ceil(parsed.retry_after * 1000)
    }
  } catch {
    // not JSON — fall through to the header
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "retry-after") {
      const secs = Number(value)
      if (Number.isFinite(secs)) return Math.ceil(secs * 1000)
    }
  }
  return undefined
}

/**
 * Map a thrown request error onto the OutboundError code enum
 * (`types/connectors/outbound.ts`): 429 → rate_limited (retryable, with
 * retryAfterMs), 401/403 → auth_failed (not retryable), other 4xx →
 * platform_4xx (not retryable), 5xx and non-HTTP failures → platform_5xx
 * (retryable).
 */
function toOutboundError(err: unknown): OutboundError {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof DiscordApiError) {
    if (err.status === 429) {
      return { code: "rate_limited", message, retryable: true, retryAfterMs: err.retryAfterMs }
    }
    if (err.status === 401 || err.status === 403) {
      return { code: "auth_failed", message, retryable: false }
    }
    if (err.status < 500) {
      return { code: "platform_4xx", message, retryable: false }
    }
    return { code: "platform_5xx", message, retryable: true }
  }
  return { code: "platform_5xx", message, retryable: true }
}

/**
 * Acknowledge a Discord interaction within the 3s deadline by POSTing to the
 * interaction callback endpoint. Authenticated by the interaction token in the
 * URL itself — no bot Authorization header. Best-effort: a failed ACK must not
 * break the inbound turn, so callers swallow rejections.
 */
async function ackInteraction(
  interactionId: string,
  token: string,
  responseType: number,
  data?: unknown
): Promise<void> {
  await connectorsHttpRequest({
    url: `${DISCORD_API_BASE}/interactions/${interactionId}/${token}/callback`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      data === undefined ? { type: responseType } : { type: responseType, data }
    ),
  })
}

/**
 * Look up a callback binding without letting a Dexie miss/throw break the
 * gateway dispatch loop (returns undefined on any failure → normal ACK path).
 */
async function safeResolveBinding(
  adapterId: string,
  actionId: string
): Promise<Awaited<ReturnType<typeof resolveCallbackBinding>>> {
  try {
    return await resolveCallbackBinding(adapterId, actionId)
  } catch {
    return undefined
  }
}

/**
 * `safeResolveBinding` bounded by {@link MODAL_BINDING_LOOKUP_TIMEOUT_MS}.
 * The modal two-hop REQUIRES the lookup before the ACK (a modal can only be
 * the interaction's initial response — you cannot deferred-ACK first and pop
 * a modal later), so instead of reordering, a slow Dexie read times out to
 * `undefined` and the interaction falls back to the deferred ACK path well
 * inside Discord's 3s window.
 */
async function resolveBindingWithDeadline(
  adapterId: string,
  actionId: string
): Promise<Awaited<ReturnType<typeof resolveCallbackBinding>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), MODAL_BINDING_LOOKUP_TIMEOUT_MS)
  })
  try {
    return await Promise.race([safeResolveBinding(adapterId, actionId), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Split the `"channelId:messageId"` composite the connector bus threads through
 * message-scoped ops (delete / pin / reaction). Discord's REST reaction API is
 * channel-scoped, but the {@link PlatformAdapter} reaction contract passes only
 * a single `messageId`, so the channel rides in the composite.
 */
function splitChannelMessage(composite: string): [channelId: string, messageId: string] {
  const idx = composite.indexOf(":")
  if (idx === -1) {
    throw new Error(
      `Discord message ops require a "channelId:messageId" composite id, got "${composite}"`
    )
  }
  return [composite.slice(0, idx), composite.slice(idx + 1)]
}

/** Derive a filename (with extension) from a URL, falling back to `fallback`. */
function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const base = new URL(url).pathname.split("/").pop()
    if (base && base.includes(".")) return decodeURIComponent(base)
  } catch {
    // not a parseable URL — use the fallback
  }
  return fallback
}

/**
 * Highest snowflake id in a page — Discord's ordering for `after` queries is
 * not worth trusting blindly, so the forward cursor is computed numerically.
 */
function newestSnowflake(messages: Array<{ id?: string }>): string | undefined {
  let best: string | undefined
  let bestVal: bigint | undefined
  for (const msg of messages) {
    if (!msg.id) continue
    try {
      const val = BigInt(msg.id)
      if (bestVal === undefined || val > bestVal) {
        bestVal = val
        best = msg.id
      }
    } catch {
      // non-numeric id (shouldn't happen) — keep any candidate we have
      if (best === undefined) best = msg.id
    }
  }
  return best
}

/** Media segment types that get a real multipart upload (voice is separate). */
type DiscordMediaSegment = Extract<MessageSegment, { type: "image" | "file" | "video" }>

/** Build the `connectorsDiscordUpload` file list from media segments. */
function mediaSegmentsToFiles(segments: DiscordMediaSegment[]) {
  return segments.map((seg) => {
    switch (seg.type) {
      case "image":
        return { sourceUrl: seg.url, filename: fileNameFromUrl(seg.url, "image.png") }
      case "video":
        return { sourceUrl: seg.url, filename: fileNameFromUrl(seg.url, "video.mp4") }
      case "file":
        return {
          sourceUrl: seg.url,
          filename: seg.name || fileNameFromUrl(seg.url, "file"),
          contentType: seg.mimeType || undefined,
        }
    }
  })
}

export function createDiscordAdapter(opts: DiscordAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined = undefined
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false
  let selfId = opts.selfId
  let _gatewayClient: GatewayClient | null = null
  let _webhookHandle: WebhookTransportHandle | null = null

  function setHealth(state: AdapterHealthState, reason?: string) {
    healthState = state
    healthReason = reason
  }

  async function doRequest(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const token = await opts.botToken()
    const resp = await connectorsHttpRequest({
      url: `${DISCORD_API_BASE}${path}`,
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (resp.status >= 400) {
      throw new DiscordApiError(
        `Discord API ${method} ${path} → ${resp.status}: ${resp.body}`,
        resp.status,
        resp.status === 429 ? parseRetryAfterMs(resp.headers, resp.body) : undefined
      )
    }
    return resp.body ? JSON.parse(resp.body) : null
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal

    // Webhook mode: interactions arrive over the Rust-hosted Interactions
    // Endpoint (message events are NOT delivered — that's gateway-only). No
    // gateway socket is opened; a bound webhook route counts as "running".
    if (opts.transportMode === "webhook") {
      _webhookHandle = await startWebhookTransport({ adapterId: opts.id, selfId, signal })
      setHealth("running")
      return
    }

    // Gateway mode stays "starting" until the first READY/RESUMED — a socket
    // that never authenticates must not report itself healthy.
    const client = startGatewayClient({
      botToken: opts.botToken,
      intents: opts.intents,
      signal,
      _backoffBaseMs: opts._backoffBaseMs,
      onStatus: (status) => {
        if (stopCalled) return
        switch (status.kind) {
          case "ready":
          case "resumed":
            setHealth("running")
            break
          case "connect_failed":
            if (status.attempts >= DEGRADE_AFTER_CONSECUTIVE_CONNECT_FAILURES) {
              setHealth(
                "degraded",
                `Discord gateway unreachable (${status.attempts} consecutive failed connects)`
              )
            }
            break
          case "fatal_close":
            setHealth(
              "down",
              `Discord gateway closed with fatal code ${status.code} (${status.reason}); not reconnecting`
            )
            break
        }
      },
    })
    _gatewayClient = client

    // Drive the gateway in the background
    ;(async () => {
      try {
        for await (const dispatch of client.dispatches) {
          if (signal.aborted) break

          // Refresh selfId from READY (captured in client.selfId)
          if (client.selfId && !selfId) {
            selfId = client.selfId
          }

          // INTERACTION_CREATE (components / modal_submit) flows through
          // the ConnectorBus callback channel — `dispatchConnectorCallback`
          // dedups via namespace="callback", recovers the surface binding
          // and forwards to the a2ui-bridge MCP server.
          if (dispatch.t === "INTERACTION_CREATE") {
            const interaction = dispatch.d as DiscordInteraction

            // Modal two-hop: a component click bound to a modal_open surface
            // must answer with the modal (InteractionResponse type 9)
            // synchronously — NOT a deferred ACK, and NOT dispatched to the bus
            // (the modal submit arrives as a separate MODAL_SUBMIT interaction).
            if (interaction.type === INTERACTION_TYPE_MESSAGE_COMPONENT) {
              const customId = interaction.data?.custom_id
              // Deadline-bounded: this lookup gates the 3s ACK below, and a
              // modal can ONLY be the initial interaction response, so it
              // must run first — but never long enough to void the ACK.
              const binding = customId
                ? await resolveBindingWithDeadline(opts.id, customId)
                : undefined
              if (binding?.kind === "modal_open" && binding.payload) {
                try {
                  await ackInteraction(
                    interaction.id,
                    interaction.token,
                    INTERACTION_RESPONSE_MODAL,
                    buildDiscordModalData(
                      customId as string,
                      binding.payload as unknown as DiscordModalPayload
                    )
                  )
                } catch {
                  // best-effort — a failed modal open leaves the button un-acted
                }
                continue
              }
            }

            // ACK component clicks / modal submits within Discord's 3s window
            // so the user never sees "This interaction failed". The assistant's
            // reply then flows through the normal bus → AI-loop → send path as
            // a channel message (unified with every other platform — no
            // interaction-token threading into `send`).
            if (
              interaction.type === INTERACTION_TYPE_MESSAGE_COMPONENT ||
              interaction.type === INTERACTION_TYPE_MODAL_SUBMIT
            ) {
              try {
                await ackInteraction(
                  interaction.id,
                  interaction.token,
                  INTERACTION_RESPONSE_DEFERRED_UPDATE
                )
              } catch {
                // best-effort — still dispatch the callback below
              }
            }
            const callback = parseDiscordInteraction(opts.id, selfId, dispatch)
            if (callback) {
              lastActivityAt = Date.now()
              await getBus().dispatchConnectorCallback(callback)
            }
            continue
          }

          const event = parseDiscordDispatch(opts.id, selfId, dispatch)
          if (event) {
            // im-refactored-crayon — at-strategy + chat allow/blocklist gate.
            if (!(await gateInboundEvent(opts.id, event))) continue
            lastActivityAt = Date.now()
            await ctx.emit(event)
          }
        }
        if (!stopCalled) {
          // Keep the fatal-close reason (set via onStatus) when present.
          healthState = "down"
        }
      } catch {
        if (!stopCalled) {
          setHealth("degraded", "Discord gateway dispatch loop crashed")
        }
      }
    })()
  }

  async function stop(): Promise<void> {
    stopCalled = true
    abortController?.abort()
    abortController = null
    _gatewayClient = null
    _webhookHandle?.stop()
    _webhookHandle = null
    setHealth("down")
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    // Media is split into three lanes:
    //   - voice: one message each (Discord requires a lone audio attachment +
    //     the IS_VOICE_MESSAGE flag), via the multipart upload bridge.
    //   - image / file / video: a single multipart message with real uploads
    //     (no more URL-only embeds).
    //   - everything else (text / markdown / code / mention / emoji / a2ui):
    //     the JSON REST serializer.
    const channelId = String((req.conversationRef as Record<string, unknown>)["channelId"] ?? "")
    const voiceSegments = req.segments.filter(
      (s): s is Extract<MessageSegment, { type: "voice" }> => s.type === "voice"
    )
    const mediaSegments = req.segments.filter(
      (s): s is DiscordMediaSegment => s.type === "image" || s.type === "file" || s.type === "video"
    )
    const otherSegments = req.segments.filter(
      (s) => s.type !== "voice" && s.type !== "image" && s.type !== "file" && s.type !== "video"
    )

    let platformMessageId: string | undefined
    // Platform idempotency (ADR-0009): every message-create of this job —
    // voice lane, media lane and each REST chunk — carries a deterministic
    // `nonce` derived from the job's idempotencyKey, so a retry after a lost
    // ack re-posts the same nonces and Discord returns the original message.
    const idempotencyKey = req.metadata?.idempotencyKey ?? ""

    try {
      for (const [voiceIndex, seg] of voiceSegments.entries()) {
        const result = await sendDiscordVoiceMessage({
          botToken: opts.botToken,
          channelId,
          voiceUrl: seg.url,
          durationSec: seg.durationSec,
          replyToMessageId: req.replyTo?.messageId,
          nonce: idempotencyKey ? discordNonce(idempotencyKey, `voice:${voiceIndex}`) : undefined,
        })
        if (result.messageId) platformMessageId = result.messageId
      }

      if (mediaSegments.length > 0) {
        const token = await opts.botToken()
        // Attach the reply only to the media message when there's no text
        // message to carry it (avoids double reply pings).
        const id = await connectorsDiscordUpload({
          botToken: token,
          channelId,
          files: mediaSegmentsToFiles(mediaSegments),
          replyToMessageId: otherSegments.length === 0 ? req.replyTo?.messageId : undefined,
          nonce: idempotencyKey ? discordNonce(idempotencyKey, "media") : undefined,
        })
        if (id) platformMessageId = id
      }

      const restReq: OutboundRequest = { ...req, segments: otherSegments }
      const calls = await serializeOutboundAsync(restReq, opts.id)
      for (const call of calls) {
        const result = (await doRequest(
          call.method,
          call.url.replace(DISCORD_API_BASE, ""),
          call.payload
        )) as { id?: string } | null
        if (result?.id) {
          platformMessageId = result.id
        }
      }
      return { ok: true, platformMessageId }
    } catch (err) {
      return { ok: false, error: toOutboundError(err) }
    }
  }

  async function edit(messageId: string, patch: OutboundRequest): Promise<OutboundResult> {
    const ref = patch.conversationRef as Record<string, unknown>
    const channelId = String(ref["channelId"] ?? "")

    // Render EVERY content-bearing segment, not just the first text one: a
    // patch that mixed text with a code block or a mention used to edit the
    // message down to its opening sentence and silently drop the rest.
    const content = renderDiscordContentRun(patch.segments)

    try {
      const call = serializeEdit(channelId, messageId, content)
      await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""), call.payload)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: toOutboundError(err) }
    }
  }

  async function deleteMessage(messageId: string): Promise<void> {
    // messageId format: "channelId:messageId" for Discord. A bare id throws
    // (same contract as addReaction) instead of silently no-oping.
    const [channelId, msgId] = splitChannelMessage(messageId)
    const call = serializeDelete(channelId, msgId)
    await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""))
  }

  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!on) return // typing indicator is triggered by POST, no "stop" endpoint
    // conversationKey: "discord:<adapterId>:<channelId>[:<threadId>]"
    const parts = conversationKey.split(":")
    const channelId = parts[2]
    await doRequest("POST", `/channels/${channelId}/typing`)
  }

  /**
   * Push a bot reaction onto a message (ADR-0009 v41 / A2), conforming to the
   * {@link PlatformAdapter} 2-arg contract `addReaction(messageId, emojiType)`
   * the connector bus calls. `messageId` is the `"channelId:messageId"`
   * composite (see {@link splitChannelMessage}); `emojiType` is a unicode
   * character or Discord's custom-emoji `name:id` form, URL-encoded by the
   * serializer for the `/reactions/{emoji}/@me` path.
   *
   * Discord reactions have no addressable id (they're keyed by emoji), so the
   * returned {@link ReactionRef} carries the emoji back as `reactionId` for a
   * later {@link removeReaction}.
   */
  async function addReaction(messageId: string, emojiType: string): Promise<ReactionRef> {
    const [channelId, msgId] = splitChannelMessage(messageId)
    const call = serializeReaction(channelId, msgId, emojiType)
    await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""))
    return { reactionId: emojiType }
  }

  /**
   * Retract a bot reaction previously added with {@link addReaction}. Per the
   * contract the `reactionId` is what `addReaction` returned — for Discord that
   * is the emoji itself.
   */
  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const [channelId, msgId] = splitChannelMessage(messageId)
    const call = serializeReactionRemoval(channelId, msgId, reactionId)
    await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""))
  }

  /**
   * Walk `GET /channels/:id/messages` with cursor pagination (ADR-0009 v41 /
   * A2.b). Each returned message is projected through `parseDiscordDispatch`
   * (via a synthetic MESSAGE_CREATE wrapper, with `allowSelfEcho` so the
   * bot's own past sends stay in the history) so the consumer sees identical
   * `NormalizedInboundEvent` shapes to the live gateway path.
   *
   * Cursor semantics — `before` and `after` are mutually exclusive on
   * Discord's endpoint, so exactly one drives the walk:
   *   - default / `opts.before`: backward walk, `before` advances to the
   *     oldest id of each page (recent → older).
   *   - `opts.after`: forward walk, `after` advances to the NEWEST id of
   *     each page and `before` is never sent.
   *
   * Bounds: per-page size = 100 (Discord cap), max pages = 50 (safety stop),
   * `opts.max` caps total events yielded.
   */
  async function* fetchHistory(
    conversationKey: string,
    historyOpts: { before?: string; after?: string; max?: number }
  ): AsyncGenerator<NormalizedInboundEvent> {
    // conversationKey shape: "discord:<adapterId>:<channelId>[:<threadId>]"
    const parts = conversationKey.split(":")
    const channelId = parts[2]
    if (!channelId) return
    const overallCap = Math.max(historyOpts.max ?? 200, 1)
    const PAGE_SIZE = 100
    const MAX_PAGES = 50
    const forward = historyOpts.after !== undefined

    let yielded = 0
    let cursor: string | undefined = forward ? historyOpts.after : historyOpts.before
    for (let page = 0; page < MAX_PAGES; page++) {
      if (yielded >= overallCap) return
      const call = serializeFetchHistory(channelId, {
        limit: Math.min(PAGE_SIZE, overallCap - yielded),
        before: forward ? undefined : cursor,
        after: forward ? cursor : undefined,
      })
      const resp = (await doRequest("GET", call.url.replace(DISCORD_API_BASE, ""))) as
        DiscordMessage[] | null
      const messages = resp ?? []
      if (messages.length === 0) return

      // Messages are yielded in returned order. The next cursor is the
      // oldest id (backward walk) or the newest id (forward walk).
      for (const msg of messages) {
        if (yielded >= overallCap) return
        const event = parseDiscordDispatch(
          opts.id,
          selfId,
          {
            t: "MESSAGE_CREATE",
            d: msg,
          } as unknown as Parameters<typeof parseDiscordDispatch>[2],
          { allowSelfEcho: true }
        )
        if (event) {
          yielded++
          yield event
        }
      }
      const next = forward ? newestSnowflake(messages) : messages[messages.length - 1]?.id
      if (!next || next === cursor) return
      cursor = next
    }
  }

  /**
   * Bot presence (Custom Status activity) — gateway-only (op 3), no REST
   * fallback. `targetUserIds` is ignored: Discord presence is bot-global.
   * Throws when the gateway is not connected so the presence runner can
   * audit + retry on the next tick.
   */
  async function setPresenceStatus(input: { text: string }): Promise<void> {
    const ok = await _gatewayClient?.updatePresence(input.text)
    if (!ok) {
      throw new Error("Discord gateway not connected; presence update skipped")
    }
  }

  /**
   * Pin a message: `PUT /channels/{channel}/messages/pins/{message}` — the
   * current endpoint; the older `PUT /channels/{c}/pins/{m}` is deprecated.
   */
  async function pinMessage(conversationKey: string, messageId: string): Promise<void> {
    // messageId is "<channelId>:<msgId>" (same convention as delete/edit);
    // fall back to the conversationKey's channel when only a bare id is given.
    const parts = messageId.split(":")
    const channelId = parts.length === 2 ? parts[0] : conversationKey.split(":")[2]
    const msgId = parts.length === 2 ? parts[1] : messageId
    await doRequest("PUT", `/channels/${channelId}/messages/pins/${msgId}`)
  }

  /**
   * Unpin a message: `DELETE /channels/{channel}/messages/pins/{message}`.
   * The contract passes only `messageId`, so the channel must ride in the
   * `"channelId:messageId"` composite (throws on a bare id).
   */
  async function unpinMessage(messageId: string): Promise<void> {
    const [channelId, msgId] = splitChannelMessage(messageId)
    await doRequest("DELETE", `/channels/${channelId}/messages/pins/${msgId}`)
  }

  async function refreshCredentials(): Promise<void> {
    // No-op: botToken is a resolver function called fresh on each request
  }

  return {
    get meta() {
      return {
        type: "discord" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: DISCORD_CAPS,
        transportModes: ["gateway", "webhook"] as const,
        configSchema: DISCORD_CONFIG_SCHEMA,
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
    setPresenceStatus,
    pinMessage,
    unpinMessage,
    addReaction,
    removeReaction,
    fetchHistory,
    refreshCredentials,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("discord"),
    a2uiCapability: () => DISCORD_A2UI_CAPABILITY,
  } as PlatformAdapter & {
    addReaction: typeof addReaction
    removeReaction: typeof removeReaction
    fetchHistory: typeof fetchHistory
  }
}
