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
import { TELEGRAM_A2UI_CAPABILITY, TELEGRAM_CAPS } from "./capability"
import { parseTelegramUpdate, parseTelegramCallbackQuery, type TelegramUpdate } from "./parse"
import { serializeOutboundAsync } from "./serialize"
import { startLongPoll } from "./transport-longpoll"
import { startWebhookTransport } from "./transport-webhook"
import { getBus } from "@/lib/connectors/bus"

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

          // Inline-keyboard / callback_query → route through the
          // ConnectorBus callback channel (G4). The bus dedups via
          // namespace="callback", recovers surfaceId/componentId via
          // `connectorCallbackBindings`, and forwards through the
          // a2ui-bridge MCP server to drive the next assistant turn.
          if (update.callback_query !== undefined) {
            const callback = parseTelegramCallbackQuery(opts.id, opts.selfId, update)
            if (callback) {
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

          // Regular message / edit / reaction → message event.
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
    const calls = await serializeOutboundAsync(req, opts.id)
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
    a2uiCapability: () => TELEGRAM_A2UI_CAPABILITY,
  }
}
