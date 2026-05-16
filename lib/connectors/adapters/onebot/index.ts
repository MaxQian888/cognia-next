/**
 * OneBot adapter factory — assembles parse + serialize + capability +
 * reverse-WS transport into a PlatformAdapter.
 *
 * Transport: the OneBot client (NapCat/Lagrange/LLOneBot) connects TO us via
 * reverse WebSocket. The Rust axum server accepts the WS upgrade on
 * `/ws/onebot/:adapter_id` and emits Tauri events; this module subscribes to
 * those events and projects them through the parser.
 *
 * Outbound: routes through sendToOneBot (echo-matched RPC), using v11 or v12
 * serialiser based on the cached variant from the first inbound event.
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
import { ONEBOT_CAPS } from "./capability"
import { parseOneBotEvent, clearVariantCache } from "./parse"
import {
  serializeOutboundV11,
  serializeOutboundV12,
  serializeDeleteV11,
  serializeDeleteV12,
} from "./serialize"
import {
  subscribeOneBotEvents,
  subscribeOneBotOpen,
  subscribeOneBotClose,
  subscribeOneBotResponses,
  sendToOneBot,
  type UnlistenFn,
} from "./transport-reverse-ws"

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

  // Cleanup functions for Tauri event listeners
  const unlisteners: UnlistenFn[] = []

  function getVariant(): "v11" | "v12" {
    return currentVariant ?? "v11"
  }

  async function start(ctx: AdapterContext): Promise<void> {
    stopCalled = false
    healthState = "running"

    // Subscribe to RPC responses first
    const unlistenResp = await subscribeOneBotResponses(opts.id)
    unlisteners.push(unlistenResp)

    // Subscribe to open/close lifecycle
    const unlistenOpen = await subscribeOneBotOpen(opts.id, () => {
      healthState = "running"
      lastActivityAt = Date.now()
    })
    unlisteners.push(unlistenOpen)

    const unlistenClose = await subscribeOneBotClose(opts.id, () => {
      if (!stopCalled) {
        healthState = "degraded"
      }
    })
    unlisteners.push(unlistenClose)

    // Subscribe to inbound events
    const unlistenEvents = await subscribeOneBotEvents(opts.id, async (rawEvent) => {
      const result = parseOneBotEvent(opts.id, rawEvent)
      if (result === null) return

      // Cache the detected variant
      currentVariant = result.variant

      if (result.parsed !== null) {
        lastActivityAt = Date.now()
        await ctx.emit(result.parsed)
      }
    })
    unlisteners.push(unlistenEvents)
  }

  async function stop(): Promise<void> {
    stopCalled = true
    for (const fn of unlisteners) {
      try {
        fn()
      } catch {
        // Ignore errors during cleanup
      }
    }
    unlisteners.length = 0
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
        const resp = await sendToOneBot(opts.id, call)
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

    await sendToOneBot(opts.id, call)
  }

  async function setTyping(_conversationKey: string, _on: boolean): Promise<void> {
    // OneBot has no typing indicator — no-op
  }

  async function refreshCredentials(): Promise<void> {
    // bearerToken is resolved on each call; nothing to refresh eagerly
  }

  return {
    get meta() {
      return {
        type: "onebot" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: ONEBOT_CAPS,
        transportModes: ["reverse-ws"] as const,
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
  }
}
