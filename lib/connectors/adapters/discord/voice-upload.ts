/**
 * Discord voice-message upload helper.
 *
 * Discord `voice` messages — short recordings rendered with a play button +
 * waveform — are sent via a multipart upload to `POST /channels/{id}/messages`
 * with `flags: 1 << 13` (IS_VOICE_MESSAGE) and a single audio attachment
 * carrying `duration_secs` (+ optional `waveform`).
 *
 * The multipart fetch-and-post lives in Rust (`connectors_discord_upload`) so
 * the renderer never has to hold the file bytes; this helper just marshals the
 * segment metadata into that command.
 */

import { connectorsDiscordUpload } from "@/lib/connectors/tauri/commands"

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
  /**
   * Deterministic idempotency `nonce` (≤25 chars, see `discordNonce`); posted
   * with `enforce_nonce: true` so a retried upload returns the original
   * message instead of creating a duplicate.
   */
  nonce?: string
}

export interface VoiceUploadResult {
  messageId?: string
}

/**
 * Send a Discord voice message via the Rust multipart upload bridge. Failures
 * throw so the outbound runner's retry / backoff path applies.
 */
export async function sendDiscordVoiceMessage(input: VoiceUploadInput): Promise<VoiceUploadResult> {
  const token = await input.botToken()
  const messageId = await connectorsDiscordUpload({
    botToken: token,
    channelId: input.channelId,
    flags: VOICE_MESSAGE_FLAG,
    files: [
      {
        sourceUrl: input.voiceUrl,
        filename: "voice-message.ogg",
        contentType: "audio/ogg",
        durationSecs: input.durationSec ?? 0,
        waveform: input.waveform,
      },
    ],
    replyToMessageId: input.replyToMessageId,
    nonce: input.nonce,
  })
  return { messageId }
}
