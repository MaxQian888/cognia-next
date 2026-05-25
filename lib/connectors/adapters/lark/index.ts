/**
 * Lark adapter factory — Task 89.
 *
 * Assembles parse + serialize + capability + transport into a PlatformAdapter.
 * Supports two transports:
 *   - long-connection (default): uses /im/v1/wsServer + WSS
 *   - webhook: subscribes to Tauri event channel from Rust HTTP proxy
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { LARK_A2UI_CAPABILITY, LARK_CAPS } from "./capability"
import {
  parseLarkEventEnvelope,
  parseLarkBotMenuEvent,
  parseLarkInteractiveCallback,
} from "./parse"
import { getBus } from "@/lib/connectors/bus"
import type { LarkEventEnvelope } from "./parse"
import type { LarkQuickCommand } from "./quick-commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import {
  serializeOutbound,
  serializeOutboundAsync,
  serializeEdit,
  serializeDelete,
  serializeReaction,
} from "./serialize"
import { getTenantAccessToken } from "./auth"
import { LarkApiError, withTatRefresh } from "./auth-retry"
import { resolveLarkMediaKeys } from "./upload"
import { startLarkLongConn } from "./transport-long-conn"
import { startLarkWebhookTransport } from "./transport-webhook"
import { parseConversationKey } from "@/types/connectors/event"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

export interface LarkAdapterOptions {
  id: string
  displayName: string
  /** Resolves the App ID (cli_...) on each call. */
  appId: () => Promise<string>
  /** Resolves the App Secret on each call. */
  appSecret: () => Promise<string>
  /** Optional Encrypt Key; required when webhook+encryption is enabled. */
  encryptKey?: () => Promise<string>
  /** Verification Token for webhook header validation. */
  verificationToken: () => Promise<string>
  /** Bot's own open_id; used to detect self-mentions. */
  selfBotOpenId: string
  /**
   * Bot-menu (快捷指令) mappings: each `event_key` → an action the assistant
   * turn should run when the user clicks the corresponding Feishu bot menu.
   */
  quickCommands?: LarkQuickCommand[]
  transport: "webhook" | "long-connection"
  /**
   * Cap on `/im/v1/messages` pages walked per `fetchHistory` call. Each
   * page is up to 50 messages (Lark's documented default). Defaults to
   * 20 pages = 1 000 messages, matching the inbox-hydration ceiling.
   * Pass `Infinity` to walk until the API stops returning `has_more`.
   */
  historyMaxPages?: number
}

const LARK_API_BASE = "https://open.feishu.cn/open-apis"

const LARK_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["appId", "appSecret", "verificationToken", "transport"],
  properties: {
    appId: { type: "string", title: "App ID (cli_...)" },
    appSecret: { type: "string", title: "App Secret" },
    encryptKey: { type: "string", title: "Encrypt Key (optional)" },
    verificationToken: { type: "string", title: "Verification Token" },
    transport: {
      type: "string",
      enum: ["long-connection", "webhook"],
      title: "Transport",
      default: "long-connection",
    },
  },
  additionalProperties: false,
}

export function createLarkAdapter(opts: LarkAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false

  // Per-adapter-session URL → file_key / image_key cache so repeated sends
  // of the same media don't re-upload. Cleared on `stop()`.
  const uploadCache = new Map<string, string>()

  async function getTat(): Promise<string> {
    const [appId, appSecret] = await Promise.all([opts.appId(), opts.appSecret()])
    return getTenantAccessToken({ appId, appSecret })
  }

  async function resolveCredentials(): Promise<{ appId: string; appSecret: string }> {
    const [appId, appSecret] = await Promise.all([opts.appId(), opts.appSecret()])
    return { appId, appSecret }
  }

  async function doRequest(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    urlPath: string,
    body?: unknown
  ): Promise<unknown> {
    const creds = await resolveCredentials()
    return withTatRefresh(creds, async () => {
      const tat = await getTenantAccessToken(creds)
      const resp = await connectorsHttpRequest({
        url: `${LARK_API_BASE}${urlPath}`,
        method,
        headers: {
          Authorization: `Bearer ${tat}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (resp.status >= 400) {
        throw new LarkApiError({
          status: resp.status,
          code: null,
          message: `Lark API ${method} ${urlPath} → ${resp.status}: ${resp.body}`,
        })
      }
      const parsed = resp.body ? (JSON.parse(resp.body) as { code?: number; msg?: string }) : null
      if (parsed && typeof parsed.code === "number" && parsed.code !== 0) {
        throw new LarkApiError({
          status: resp.status,
          code: parsed.code,
          message: `Lark API error: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`,
        })
      }
      return parsed
    })
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal

    healthState = "running"

    /**
     * Shared envelope dispatcher — handles both the long-connection and
     * webhook paths. Interactive-card callbacks (G3.4) go through the
     * ConnectorBus callback channel; everything else flows to
     * `ctx.emit` as a normalised message event.
     */
    const dispatchEnvelope = async (envelope: LarkEventEnvelope): Promise<void> => {
      // Interactive card callbacks — route to the callback channel.
      if (envelope.header?.event_type === "im.interactive_message.action_triggered_v1") {
        const callback = parseLarkInteractiveCallback(opts.id, opts.selfBotOpenId, envelope)
        if (callback) {
          lastActivityAt = Date.now()
          await getBus().dispatchConnectorCallback(callback)
        }
        return
      }
      // Bot-menu (快捷指令) clicks — map event_key → action, then run the
      // same gate → bus → ai-run path as a regular message.
      if (envelope.header?.event_type === "application.bot.menu_v6") {
        const menuEvent = parseLarkBotMenuEvent(
          opts.id,
          opts.selfBotOpenId,
          envelope,
          opts.quickCommands
        )
        if (menuEvent) {
          if (!(await gateInboundEvent(opts.id, menuEvent))) return
          lastActivityAt = Date.now()
          await ctx.emit(menuEvent)
        }
        return
      }
      const event = parseLarkEventEnvelope(opts.id, opts.selfBotOpenId, envelope)
      if (event) {
        // v45 (im-refactored-crayon) — gate inbound `create` messages on
        // the operator-configured at-strategy + chat allow/blocklist
        // before the bus is invoked. Helper audits `inbound.policy_blocked`
        // on deny and fails open on Dexie read errors.
        if (!(await gateInboundEvent(opts.id, event))) return
        lastActivityAt = Date.now()
        await ctx.emit(event)
      }
    }

    if (opts.transport === "long-connection") {
      ;(async () => {
        try {
          const generator = startLarkLongConn({
            adapterId: opts.id,
            signal,
          })
          for await (const envelope of generator) {
            if (signal.aborted) break
            await dispatchEnvelope(envelope as LarkEventEnvelope)
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
      // webhook transport
      ;(async () => {
        try {
          const generator = startLarkWebhookTransport({
            adapterId: opts.id,
            signal,
          })
          for await (const envelope of generator) {
            if (signal.aborted) break
            await dispatchEnvelope(envelope as LarkEventEnvelope)
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
    uploadCache.clear()
  }

  function health(): AdapterHealth {
    return { state: healthState, lastActivityAt }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    try {
      const creds = await resolveCredentials()
      // Upload pre-pass — Rust `connectors_lark_upload_*` commands surface
      // TAT invalidation as Error.message text; `withTatRefresh` detects
      // those by substring and retries with a fresh token.
      const resolvedSegments = await withTatRefresh(creds, () =>
        resolveLarkMediaKeys(req.segments, {
          getAccessToken: getTat,
          uploadCache,
        })
      )
      const call = await serializeOutboundAsync({ ...req, segments: resolvedSegments }, opts.id)
      const urlPath = call.url.replace(LARK_API_BASE, "")
      await doRequest(call.method, urlPath, call.payload)
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

  async function edit(messageId: string, patch: OutboundRequest): Promise<OutboundResult> {
    try {
      const creds = await resolveCredentials()
      const resolvedSegments = await withTatRefresh(creds, () =>
        resolveLarkMediaKeys(patch.segments, {
          getAccessToken: getTat,
          uploadCache,
        })
      )
      const call = serializeEdit(messageId, { ...patch, segments: resolvedSegments })
      const urlPath = call.url.replace(LARK_API_BASE, "")
      await doRequest(call.method, urlPath, call.payload)
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
    const call = serializeDelete(messageId)
    const urlPath = call.url.replace(LARK_API_BASE, "")
    await doRequest(call.method, urlPath)
  }

  /**
   * Walk Lark's `/im/v1/messages` list with `page_token` cursor
   * pagination. Each raw message is wrapped in a synthetic
   * im.message.receive_v1 envelope and projected through the live event
   * parser so the consumer sees the same NormalizedInboundEvent shape.
   *
   * Bounds:
   *   - per-page size = 50 (Lark default; max 50)
   *   - max pages    = `opts.historyMaxPages` ?? 20
   *   - `historyOpts.before` / `historyOpts.after` are forwarded as
   *     `end_time` / `start_time` (Lark expects ISO seconds-since-epoch
   *     strings; the caller must already provide that format).
   *   - `historyOpts.max` further caps the total messages yielded.
   */
  async function* fetchHistory(
    conversationKey: string,
    historyOpts: { before?: string; after?: string; max?: number }
  ): AsyncIterable<NormalizedInboundEvent> {
    const parsed = parseConversationKey(conversationKey)
    const chatId = parsed.remoteChatId
    const maxPages = opts.historyMaxPages ?? 20
    const overallCap = historyOpts.max ?? Number.POSITIVE_INFINITY

    let pageToken: string | undefined = undefined
    let yielded = 0

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = {
        container_id_type: "chat",
        container_id: chatId,
        page_size: "50",
      }
      if (pageToken) params["page_token"] = pageToken
      if (historyOpts.after) params["start_time"] = historyOpts.after
      if (historyOpts.before) params["end_time"] = historyOpts.before

      const search = new URLSearchParams(params).toString()
      const response = (await doRequest("GET", `/im/v1/messages?${search}`)) as {
        data?: {
          items?: Array<Record<string, unknown>>
          page_token?: string
          has_more?: boolean
        }
      } | null

      const items = response?.data?.items ?? []
      for (const item of items) {
        if (yielded >= overallCap) return
        const envelope: LarkEventEnvelope = {
          schema: "2.0",
          header: {
            event_id: `hist:${(item as { message_id?: string }).message_id ?? "?"}`,
            event_type: "im.message.receive_v1",
          },
          event: {
            sender: (item as { sender?: LarkEventEnvelope["event"]["sender"] }).sender,
            message: item as unknown as LarkEventEnvelope["event"]["message"],
          },
        }
        const event = parseLarkEventEnvelope(opts.id, opts.selfBotOpenId, envelope)
        if (event) {
          yielded++
          yield event
        }
      }

      const nextToken = response?.data?.page_token
      const hasMore = response?.data?.has_more
      if (!hasMore || !nextToken || nextToken.length === 0) return
      pageToken = nextToken
    }
  }

  async function setTyping(_conversationKey: string, _on: boolean): Promise<void> {
    // Lark has no native typing indicator for bots; no-op.
  }

  async function refreshCredentials(): Promise<void> {
    // All token resolvers call fresh on each request; cache handles the rest.
  }

  async function addReaction(messageId: string, emojiType: string): Promise<void> {
    const call = serializeReaction(messageId, emojiType)
    const urlPath = call.url.replace(LARK_API_BASE, "")
    await doRequest(call.method, urlPath, call.payload)
  }

  const adapter: PlatformAdapter & { addReaction?: typeof addReaction } = {
    get meta() {
      return {
        type: "lark" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: LARK_CAPS,
        transportModes: [opts.transport === "long-connection" ? "gateway" : "webhook"] as const,
        configSchema: LARK_CONFIG_SCHEMA,
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
    a2uiCapability: () => LARK_A2UI_CAPABILITY,
    platformSkillCapabilities: () => {
      // Lazy ESM import via the synchronous bundler entry. The barrel
      // self-registers every Lark skill family; `summariseSkillCapabilities`
      // just walks the registry — zero I/O, safe in adapter start.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@/lib/skills/built-in")
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { summariseSkillCapabilities } = require("@/lib/skills/built-in/manifest") as {
        summariseSkillCapabilities: typeof import("@/lib/skills/built-in/manifest").summariseSkillCapabilities
      }
      return summariseSkillCapabilities("lark")
    },
    addReaction,
  }

  return adapter
}
