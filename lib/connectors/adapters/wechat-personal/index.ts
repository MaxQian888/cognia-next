/**
 * Personal WeChat (iLink) adapter factory.
 *
 * HTTP long-poll, not WebSocket: `start()` runs a loop that POSTs `getupdates`
 * (held ~35 s by the gateway) through the Rust HTTP proxy (`ctx.tauri.httpRequest`),
 * advancing the `get_updates_buf` cursor. Replies go through `sendmessage`,
 * echoing the inbound `context_token` — there is NO proactive send. On `ret
 * -14` (session expired) the adapter degrades and the operator must re-scan the
 * QR code from the settings form.
 */

import type {
  PlatformAdapter,
  AdapterContext,
  AdapterHealth,
  AdapterHealthState,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import { conversationBoundRoute } from "@/lib/connectors/adapters/_shared/message-route"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildConversationKey } from "@/types/connectors/event"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import {
  ILINK_DEFAULT_BASE_URL,
  ilinkResultCode,
  ilinkMediaUrl,
  ilinkItemMedia,
  ILINK_PATHS,
  ILINK_RET_SESSION_EXPIRED,
  ILINK_LONGPOLL_TIMEOUT_MS,
  buildIlinkHeaders,
  buildGetUpdatesBody,
  buildSendTextBody,
  buildSendMediaBody,
  type IlinkGetUpdatesResponse,
  type IlinkMessage,
} from "./protocol"
import {
  parseIlinkMessage,
  tryParseNumericCallback,
  type WechatPersonalConversationRef,
} from "./parse"
import { getBus } from "@/lib/connectors/bus"
import { isRecordedInbound, recordAndCheckInbound } from "@/lib/connectors/dedup"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import { consumeNumericAction } from "./numeric-action-registry"
import { reconnectBackoffMs } from "@/lib/connectors/adapters/_shared/reconnect-backoff"
import { serializeIlinkSegments } from "./serialize"
import { WECHAT_PERSONAL_CAPS, WECHAT_PERSONAL_A2UI_CAPABILITY } from "./capability"
import {
  fetchAndDecryptIlinkMediaViaTauri,
  bytesToBase64,
  uploadIlinkMedia,
  IlinkMediaError,
} from "./media"
import { md5Hex } from "../wecom/md5"
import { sniffImageMediaType } from "../_shared/inbound-media"
import { getAdapterInstance, commitWechatPersonalCheckpoint } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { sha256Hex } from "@/lib/share/hash"

export interface WechatPersonalAdapterOptions {
  id: string
  displayName: string
  /** Resolves the iLink bot_token from the keyring. */
  token: () => Promise<string>
  /** Atomic Host-owned login identity; production must use this over token(). */
  tokenSnapshot?: () => Promise<{ value: string; revision: string } | null>
  /** Resolves the per-session base URL (defaults to the public gateway). */
  baseUrl?: () => Promise<string>
  /** Test seam: backoff base ms (default 2000). */
  _backoffBaseMs?: number
}

const WECHAT_PERSONAL_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [],
  properties: {
    baseUrl: { type: "string", title: "iLink base URL" },
    accountId: { type: "string", title: "Account id" },
  },
  additionalProperties: true,
}

export function createWechatPersonalAdapter(opts: WechatPersonalAdapterOptions): PlatformAdapter {
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined
  let lastActivityAt: number | undefined
  let stopCalled = false
  let ctx: AdapterContext | null = null
  let cursor = ""
  let attempts = 0
  let generation = 0
  let cursorScope: string | undefined
  let checkpointConfigured = false
  let checkpointAccountId: string | undefined
  let configurationScope: string | undefined
  let checkpointWrite: Promise<void> = Promise.resolve()
  let hashedToken: { token: string; hash: string } | undefined
  /** Latest context_token per conversation (reply anchor; reply-only channel). */
  const contextTokens = new Map<string, string>()
  // Pin unresolved callbacks while the current poll batch is retried. A new
  // menu must not redirect an older message to a different action.
  const pendingCallbacks = new Map<string, ConnectorCallbackEvent>()

  const backoffBaseMs = opts._backoffBaseMs ?? 2000

  /** Wakes the pending backoff sleep early — set while a delay() is in flight. */
  let wakeDelay: (() => void) | null = null

  /** True once stop() ran or the runtime aborted this adapter's signal. */
  function shouldStop(run = generation, owner = ctx): boolean {
    return run !== generation || !owner || owner !== ctx || stopCalled || owner.signal.aborted
  }

  /**
   * Abortable sleep: resolves early when stop() is called or `ctx.signal`
   * aborts, so a 30s+ backoff never outlives the adapter lifecycle.
   */
  function delay(ms: number, run: number, owner: AdapterContext): Promise<void> {
    return new Promise((resolve) => {
      const signal = owner.signal
      if (shouldStop(run, owner)) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", finish)
        if (wakeDelay === finish) wakeDelay = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      wakeDelay = finish
      signal?.addEventListener("abort", finish)
    })
  }

  async function readPollCredential(): Promise<{ value: string; revision?: string } | null> {
    return opts.tokenSnapshot ? opts.tokenSnapshot() : { value: await opts.token() }
  }

  async function restoreCursor(
    token: string,
    baseUrl: string,
    run: number,
    owner: AdapterContext,
    credentialRevision?: string
  ) {
    // A previous generation's already-started storage write must settle
    // before its replacement reads the authoritative cursor.
    await checkpointWrite.catch(() => {})
    if (shouldStop(run, owner)) return
    if (hashedToken?.token !== token) {
      const hash = await sha256Hex(token)
      if (shouldStop(run, owner)) return
      hashedToken = { token, hash }
    }
    const credentialHash = hashedToken.hash
    const scope = JSON.stringify([baseUrl, credentialHash, credentialRevision])
    const stored = await getAdapterInstance(opts.id)
    if (shouldStop(run, owner)) return
    const row = stored ? structuredClone(stored) : undefined
    const accountId =
      typeof row?.settings?.accountId === "string" ? row.settings.accountId : undefined
    if (cursorScope !== scope || row) {
      const saved = row?.settings?.ilinkCheckpoint as
        | {
            baseUrl?: unknown
            credentialHash?: unknown
            credentialRevision?: unknown
            accountId?: unknown
            cursor?: unknown
          }
        | undefined
      cursor =
        saved?.baseUrl === baseUrl &&
        saved.credentialHash === credentialHash &&
        saved.credentialRevision === credentialRevision &&
        saved.accountId === accountId &&
        typeof saved.cursor === "string"
          ? saved.cursor
          : ""
    }
    if (cursorScope !== scope) {
      cursorScope = scope
      checkpointConfigured = Boolean(row)
      checkpointAccountId = accountId
      configurationScope = row ? pollConfiguration(row) : undefined
    }
    return {
      expected: row,
      next: {
        baseUrl,
        credentialHash,
        ...(credentialRevision === undefined ? {} : { credentialRevision }),
        ...(checkpointAccountId === undefined ? {} : { accountId: checkpointAccountId }),
      },
    }
  }

  function pollConfiguration(row: AdapterInstanceRow): string {
    // Progress and unrelated settings may change while a poll is accepted.
    // Only the configured transport/account and its local authority fence it.
    return JSON.stringify([
      row.createdAt,
      row.type,
      row.enabled,
      row.owner,
      row.credentialsRef,
      row.settings?.baseUrl,
      row.settings?.accountId,
    ])
  }

  async function resolveBaseUrl(): Promise<string> {
    const raw = opts.baseUrl
      ? (await opts.baseUrl()) || ILINK_DEFAULT_BASE_URL
      : ILINK_DEFAULT_BASE_URL
    // Persisted base URLs sometimes carry a trailing slash; the plain
    // `${baseUrl}${path}` join would then hit `https://host//ilink/...`.
    return raw.replace(/\/+$/, "")
  }

  async function ownsPoll(
    token: string,
    baseUrl: string,
    run: number,
    owner: AdapterContext,
    credentialRevision?: string
  ): Promise<boolean> {
    if (shouldStop(run, owner)) return false
    const [currentCredential, currentBaseUrl, row] = await Promise.all([
      readPollCredential(),
      resolveBaseUrl(),
      checkpointConfigured ? getAdapterInstance(opts.id) : undefined,
    ])
    if (shouldStop(run, owner)) return false
    const configuredBaseUrl =
      typeof row?.settings?.baseUrl === "string"
        ? row.settings.baseUrl.replace(/\/+$/, "")
        : undefined
    if (
      checkpointConfigured &&
      (!row ||
        row.enabled === false ||
        pollConfiguration(row) !== configurationScope ||
        (configuredBaseUrl && configuredBaseUrl !== baseUrl))
    ) {
      contextTokens.clear()
      pendingCallbacks.clear()
      healthState = "degraded"
      healthReason = "configuration_changed"
      stopCalled = true
      return false
    }
    if (
      currentCredential?.value === token &&
      currentCredential.revision === credentialRevision &&
      currentBaseUrl === baseUrl
    )
      return true
    // A dynamic secret lookup can change before the supervisor observes its
    // configuration update. Nothing from that poll belongs to the new login.
    contextTokens.clear()
    pendingCallbacks.clear()
    return false
  }

  /** Resolve each encrypted attachment independently, including quoted media. */
  async function resolveInboundImage(
    segments: MessageSegment[],
    msg: IlinkMessage,
    run: number,
    owner: AdapterContext
  ): Promise<void> {
    const media = (Array.isArray(msg.item_list) ? msg.item_list : [])
      .flatMap((item) =>
        item && typeof item === "object" ? [item.ref_msg?.message_item, item] : []
      )
      .flatMap((item) => {
        const value = ilinkItemMedia(item)
        const type =
          item?.type === 2
            ? "image"
            : item?.type === 3
              ? "voice"
              : item?.type === 4
                ? "file"
                : "video"
        return value && ilinkMediaUrl(value) ? [{ value, type, url: ilinkMediaUrl(value)! }] : []
      })
    const mediaSegments = segments.filter(
      (segment) =>
        segment.type === "image" ||
        segment.type === "voice" ||
        segment.type === "video" ||
        segment.type === "file"
    )
    for (const seg of mediaSegments) {
      if (shouldStop(run, owner)) return
      const index = media.findIndex((item) => item.type === seg.type && item.url === seg.url)
      if (index < 0) continue
      const { value: item } = media.splice(index, 1)[0]
      try {
        if (item.aeskey && !/^[a-fA-F0-9]{32}$/.test(item.aeskey))
          throw new Error("Invalid image AES key")
        const key = item.aeskey
          ? bytesToBase64(
              Uint8Array.from(item.aeskey.match(/.{1,2}/g) ?? [], (hex) => Number.parseInt(hex, 16))
            )
          : (item.media?.aes_key ?? item.aes_key)
        const bytes = await fetchAndDecryptIlinkMediaViaTauri({
          adapterId: opts.id,
          url: ilinkMediaUrl(item)!,
          aesKeyBase64: key,
          fetchAttachment: (adapterId, remoteRef) =>
            owner.tauri.fetchAttachment(adapterId, remoteRef),
        })
        if (shouldStop(run, owner)) return
        const dataBase64 = bytesToBase64(bytes)
        const voiceMime: Record<number, string> = {
          1: "audio/pcm",
          2: "audio/adpcm",
          4: "audio/speex",
          5: "audio/amr",
          6: "audio/silk",
          7: "audio/mpeg",
          8: "audio/ogg",
        }
        seg.mimeType =
          sniffImageMediaType(dataBase64) ??
          (seg.type === "video"
            ? "video/mp4"
            : seg.type === "voice"
              ? voiceMime[Number(item.encode_type)]
              : undefined) ??
          "application/octet-stream"
        if (seg.type === "image" || seg.type === "file") seg.dataBase64 = dataBase64
        seg.rawUrl = seg.url
        seg.url = `data:${seg.mimeType};base64,${dataBase64}`
      } catch (err) {
        owner.logger.warn(
          `ilink media resolve failed: ${err instanceof Error ? err.message : String(err)}`
        )
        seg.rawUrl = seg.url
        seg.url = ""
        if (seg.type === "image") seg.alt = "[unavailable image]"
      }
    }
  }

  async function handleMessage(
    msg: IlinkMessage,
    run: number,
    owner: AdapterContext,
    token: string,
    baseUrl: string,
    credentialRevision?: string
  ): Promise<void> {
    if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return
    const event = parseIlinkMessage(opts.id, msg)
    if (!event) return
    const receiptId = `ilink-numeric:${event.messageId}`
    const pendingKey = JSON.stringify([event.conversationKey, event.messageId])
    if (
      /^[1-9]$/.test(event.plainText.trim()) &&
      (await isRecordedInbound(opts.id, receiptId, "callback", event.conversationKey))
    )
      return
    if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return
    // Numeric reply → A2UI callback short-circuit. When the registry has
    // a live binding for this conversation + digit we route to
    // dispatchConnectorCallback (which the bus then routes to the
    // wf_approve / generic callback handler depending on binding kind)
    // and DO NOT also emit a regular message — the user's "1" was a tap,
    // not a chat message.
    const callback = pendingCallbacks.get(pendingKey) ?? tryParseNumericCallback(opts.id, msg)
    if (callback) {
      pendingCallbacks.set(pendingKey, callback)
      // Stash the context_token so the eventual outbound reply
      // (workflow approval confirmation, assistant turn, etc.) has a
      // live reply anchor. `tryParseNumericCallback` always populates
      // `conversationKey`; narrow for the type system.
      if (callback.conversationKey) {
        contextTokens.set(callback.conversationKey, msg.context_token ?? "")
      }
      lastActivityAt = Date.now()
      const outcome = await getBus().dispatchConnectorCallback(callback)
      if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return
      if (outcome !== "terminal") throw new Error("Numeric callback requires redelivery")
      await recordAndCheckInbound(opts.id, receiptId, "callback", event.conversationKey)
      if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return
      consumeNumericAction(
        event.conversationKey,
        Number(callback.value),
        Date.now(),
        callback.triggerId
      )
      pendingCallbacks.delete(pendingKey)
      return
    }
    contextTokens.set(
      event.conversationKey,
      (event.conversationRef as WechatPersonalConversationRef).contextToken
    )
    await resolveInboundImage(event.segments, msg, run, owner)
    if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return
    if (!(await gateInboundEvent(opts.id, event))) return
    if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return
    lastActivityAt = Date.now()
    await owner.emit(event)
  }

  async function pollOnce(run: number, owner: AdapterContext): Promise<"ok" | "expired" | "error"> {
    const [credential, baseUrl] = await Promise.all([readPollCredential(), resolveBaseUrl()])
    const token = credential?.value ?? ""
    const credentialRevision = credential?.revision
    if (shouldStop(run, owner)) return "ok"
    if (!token) {
      healthReason = "token_missing"
      ctx?.logger.warn("ilink poll skipped: bot token missing from keyring")
      return "error"
    }
    const checkpoint = await restoreCursor(token, baseUrl, run, owner, credentialRevision)
    if (!checkpoint || !(await ownsPoll(token, baseUrl, run, owner, credentialRevision)))
      return "ok"
    const resp = await owner.tauri.httpRequest({
      url: `${baseUrl}${ILINK_PATHS.getUpdates}`,
      method: "POST",
      headers: buildIlinkHeaders(token),
      body: JSON.stringify(buildGetUpdatesBody(cursor)),
      timeoutMs: ILINK_LONGPOLL_TIMEOUT_MS + 10_000,
    })
    if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return "ok"
    let parsed: IlinkGetUpdatesResponse
    try {
      parsed = JSON.parse(resp.body) as IlinkGetUpdatesResponse
    } catch {
      healthReason = "bad_response"
      ctx?.logger.warn(`ilink getupdates returned a non-JSON body (status ${resp.status})`)
      return "error"
    }
    const resultCode = ilinkResultCode(parsed)
    if (resultCode === ILINK_RET_SESSION_EXPIRED) {
      return "expired"
    }
    if (resp.status >= 400 || resultCode !== 0) {
      healthReason = "bad_response"
      ctx?.logger.warn(
        `ilink getupdates failed: HTTP ${resp.status}, ret ${resultCode} ${parsed?.errmsg ?? ""}`.trim()
      )
      return "error"
    }
    if (
      (parsed.msgs !== undefined && !Array.isArray(parsed.msgs)) ||
      (parsed.get_updates_buf !== undefined && typeof parsed.get_updates_buf !== "string")
    ) {
      healthReason = "bad_response"
      return "error"
    }

    healthState = "running"
    healthReason = undefined
    lastActivityAt = Date.now()
    // Process the batch BEFORE advancing the cursor — advancing first would
    // silently drop the unprocessed tail if a handler threw mid-batch. Process
    // the remaining messages, but retain the cursor if any delivery fails.
    let deliveryFailed = false
    for (const msg of parsed.msgs ?? []) {
      if (shouldStop(run, owner)) return "ok"
      try {
        await handleMessage(msg, run, owner, token, baseUrl, credentialRevision)
      } catch (err) {
        deliveryFailed = true
        ctx?.logger.warn(
          `ilink message handling failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return "ok"
    if (deliveryFailed) {
      healthReason = "inbound_delivery_failed"
      return "error"
    }
    if (typeof parsed.get_updates_buf === "string" && parsed.get_updates_buf) {
      const next = parsed.get_updates_buf
      let committed = false
      const write = checkpointWrite
        .catch(() => {})
        .then(async () => {
          if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return
          if (checkpoint.expected)
            committed = await commitWechatPersonalCheckpoint(
              opts.id,
              checkpoint.expected,
              { ...checkpoint.next, cursor: next },
              () => !shouldStop(run, owner)
            )
        })
      checkpointWrite = write
      await write
      if (!(await ownsPoll(token, baseUrl, run, owner, credentialRevision))) return "ok"
      if (!committed) {
        cursorScope = undefined
        healthReason = "checkpoint_conflict"
        return "error"
      }
      cursor = next
    }
    pendingCallbacks.clear()
    return "ok"
  }

  async function pollLoop(run: number, owner: AdapterContext): Promise<void> {
    while (!shouldStop(run, owner)) {
      try {
        const result = await pollOnce(run, owner)
        if (shouldStop(run, owner)) return
        if (result === "expired") {
          healthState = "degraded"
          healthReason = "session_expired_rescan"
          return // requires a fresh QR scan; stop polling
        }
        if (result === "error") {
          attempts += 1
          healthState = "degraded"
          await delay(reconnectBackoffMs(backoffBaseMs, attempts), run, owner)
          continue
        }
        attempts = 0
      } catch (err) {
        if (shouldStop(run, owner)) return
        attempts += 1
        healthState = "degraded"
        healthReason = "network_error"
        ctx?.logger.warn(`ilink poll failed: ${err instanceof Error ? err.message : String(err)}`)
        await delay(reconnectBackoffMs(backoffBaseMs, attempts), run, owner)
      }
    }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    const ref = req.conversationRef as WechatPersonalConversationRef
    const conversationKey = ref.userId
      ? buildConversationKey("wechat-personal", opts.id, ref.userId)
      : undefined
    const contextToken =
      ref.contextToken || (conversationKey ? contextTokens.get(conversationKey) : undefined)

    if (!contextToken || !ref.userId) {
      // iLink cannot initiate a conversation — replies need a live context_token.
      return {
        ok: false,
        error: {
          code: "unsupported_segment",
          message: "personal WeChat is reply-only — no context_token for proactive send",
          retryable: false,
        },
      }
    }

    // ref.userId is non-null past the guard above, so conversationKey is
    // always defined here — TypeScript still wants the explicit narrow.
    if (!conversationKey) {
      return {
        ok: false,
        error: {
          code: "unsupported_segment",
          message: "missing conversation key",
          retryable: false,
        },
      }
    }
    const serialized = await serializeIlinkSegments(req.segments, {
      adapterId: opts.id,
      conversationKey,
    })
    if (serialized.parts.length === 0) {
      return {
        ok: false,
        error: { code: "validation", message: "empty message", retryable: false },
      }
    }

    let delivered = 0
    let lastClientId: string | undefined
    try {
      const [token, baseUrl] = await Promise.all([opts.token(), resolveBaseUrl()])
      const bodies = []
      // Finish every upload before publishing any part of the reply.
      for (const part of serialized.parts) {
        if (part.type === "text")
          bodies.push(buildSendTextBody(ref.userId, contextToken, part.text))
        else {
          const uploaded = await uploadIlinkMedia({
            adapterId: opts.id,
            baseUrl,
            token,
            userId: ref.userId,
            segment: part.segment,
            tauri: ctx!.tauri,
          })
          bodies.push(
            buildSendMediaBody(ref.userId, contextToken, uploaded.itemType, uploaded.mediaItem)
          )
        }
      }
      for (const [index, body] of bodies.entries()) {
        body.msg.client_id = `cognia-${md5Hex(`${opts.id}:${req.metadata.idempotencyKey}:${index}`)}`
        const resp = await ctx!.tauri.httpRequest({
          url: `${baseUrl}${ILINK_PATHS.sendMessage}`,
          method: "POST",
          headers: buildIlinkHeaders(token),
          body: JSON.stringify(body),
          timeoutMs: 15_000,
        })
        const parsed = JSON.parse(resp.body) as { ret?: number; errcode?: number; errmsg?: string }
        const ret = ilinkResultCode(parsed)
        if (ret === ILINK_RET_SESSION_EXPIRED) {
          // Dead session — retrying is useless until the operator re-scans
          // the QR code. Degrade health so the settings UI surfaces it and
          // return non-retryable so the outbound queue doesn't spin forever.
          healthState = "degraded"
          healthReason = "session_expired_rescan"
          return {
            ok: false,
            error: {
              code: "auth_failed",
              message: parsed.errmsg ?? `ret ${ret} (session expired — re-scan the QR code)`,
              retryable: false,
            },
          }
        }
        if (resp.status >= 400 || ret !== 0) {
          const code =
            resp.status === 401 || resp.status === 403
              ? "auth_failed"
              : resp.status === 429
                ? "rate_limited"
                : resp.status >= 500
                  ? "platform_5xx"
                  : resp.status >= 400 || ret !== undefined
                    ? "platform_4xx"
                    : "bad_response"
          return {
            ok: false,
            error: {
              code: delivered > 0 ? "reconciliation_required" : code,
              message: parsed?.errmsg ?? `HTTP ${resp.status}, ret ${ret ?? "missing"}`,
              retryable:
                delivered === 0 &&
                code !== "auth_failed" &&
                (resp.status < 400 || resp.status === 429 || resp.status >= 500),
            },
          }
        }
        delivered += 1
        lastClientId = body.msg.client_id
      }
      return { ok: true, platformMessageId: lastClientId, downgrades: serialized.downgrades }
    } catch (err) {
      if (err instanceof IlinkMediaError && err.sessionExpired) {
        healthState = "degraded"
        healthReason = "session_expired_rescan"
      }
      return {
        ok: false,
        platformMessageId: lastClientId,
        error: {
          code:
            delivered > 0
              ? "reconciliation_required"
              : err instanceof IlinkMediaError
                ? err.sessionExpired
                  ? "auth_failed"
                  : "validation"
                : "network",
          message: `${delivered > 0 ? `${delivered} message part(s) delivered; ` : ""}${err instanceof Error ? err.message : String(err)}`,
          retryable:
            delivered === 0 &&
            (err instanceof IlinkMediaError ? err.retryable && !err.sessionExpired : true),
        },
      }
    }
  }

  return {
    get meta() {
      return {
        type: "wechat-personal" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: WECHAT_PERSONAL_CAPS,
        transportModes: ["longpoll"] as const,
        configSchema: WECHAT_PERSONAL_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    async start(c: AdapterContext): Promise<void> {
      generation += 1
      wakeDelay?.()
      ctx = c
      stopCalled = false
      healthState = "starting"
      cursor = ""
      cursorScope = undefined
      attempts = 0
      const run = generation
      try {
        const [credential, baseUrl] = await Promise.all([readPollCredential(), resolveBaseUrl()])
        if (credential?.value)
          await restoreCursor(credential.value, baseUrl, run, c, credential.revision)
      } catch {
        // The polling loop owns the existing degraded/retry classification.
      }
      if (!shouldStop(run, c)) void pollLoop(run, c)
    },
    async stop(): Promise<void> {
      generation += 1
      stopCalled = true
      // Wake a pending backoff sleep so the loop exits promptly instead of
      // outliving stop() by up to a full backoff window.
      wakeDelay?.()
      contextTokens.clear()
      healthState = "down"
    },
    health(): AdapterHealth {
      return { state: healthState, reason: healthReason, lastActivityAt }
    },
    send,
    // Every delivery goes to the reference's chat: a reply's message id never
    // moves it, and there is no edit (ADR-0239).
    messageRoute: conversationBoundRoute,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("wechat-personal"),
    a2uiCapability: () => WECHAT_PERSONAL_A2UI_CAPABILITY,
  }
}
