import {
  buildClientSecretBody,
  createInitialLiveVoiceState,
  reduceLiveVoiceEvent,
  type LiveVoiceState,
} from "./realtime-session"

describe("reduceLiveVoiceEvent", () => {
  let state: LiveVoiceState

  beforeEach(() => {
    state = createInitialLiveVoiceState()
  })

  it("tracks the connected, listening, and thinking lifecycle", () => {
    state = reduceLiveVoiceEvent(state, { type: "session.created" })
    expect(state.phase).toBe("listening")

    state = reduceLiveVoiceEvent(state, { type: "input_audio_buffer.speech_started" })
    expect(state.phase).toBe("speaking")

    state = reduceLiveVoiceEvent(state, { type: "input_audio_buffer.speech_stopped" })
    expect(state.phase).toBe("thinking")

    state = reduceLiveVoiceEvent(state, { type: "response.created" })
    expect(state.phase).toBe("responding")

    state = reduceLiveVoiceEvent(state, { type: "response.done" })
    expect(state.phase).toBe("listening")
  })

  it("collects completed user turns and streamed assistant transcripts", () => {
    state = reduceLiveVoiceEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Run the tests",
      item_id: "user-1",
    })
    state = reduceLiveVoiceEvent(state, {
      type: "response.output_audio_transcript.delta",
      delta: "I’ll ",
      item_id: "assistant-1",
    })
    state = reduceLiveVoiceEvent(state, {
      type: "response.output_audio_transcript.delta",
      delta: "check.",
      item_id: "assistant-1",
    })
    state = reduceLiveVoiceEvent(state, {
      type: "response.output_audio_transcript.done",
      transcript: "I’ll check.",
      item_id: "assistant-1",
    })

    expect(state.turns).toEqual([
      { id: "user-1", role: "user", text: "Run the tests" },
      { id: "assistant-1", role: "assistant", text: "I’ll check." },
    ])
    expect(state.assistantDraft).toBe("")
  })

  it("redacts PII from completed user transcripts before they leave the voice path", () => {
    state = reduceLiveVoiceEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Email me at alex@example.com",
      item_id: "user-sensitive",
    })

    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]?.text).not.toContain("alex@example.com")
  })

  it("marks barge-in immediately and preserves prior completed turns", () => {
    state = {
      ...state,
      phase: "responding",
      turns: [{ id: "assistant-0", role: "assistant", text: "Long answer" }],
      assistantDraft: "unfinished",
    }

    state = reduceLiveVoiceEvent(state, { type: "input_audio_buffer.speech_started" })

    expect(state.phase).toBe("speaking")
    expect(state.assistantDraft).toBe("")
    expect(state.turns).toHaveLength(1)
  })

  it("surfaces server errors", () => {
    state = reduceLiveVoiceEvent(state, {
      type: "error",
      error: { message: "Invalid API key" },
    })
    expect(state.phase).toBe("error")
    expect(state.error).toBe("Invalid API key")
  })
})

describe("buildClientSecretBody", () => {
  it("configures current realtime voice, semantic VAD, transcription, and interruption", () => {
    expect(
      buildClientSecretBody({
        model: "gpt-realtime-2.1",
        voice: "marin",
        instructions: "Keep answers short",
      })
    ).toEqual({
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: "gpt-realtime-whisper" },
            turn_detection: {
              type: "semantic_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: "marin" },
        },
        instructions: "Keep answers short",
      },
    })
  })

  it("redacts PII from custom instructions before creating the remote session", () => {
    const body = buildClientSecretBody({
      model: "gpt-realtime-2.1",
      voice: "marin",
      instructions: "Call alex@example.com after every response",
    })

    expect(JSON.stringify(body)).not.toContain("alex@example.com")
  })
})
