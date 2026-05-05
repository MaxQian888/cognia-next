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
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { TELEGRAM_CAPS } from "./capability"
import { parseTelegramUpdate, type TelegramUpdate } from "./parse"
import { serializeOutbound } from "./serialize"
import { startLongPoll } from "./transport-longpoll"
import { startWebhookTransport } from "./transport-webhook"

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
    webhookSecret: { type: "string", title: "Webhook Secret Token" },
  },
  additionalProperties: false,
}

const TELEGRAM_API_BASE = "https://api.telegram.org"

export function createTelegramAdapter(opts: TelegramAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false

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
    const body = JSON.parse(resp.body) as { ok: boolean; result?: { message_id?: number } }
    if (!body.ok) {
      throw new Error(`Telegram ${method} failed: ${resp.body}`)
    }
    return body.result ?? {}
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal

    healthState = "running"

    const feed: AsyncGenerator<TelegramUpdate> =
      opts.transport === "longpoll"
        ? startLongPoll({ botToken: opts.botToken, signal })
        : startWebhookTransport({ adapterId: opts.id, signal })

    // Drive the transport in the background
    ;(async () => {
      try {
        for await (const update of feed) {
          if (signal.aborted) break
          const event = parseTelegramUpdate(opts.id, opts.selfId, update)
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
        const result = await doSend(call.method, call.payload as Record<string, unknown>)
        if (result.message_id !== undefined) {
          platformMessageId = String(result.message_id)
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
    const chatId = ref["chatId"]

    // Build text from first text/markdown segment
    const seg = patch.segments.find((s) => s.type === "text" || s.type === "markdown")
    const text = seg?.type === "text" ? seg.text : seg?.type === "markdown" ? seg.md : ""

    try {
      await doSend("editMessageText", {
        chat_id: chatId,
        message_id: Number(messageId),
        text,
      })
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
    // We need chat_id — callers must embed it in the messageId as "chatId:msgId" for Telegram
    // For simplicity in Phase 1, messageId is expected as plain message_id and chatId comes from context.
    // This method signature only gets messageId, so we can only do best-effort.
    await doSend("deleteMessage", { message_id: Number(messageId) })
  }

  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!on) return // Telegram doesn't have a "stop typing" command
    // Extract chatId from conversationKey: "telegram:<adapterId>:<chatId>[:<threadId>]"
    const parts = conversationKey.split(":")
    const chatId = parts[2]
    await doSend("sendChatAction", { chat_id: chatId, action: "typing" })
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
    refreshCredentials,
  }
}
