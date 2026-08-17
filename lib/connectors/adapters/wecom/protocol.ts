/**
 * WeCom 智能机器人 (AI bot) long-connection wire protocol.
 *
 * Endpoint: `wss://openws.work.weixin.qq.com` — plain JSON text frames (no
 * protobuf, no message-level encryption, no IP whitelist). Every frame is a
 * `{ cmd, headers: { req_id }, body }` envelope; responses to our outbound
 * frames echo `{ headers: { req_id }, errcode, errmsg }`.
 *
 * Reference: https://developer.work.weixin.qq.com/document/path/101463
 *
 * This module is PURE — it defines the frame shapes and synchronous builders.
 * Connection lifecycle lives in `index.ts`; event normalisation in `parse.ts`;
 * A2UI ↔ template_card mapping in `a2ui-mapper.ts`; media crypto/upload in
 * `media.ts`.
 */

/** The single documented long-connection endpoint. */
export const WECOM_WS_URL = "wss://openws.work.weixin.qq.com"

/** Heartbeat cadence — the doc recommends a `ping` every 30 s. */
export const WECOM_PING_INTERVAL_MS = 30_000

/** Markdown body hard cap (20 480 bytes per the protocol). */
export const WECOM_MARKDOWN_MAX_BYTES = 20_480

// ---------------------------------------------------------------------------
// Inbound frames (WeCom → us)
// ---------------------------------------------------------------------------

export type WeComChatType = "single" | "group"

/** Encrypted media descriptor carried on inbound media messages. */
export interface WeComMediaRef {
  url: string
  /** Base64 AES key; decryption is AES-256-CBC, IV = first 16 bytes of the key. */
  aeskey?: string
}

export interface WeComInboundMsgBody {
  msgid: string
  aibotid: string
  chatid: string
  chattype: WeComChatType
  from?: { userid?: string; name?: string }
  msgtype: "text" | "markdown" | "image" | "voice" | "file" | "video" | "mixed"
  text?: { content?: string }
  markdown?: { content?: string }
  image?: WeComMediaRef
  voice?: WeComMediaRef & { transcript?: string }
  file?: WeComMediaRef & { filename?: string; fileext?: string }
  video?: WeComMediaRef
  /** "mixed" user content — an ordered list of text/image items. */
  mixed?: {
    msg_item?: Array<{ msgtype?: string; text?: { content?: string }; image?: WeComMediaRef }>
  }
}

export type WeComEventType =
  "enter_chat" | "template_card_event" | "feedback_event" | "disconnected_event"

export interface WeComInboundEventBody {
  msgid?: string
  create_time?: number
  aibotid: string
  chatid?: string
  chattype?: WeComChatType
  from?: { userid?: string; name?: string }
  msgtype: "event"
  event: {
    eventtype: WeComEventType
    /** template_card_event carries the clicked button payload. */
    template_card?: {
      /** The `key` of the button the user clicked (we bake the A2UI action id here). */
      event_key?: string
      task_id?: string
      card_type?: string
    }
    /** feedback_event carries the thumbs up/down. */
    feedback?: { type?: number; id?: string }
  }
}

export interface WeComFrameEnvelope<TBody = unknown> {
  cmd?: string
  headers?: { req_id?: string }
  body?: TBody
  /** Present on ack/response frames. */
  errcode?: number
  errmsg?: string
}

/**
 * Discriminated classification of an inbound frame so the transport loop can
 * branch without re-reading `cmd` everywhere. `ack` covers the
 * `aibot_subscribe` / `ping` responses (no `cmd`, just `errcode`).
 */
export type ParsedInboundFrame =
  | { kind: "ack"; reqId?: string; errcode?: number; errmsg?: string }
  | { kind: "message"; reqId?: string; body: WeComInboundMsgBody }
  | { kind: "event"; reqId?: string; body: WeComInboundEventBody }
  | { kind: "unknown"; cmd?: string; reqId?: string }

/**
 * Parse a raw inbound JSON string into a {@link ParsedInboundFrame}. Returns
 * `{ kind: "unknown" }` for malformed JSON or unrecognised commands so the
 * caller can log-and-ignore without throwing.
 */
export function classifyInboundFrame(raw: string): ParsedInboundFrame {
  let env: WeComFrameEnvelope
  try {
    env = JSON.parse(raw) as WeComFrameEnvelope
  } catch {
    return { kind: "unknown" }
  }
  if (!env || typeof env !== "object") return { kind: "unknown" }
  const reqId = env.headers?.req_id

  if (env.cmd === "aibot_msg_callback" && env.body && typeof env.body === "object") {
    return { kind: "message", reqId, body: env.body as WeComInboundMsgBody }
  }
  if (env.cmd === "aibot_event_callback" && env.body && typeof env.body === "object") {
    return { kind: "event", reqId, body: env.body as WeComInboundEventBody }
  }
  // Subscribe / ping responses (and any future ack) carry no cmd but an errcode.
  if (env.cmd === undefined && typeof env.errcode === "number") {
    return { kind: "ack", reqId, errcode: env.errcode, errmsg: env.errmsg }
  }
  return { kind: "unknown", cmd: env.cmd, reqId }
}

// ---------------------------------------------------------------------------
// Outbound frames (us → WeCom)
// ---------------------------------------------------------------------------

export interface WeComTemplateCard {
  card_type: "button_interaction" | "text_notice" | string
  main_title?: { title?: string; desc?: string }
  sub_title_text?: string
  /** button_interaction buttons. `key` round-trips back as `event_key`. */
  button_list?: Array<{ key: string; text: string; style?: number }>
  task_id?: string
  [k: string]: unknown
}

/** Generate a short, unique req_id (≤256 bytes per the protocol). */
export function newReqId(adapterId: string): string {
  return `${adapterId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
}

export function buildSubscribeFrame(
  reqId: string,
  botId: string,
  secret: string
): WeComFrameEnvelope {
  return { cmd: "aibot_subscribe", headers: { req_id: reqId }, body: { bot_id: botId, secret } }
}

export function buildPingFrame(reqId: string): WeComFrameEnvelope {
  return { cmd: "ping", headers: { req_id: reqId } }
}

/**
 * Streaming reply frame. The first call (with a fresh `streamId`) creates the
 * stream; subsequent calls reuse `streamId` to refresh content; the terminal
 * call sets `finish:true`. Must reuse the triggering callback's `req_id`.
 */
export function buildStreamRespondFrame(
  reqId: string,
  streamId: string,
  content: string,
  finish: boolean
): WeComFrameEnvelope {
  return {
    cmd: "aibot_respond_msg",
    headers: { req_id: reqId },
    body: { msgtype: "stream", stream: { id: streamId, content, finish } },
  }
}

/**
 * Combined "finished stream + template card" reply. The platform accepts a
 * card on a streamed reply ONLY through the single msgtype
 * `"stream_with_template_card"` (official SDK `reply_stream_with_card`) — a
 * separate `template_card` respond after a `finish:true` stream frame is
 * dropped. `finish` is always true here: the combined frame closes the
 * stream and attaches the card in one shot.
 */
export function buildStreamWithTemplateCardFrame(
  reqId: string,
  streamId: string,
  content: string,
  card: WeComTemplateCard
): WeComFrameEnvelope {
  return {
    cmd: "aibot_respond_msg",
    headers: { req_id: reqId },
    body: {
      msgtype: "stream_with_template_card",
      stream: { id: streamId, content, finish: true },
      template_card: card,
    },
  }
}

/** Interactive template-card reply (reuses the callback's req_id). */
export function buildTemplateCardRespondFrame(
  reqId: string,
  card: WeComTemplateCard
): WeComFrameEnvelope {
  return {
    cmd: "aibot_respond_msg",
    headers: { req_id: reqId },
    body: { msgtype: "template_card", template_card: card },
  }
}

/** Welcome reply fired on `enter_chat` — must land within 5 s. */
export function buildWelcomeFrame(reqId: string, content: string): WeComFrameEnvelope {
  return {
    cmd: "aibot_respond_welcome_msg",
    headers: { req_id: reqId },
    body: { msgtype: "text", text: { content } },
  }
}

/**
 * Welcome reply variant carrying a template_card instead of text — used by
 * the menu-card path. Same 5 s SLA as `buildWelcomeFrame`; the adapter
 * picks one or the other based on whether quick-commands are configured.
 */
export function buildWelcomeCardFrame(reqId: string, card: WeComTemplateCard): WeComFrameEnvelope {
  return {
    cmd: "aibot_respond_welcome_msg",
    headers: { req_id: reqId },
    body: { msgtype: "template_card", template_card: card },
  }
}

/** Template-card update fired on `template_card_event` — must land within 5 s. */
export function buildUpdateCardFrame(reqId: string, card: WeComTemplateCard): WeComFrameEnvelope {
  return {
    cmd: "aibot_respond_update_msg",
    headers: { req_id: reqId },
    body: { response_type: "update_template_card", template_card: card },
  }
}

export type WeComProactiveBody =
  | { chatid: string; chat_type: 0 | 1 | 2; msgtype: "markdown"; markdown: { content: string } }
  | { chatid: string; chat_type: 0 | 1 | 2; msgtype: "text"; text: { content: string } }
  | {
      chatid: string
      chat_type: 0 | 1 | 2
      msgtype: "template_card"
      template_card: WeComTemplateCard
    }
  // Media frames key the payload object BY msgtype — `{"msgtype":"image",
  // "image":{"media_id":…}}` — exactly like the reply path; the protocol has
  // no generic `media` key.
  | { chatid: string; chat_type: 0 | 1 | 2; msgtype: "image"; image: { media_id: string } }
  | { chatid: string; chat_type: 0 | 1 | 2; msgtype: "voice"; voice: { media_id: string } }
  | { chatid: string; chat_type: 0 | 1 | 2; msgtype: "video"; video: { media_id: string } }
  | { chatid: string; chat_type: 0 | 1 | 2; msgtype: "file"; file: { media_id: string } }

/**
 * Proactive push (no triggering message). `chatid` is the user's `userid`
 * for a single chat or the group `chatid` from a prior callback; `chat_type`
 * is `1` single / `2` group / `0` auto. NOTE: WeCom only delivers proactive
 * pushes to a chat the user has previously messaged the bot in.
 */
export function buildSendMsgFrame(reqId: string, body: WeComProactiveBody): WeComFrameEnvelope {
  return { cmd: "aibot_send_msg", headers: { req_id: reqId }, body }
}

// ---------------------------------------------------------------------------
// Media upload (3-step chunked) — used by media.ts
// ---------------------------------------------------------------------------

export interface WeComMediaInit {
  type: "image" | "voice" | "video" | "file"
  filename: string
  totalSize: number
  totalChunks: number
  /** MD5 hex digest of the complete file bytes. */
  md5: string
}

/**
 * Init frame of the 3-step upload. The protocol wants
 * `{type, filename, total_size, total_chunks, md5}` — `md5` is the hex
 * digest of the WHOLE file, `total_chunks` the number of chunk frames the
 * server should expect.
 */
export function buildMediaInitFrame(reqId: string, init: WeComMediaInit): WeComFrameEnvelope {
  return {
    cmd: "aibot_upload_media_init",
    headers: { req_id: reqId },
    body: {
      type: init.type,
      filename: init.filename,
      total_size: init.totalSize,
      total_chunks: init.totalChunks,
      md5: init.md5,
    },
  }
}

/** Chunk frame — the protocol keys the fields `chunk_index` / `base64_data`. */
export function buildMediaChunkFrame(
  reqId: string,
  uploadId: string,
  chunkIndex: number,
  dataBase64: string
): WeComFrameEnvelope {
  return {
    cmd: "aibot_upload_media_chunk",
    headers: { req_id: reqId },
    body: { upload_id: uploadId, chunk_index: chunkIndex, base64_data: dataBase64 },
  }
}

export function buildMediaFinishFrame(reqId: string, uploadId: string): WeComFrameEnvelope {
  return {
    cmd: "aibot_upload_media_finish",
    headers: { req_id: reqId },
    body: { upload_id: uploadId },
  }
}
