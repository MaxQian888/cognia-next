/**
 * Slack adapter factory — Task 76.
 *
 * Assembles parse + serialize + capability + transport into a PlatformAdapter.
 * Supports two transports:
 *   - socket-mode  (default): uses apps.connections.open + WSS (dials out).
 *   - events-api-webhook: Rust (axum + `verify_slack`) terminates the HMAC
 *     signature check and emits the parsed body on `connectors://webhook/<id>`;
 *     `start()` subscribes via `startSlackWebhookTransport` and routes each
 *     envelope through the same `parseSlackEventCallback` the socket-mode path
 *     uses. Requires the adapter to be registered with the Rust server — done
 *     centrally by `ConnectorBusProvider` for every inbound-server transport.
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
  AdapterLogger,
  AdapterAttachmentRef,
  AttachmentDescriptor,
  ReactionRef,
} from "@/types/connectors/adapter"
import type { OutboundError, OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { connectorsHttpRequest, connectorsMediaUpload } from "@/lib/connectors/tauri/commands"
import { statFile } from "@/lib/file/file-operations"
import { SLACK_A2UI_CAPABILITY, SLACK_CAPS } from "./capability"
import {
  parseSlackEventCallback,
  parseSlackInteractivePayload,
  parseSlackSlashCommand,
} from "./parse"
import type { SlackEventEnvelope, SlackInteractivePayload } from "./parse"
import {
  serializeOutboundAsync,
  serializeUpdate,
  serializeDeleteMessage,
  serializeReaction,
  serializeReactionRemoval,
  serializeAssistantStatus,
  serializeAssistantSuggestedPrompts,
  SlackEmptyMessageError,
} from "./serialize"
import { startSocketMode } from "./transport-socket-mode"
import { startSlackWebhookTransport } from "./transport-webhook"
import { parseConversationKey } from "@/types/connectors/event"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { getBus } from "@/lib/connectors/bus"
import { gateInboundEvent } from "@/lib/connectors/at-gate"

export interface SlackAdapterOptions {
  id: string
  displayName: string
  /** Resolves the xoxb-... bot token from the keyring on each call. */
  botToken: () => Promise<string>
  /** Resolves the xapp-... app-level token; required when transport === "socket-mode". */
  appToken?: () => Promise<string>
  /** Used to verify webhook signatures from Slack. */
  signingSecret: () => Promise<string>
  /**
   * Optional xoxp-... user token with `users.profile:write`. Bots cannot set
   * a *user's* status — `setPresenceStatus` requires this token and throws a
   * clear error when it is absent so the presence runner can surface the
   * misconfiguration instead of failing silently.
   */
  userToken?: () => Promise<string>
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
    userToken: { type: "string", title: "User Token (xoxp-..., status updates)" },
    signingSecret: { type: "string", title: "Signing Secret" },
    transport: {
      type: "string",
      enum: ["socket-mode", "events-api-webhook"],
      title: "Transport",
      default: "socket-mode",
    },
    assistantAppEnabled: {
      type: "boolean",
      title: "Assistant app (typing status + suggested prompts)",
      default: false,
    },
    historyMaxPages: {
      type: "number",
      title: "History pages per fetch (200 msgs each)",
      default: 10,
      minimum: 1,
    },
  },
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Error classification (Slack Web API `error` strings → OutboundError codes)
// ---------------------------------------------------------------------------

/** Credential-shaped errors — retrying without operator action is pointless. */
const SLACK_AUTH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "ekm_access_denied",
])

/** Transient server-side errors that a retry can plausibly fix. */
const SLACK_TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "service_unavailable",
  "request_timeout",
  "fatal_error",
])

/**
 * Error thrown by `doRequest` for any HTTP >= 400 or `ok: false` response,
 * carrying enough context to classify retryability.
 */
class SlackApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly slackError: string | undefined,
    readonly retryAfterMs: number | undefined
  ) {
    super(message)
    this.name = "SlackApiError"
  }
}

/** Parse a Retry-After header (seconds) into ms; key lookup is case-insensitive. */
function extractRetryAfterMs(headers: Record<string, string>): number | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "retry-after") {
      const secs = Number(v)
      if (Number.isFinite(secs) && secs > 0) return secs * 1000
    }
  }
  return undefined
}

/**
 * Map a thrown error to an OutboundError:
 *   - empty serialization           → validation      (non-retryable)
 *   - 429 / ratelimited             → rate_limited    (retryable, honors Retry-After)
 *   - invalid_auth / missing_scope… → auth_failed     (non-retryable)
 *   - transient Slack errors / 5xx  → platform_5xx    (retryable)
 *   - every other `ok:false` string → platform_4xx    (non-retryable — Slack's
 *     channel_not_found / msg_too_long / is_archived / restricted_action etc.
 *     are permanent for this payload and must not retry forever)
 *   - anything else (IPC/network)   → network         (retryable)
 */
function toOutboundError(err: unknown): OutboundError {
  if (err instanceof SlackEmptyMessageError || err instanceof SlackValidationError) {
    return { code: "validation", message: err.message, retryable: false }
  }
  if (err instanceof SlackApiError) {
    if (
      err.status === 429 ||
      err.slackError === "ratelimited" ||
      err.slackError === "rate_limited"
    ) {
      return {
        code: "rate_limited",
        message: err.message,
        retryable: true,
        retryAfterMs: err.retryAfterMs,
      }
    }
    // Payload permanently too large — HTTP 413 from the upload_url byte POST
    // or Slack's `file_upload_size_restricted` from files.getUploadURLExternal.
    // Retrying the same bytes can never succeed.
    if (err.status === 413 || err.slackError === "file_upload_size_restricted") {
      return { code: "validation", message: err.message, retryable: false }
    }
    if (err.slackError && SLACK_AUTH_ERRORS.has(err.slackError)) {
      return { code: "auth_failed", message: err.message, retryable: false }
    }
    if ((err.slackError && SLACK_TRANSIENT_ERRORS.has(err.slackError)) || err.status >= 500) {
      return { code: "platform_5xx", message: err.message, retryable: true }
    }
    return { code: "platform_4xx", message: err.message, retryable: false }
  }
  return {
    code: "network",
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  }
}

/**
 * Non-retryable local validation failure (missing byte size, oversized
 * payload rejected by the Rust byte cap, …). Maps to the `validation`
 * OutboundError code — dead-lettered immediately, never retried.
 */
class SlackValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SlackValidationError"
  }
}

// ---------------------------------------------------------------------------
// Composite platform message id — "<channelId>:<ts>"
// ---------------------------------------------------------------------------

/**
 * Slack message ops (chat.update / chat.delete / reactions.* / pins.*) are
 * channel-scoped, but the PlatformAdapter contract passes a single
 * `messageId`. `send()` therefore returns the composite "<channelId>:<ts>"
 * (same convention as the Discord adapter) and every message-scoped method
 * parses it back. A bare ts (no ":") is accepted for backward compatibility
 * when the method has another channel source (edit's conversationRef, pin's
 * conversationKey); methods with no such context throw a clear error.
 */
function splitChannelTs(composite: string): { channel?: string; ts: string } {
  const idx = composite.indexOf(":")
  if (idx === -1) return { ts: composite }
  return { channel: composite.slice(0, idx), ts: composite.slice(idx + 1) }
}

/**
 * Strip surrounding colons from an emoji shortcode (":thumbsup:" →
 * "thumbsup") — Slack's reactions API wants the bare name. Unicode emoji
 * pass through unchanged: Slack resolves standard-emoji aliases itself and
 * mapping unicode → shortcode is the platform's job, not ours.
 */
function normalizeEmojiName(emoji: string): string {
  return emoji.replace(/^:+/, "").replace(/:+$/, "")
}

// ---------------------------------------------------------------------------
// File upload sources — external upload flow vs link passthrough
// ---------------------------------------------------------------------------

/**
 * True for a genuinely remote http(s) URL that Slack's clients can fetch on
 * their own — those keep the link / image-block projection. Everything else
 * (file://, asset://, Tauri's `https://asset.localhost/...` webview scheme,
 * bare filesystem paths) is local-only and must go through the external
 * upload flow to be visible to anyone else.
 */
function isRemoteHttpSource(url: string): boolean {
  if (/^(?:asset:\/\/|https?:\/\/asset\.localhost\/)/i.test(url)) return false
  return /^https?:\/\//i.test(url)
}

/**
 * Resolve a local source (file:// URL, Tauri asset:// / asset.localhost
 * convertFileSrc URL, or a bare filesystem path) into the absolute path the
 * Rust `connectors_media_upload` command reads via `localPath`.
 */
function localPathFromSource(source: string): string {
  const assetMatch = source.match(/^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/(.+)$/i)
  if (assetMatch) {
    const decoded = decodeURIComponent(assetMatch[1])
    // Windows drive paths decode without a leading slash; POSIX paths need one.
    return /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : `/${decoded.replace(/^\/+/, "")}`
  }
  if (/^file:\/\//i.test(source)) {
    try {
      return decodeURIComponent(new URL(source).pathname)
    } catch {
      return source.replace(/^file:\/\//i, "")
    }
  }
  return source
}

/** Derive a filename (with extension when present) from a URL or path. */
function fileNameFromSource(source: string, fallback: string): string {
  try {
    const base = new URL(source).pathname.split("/").pop()
    if (base) return decodeURIComponent(base)
  } catch {
    const tail = source.split(/[\\/]/).pop()
    if (tail) return tail
  }
  return fallback
}

export function createSlackAdapter(opts: SlackAdapterOptions): PlatformAdapter {
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined = undefined
  let lastActivityAt: number | undefined = undefined
  let stopCalled = false
  /** Captured from `start(ctx)` so non-lifecycle methods can log too. */
  let logger: AdapterLogger | null = null

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
    let parsed: { ok?: boolean; error?: string } | null = null
    if (resp.body) {
      try {
        parsed = JSON.parse(resp.body) as { ok?: boolean; error?: string }
      } catch {
        parsed = null
      }
    }
    // Slack signals most errors as HTTP 200 + `ok: false` with a stable
    // `error` string; real HTTP failures (429, 5xx) also occur. Both throw a
    // SlackApiError so `toOutboundError` can classify retryability instead
    // of treating everything as a retryable platform_5xx.
    if (resp.status >= 400 || parsed?.ok === false) {
      throw new SlackApiError(
        `Slack API ${method} ${path} failed (HTTP ${resp.status}): ${
          parsed?.error ?? resp.body.slice(0, 200)
        }`,
        resp.status,
        parsed?.error,
        resp.status === 429 ? extractRetryAfterMs(resp.headers) : undefined
      )
    }
    return parsed
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return // already started
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal
    logger = ctx.logger

    if (opts.transport === "socket-mode") {
      // Stay "starting" until the first Socket Mode `hello` frame confirms a
      // live connection — reporting "running" before any connection attempt
      // hid every startup failure from the health panel.
      healthState = "starting"
      healthReason = undefined

      const appToken = opts.appToken
      if (!appToken) {
        healthState = "degraded"
        healthReason = "socket-mode transport requires an app-level token (xapp-…)"
        ctx.logger.warn("slack: missing app token for socket-mode transport", {
          adapterId: opts.id,
        })
        return
      }

      // Drive the socket-mode generator in the background
      ;(async () => {
        try {
          const generator = startSocketMode({
            appToken,
            signal,
            onHello: () => {
              healthState = "running"
              healthReason = undefined
            },
          })
          for await (const delivery of generator) {
            if (signal.aborted) break

            // A2UI round-trip: block_actions / view_submission / view_closed
            // route to the bus callback channel, not the message stream.
            if (delivery.kind === "interactive") {
              await handleInteractivePayload(delivery.payload)
              continue
            }

            const event =
              delivery.kind === "slash_command"
                ? parseSlackSlashCommand(opts.id, opts.selfId, delivery.payload)
                : parseSlackEventCallback(opts.id, opts.selfId, delivery.envelope)
            if (event) {
              // im-refactored-crayon — at-strategy + chat allow/blocklist gate.
              if (!(await gateInboundEvent(opts.id, event))) continue
              lastActivityAt = Date.now()
              await ctx.emit(event)
            }
          }
          if (!stopCalled) {
            healthState = "down"
            healthReason = "socket-mode stream ended unexpectedly"
          }
        } catch (err) {
          if (!stopCalled) {
            healthState = "degraded"
            healthReason = err instanceof Error ? err.message : String(err)
            ctx.logger.warn("slack: socket-mode transport failed", {
              adapterId: opts.id,
              reason: healthReason,
            })
          }
        }
      })()
    } else {
      // events-api-webhook: Rust (axum + verify_slack) terminates the HMAC
      // signature check and emits the parsed body on
      // `connectors://webhook/<adapterId>`. We subscribe here and route each
      // envelope through the same parser the socket-mode path uses. The
      // transport is passive (no handshake to await), so a successful
      // subscription IS the running state.
      healthState = "running"
      healthReason = undefined
      ;(async () => {
        try {
          const generator = startSlackWebhookTransport({ adapterId: opts.id, signal })
          for await (const envelope of generator) {
            if (signal.aborted) break

            // The Rust side also emits decoded interactive payloads (the
            // inner JSON of the form-encoded `payload=` field) on the same
            // channel — route those to the callback channel instead of the
            // event parser.
            const kind = (envelope as { type?: string }).type
            if (
              kind === "block_actions" ||
              kind === "view_submission" ||
              kind === "view_closed" ||
              kind === "shortcut" ||
              kind === "message_action"
            ) {
              await handleInteractivePayload(envelope as unknown as SlackInteractivePayload)
              continue
            }

            const event = parseSlackEventCallback(opts.id, opts.selfId, envelope)
            if (event) {
              // im-refactored-crayon — at-strategy + chat allow/blocklist gate.
              if (!(await gateInboundEvent(opts.id, event))) continue
              lastActivityAt = Date.now()
              await ctx.emit(event)
            }
          }
          if (!stopCalled) {
            healthState = "down"
            healthReason = "webhook subscription ended unexpectedly"
          }
        } catch (err) {
          if (!stopCalled) {
            healthState = "degraded"
            healthReason = err instanceof Error ? err.message : String(err)
            ctx.logger.warn("slack: webhook transport failed", {
              adapterId: opts.id,
              reason: healthReason,
            })
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
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  /**
   * External file upload — Slack's documented 3-step flow
   * (docs.slack.dev/messaging/working-with-files):
   *
   *   1. `files.getUploadURLExternal` — required args `filename` + `length`
   *      ("Size in bytes of the file being uploaded"); returns
   *      `{ ok, upload_url, file_id }`. Scope: files:write.
   *   2. POST the raw bytes to `upload_url` with
   *      `Content-Type: application/octet-stream` (the docs' curl example
   *      uses `--data-binary`); "success is confirmed by checking the HTTP
   *      status code", the body is plain text like "OK - 12".
   *   3. `files.completeUploadExternal` — required `files` = "Array of file
   *      ids and their corresponding (optional) titles" (`[{id, title}]`);
   *      optional `channel_id` ("Channel ID where the file will be shared.
   *      If not specified the file will be private.") and `thread_ts`
   *      ("Provide another message's ts value to upload this file as a
   *      reply."). With `channel_id` the file is posted into the
   *      conversation by Slack itself — callers must not double-post.
   *
   * Returns the Slack `file_id`.
   */
  async function uploadToSlack(
    file: { url: string; name: string; mimeType?: string; sizeBytes?: number },
    share?: { channelId?: string; threadTs?: string }
  ): Promise<string> {
    // `length` is a required argument of files.getUploadURLExternal. File
    // segments always carry sizeBytes; for image segments / descriptors
    // without one, stat local sources to recover it.
    let length =
      typeof file.sizeBytes === "number" && Number.isFinite(file.sizeBytes) && file.sizeBytes > 0
        ? Math.floor(file.sizeBytes)
        : undefined
    if (length === undefined && !isRemoteHttpSource(file.url)) {
      try {
        const stat = await statFile(localPathFromSource(file.url))
        if (stat.size > 0) length = stat.size
      } catch {
        // fall through to the validation error below
      }
    }
    if (!length) {
      throw new SlackValidationError(
        `Slack upload requires the byte size of "${file.name}" — files.getUploadURLExternal's required \`length\` argument could not be determined`
      )
    }

    // Step 1 — filename + length ride as query args (Slack accepts Web API
    // args via querystring for form-encoded methods).
    const search = new URLSearchParams({ filename: file.name, length: String(length) })
    const opened = (await doRequest("POST", `files.getUploadURLExternal?${search}`)) as {
      upload_url?: string
      file_id?: string
    } | null
    if (!opened?.upload_url || !opened.file_id) {
      throw new SlackApiError(
        "files.getUploadURLExternal returned ok but no upload_url/file_id",
        200,
        undefined,
        undefined
      )
    }

    // Step 2 — raw-byte POST via the shared Rust media-upload command
    // (fetches http(s) sources / reads local paths in Rust, 100 MiB cap).
    try {
      await connectorsMediaUpload({
        uploadUrl: opened.upload_url,
        contentType: file.mimeType || "application/octet-stream",
        ...(isRemoteHttpSource(file.url)
          ? { sourceUrl: file.url }
          : { localPath: localPathFromSource(file.url) }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // The shared command verifies HTTP status (<400) BEFORE parsing the
      // response body for Matrix's `content_uri`. Slack's upload_url answers
      // with plain text ("OK - 12" per the docs), so exactly these two parse
      // errors mean the byte POST itself already succeeded.
      if (!/response is not JSON|missing content_uri/.test(msg)) {
        // Rust-side byte cap ("… exceeding the N-byte upload cap") — the
        // payload can never fit; dead-letter instead of retrying.
        if (/byte upload cap/.test(msg)) throw new SlackValidationError(msg)
        // HTTP failure from the upload_url POST ("media upload HTTP <status>: …")
        // — recover the status so 413 → validation, 5xx → retryable, etc.
        const httpStatus = msg.match(/media upload HTTP (\d+)/)
        if (httpStatus) throw new SlackApiError(msg, Number(httpStatus[1]), undefined, undefined)
        throw err
      }
    }

    // Step 3 — finalize; with channel_id Slack shares the file into the
    // conversation itself.
    await doRequest("POST", "files.completeUploadExternal", {
      files: [{ id: opened.file_id, title: file.name }],
      ...(share?.channelId ? { channel_id: share.channelId } : {}),
      ...(share?.threadTs ? { thread_ts: share.threadTs } : {}),
    })

    return opened.file_id
  }

  /**
   * `PlatformAdapter.uploadFile` — uploads the descriptor's bytes as a
   * PRIVATE workspace file (no `channel_id` share) and returns the Slack
   * `file_id` as `remoteRef`. Conversation-scoped sharing happens in
   * `send()`, which passes `channel_id`/`thread_ts` to the same flow.
   */
  async function uploadFile(file: AttachmentDescriptor): Promise<AdapterAttachmentRef> {
    const fileId = await uploadToSlack({
      url: file.url,
      name: file.name || fileNameFromSource(file.url, "file"),
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    })
    return { localUrl: file.url, remoteRef: fileId }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    try {
      // Partition: file/image segments whose source is NOT a remote http(s)
      // URL (file://, asset://, bare paths) go through the external upload
      // flow — a link block pointing at a local path is invisible to every
      // other Slack user. Public http(s) sources keep the existing link /
      // image-block projection.
      const uploads: Array<Extract<MessageSegment, { type: "file" | "image" }>> = []
      const rest: MessageSegment[] = []
      for (const seg of req.segments) {
        if ((seg.type === "file" || seg.type === "image") && !isRemoteHttpSource(seg.url)) {
          uploads.push(seg)
        } else {
          rest.push(seg)
        }
      }

      const ref = req.conversationRef as Record<string, unknown>
      const refChannel = String(ref["channelId"] ?? "")
      const refThreadTs = typeof ref["threadTs"] === "string" ? ref["threadTs"] : undefined

      let platformMessageId: string | undefined
      // Post the block/text message first (when there is one) so the reply
      // text lands above its attachments. When ALL segments are uploads,
      // skip chat.postMessage entirely — completeUploadExternal with
      // channel_id already shares the files into the conversation.
      if (rest.length > 0 || uploads.length === 0) {
        const call = await serializeOutboundAsync({ ...req, segments: rest }, opts.id)
        const result = (await doRequest("POST", "chat.postMessage", call.payload)) as {
          ts?: string
          channel?: string
        } | null
        // Composite "<channelId>:<ts>" — message-scoped follow-ups (edit /
        // delete / reactions / pins) are channel-scoped on Slack, so the
        // channel must ride in the platform message id.
        const channel = result?.channel ?? String(call.payload["channel"] ?? "")
        platformMessageId = result?.ts
          ? channel
            ? `${channel}:${result.ts}`
            : result.ts
          : undefined
      }

      for (const seg of uploads) {
        await uploadToSlack(
          {
            url: seg.url,
            name:
              seg.type === "file"
                ? seg.name || fileNameFromSource(seg.url, "file")
                : seg.alt || fileNameFromSource(seg.url, "image"),
            mimeType: seg.type === "file" ? seg.mimeType : undefined,
            sizeBytes: seg.type === "file" ? seg.sizeBytes : undefined,
          },
          { channelId: refChannel || undefined, threadTs: refThreadTs }
        )
      }

      return { ok: true, platformMessageId }
    } catch (err) {
      return { ok: false, error: toOutboundError(err) }
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
    // messageId is the "<channelId>:<ts>" composite from send(); a bare ts
    // (legacy rows) falls back to the channel on the patch's conversationRef.
    const { channel: idChannel, ts } = splitChannelTs(messageId)
    const ref = patch.conversationRef as Record<string, unknown>
    const channel = idChannel || String(ref["channelId"] ?? "")
    if (!channel || !ts) {
      return {
        ok: false,
        error: {
          code: "validation",
          message: `Slack edit needs a "<channelId>:<ts>" message id or a conversationRef.channelId, got "${messageId}"`,
          retryable: false,
        },
      }
    }
    try {
      const call = serializeUpdate(channel, ts, patch)
      await doRequest("POST", "chat.update", call.payload)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: toOutboundError(err) }
    }
  }

  async function deleteMessage(messageId: string): Promise<void> {
    // messageId is the "<channelId>:<ts>" composite from send(). A bare ts
    // carries no channel and chat.delete is channel-scoped — fail loudly
    // instead of silently skipping the delete.
    const { channel, ts } = splitChannelTs(messageId)
    if (!channel || !ts) {
      throw new Error(`Slack delete requires a "<channelId>:<ts>" message id, got "${messageId}"`)
    }
    const call = serializeDeleteMessage(channel, ts)
    await doRequest("POST", "chat.delete", call.payload)
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
   * Typing indicator. When `assistantAppEnabled` is false, this is a
   * documented no-op: Slack has NO typing API for regular bots — only
   * Assistant Apps get `assistant.threads.setStatus`. The `typing`
   * capability stays statically advertised (AdapterMeta.capabilities is a
   * static list; there is no per-instance capability projection), so the
   * honest minimal option is this logged fallback rather than a phantom
   * API call that would 403 for every non-assistant install. When enabled
   * and the conversationKey carries a thread, we issue
   * `assistant.threads.setStatus` with "is typing…" / "" depending on
   * `on`. Conversations without a thread_ts can't set assistant status —
   * Slack returns `not_supported` — so we silently skip those.
   */
  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!opts.assistantAppEnabled) {
      logger?.debug("slack: setTyping skipped — assistantAppEnabled is false", {
        adapterId: opts.id,
        conversationKey,
        on,
      })
      return
    }
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

  /**
   * Set the connected user's profile status via `users.profile.set`
   * (status_text ≤ 100 chars). Requires the optional user token — Slack has
   * no API for a bot to set someone else's status. `targetUserIds` is
   * ignored: the token itself identifies the user.
   */
  async function setPresenceStatus(input: { text: string; expiresAt?: number }): Promise<void> {
    const token = await opts.userToken?.().catch(() => "")
    if (!token) {
      throw new Error("Slack presence requires a user token (xoxp-…) with users.profile:write")
    }
    const resp = await connectorsHttpRequest({
      url: `${SLACK_API_BASE}/users.profile.set`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        profile: {
          status_text: input.text.slice(0, 100),
          // PresenceStatusInput (types/connectors/presence.ts) carries no
          // emoji/icon field — the contract is text + expiry only — so the
          // robot-face badge is a deliberate fixed marker for bot-driven
          // statuses. Revisit if the shared input type ever grows an icon.
          status_emoji: ":robot_face:",
          status_expiration: input.expiresAt ? Math.floor(input.expiresAt / 1000) : 0,
        },
      }),
    })
    const parsed = resp.body ? (JSON.parse(resp.body) as { ok?: boolean; error?: string }) : null
    if (resp.status >= 400 || parsed?.ok === false) {
      throw new Error(`Slack users.profile.set failed: ${parsed?.error ?? resp.status}`)
    }
  }

  /** Pin a message in its channel via `pins.add` (bot token). */
  async function pinMessage(conversationKey: string, messageId: string): Promise<void> {
    // messageId may be the "<channelId>:<ts>" composite (from send()) or a
    // bare ts — the channel then comes from the conversationKey.
    const { channel: idChannel, ts } = splitChannelTs(messageId)
    const channel = idChannel || parseConversationKey(conversationKey).remoteChatId
    if (!channel || !ts) {
      throw new Error(`Slack pin requires a channel and ts, got "${messageId}"`)
    }
    await doRequest("POST", "pins.add", { channel, timestamp: ts })
  }

  /** Remove a previously pinned message via `pins.remove` (bot token). */
  async function unpinMessage(messageId: string): Promise<void> {
    const { channel, ts } = splitChannelTs(messageId)
    if (!channel || !ts) {
      throw new Error(`Slack unpin requires a "<channelId>:<ts>" message id, got "${messageId}"`)
    }
    await doRequest("POST", "pins.remove", { channel, timestamp: ts })
  }

  /**
   * Add an emoji reaction, conforming to the {@link PlatformAdapter} 2-arg
   * contract `addReaction(messageId, emojiType)` the connector bus calls.
   * `messageId` is the "<channelId>:<ts>" composite; `emojiType` is a Slack
   * emoji name with or without surrounding colons (":thumbsup:" or
   * "thumbsup"). Slack reactions have no addressable id (they're keyed by
   * emoji name), so the returned {@link ReactionRef} carries the normalized
   * name back as `reactionId` for a later {@link removeReaction}.
   */
  async function addReaction(messageId: string, emojiType: string): Promise<ReactionRef> {
    const { channel, ts } = splitChannelTs(messageId)
    if (!channel || !ts) {
      throw new Error(`Slack reaction requires a "<channelId>:<ts>" message id, got "${messageId}"`)
    }
    const name = normalizeEmojiName(emojiType)
    const call = serializeReaction(channel, ts, name)
    await doRequest("POST", "reactions.add", call.payload)
    return { reactionId: name }
  }

  /**
   * Retract a reaction previously added with {@link addReaction}. Per the
   * contract, `reactionId` is what `addReaction` returned — for Slack that
   * is the emoji name itself.
   */
  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const { channel, ts } = splitChannelTs(messageId)
    if (!channel || !ts) {
      throw new Error(`Slack reaction requires a "<channelId>:<ts>" message id, got "${messageId}"`)
    }
    const call = serializeReactionRemoval(channel, ts, normalizeEmojiName(reactionId))
    await doRequest("POST", "reactions.remove", call.payload)
  }

  const adapter: PlatformAdapter & {
    setSuggestedPrompts?: typeof setSuggestedPrompts
    handleInteractivePayload?: typeof handleInteractivePayload
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
    uploadFile,
    fetchHistory,
    setTyping,
    refreshCredentials,
    setPresenceStatus,
    pinMessage,
    unpinMessage,
    a2uiCapability: () => SLACK_A2UI_CAPABILITY,
    addReaction,
    removeReaction,
    setSuggestedPrompts,
    handleInteractivePayload,
  }

  return adapter
}
