import { createBaiduLiveAdapter, createQwenLiveAdapter } from "./china-json-adapters"
import fixtures from "./protocol-fixtures.json"

describe.each([
  ["qwen", createQwenLiveAdapter],
  ["baidu", createBaiduLiveAdapter],
] as const)("%s live JSON adapter", (provider, createAdapter) => {
  const adapter = createAdapter("model-1")

  it("serializes session setup and PCM16 input", () => {
    expect(
      adapter.serializeClientEvent({
        type: "session-update",
        config: {
          instructions: "brief",
          voice: "voice-1",
          inputAudioTranscription: {},
          turnDetection: { type: "server-vad" },
          tools: [
            {
              type: "function",
              name: "weather",
              description: "Weather",
              parameters: { type: "object" },
            },
          ],
        },
      })
    ).toMatchObject({
      type: "session.update",
      session: {
        modalities: provider === "qwen" ? ["audio", "text"] : ["text", "audio"],
        input_audio_format: provider === "qwen" ? "pcm" : "pcm16",
        output_audio_format: provider === "qwen" ? "pcm" : "pcm16",
        input_audio_transcription: { model: provider === "qwen" ? "fun-asr" : "default" },
        instructions: "brief",
        voice: "voice-1",
        turn_detection:
          provider === "qwen"
            ? { type: "server_vad" }
            : { type: "server_vad", create_response: true, interrupt_response: true },
        tool_choice: "auto",
        tools: [{ type: "function", name: "weather" }],
      },
    })
    expect(adapter.serializeClientEvent({ type: "input-audio-append", audio: "AAEC" })).toEqual({
      type: "input_audio_buffer.append",
      audio: "AAEC",
    })
  })

  it("maps transcripts, audio, tools, cancellation and provider errors", () => {
    expect(
      adapter.parseServerEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "hello",
      })
    ).toMatchObject({ type: "input-transcription-completed", itemId: "u1", transcript: "hello" })
    expect(
      adapter.parseServerEvent({
        type: "response.audio.delta",
        response_id: "r1",
        item_id: "a1",
        delta: "AQI=",
      })
    ).toMatchObject({ type: "audio-delta", responseId: "r1", itemId: "a1", delta: "AQI=" })
    expect(
      adapter.parseServerEvent({
        type: "response.function_call_arguments.done",
        response_id: "r1",
        item_id: "f1",
        call_id: "c1",
        name: "weather",
        arguments: "{}",
      })
    ).toMatchObject({ type: "function-call-arguments-done", callId: "c1", name: "weather" })
    expect(adapter.serializeClientEvent({ type: "response-cancel" })).toEqual({
      type: "response.cancel",
    })
    expect(
      adapter.parseServerEvent({ type: "error", error: { code: "401", message: "denied" } })
    ).toMatchObject({ type: "error", code: "401", message: "denied" })
  })

  it("rejects malformed events", () => {
    expect(() => adapter.parseServerEvent(null)).toThrow(/malformed/)
    expect(() => adapter.parseServerEvent({})).toThrow(/missing type/)
  })

  it("never mints a renderer-visible secret", async () => {
    await expect(adapter.doCreateClientSecret({ sessionConfig: {} })).rejects.toThrow(
      /host keyring/
    )
    expect(adapter.provider).toBe(provider)
  })
})

it("parses sanitized Qwen and Baidu protocol fixtures", () => {
  expect(
    createQwenLiveAdapter("qwen").parseServerEvent(fixtures.qwen.inputTranscript)
  ).toMatchObject({ type: "input-transcription-completed", transcript: "你好，Cognia" })
  expect(createBaiduLiveAdapter("baidu").parseServerEvent(fixtures.baidu.audioDelta)).toMatchObject(
    {
      type: "audio-delta",
      delta: "AQID",
    }
  )
})
