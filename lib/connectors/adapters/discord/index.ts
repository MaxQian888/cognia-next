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
import { DISCORD_CAPS } from "./capability"
import { parseDiscordDispatch } from "./parse"
import { serializeOutbound, serializeDelete, serializeEdit } from "./serialize"
import { startGatewayClient } from "./gateway-client"
import type { GatewayClient } from "./gateway-client"

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
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

          const event = parseDiscordDispatch(opts.id, selfId, dispatch)
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
    const calls = serializeOutbound(req)
    let platformMessageId: string | undefined

    try {
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
    refreshCredentials,
  }
}
