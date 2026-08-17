/**
 * Tests for the Discord voice-message upload helper. The multipart fetch/post
 * happens in Rust (`connectors_discord_upload`); here we only assert the segment
 * metadata is marshalled correctly (voice flag + duration + waveform).
 */

const mockUpload = jest.fn().mockResolvedValue("voice-msg-id")

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsDiscordUpload: (...args: unknown[]) => mockUpload(...args),
}))

import { sendDiscordVoiceMessage } from "./voice-upload"

beforeEach(() => {
  mockUpload.mockClear()
  mockUpload.mockResolvedValue("voice-msg-id")
})

describe("sendDiscordVoiceMessage", () => {
  it("uploads with the IS_VOICE_MESSAGE flag + duration + waveform + reply", async () => {
    const res = await sendDiscordVoiceMessage({
      botToken: async () => "TOKEN",
      channelId: "c1",
      voiceUrl: "https://cdn/x/v.ogg",
      durationSec: 4,
      waveform: "AAAA",
      replyToMessageId: "m1",
    })
    expect(res.messageId).toBe("voice-msg-id")
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: "TOKEN",
        channelId: "c1",
        flags: 1 << 13,
        replyToMessageId: "m1",
        files: [
          expect.objectContaining({
            sourceUrl: "https://cdn/x/v.ogg",
            contentType: "audio/ogg",
            durationSecs: 4,
            waveform: "AAAA",
          }),
        ],
      })
    )
  })

  it("forwards the idempotency nonce to the upload bridge", async () => {
    await sendDiscordVoiceMessage({
      botToken: async () => "TOKEN",
      channelId: "c1",
      voiceUrl: "https://cdn/x/v.ogg",
      nonce: "abc123",
    })
    expect(mockUpload).toHaveBeenCalledWith(expect.objectContaining({ nonce: "abc123" }))
  })

  it("defaults durationSecs to 0 when omitted", async () => {
    await sendDiscordVoiceMessage({
      botToken: async () => "TOKEN",
      channelId: "c1",
      voiceUrl: "https://cdn/x/v.ogg",
    })
    const req = mockUpload.mock.calls[0][0] as { files: Array<{ durationSecs: number }> }
    expect(req.files[0].durationSecs).toBe(0)
  })

  it("propagates upload failures to the caller", async () => {
    mockUpload.mockRejectedValueOnce(new Error("HTTP 413"))
    await expect(
      sendDiscordVoiceMessage({
        botToken: async () => "TOKEN",
        channelId: "c1",
        voiceUrl: "https://cdn/x/v.ogg",
      })
    ).rejects.toThrow("HTTP 413")
  })
})
