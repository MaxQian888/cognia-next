/**
 * Matrix adapter factory.
 *
 * Assembles auth + parse + serialize + capability + the `/sync` transport
 * into a PlatformAdapter. Matrix is an HTTP-only protocol, so every call goes
 * through the Tauri HTTP proxy (`connectorsHttpRequest`); no WebSocket or
 * Rust-side transport is needed.
 */

import type {
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
  PlatformAdapter,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { connectorsHttpRequest, connectorsMediaUpload } from "@/lib/connectors/tauri/commands"
import { getBus } from "@/lib/connectors/bus"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { MATRIX_A2UI_CAPABILITY, MATRIX_CAPS } from "./capability"
import { normalizeHomeserver } from "./auth"
import { parseMatrixEvent, parseMatrixReplyCorrelation } from "./parse"
import { resolveInboundMatrixMedia } from "./media"
import {
  serializeEdit,
  serializeMediaLinkFallback,
  serializeOutbound,
  serializeReaction,
  type MatrixMediaChunk,
  type MatrixSendContent,
} from "./serialize"
import { startMatrixSync } from "./transport-sync"

export interface MatrixAdapterOptions {
  id: string
  displayName: string
  /** Homeserver base URL (e.g. https://matrix.org). */
  homeserver: string
  /** Resolves the access token from the keyring on each call. */
  accessToken: () => Promise<string>
  /** Bot's own user id (e.g. @bot:matrix.org) from whoami at startup. */
  selfId: string
}

const CLIENT_V3 = "/_matrix/client/v3"

const MATRIX_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["homeserver", "accessToken"],
  properties: {
    homeserver: { type: "string", title: "Homeserver URL" },
    accessToken: { type: "string", title: "Access Token" },
  },
  additionalProperties: false,
}

class MatrixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | undefined
  ) {
    super(message)
    this.name = "MatrixApiError"
  }
}

function mediaName(seg: MatrixMediaChunk["segment"]): string {
  if (seg.type === "file") return seg.name
  if (seg.type === "image") return seg.alt || seg.type
  return seg.type
}

function mediaMimeType(seg: MatrixMediaChunk["segment"]): string | undefined {
  return seg.mimeType
}

function buildMediaEventContent(
  seg: MatrixMediaChunk["segment"],
  contentUri: string
): Record<string, unknown> {
  switch (seg.type) {
    case "image":
      return {
        msgtype: "m.image",
        body: seg.alt ?? "image",
        url: contentUri,
        info: {
          ...(seg.mimeType ? { mimetype: seg.mimeType } : {}),
          ...(seg.width !== undefined ? { w: seg.width } : {}),
          ...(seg.height !== undefined ? { h: seg.height } : {}),
        },
      }
    case "video":
      return {
        msgtype: "m.video",
        body: "video",
        url: contentUri,
        info: {
          ...(seg.mimeType ? { mimetype: seg.mimeType } : {}),
          ...(seg.durationSec !== undefined ? { duration: seg.durationSec * 1000 } : {}),
        },
      }
    case "voice":
      return {
        msgtype: "m.audio",
        body: "audio",
        url: contentUri,
        info: {
          ...(seg.mimeType ? { mimetype: seg.mimeType } : {}),
          ...(seg.durationSec !== undefined ? { duration: seg.durationSec * 1000 } : {}),
        },
      }
    case "file":
      return {
        msgtype: "m.file",
        body: seg.name,
        filename: seg.name,
        url: contentUri,
        info: { mimetype: seg.mimeType, size: seg.sizeBytes },
      }
  }
}

export function createMatrixAdapter(opts: MatrixAdapterOptions): PlatformAdapter {
  const base = normalizeHomeserver(opts.homeserver)
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let lastActivityAt: number | undefined
  let stopCalled = false

  function txn(prefix: string): string {
    return `${prefix}:${crypto.randomUUID()}`
  }

  async function matrixRequest(
    method: "GET" | "POST" | "PUT",
    path: string,
    payload?: unknown
  ): Promise<Record<string, unknown>> {
    const token = await opts.accessToken()
    const resp = await connectorsHttpRequest({
      url: `${base}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    })
    let body: Record<string, unknown>
    try {
      body = JSON.parse(resp.body) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (resp.status < 200 || resp.status >= 300) {
      // Matrix rate-limit responses carry `retry_after_ms` (M_LIMIT_EXCEEDED).
      const retryAfterMs = typeof body.retry_after_ms === "number" ? body.retry_after_ms : undefined
      const errcode = typeof body.errcode === "string" ? body.errcode : `status ${resp.status}`
      const error = typeof body.error === "string" ? body.error : errcode
      throw new MatrixApiError(
        `Matrix ${method} ${path} failed: ${error}`,
        resp.status,
        retryAfterMs
      )
    }
    return body
  }

  /** PUT a room event; returns the assigned event_id. */
  async function sendRoomEvent(
    roomId: string,
    eventType: string,
    txnId: string,
    content: unknown
  ): Promise<string> {
    const body = await matrixRequest(
      "PUT",
      `${CLIENT_V3}/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${encodeURIComponent(txnId)}`,
      content
    )
    return typeof body.event_id === "string" ? body.event_id : ""
  }

  async function uploadMedia(seg: MatrixMediaChunk["segment"]): Promise<string> {
    const token = await opts.accessToken()
    const mimeType = mediaMimeType(seg)
    return connectorsMediaUpload({
      uploadUrl: `${base}/_matrix/media/v3/upload?filename=${encodeURIComponent(mediaName(seg))}`,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(mimeType ? { "Content-Type": mimeType } : {}),
      },
      sourceUrl: seg.url,
      contentType: mimeType,
    })
  }

  async function sendSerializedContent(
    roomId: string,
    txnId: string,
    content: MatrixSendContent | MatrixMediaChunk
  ): Promise<string> {
    if (content.kind === "media") {
      let mediaContent: Record<string, unknown>
      try {
        const contentUri = await uploadMedia(content.segment)
        mediaContent = buildMediaEventContent(content.segment, contentUri)
      } catch {
        // Upload failed (media repo error, unfetchable source URL, or web
        // mode without the Tauri upload command) — degrade to a link line
        // instead of aborting the whole multi-chunk send.
        mediaContent = { ...serializeMediaLinkFallback(content.segment) }
      }
      if (content.relatesTo) mediaContent["m.relates_to"] = content.relatesTo
      return sendRoomEvent(roomId, "m.room.message", txnId, mediaContent)
    }
    return sendRoomEvent(roomId, "m.room.message", txnId, content)
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return
    stopCalled = false
    abortController = new AbortController()
    const signal = abortController.signal
    healthState = "running"

    const feed = startMatrixSync({ homeserver: base, accessToken: opts.accessToken, signal })
    ;(async () => {
      try {
        for await (const { roomId, event } of feed) {
          if (signal.aborted) break

          // A2UI reply-correlation: a reply to one of our surface messages is
          // routed onto the surface as an `input` action.
          try {
            const callback = await parseMatrixReplyCorrelation(opts.id, opts.selfId, roomId, event)
            if (callback) {
              lastActivityAt = Date.now()
              await getBus().dispatchConnectorCallback(callback)
              continue
            }
          } catch (err) {
            ctx.logger.warn("matrix:reply correlation failed", {
              reason: err instanceof Error ? err.message : String(err),
            })
          }

          // Isolate per-event parse/dispatch failures: a single malformed or
          // unexpected event must not throw out of the `for await` loop (which
          // would flip health to "degraded" and stop delivering ALL further
          // messages until restart), matching the reply-correlation guard above.
          try {
            const normalized = parseMatrixEvent(opts.id, opts.selfId, roomId, event, {
              homeserver: base,
            })
            if (normalized) {
              // Gate BEFORE resolving media (like the Telegram / Discord
              // adapters): in a busy room with a mention-gate, downloading +
              // encrypting every bystander attachment would waste bandwidth and
              // head-of-line-block gated messages behind serial media fetches.
              if (!(await gateInboundEvent(opts.id, normalized))) continue
              await resolveInboundMatrixMedia(normalized, {
                accessToken: await opts.accessToken(),
              })
              lastActivityAt = Date.now()
              await ctx.emit(normalized)
            }
          } catch (err) {
            ctx.logger.warn("matrix:event parse/dispatch failed", {
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }
        if (!stopCalled) healthState = "down"
      } catch {
        if (!stopCalled) healthState = "degraded"
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

  function errorToResult(err: unknown): OutboundResult {
    if (err instanceof MatrixApiError) {
      const code =
        err.status === 429
          ? "rate_limited"
          : err.status === 401 || err.status === 403
            ? "auth_failed"
            : err.status >= 500
              ? "platform_5xx"
              : "platform_4xx"
      return {
        ok: false,
        error: {
          code,
          message: err.message,
          retryable: code !== "platform_4xx" && code !== "auth_failed",
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

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const ref = req.conversationRef as { roomId?: string }
    const roomId = String(ref.roomId ?? "")
    if (!roomId) {
      return {
        ok: false,
        error: { code: "validation", message: "Matrix send: missing roomId", retryable: false },
      }
    }

    const { contents, a2uiBinding } = serializeOutbound(req)
    if (contents.length === 0) {
      return { ok: true }
    }

    let platformMessageId: string | undefined
    try {
      for (let i = 0; i < contents.length; i += 1) {
        // Stable txn per chunk so retries dedup server-side.
        const txnId = `${req.metadata.idempotencyKey}:${i}`
        const eventId = await sendSerializedContent(roomId, txnId, contents[i])
        if (eventId) platformMessageId = eventId
      }

      // Persist the A2UI reply-correlation binding against the sent event id.
      if (a2uiBinding && platformMessageId) {
        try {
          await recordCallbackBinding({
            adapterId: opts.id,
            actionId: platformMessageId,
            kind: "force_reply",
            surfaceId: a2uiBinding.surfaceId,
            conversationKey: req.metadata.sourceMessageId,
          })
        } catch {
          // Binding persistence is best-effort.
        }
      }

      return { ok: true, platformMessageId }
    } catch (err) {
      return errorToResult(err)
    }
  }

  async function edit(messageId: string, patch: OutboundRequest): Promise<OutboundResult> {
    const ref = patch.conversationRef as { roomId?: string }
    const roomId = String(ref.roomId ?? "")
    if (!roomId) {
      return {
        ok: false,
        error: { code: "validation", message: "Matrix edit: missing roomId", retryable: false },
      }
    }
    try {
      const content = serializeEdit(messageId, patch)
      const eventId = await sendRoomEvent(roomId, "m.room.message", txn("edit"), content)
      return { ok: true, platformMessageId: eventId }
    } catch (err) {
      return errorToResult(err)
    }
  }

  /**
   * Redact a message. Matrix needs both the room id and event id, which the
   * single `messageId` argument cannot carry, so callers pass the composite
   * `"<roomId>|<eventId>"` (room ids contain colons, hence the `|`
   * separator). Mirrors the `channelId:messageId` convention Discord/Slack use.
   */
  async function deleteMessage(messageId: string): Promise<void> {
    const sep = messageId.indexOf("|")
    if (sep < 0) {
      throw new Error(`Matrix delete: messageId must be "<roomId>|<eventId>" (got ${messageId})`)
    }
    const roomId = messageId.slice(0, sep)
    const eventId = messageId.slice(sep + 1)
    await matrixRequest(
      "PUT",
      `${CLIENT_V3}/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txn("redact"))}`,
      {}
    )
  }

  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    // conversationKey: "matrix:<adapterId>:<roomId>[:<threadId>]"
    const parts = conversationKey.split(":")
    const roomId = parts[2]
    if (!roomId || !opts.selfId) return
    await matrixRequest(
      "PUT",
      `${CLIENT_V3}/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(opts.selfId)}`,
      { typing: on, timeout: on ? 30_000 : 0 }
    )
  }

  /**
   * Push a bot reaction (`m.annotation`) onto a message. `roomId` + the
   * target `eventId` come from the inbound event's conversationRef.
   */
  async function addReaction(roomId: string, eventId: string, key: string): Promise<void> {
    const { eventType, content } = serializeReaction(eventId, key)
    await sendRoomEvent(roomId, eventType, txn("react"), content)
  }

  async function refreshCredentials(): Promise<void> {
    // No-op: accessToken is a resolver called fresh on each request.
  }

  return {
    get meta() {
      return {
        type: "matrix" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: MATRIX_CAPS,
        transportModes: ["longpoll"] as const,
        configSchema: MATRIX_CONFIG_SCHEMA,
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
    refreshCredentials,
    a2uiCapability: () => MATRIX_A2UI_CAPABILITY,
  } as PlatformAdapter & { addReaction: typeof addReaction }
}
