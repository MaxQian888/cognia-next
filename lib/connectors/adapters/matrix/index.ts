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
  ReactionRef,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import { connectorsHttpRequest, connectorsMediaUpload } from "@/lib/connectors/tauri/commands"
import { getBus } from "@/lib/connectors/bus"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { MATRIX_A2UI_CAPABILITY, MATRIX_CAPS } from "./capability"
import { normalizeHomeserver } from "./auth"
import { buildMatrixMessageId, parseMatrixConversationKey, splitMatrixMessageId } from "./ids"
import { parseMatrixEvent, parseMatrixReplyCorrelation } from "./parse"
import { resolveInboundMatrixMedia } from "./media"
import {
  serializeEdit,
  serializeMediaFailureNotice,
  serializeMediaLinkFallback,
  serializeOutbound,
  serializeReaction,
  type MatrixMediaChunk,
  type MatrixSendContent,
} from "./serialize"
import { MatrixSyncAuthError, startMatrixSync } from "./transport-sync"

export interface MatrixAdapterOptions {
  id: string
  displayName: string
  /** Homeserver base URL (e.g. https://matrix.org). */
  homeserver: string
  /** Resolves the access token from the keyring on each call. */
  accessToken: () => Promise<string>
  /**
   * Bot's own user id (e.g. @bot:matrix.org) from whoami at startup. May be
   * "" when the startup probe failed — the adapter then lazily re-probes
   * whoami itself (an empty selfId disables own-echo suppression, so the bot
   * would otherwise reply to its own messages until restart).
   */
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

/** Persist the sync cursor at most this often (plus a flush on stop()). */
const SYNC_TOKEN_PERSIST_INTERVAL_MS = 30_000
/** Minimum gap between lazy whoami re-probe attempts. */
const SELF_ID_REPROBE_INTERVAL_MS = 60_000
/** Cap on the recently-sent own event-id set (reply-to-self detection). */
const OWN_EVENT_IDS_CAP = 500

export function createMatrixAdapter(opts: MatrixAdapterOptions): PlatformAdapter {
  const base = normalizeHomeserver(opts.homeserver)
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined
  let lastActivityAt: number | undefined
  let stopCalled = false
  // Mutable so the lazy whoami re-probe can fill in a missing startup value.
  let selfId = opts.selfId
  let lastSelfProbeAt = 0
  // `next_batch` persistence state — throttled writes + flush on stop().
  let pendingSyncToken: string | null = null
  let lastTokenPersistAt = 0
  // Rooms already warned about undecryptable (E2EE) traffic.
  const warnedEncryptedRooms = new Set<string>()
  // Recently-sent own event ids (bare), for reply-to-self mention detection.
  const ownEventIds = new Set<string>()

  function rememberOwnEvent(eventId: string): void {
    if (!eventId) return
    ownEventIds.add(eventId)
    if (ownEventIds.size > OWN_EVENT_IDS_CAP) {
      const oldest = ownEventIds.values().next().value
      if (oldest !== undefined) ownEventIds.delete(oldest)
    }
  }

  function txn(prefix: string): string {
    return `${prefix}:${crypto.randomUUID()}`
  }

  /**
   * Persist the latest `next_batch` into `AdapterInstanceRow.settings` so a
   * restart resumes from where we stopped instead of re-priming (which
   * permanently drops every message received while the app was down).
   * Settings are MERGED — homeserver etc. live in the same blob.
   */
  async function flushSyncToken(): Promise<void> {
    const token = pendingSyncToken
    if (token === null) return
    lastTokenPersistAt = Date.now()
    try {
      const row = await getAdapterInstance(opts.id)
      await updateAdapterInstance(opts.id, {
        settings: { ...(row?.settings ?? {}), syncSinceToken: token },
      })
      if (pendingSyncToken === token) pendingSyncToken = null
    } catch {
      // Best-effort: a failed persist only costs downtime catch-up on the
      // next restart; the live loop keeps its in-memory cursor.
    }
  }

  function onNextBatch(token: string): void {
    pendingSyncToken = token
    if (Date.now() - lastTokenPersistAt >= SYNC_TOKEN_PERSIST_INTERVAL_MS) {
      void flushSyncToken()
    }
  }

  /**
   * Lazily resolve the bot's own user id when the startup whoami probe
   * failed. Without it, own-echo suppression (`ev.sender === selfId`) is
   * disabled and the bot can reply to its own messages. Throttled so a dead
   * homeserver isn't hammered once per event.
   */
  async function ensureSelfId(): Promise<void> {
    if (selfId !== "") return
    const now = Date.now()
    if (now - lastSelfProbeAt < SELF_ID_REPROBE_INTERVAL_MS) return
    lastSelfProbeAt = now
    try {
      const body = await matrixRequest("GET", `${CLIENT_V3}/account/whoami`)
      if (typeof body.user_id === "string" && body.user_id) selfId = body.user_id
    } catch {
      // Still unreachable / unauthorized — retry after the throttle window.
    }
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
        // mode without the Tauri upload command) — degrade instead of
        // aborting the whole multi-chunk send. Only http(s) sources may be
        // linked verbatim; local paths / asset:// URIs must not leak into
        // the room, so those degrade to a named failure notice.
        mediaContent = /^https?:\/\//i.test(content.segment.url)
          ? { ...serializeMediaLinkFallback(content.segment) }
          : { ...serializeMediaFailureNotice(mediaName(content.segment)) }
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
    healthReason = undefined

    // Resume from the persisted cursor when one exists (messages received
    // while the app was down are then delivered instead of discarded).
    let initialSince: string | undefined
    try {
      const row = await getAdapterInstance(opts.id)
      const persisted = (row?.settings as { syncSinceToken?: unknown } | undefined)?.syncSinceToken
      if (typeof persisted === "string" && persisted) initialSince = persisted
    } catch {
      // No row / storage unavailable — fall back to prime-and-discard.
    }

    const feed = startMatrixSync({
      homeserver: base,
      accessToken: opts.accessToken,
      signal,
      initialSince,
      onNextBatch,
      logger: ctx.logger,
    })
    ;(async () => {
      try {
        // The startup whoami probe may have failed (registry builds the
        // adapter with selfId "") — re-probe before processing traffic so
        // own-echo suppression works.
        await ensureSelfId()
        for await (const { roomId, event } of feed) {
          if (signal.aborted) break
          await ensureSelfId()

          // GAP: E2EE is not wired up yet. A full Rust crypto layer exists
          // unused (the `connectorsMatrixCrypto*` commands; whoami already
          // persists the deviceId) — until it is connected, encrypted rooms
          // degrade honestly: nothing reaches the AI loop and we warn once
          // per room instead of silently dropping the traffic.
          if (event.type === "m.room.encrypted") {
            if (!warnedEncryptedRooms.has(roomId)) {
              warnedEncryptedRooms.add(roomId)
              ctx.logger.warn("matrix:encrypted room not supported yet", { roomId })
            }
            continue
          }

          // A2UI reply-correlation: a reply to one of our surface messages is
          // routed onto the surface as an `input` action.
          try {
            const callback = await parseMatrixReplyCorrelation(opts.id, selfId, roomId, event)
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
            const normalized = parseMatrixEvent(opts.id, selfId, roomId, event, {
              homeserver: base,
              ownEventIds,
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
      } catch (err) {
        if (!stopCalled) {
          healthState = "degraded"
          if (err instanceof MatrixSyncAuthError) {
            // Dead access token — the sync loop stopped itself; surface the
            // reason so the UI can prompt for re-auth instead of showing a
            // healthy adapter that never delivers.
            healthReason = "auth_failed"
            ctx.logger.error("matrix:sync stopped — access token rejected", {
              reason: err.message,
            })
          }
        }
      }
    })()
  }

  async function stop(): Promise<void> {
    stopCalled = true
    abortController?.abort()
    abortController = null
    healthState = "down"
    // Flush the pending sync cursor so the next start resumes cleanly.
    await flushSyncToken()
  }

  function health(): AdapterHealth {
    return { state: healthState, lastActivityAt, ...(healthReason ? { reason: healthReason } : {}) }
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

    let lastEventId: string | undefined
    try {
      for (let i = 0; i < contents.length; i += 1) {
        // Stable txn per chunk so retries dedup server-side.
        const txnId = `${req.metadata.idempotencyKey}:${i}`
        const eventId = await sendSerializedContent(roomId, txnId, contents[i])
        if (eventId) {
          lastEventId = eventId
          rememberOwnEvent(eventId)
        }
      }

      // Persist the A2UI reply-correlation binding against the BARE sent
      // event id — inbound replies carry the bare id in `m.in_reply_to`.
      if (a2uiBinding && lastEventId) {
        try {
          await recordCallbackBinding({
            adapterId: opts.id,
            actionId: lastEventId,
            kind: "force_reply",
            surfaceId: a2uiBinding.surfaceId,
            conversationKey: req.metadata.sourceMessageId,
          })
        } catch {
          // Binding persistence is best-effort.
        }
      }

      // The adapter-public id is the "<roomId>|<eventId>" composite so it
      // round-trips into delete()/addReaction()/edit() (which need the room).
      return {
        ok: true,
        ...(lastEventId ? { platformMessageId: buildMatrixMessageId(roomId, lastEventId) } : {}),
      }
    } catch (err) {
      return errorToResult(err)
    }
  }

  /**
   * In-place edit. `messageId` is the adapter-public `"<roomId>|<eventId>"`
   * composite from a prior send (a bare event id is accepted too, using the
   * patch's conversationRef room).
   */
  async function edit(messageId: string, patch: OutboundRequest): Promise<OutboundResult> {
    const ref = patch.conversationRef as { roomId?: string }
    let roomId = String(ref.roomId ?? "")
    let targetEventId = messageId
    if (messageId.includes("|")) {
      const split = splitMatrixMessageId(messageId)
      roomId = split.roomId
      targetEventId = split.eventId
    }
    if (!roomId) {
      return {
        ok: false,
        error: { code: "validation", message: "Matrix edit: missing roomId", retryable: false },
      }
    }
    try {
      const content = serializeEdit(targetEventId, patch)
      // Stable txn derived from the request idempotency key so retried edits
      // dedup server-side instead of stacking duplicate m.replace events.
      const txnId = patch.metadata?.idempotencyKey
        ? `${patch.metadata.idempotencyKey}:edit`
        : txn("edit")
      const eventId = await sendRoomEvent(roomId, "m.room.message", txnId, content)
      if (eventId) rememberOwnEvent(eventId)
      return {
        ok: true,
        ...(eventId ? { platformMessageId: buildMatrixMessageId(roomId, eventId) } : {}),
      }
    } catch (err) {
      return errorToResult(err)
    }
  }

  /**
   * Redact a message. Matrix needs both the room id and event id, which the
   * single `messageId` argument cannot carry, so callers pass the composite
   * `"<roomId>|<eventId>"` — exactly what `send()`/`edit()` return and what
   * the inbound parser stamps on events. Throws a descriptive error on a
   * malformed id (see ids.ts).
   *
   * Redaction has no request-level idempotency key; the txn is random, but a
   * duplicate redaction of an already-redacted event is a no-op server-side.
   */
  async function deleteMessage(messageId: string): Promise<void> {
    const { roomId, eventId } = splitMatrixMessageId(messageId)
    await matrixRequest(
      "PUT",
      `${CLIENT_V3}/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txn("redact"))}`,
      {}
    )
  }

  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    // conversationKey: "matrix:<adapterId>:<roomId>[:<threadRoot>]" — the
    // room id itself contains colons, so use the matrix-aware parser.
    let roomId: string
    try {
      roomId = parseMatrixConversationKey(conversationKey).roomId
    } catch {
      return
    }
    if (!roomId || !selfId) return
    await matrixRequest(
      "PUT",
      `${CLIENT_V3}/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(selfId)}`,
      { typing: on, timeout: on ? 30_000 : 0 }
    )
  }

  /**
   * Push a bot reaction (`m.annotation`) onto a message, conforming to the
   * {@link PlatformAdapter} 2-arg contract `addReaction(messageId, emojiType)`
   * the connector bus calls. `messageId` is the `"<roomId>|<eventId>"`
   * composite; the returned {@link ReactionRef} carries the reaction event's
   * own id so {@link removeReaction} can redact exactly this reaction.
   */
  async function addReaction(messageId: string, emojiType: string): Promise<ReactionRef> {
    const { roomId, eventId } = splitMatrixMessageId(messageId)
    const { eventType, content } = serializeReaction(eventId, emojiType)
    // No request-level idempotency key on the 2-arg reaction contract, so
    // the txn is random (a retried duplicate annotation is rejected by the
    // server with M_DUPLICATE_ANNOTATION, not doubled).
    const reactionEventId = await sendRoomEvent(roomId, eventType, txn("react"), content)
    return reactionEventId ? { reactionId: reactionEventId } : {}
  }

  /**
   * Retract a bot reaction: redact the reaction event itself. `reactionId`
   * is the reaction event id a prior {@link addReaction} returned;
   * `messageId` is the same `"<roomId>|<eventId>"` composite (only its room
   * part is needed — the redaction targets the reaction event).
   */
  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const { roomId } = splitMatrixMessageId(messageId)
    if (!reactionId) {
      throw new Error("Matrix removeReaction: missing reactionId (from addReaction's ReactionRef)")
    }
    await matrixRequest(
      "PUT",
      `${CLIENT_V3}/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(reactionId)}/${encodeURIComponent(txn("unreact"))}`,
      {}
    )
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
    removeReaction,
    refreshCredentials,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("matrix"),
    a2uiCapability: () => MATRIX_A2UI_CAPABILITY,
  }
}
