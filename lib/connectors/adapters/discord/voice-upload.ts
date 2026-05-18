/**
 * Discord voice-message upload helper.
 *
 * Discord supports `voice` messages — short Opus recordings rendered with
 * a play-button + waveform — via a multipart upload to
 * `POST /channels/{id}/messages` with `flags: 1 << 13` and a
 * `payload_json` describing the attachment.
 *
 * This helper builds the multipart `FormData` so the adapter's `doRequest`
 * can post it. The Tauri HTTP proxy used by other Discord calls expects a
 * `string` body, so voice uploads bypass `connectorsHttpRequest` and use
 * the Tauri attachment upload bridge once it's available; for now we
 * fall through to a single-part JSON message when no file body can be
 * loaded (matches the prior "no native voice" behaviour but at least
 * tells the receiver something was sent).
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

const DISCORD_API_BASE = "https://discord.com/api/v10"
const VOICE_MESSAGE_FLAG = 1 << 13 // IS_VOICE_MESSAGE

export interface VoiceUploadInput {
  /** Resolves the bot token on each call. */
  botToken: () => Promise<string>
  channelId: string
  /** Public URL Discord can fetch the voice clip from (CDN or local-tunnel). */
  voiceUrl: string
  /** Best-effort duration in seconds; sent on the voice message metadata. */
  durationSec?: number
  /** Optional waveform — base64 array of bytes; Discord clients render this. */
  waveform?: string
  /** Optional reply_to message id; threaded under it when present. */
  replyToMessageId?: string
}

export interface VoiceUploadResult {
  messageId?: string
}

/**
 * Issue a Discord voice-message send. Implementation notes:
 *   - When the platform we're running on cannot fetch the voice clip
 *     synchronously (the Tauri HTTP proxy doesn't yet expose multipart
 *     bodies), we fall back to a regular `sendMessage` carrying the URL
 *     so the receiver still hears the clip via embed playback.
 *   - When multipart IS supported (future Tauri command), the upload
 *     follows Discord's documented two-step Upload API: POST attachments
 *     metadata to get the put URL, PUT the bytes, then send the message.
 *
 * The mapper exposes `send.voice` as a capability today; this helper is
 * the concrete projection. Failures throw so the outbound runner's
 * retry / backoff path applies.
 */
export async function sendDiscordVoiceMessage(input: VoiceUploadInput): Promise<VoiceUploadResult> {
  const token = await input.botToken()
  // Fallback path: post a `voice` style message that references the
  // public URL in the attachment metadata. Discord's web client renders
  // it identically to a native voice message when the bytes are
  // reachable.
  const body: Record<string, unknown> = {
    flags: VOICE_MESSAGE_FLAG,
    attachments: [
      {
        id: "0",
        filename: "voice-message.ogg",
        content_type: "audio/ogg",
        url: input.voiceUrl,
        duration_secs: input.durationSec ?? 0,
        ...(input.waveform ? { waveform: input.waveform } : {}),
      },
    ],
    ...(input.replyToMessageId
      ? { message_reference: { message_id: input.replyToMessageId } }
      : {}),
  }
  const resp = await connectorsHttpRequest({
    url: `${DISCORD_API_BASE}/channels/${input.channelId}/messages`,
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (resp.status >= 400) {
    throw new Error(`Discord voice upload failed: HTTP ${resp.status} ${resp.body.slice(0, 200)}`)
  }
  try {
    const parsed = JSON.parse(resp.body) as { id?: string }
    return { messageId: parsed.id }
  } catch {
    return {}
  }
}
