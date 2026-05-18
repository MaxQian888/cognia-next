/**
 * Slack adapter factory — Task 76.
 *
 * Assembles parse + serialize + capability + socket-mode transport into a
 * PlatformAdapter. Supports two transports:
 *   - socket-mode  (default): uses apps.connections.open + WSS
 *   - events-api-webhook: stub in Phase 1
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { SLACK_A2UI_CAPABILITY, SLACK_CAPS } from "./capability"
import { parseSlackEventCallback, parseSlackInteractivePayload } from "./parse"
import type { SlackEventEnvelope, SlackInteractivePayload } from "./parse"
import {
  serializeOutboundAsync,
  serializeUpdate,
  serializeDeleteMessage,
  serializeReaction,
  serializeAssistantStatus,
  serializeAssistantSuggestedPrompts,
} from "./serialize"
import { startSocketMode } from "./transport-socket-mode"
import { startSlackWebhookTransport } from "./transport-webhook"
import { parseConversationKey } from "@/types/connectors/event"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { getBus } from "@/lib/connectors/bus"

export interface SlackAdapterOptions {
  id: string
  displayName: string
  /** Resolves the xoxb-... bot token from the keyring on each call. */
  botToken: () => Promise<string>
  /** Resolves the xapp-... app-level token; required when transport === "socket-mode". */
  appToken?: () => Promise<string>
  /** Used to verify webhook signatures from Slack. */
  signingSecret: () => Promise<string>
  /** Bot's own user id (from auth.test). */
  selfId: string
  transport: "socket-mode" | "events-api-webhook"
  /**
   * Opt-in to the Slack assistant-app surface. When true, `setTyping`
   * issues `assistant.threads.setStatus` and the optional
   * `setSuggestedPrompts` adapter method calls
   * `assistant.threads.setSuggestedPrompts`. Off by default so a regular
   * bot adapter never hits Slack's "not_supported" path.
   */
  assistantAppEnabled?: boolean
  /**
   * Cap on `conversations.history` pages walked per `fetchHistory` call.
   * Each page is up to 200 messages; default 10 pages = 2 000 messages,
   * which matches the standard inbox-hydration ceiling. Pass `Infinity`
   * to walk until the API returns `next_cursor === ""`.
   */
  historyMaxPages?: number
}

const SLACK_API_BASE = "https://slack.com/api"

const SLACK_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["botToken", "signingSecret", "transport"],
  properties: {
    botToken: { type: "string", title: "Bot Token (xoxb-...)" },
    appToken: { type: "string", title: "App Token (xapp-...)" },
    signingSecret: { type: "string", title: "Signing Secret" },
    transport: {
      type: "string",
      enum: ["socket-mode", "events-api-webhook"],
      title: "Transport",
      default: "socket-mode",
    },
  },
  additionalProperties: false,
}

export function createSlackAdapter(opts: SlackAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false

  async function doRequest(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const token = await opts.botToken()
    const resp = await connectorsHttpRequest({
      url: `${SLACK_API_BASE}/${path}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (resp.status >= 400) {
      throw new Error(`Slack API ${method} ${path} → ${resp.status}: ${resp.body}`)
    }
    const parsed = resp.body ? (JSON.parse(resp.body) as { ok?: boolean; error?: string }) : null
    if (parsed && parsed.ok === false) {
      throw new Error(`Slack API error: ${parsed.error ?? "unknown"}`)
    }
    return parsed
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal

    healthState = "running"

    if (opts.transport === "socket-mode") {
      const appToken = opts.appToken
      if (!appToken) {
        healthState = "degraded"
        return
      }

      // Drive the socket-mode generator in the background
      ;(async () => {
        try {
          const generator = startSocketMode({ appToken, signal })
          for await (const envelope of generator) {
            if (signal.aborted) break
            const event = parseSlackEventCallback(
              opts.id,
              opts.selfId,
              envelope as SlackEventEnvelope
            )
            if (event) {
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
    } else {
      // events-api-webhook: Rust (axum + verify_slack) terminates the HMAC
      // signature check and emits the parsed body on
      // `connectors://webhook/<adapterId>`. We subscribe here and route each
      // envelope through the same parser the socket-mode path uses.
      ;(async () => {
        try {
          const generator = startSlackWebhookTransport({ adapterId: opts.id, signal })
          for await (const envelope of generator) {
            if (signal.aborted) break
            const event = parseSlackEventCallback(opts.id, opts.selfId, envelope)
            if (event) {
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
  }

  async function stop(): Promise<void> {
    stopCalled = true
    abortController?.abort()
    abortController = null
    healthState = "down"
  }

  function health(): AdapterHealth {
    return { state: healthState, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    try {
      const call = await serializeOutboundAsync(req, opts.id)
      const result = (await doRequest("POST", "chat.postMessage", call.payload)) as {
        ts?: string
      } | null
      return { ok: true, platformMessageId: result?.ts }
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

  /**
   * Public entry point for the Tauri webhook dispatcher / Socket Mode
   * dispatcher to hand a Slack interactive payload to the bus callback
   * channel. Mirrors the `ctx.emit` shape but produces a
   * `ConnectorCallbackEvent` instead of a message event.
   */
  async function handleInteractivePayload(payload: SlackInteractivePayload): Promise<void> {
    const callback = parseSlackInteractivePayload(opts.id, opts.selfId, payload)
    if (!callback) return
    lastActivityAt = Date.now()
    await getBus().dispatchConnectorCallback(callback)
  }

  async function edit(messageId: string, patch: OutboundRequest): Promise<OutboundResult> {
    const ref = patch.conversationRef as Record<string, unknown>
    const channel = String(ref["channelId"] ?? "")
    // messageId in Slack is the ts
    try {
      const call = serializeUpdate(channel, messageId, patch)
      await doRequest("POST", "chat.update", call.payload)
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
    // messageId format: "channelId:ts"
    const parts = messageId.split(":")
    if (parts.length === 2) {
      const [channel, ts] = parts
      const call = serializeDeleteMessage(channel, ts)
      await doRequest("POST", "chat.delete", call.payload)
    }
  }

  /**
   * Walk `conversations.history` (and `conversations.replies` when the
   * conversationKey carries a thread_ts) with cursor pagination. Each
   * raw Slack message is projected through the regular event parser so
   * the consumer sees the same NormalizedInboundEvent shape as a live
   * websocket delivery.
   *
   * Bounds:
   *   - per-page size = 200 (Slack's `conversations.history` cap)
   *   - max pages    = `opts.historyMaxPages` ?? 10
   *   - `opts.before` is forwarded as `latest`; `opts.after` as `oldest`.
   *   - `opts.max` further caps total messages yielded.
   */
  async function* fetchHistory(
    conversationKey: string,
    historyOpts: { before?: string; after?: string; max?: number }
  ): AsyncIterable<NormalizedInboundEvent> {
    const parsed = parseConversationKey(conversationKey)
    const channel = parsed.remoteChatId
    const threadTs = parsed.threadId
    const maxPages = opts.historyMaxPages ?? 10
    const overallCap = historyOpts.max ?? Number.POSITIVE_INFINITY

    let cursor: string | undefined = undefined
    let yielded = 0

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { channel, limit: "200" }
      if (cursor) params["cursor"] = cursor
      if (historyOpts.before) params["latest"] = historyOpts.before
      if (historyOpts.after) params["oldest"] = historyOpts.after
      if (threadTs) params["ts"] = threadTs

      const search = new URLSearchParams(params).toString()
      const apiPath = threadTs
        ? `conversations.replies?${search}`
        : `conversations.history?${search}`

      const response = (await doRequest("GET", apiPath)) as {
        messages?: Array<Record<string, unknown>>
        response_metadata?: { next_cursor?: string }
      } | null

      const messages = response?.messages ?? []
      for (const msg of messages) {
        if (yielded >= overallCap) return
        // Project a Slack message into the SlackEventEnvelope shape the
        // parser already understands. Synthesising channel + type lets us
        // share the live + history paths without a second parser.
        const envelope: SlackEventEnvelope = {
          type: "event_callback",
          event: {
            type: "message",
            channel,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            ...(msg as Record<string, unknown>),
          } as SlackEventEnvelope["event"],
        } as SlackEventEnvelope
        const event = parseSlackEventCallback(opts.id, opts.selfId, envelope)
        if (event) {
          yielded++
          yield event
        }
      }

      const nextCursor = response?.response_metadata?.next_cursor
      if (!nextCursor || nextCursor.length === 0) return
      cursor = nextCursor
    }
  }

  /**
   * Typing indicator. When `assistantAppEnabled` is false, this stays a
   * no-op (matches Phase 1 behaviour for regular bot installs). When
   * enabled and the conversationKey carries a thread, we issue
   * `assistant.threads.setStatus` with "is typing…" / "" depending on
   * `on`. Conversations without a thread_ts can't set assistant status —
   * Slack returns `not_supported` — so we silently skip those.
   */
  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!opts.assistantAppEnabled) return
    const parsed = parseConversationKey(conversationKey)
    if (!parsed.threadId) return
    const call = serializeAssistantStatus(
      parsed.remoteChatId,
      parsed.threadId,
      on ? "is typing…" : ""
    )
    await doRequest("POST", "assistant.threads.setStatus", call.payload)
  }

  /**
   * Optional Slack-only escape hatch for surfacing assistant-thread
   * suggested prompts. Cognia's chat surface does not yet expose this —
   * the method is here so plugins / workflows can drive it directly via
   * `bus.listAdapters().find(...).setSuggestedPrompts(...)`. No-op when
   * `assistantAppEnabled` is false.
   */
  async function setSuggestedPrompts(
    conversationKey: string,
    prompts: Array<{ title: string; message: string }>,
    title?: string
  ): Promise<void> {
    if (!opts.assistantAppEnabled) return
    const parsed = parseConversationKey(conversationKey)
    if (!parsed.threadId) return
    const call = serializeAssistantSuggestedPrompts(
      parsed.remoteChatId,
      parsed.threadId,
      prompts,
      title
    )
    await doRequest("POST", "assistant.threads.setSuggestedPrompts", call.payload)
  }

  async function refreshCredentials(): Promise<void> {
    // No-op: all token resolvers call fresh on each request.
  }

  async function addReaction(channel: string, ts: string, name: string): Promise<void> {
    const call = serializeReaction(channel, ts, name)
    await doRequest("POST", "reactions.add", call.payload)
  }

  const adapter: PlatformAdapter & {
    addReaction?: typeof addReaction
    setSuggestedPrompts?: typeof setSuggestedPrompts
  } = {
    get meta() {
      return {
        type: "slack" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: SLACK_CAPS,
        transportModes: [opts.transport === "socket-mode" ? "gateway" : "webhook"] as const,
        configSchema: SLACK_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    edit,
    delete: deleteMessage,
    fetchHistory,
    setTyping,
    refreshCredentials,
    a2uiCapability: () => SLACK_A2UI_CAPABILITY,
    addReaction,
    setSuggestedPrompts,
    handleInteractivePayload,
  } as PlatformAdapter & {
    addReaction?: typeof addReaction
    setSuggestedPrompts?: typeof setSuggestedPrompts
    handleInteractivePayload?: typeof handleInteractivePayload
  }

  return adapter
}
