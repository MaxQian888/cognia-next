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
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { DISCORD_A2UI_CAPABILITY, DISCORD_CAPS } from "./capability"
import { parseDiscordDispatch, parseDiscordInteraction, type DiscordMessage } from "./parse"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import {
  serializeOutboundAsync,
  serializeDelete,
  serializeEdit,
  serializeReaction,
  serializeReactionRemoval,
  serializeFetchHistory,
} from "./serialize"
import { sendDiscordVoiceMessage } from "./voice-upload"
import { startGatewayClient } from "./gateway-client"
import type { GatewayClient } from "./gateway-client"
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
}

const DISCORD_API_BASE = "https://discord.com/api/v10"

const DISCORD_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["botToken"],
  properties: {
    botToken: { type: "string", title: "Bot Token" },
    publicKey: { type: "string", title: "Public Key (for webhook verification)" },
    intents: { type: "number", title: "Gateway Intents", default: 33281 },
  },
  additionalProperties: false,
}

export function createDiscordAdapter(opts: DiscordAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false
  let selfId = opts.selfId
  let _gatewayClient: GatewayClient | null = null

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
      throw new Error(`Discord API ${method} ${path} → ${resp.status}: ${resp.body}`)
    }
    return resp.body ? JSON.parse(resp.body) : null
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal

    healthState = "running"

    const client = startGatewayClient({
      botToken: opts.botToken,
      signal,
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
          healthState = "down"
        }
      } catch {
        if (!stopCalled) {
          healthState = "degraded"
        }
      }
    })()
  }

  async function stop(): Promise<void> {
    stopCalled = true
    abortController?.abort()
    abortController = null
    _gatewayClient = null
    healthState = "down"
  }

  function health(): AdapterHealth {
    return { state: healthState, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    // Voice segments use a dedicated multipart-style upload helper
    // because Discord's voice messages require the IS_VOICE_MESSAGE flag
    // + duration_secs metadata on the attachment, which doesn't fit the
    // generic POST /messages JSON body the rest of the segments use.
    const channelId = String((req.conversationRef as Record<string, unknown>)["channelId"] ?? "")
    const voiceSegments = req.segments.filter((s) => s.type === "voice")
    const otherSegments = req.segments.filter((s) => s.type !== "voice")

    let platformMessageId: string | undefined

    try {
      for (const seg of voiceSegments) {
        if (seg.type !== "voice") continue
        const result = await sendDiscordVoiceMessage({
          botToken: opts.botToken,
          channelId,
          voiceUrl: seg.url,
          durationSec: seg.durationSec,
          replyToMessageId: req.replyTo?.messageId,
        })
        if (result.messageId) platformMessageId = result.messageId
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
    const channelId = String(ref["channelId"] ?? "")

    // Build content from first text/markdown segment
    const seg = patch.segments.find((s) => s.type === "text" || s.type === "markdown")
    const content = seg?.type === "text" ? seg.text : seg?.type === "markdown" ? seg.md : ""

    try {
      const call = serializeEdit(channelId, messageId, content)
      await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""), call.payload)
      return { ok: true }
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

  async function deleteMessage(messageId: string): Promise<void> {
    // messageId format: "channelId:messageId" for Discord
    const parts = messageId.split(":")
    if (parts.length === 2) {
      const [channelId, msgId] = parts
      const call = serializeDelete(channelId, msgId)
      await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""))
    }
  }

  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!on) return // typing indicator is triggered by POST, no "stop" endpoint
    // conversationKey: "discord:<adapterId>:<channelId>[:<threadId>]"
    const parts = conversationKey.split(":")
    const channelId = parts[2]
    await doRequest("POST", `/channels/${channelId}/typing`)
  }

  /**
   * Push a bot reaction onto a message (ADR-0009 v41 / A2). Mirrors the
   * Slack adapter's `addReaction(channel, ts, name)` shape so the
   * connector bus can issue reaction sends without adapter-specific
   * branches. `emoji` is either a unicode character or Discord's custom
   * emoji `name:id` form; the serializer URL-encodes it for the
   * `/reactions/{emoji}/@me` path.
   */
  async function addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const call = serializeReaction(channelId, messageId, emoji)
    await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""))
  }

  /** Retract a bot reaction previously added with `addReaction`. */
  async function removeReaction(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const call = serializeReactionRemoval(channelId, messageId, emoji)
    await doRequest(call.method, call.url.replace(DISCORD_API_BASE, ""))
  }

  /**
   * Walk `GET /channels/:id/messages` with `before=cursor` pagination
   * (ADR-0009 v41 / A2.b). Each returned message is projected through
   * `parseDiscordDispatch` (via a synthetic MESSAGE_CREATE wrapper) so the
   * consumer sees identical `NormalizedInboundEvent` shapes to the live
   * gateway path.
   *
   * Bounds:
   *   - per-page size = 100 (Discord cap)
   *   - max pages = 50 (safety stop)
   *   - `opts.before` is forwarded as the starting message-id cursor
   *   - `opts.max` caps total events yielded.
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

    let yielded = 0
    let cursor: string | undefined = historyOpts.before
    for (let page = 0; page < MAX_PAGES; page++) {
      if (yielded >= overallCap) return
      const call = serializeFetchHistory(channelId, {
        limit: Math.min(PAGE_SIZE, overallCap - yielded),
        before: cursor,
        after: historyOpts.after,
      })
      const resp = (await doRequest("GET", call.url.replace(DISCORD_API_BASE, ""))) as
        | DiscordMessage[]
        | null
      const messages = resp ?? []
      if (messages.length === 0) return

      // Discord returns newest-first; iterate in returned order so the
      // consumer gets recent → older. The pagination cursor is the oldest
      // message's id for the next (even older) page.
      for (const msg of messages) {
        if (yielded >= overallCap) return
        const event = parseDiscordDispatch(opts.id, selfId, {
          t: "MESSAGE_CREATE",
          d: msg,
        } as unknown as Parameters<typeof parseDiscordDispatch>[2])
        if (event) {
          yielded++
          yield event
        }
      }
      const oldest = messages[messages.length - 1]
      if (!oldest?.id || oldest.id === cursor) return
      cursor = oldest.id
    }
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
        transportModes: ["gateway"] as const,
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
    addReaction,
    removeReaction,
    fetchHistory,
    refreshCredentials,
    a2uiCapability: () => DISCORD_A2UI_CAPABILITY,
  } as PlatformAdapter & {
    addReaction: typeof addReaction
    removeReaction: typeof removeReaction
    fetchHistory: typeof fetchHistory
  }
}
