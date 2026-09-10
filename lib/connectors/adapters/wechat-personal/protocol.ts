/**
 * Personal WeChat — iLink (智联) bot HTTP protocol.
 *
 * Tencent iLink gateway at `https://ilinkai.weixin.qq.com` (the
 * OpenClaw "微信 ClawBot" feature). HTTP/JSON, not WebSocket: the client
 * long-polls `getupdates` and replies via `sendmessage`. Every reply MUST echo
 * the inbound message's `context_token` — there is NO proactive-send path
 * (sending to a conversation the bot was never messaged in is impossible).
 *
 * This module is PURE — endpoints, header construction, and request/response
 * shapes + builders. The long-poll loop lives in `index.ts`, QR login in
 * `auth.ts`, normalisation in `parse.ts`, media crypto in `media.ts`.
 *
 * Ref: https://github.com/Tencent/openclaw-weixin (SDK 2.4.8).
 */

export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
export const ILINK_CHANNEL_VERSION = "1.0.0"
/** bot_type for a personal-account bot. */
export const ILINK_BOT_TYPE = 3
/** Fallback long-poll timeout when the server omits `longpolling_timeout_ms`. */
export const ILINK_LONGPOLL_TIMEOUT_MS = 35_000

export const ILINK_PATHS = {
  getBotQrcode: "/ilink/bot/get_bot_qrcode",
  getQrcodeStatus: "/ilink/bot/get_qrcode_status",
  getUpdates: "/ilink/bot/getupdates",
  sendMessage: "/ilink/bot/sendmessage",
  getUploadUrl: "/ilink/bot/getuploadurl",
} as const

/** Session-expired sentinel — clear state + re-scan the QR code. */
export const ILINK_RET_SESSION_EXPIRED = -14

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * `X-WECHAT-UIN` is an anti-replay nonce: base64 of a random uint32 rendered
 * as a decimal string. Fresh per request.
 */
export function newWechatUin(): string {
  const n = Math.floor(Math.random() * 0xffffffff)
  // btoa is available in the Tauri webview + jsdom.
  return btoa(String(n))
}

/**
 * Headers for an iLink business POST. `token` is omitted for the pre-login
 * QR endpoints (no bot_token yet).
 */
export function buildIlinkHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": newWechatUin(),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// ---------------------------------------------------------------------------
// Message item shapes
// ---------------------------------------------------------------------------

/** item_list[].type discriminator. */
export const ILINK_ITEM = {
  text: 1,
  image: 2,
  voice: 3,
  file: 4,
  video: 5,
} as const

/** Top-level message_type: direction/sender kind. */
export const ILINK_MSG = {
  fromUser: 1,
  fromBot: 2,
} as const

export interface IlinkMediaItem {
  media?: {
    full_url?: string
    encrypt_query_param?: string
    aes_key?: string
    encrypt_type?: number
  }
  /** Official image-specific AES key, hex encoded. */
  aeskey?: string
  len?: string
  text?: string

  /** CDN download URL (encrypted content). */
  url?: string
  /** Base64 AES-128 key for ECB decryption of the CDN payload. */
  aes_key?: string
  file_name?: string
  file_ext?: string
  [k: string]: unknown
}

export interface IlinkItem {
  type: number
  ref_msg?: { title?: string; message_item?: IlinkItem }
  text_item?: { text?: string }
  image_item?: IlinkMediaItem
  voice_item?: IlinkMediaItem & { transcript?: string }
  file_item?: IlinkMediaItem
  video_item?: IlinkMediaItem
}

export interface IlinkMessage {
  message_id?: number | string
  client_id?: string
  create_time_ms?: number
  group_id?: string
  from_user_id: string
  to_user_id: string
  message_type: number
  message_state?: number
  context_token: string
  session_id?: string
  item_list?: IlinkItem[]
}

export interface IlinkGetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: IlinkMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface IlinkQrcodeResponse {
  qrcode?: string
  /** Official QR payload URL, to be encoded into a QR image by the client. */
  qrcode_img_content?: string
  errcode?: number
  errmsg?: string
}

export type IlinkQrStatus = "wait" | "scaned" | "confirmed" | "expired" | string

export interface IlinkQrStatusResponse {
  status: IlinkQrStatus
  bot_token?: string
  baseurl?: string
  /** The scanned account's id, when the gateway returns it on confirm. */
  account_id?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  redirect_host?: string
  errcode?: number
  errmsg?: string
}

// ---------------------------------------------------------------------------
// Request body builders
// ---------------------------------------------------------------------------

export function buildGetUpdatesBody(cursor: string): {
  get_updates_buf: string
  base_info: { channel_version: string }
} {
  return { get_updates_buf: cursor, base_info: { channel_version: ILINK_CHANNEL_VERSION } }
}

export function buildSendTextBody(
  toUserId: string,
  contextToken: string,
  text: string
): { msg: IlinkMessage; base_info: { channel_version: string } } {
  return {
    msg: {
      to_user_id: toUserId,
      from_user_id: "",
      message_type: ILINK_MSG.fromBot,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: ILINK_ITEM.text, text_item: { text } }],
    },
    base_info: { channel_version: ILINK_CHANNEL_VERSION },
  }
}

export function buildSendMediaBody(
  toUserId: string,
  contextToken: string,
  itemType: number,
  mediaItem: IlinkMediaItem
): { msg: IlinkMessage; base_info: { channel_version: string } } {
  const itemKey =
    itemType === ILINK_ITEM.image
      ? "image_item"
      : itemType === ILINK_ITEM.voice
        ? "voice_item"
        : itemType === ILINK_ITEM.video
          ? "video_item"
          : "file_item"
  return {
    msg: {
      to_user_id: toUserId,
      from_user_id: "",
      message_type: ILINK_MSG.fromBot,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: itemType, [itemKey]: mediaItem }],
    },
    base_info: { channel_version: ILINK_CHANNEL_VERSION },
  }
}

/** Preserve either error indicator; protobuf JSON may omit zero-valued status fields. */
export function ilinkResultCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const { ret, errcode } = value as { ret?: unknown; errcode?: unknown }
  for (const code of [ret, errcode]) {
    if (code !== undefined && (typeof code !== "number" || !Number.isFinite(code))) return undefined
  }
  if (ret === ILINK_RET_SESSION_EXPIRED || errcode === ILINK_RET_SESSION_EXPIRED)
    return ILINK_RET_SESSION_EXPIRED
  if (typeof ret === "number" && ret !== 0) return ret
  if (typeof errcode === "number" && errcode !== 0) return errcode
  return 0
}

/** Official CDN resolver, with legacy direct URLs retained for existing accounts. */
export function ilinkMediaUrl(item: IlinkMediaItem | undefined): string | undefined {
  if (item?.media?.full_url) return item.media.full_url
  if (item?.media?.encrypt_query_param) {
    return `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(item.media.encrypt_query_param)}`
  }
  return item?.url
}
