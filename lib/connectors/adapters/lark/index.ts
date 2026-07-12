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
import { normalizeQuickCommandList } from "@/lib/connectors/quick-commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import {
  serializeOutboundAsync,
  serializeEditAsync,
  serializeDelete,
  serializeReaction,
} from "./serialize"
import { getTenantAccessToken, getUserAccessToken } from "./auth"
import { LarkApiError, withTatRefresh, withUserTokenRefresh } from "./auth-retry"
import { createLarkChatManagement } from "./chat-management"
import { resolveLarkMediaKeys } from "./upload"
import { enrichLarkInboundMedia } from "./inbound-media"
import { createLarkPresence } from "./presence"
import { startLarkLongConn } from "./transport-long-conn"
import { startLarkWebhookTransport } from "./transport-webhook"
import { parseConversationKey } from "@/types/connectors/event"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { loggers } from "@/lib/logging"

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
   * Bot-menu (快捷指令) mappings: each trigger key → an action the assistant
   * turn should run when the user clicks the corresponding Feishu bot menu.
   * Legacy persisted rows (`eventKey` instead of `triggerKey`) are upgraded
   * at the adapter-registry boundary via `normalizeQuickCommandList`; the
   * factory itself re-normalises as defense-in-depth.
   */
  quickCommands?: LarkQuickCommand[]
  /**
   * When true and a user access token is connected (via the OAuth flow in
   * `oauth-handler.ts`), outbound `send()` acts on behalf of the authorised
   * user (user_access_token) instead of the bot (tenant_access_token). Opt-in
   * per adapter via `settings.sendAsUser`. Falls back to the bot identity when
   * no user token is connected or it cannot be refreshed.
   */
  sendAsUser?: boolean
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
  // Normalise quickCommands once at factory time so the inbound parse
  // path receives canonical `triggerKey` rows even when the persisted
  // Dexie shape still carries the legacy `eventKey` field.
  const normalizedQuickCommands = normalizeQuickCommandList(opts.quickCommands)
  opts = { ...opts, quickCommands: normalizedQuickCommands }

  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  // Stable machine code (not a sentence) explaining a non-running health
  // state, surfaced to the UI via `health().reason` → heartbeat →
  // `useAdapterHealth`. Localized in the renderer by `healthReasonLabel`.
  let healthReason: string | undefined = undefined
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

  /** Issue one authenticated Lark API call with an explicit bearer token. */
  async function sendHttp(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    urlPath: string,
    body: unknown,
    token: string
  ): Promise<unknown> {
    const resp = await connectorsHttpRequest({
      url: `${LARK_API_BASE}${urlPath}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
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
  }

  async function doRequest(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    urlPath: string,
    body?: unknown,
    reqOpts?: { asUser?: boolean }
  ): Promise<unknown> {
    const creds = await resolveCredentials()

    // Opt-in send-as-user path: act on behalf of the connected user when a user
    // token is present, refreshing it once on invalidation. Any failure of the
    // user path degrades to the bot (tenant) identity so the message still
    // goes out — the user just needs to re-authorise to restore their identity.
    if (reqOpts?.asUser) {
      const userToken = await getUserAccessToken(opts.id).catch(() => null)
      if (userToken) {
        try {
          return await withUserTokenRefresh({ adapterId: opts.id, ...creds }, async () => {
            const tok = (await getUserAccessToken(opts.id)) ?? userToken
            return sendHttp(method, urlPath, body, tok)
          })
        } catch (err) {
          loggers.network.warn("[lark] user-token send failed; falling back to bot identity", {
            id: opts.id,
            reason: err instanceof Error ? err.message : String(err),
          })
          // fall through to the tenant path below
        }
      }
    }

    return withTatRefresh(creds, async () => {
      const tat = await getTenantAccessToken(creds)
      return sendHttp(method, urlPath, body, tat)
    })
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false

    // Pre-flight credential check. A Lark adapter with no appId/appSecret can
    // never connect — Rust `open()` aborts with "not configured in keyring",
    // and the long-conn transport would otherwise retry that terminal failure
    // forever, spamming warns. Skip such adapters cleanly (auto-exclude the
    // empty ones) instead of starting a doomed reconnect loop.
    let creds: { appId: string; appSecret: string }
    try {
      creds = await resolveCredentials()
    } catch (err) {
      // Resolving credentials can fail for reasons that are *not* an
      // app-level fault — most commonly the OS keyring denying access to a
      // not-yet-configured adapter (e.g. the user only reuses the Claude
      // subscription and never set up Lark, or a dev rebuild changed the
      // signing identity so the keychain ACL no longer matches). The outcome
      // is identical to the empty-credential case below — the adapter simply
      // cannot start — so skip it cleanly with a single non-alarming warn
      // (reason attached for diagnosis) instead of a red ERROR that re-fires
      // on every boot.
      healthState = "down"
      healthReason = "credentials_unavailable"
      loggers.network.warn("[lark] adapter skipped — credentials unavailable", {
        id: opts.id,
        reason: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (!creds.appId || !creds.appSecret) {
      healthState = "down"
      healthReason = "credentials_missing"
      loggers.network.warn("[lark] adapter skipped — appId/appSecret not configured", {
        id: opts.id,
      })
      return
    }

    abortController = new AbortController()
    const signal = abortController.signal

    healthState = "running"
    healthReason = undefined

    // An empty selfBotOpenId silently disables self-mention detection —
    // under the default `mention_only` at-strategy every group message
    // would be dropped with no trace. Warn loudly so the operator knows
    // to run the whoami probe (which persists the bot's open_id).
    if (!opts.selfBotOpenId) {
      loggers.network.warn(
        "[lark] selfBotOpenId is empty — @-mention detection is disabled; " +
          "run the bot identity probe (whoami) so mention_only gating can work",
        { id: opts.id }
      )
    }

    // Inbound observability — the long-conn path was previously silent on
    // success and swallowed failures, so a non-working bot left no trace.
    // These [lark] info logs surface to stdout + the in-app log panel.
    loggers.network.info("[lark] adapter start", {
      id: opts.id,
      transport: opts.transport,
    })

    /**
     * Shared envelope dispatcher — handles both the long-connection and
     * webhook paths. Interactive-card callbacks (G3.4) go through the
     * ConnectorBus callback channel; everything else flows to
     * `ctx.emit` as a normalised message event.
     */
    const dispatchEnvelope = async (envelope: LarkEventEnvelope): Promise<void> => {
      loggers.network.info("[lark] inbound envelope", {
        id: opts.id,
        eventType: envelope.header?.event_type,
      })
      // Interactive card callbacks — route to the callback channel. Both
      // the legacy v1 event name and the Card 2.0 `card.action.trigger`
      // callback are accepted; `parseLarkInteractiveCallback` normalises
      // the two payload shapes.
      if (
        envelope.header?.event_type === "im.interactive_message.action_triggered_v1" ||
        envelope.header?.event_type === "card.action.trigger"
      ) {
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
      if (!event) {
        loggers.network.warn("[lark] inbound envelope not parsed into an event", {
          id: opts.id,
          eventType: envelope.header?.event_type,
        })
        return
      }
      // v45 (im-refactored-crayon) — gate inbound `create` messages on
      // the operator-configured at-strategy + chat allow/blocklist
      // before the bus is invoked. Helper audits `inbound.policy_blocked`
      // on deny and fails open on Dexie read errors.
      if (!(await gateInboundEvent(opts.id, event))) {
        loggers.network.warn("[lark] inbound event blocked by gate (at-strategy / allowlist)", {
          id: opts.id,
        })
        return
      }
      lastActivityAt = Date.now()
      loggers.network.info("[lark] inbound event passed gate → emit to bus", { id: opts.id })
      // Second pass: download inbound rich media (image / file bytes) so the
      // model + inbound OCR see actual content rather than a bare platform key.
      // Best-effort and self-contained — never blocks or fails the dispatch.
      await enrichLarkInboundMedia(event, { getAccessToken: getTat })
      await ctx.emit(event)
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
            healthReason = "no_data"
            loggers.network.warn("[lark] long-conn generator ended (no data, health=down)", {
              id: opts.id,
            })
          }
        } catch (err) {
          if (!stopCalled) {
            healthState = "degraded"
            healthReason = "transport_error"
            loggers.network.error("[lark] long-conn generator threw (health=degraded)", err, {
              id: opts.id,
            })
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
            healthReason = "no_data"
          }
        } catch {
          if (!stopCalled) {
            healthState = "degraded"
            healthReason = "transport_error"
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
    healthReason = undefined
    uploadCache.clear()
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
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
      // Replies are the identity-bearing path — send as the connected user when
      // opted in. Edits / deletes / reactions stay on the bot identity (they act
      // on bot-owned messages such as live-activity / progress cards).
      const resp = (await doRequest(call.method, urlPath, call.payload, {
        asUser: opts.sendAsUser === true,
      })) as { data?: { message_id?: string } } | null
      // Surface the real platform message id so the outbound runner persists
      // it on the job row — downstream consumers (workflow send node output,
      // edit/reaction chains, delivery audit) need the `om_…` id, not the
      // idempotency-key placeholder the runner falls back to.
      const messageId = resp?.data?.message_id
      return { ok: true, ...(messageId ? { platformMessageId: messageId } : {}) }
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
      const call = await serializeEditAsync(
        messageId,
        { ...patch, segments: resolvedSegments },
        opts.id
      )
      const urlPath = call.url.replace(LARK_API_BASE, "")
      await doRequest(call.method, urlPath, call.payload)
      // An edit keeps the platform message id — echo it back so callers
      // (workflow send node with editTargetMessageId, runner audit) get the
      // same feedback shape as a fresh send.
      return { ok: true, platformMessageId: messageId }
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
        // History items differ from live push events in TWO shapes (proven
        // against the real API): the type field is `msg_type` (live:
        // `message_type`) and the content JSON lives under `body.content`
        // (live: `content`). Normalise into the live shape so
        // `parseLarkEventEnvelope` → `buildSegments` sees real content
        // instead of silently yielding empty events. Recalled messages
        // ("This message was recalled") and system notices carry no
        // recoverable content — skip them.
        const raw = item as {
          message_id?: string
          chat_id?: string
          chat_type?: string
          msg_type?: string
          body?: { content?: string }
          mentions?: unknown
          create_time?: string
          thread_id?: string | null
          deleted?: boolean
        }
        if (raw.deleted === true || raw.msg_type === "system") continue
        const normalizedMessage = {
          message_id: raw.message_id ?? "",
          chat_id: raw.chat_id ?? chatId,
          chat_type: raw.chat_type ?? (chatId.startsWith("oc_") ? "group" : "p2p"),
          message_type: raw.msg_type ?? "",
          content: raw.body?.content ?? "",
          mentions: raw.mentions,
          create_time: raw.create_time,
          thread_id: raw.thread_id ?? null,
        }
        const envelope: LarkEventEnvelope = {
          schema: "2.0",
          header: {
            event_id: `hist:${raw.message_id ?? "?"}`,
            event_type: "im.message.receive_v1",
          },
          event: {
            sender: (item as { sender?: LarkEventEnvelope["event"]["sender"] }).sender,
            message: normalizedMessage as unknown as LarkEventEnvelope["event"]["message"],
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

  // Presence (系统状态 badge + pin). Status-id persistence rides the adapter
  // row's `presenceState` JSON column via lazy imports so the Dexie graph
  // stays out of the adapter's eager bundle.
  const presence = createLarkPresence({
    adapterId: opts.id,
    request: (method, urlPath, body) => doRequest(method, urlPath, body),
    getStatusId: async () => {
      const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
      const row = await getAdapterInstance(opts.id)
      return row?.presenceState?.platformStatusId
    },
    setStatusId: async (id) => {
      const { getAdapterInstance, updateAdapterInstance } =
        await import("@/lib/db/adapter-instances")
      const row = await getAdapterInstance(opts.id)
      await updateAdapterInstance(opts.id, {
        presenceState: { ...row?.presenceState, platformStatusId: id },
      })
    },
  })

  async function addReaction(messageId: string, emojiType: string): Promise<void> {
    const call = serializeReaction(messageId, emojiType)
    const urlPath = call.url.replace(LARK_API_BASE, "")
    await doRequest(call.method, urlPath, call.payload)
  }

  // Chat management (W2 multi-bot): five optional PlatformAdapter methods,
  // paired with the `chat.create` / `chat.members` / `chat.update` /
  // `contact.resolve` flags declared in LARK_CAPS.
  const chatMgmt = createLarkChatManagement(opts.id, resolveCredentials)

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
    setPresenceStatus: presence.setPresenceStatus,
    pinMessage: presence.pinMessage,
    createChat: chatMgmt.createChat,
    addChatMembers: chatMgmt.addChatMembers,
    removeChatMembers: chatMgmt.removeChatMembers,
    updateChat: chatMgmt.updateChat,
    resolveContacts: chatMgmt.resolveContacts,
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
