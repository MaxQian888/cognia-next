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
import { SLACK_CAPS } from "./capability"
import { parseSlackEventCallback } from "./parse"
import type { SlackEventEnvelope } from "./parse"
import {
  serializeOutbound,
  serializeUpdate,
  serializeDeleteMessage,
  serializeReaction,
} from "./serialize"
import { startSocketMode } from "./transport-socket-mode"

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
      // events-api-webhook: stub in Phase 1
      // The webhook endpoint is handled by the Tauri Rust HTTP proxy;
      // nothing to drive here in Phase 1.
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
      const call = serializeOutbound(req)
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

  async function* fetchHistory(
    _conversationKey: string,
    _opts: { before?: string; after?: string; max?: number }
  ): AsyncIterable<import("@/types/connectors").NormalizedInboundEvent> {
    // TODO Phase 2: implement conversations.history with cursor pagination
  }

  async function setTyping(_conversationKey: string, _on: boolean): Promise<void> {
    // Slack assistant.threads.setStatus is gated to assistant apps;
    // no-op for standard bot adapters in Phase 1.
  }

  async function refreshCredentials(): Promise<void> {
    // No-op: all token resolvers call fresh on each request.
  }

  async function addReaction(channel: string, ts: string, name: string): Promise<void> {
    const call = serializeReaction(channel, ts, name)
    await doRequest("POST", "reactions.add", call.payload)
  }

  const adapter: PlatformAdapter & { addReaction?: typeof addReaction } = {
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
    addReaction,
  }

  return adapter
}
