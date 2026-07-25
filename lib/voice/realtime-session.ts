import { isTauri } from "@/lib/tauri"
import { getProviderKey } from "@/lib/tts/keyring"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export type LiveVoicePhase =
  "idle" | "connecting" | "listening" | "speaking" | "thinking" | "responding" | "error"

export interface LiveVoiceTurn {
  id: string
  role: "user" | "assistant"
  text: string
}

export interface LiveVoiceState {
  phase: LiveVoicePhase
  turns: LiveVoiceTurn[]
  assistantDraft: string
  muted: boolean
  error?: string
}

export interface RealtimeServerEvent {
  type: string
  item_id?: string
  response_id?: string
  transcript?: string
  delta?: string
  error?: { message?: string }
}

export interface LiveVoiceConfig {
  model: string
  voice: string
  instructions?: string
  microphoneId?: string
}

export function createInitialLiveVoiceState(): LiveVoiceState {
  return {
    phase: "idle",
    turns: [],
    assistantDraft: "",
    muted: false,
  }
}

function eventItemId(event: RealtimeServerEvent, fallback: string): string {
  return event.item_id ?? event.response_id ?? fallback
}

function upsertTurn(turns: LiveVoiceTurn[], next: LiveVoiceTurn): LiveVoiceTurn[] {
  const index = turns.findIndex((turn) => turn.id === next.id)
  if (index < 0) return [...turns, next]
  const copy = [...turns]
  copy[index] = next
  return copy
}

/**
 * Fail-closed text boundary for Realtime voice. Audio cannot be screened before
 * transcription, so every resulting text value is redacted and re-checked
 * before it can enter the composer or a remote session configuration.
 */
export function screenLiveVoiceText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (hasNoLeakingPii(trimmed)) return trimmed
  const redacted = redactText(trimmed).redacted.trim()
  return redacted && hasNoLeakingPii(redacted) ? redacted : null
}

export function reduceLiveVoiceEvent(
  state: LiveVoiceState,
  event: RealtimeServerEvent
): LiveVoiceState {
  switch (event.type) {
    case "session.created":
    case "session.updated":
    case "response.done":
    case "response.cancelled":
      return { ...state, phase: "listening", error: undefined }
    case "input_audio_buffer.speech_started":
      return {
        ...state,
        phase: "speaking",
        assistantDraft: "",
        error: undefined,
      }
    case "input_audio_buffer.speech_stopped":
      return { ...state, phase: "thinking" }
    case "response.created":
      return { ...state, phase: "responding" }
    case "conversation.item.input_audio_transcription.completed": {
      const text = screenLiveVoiceText(event.transcript ?? "")
      if (!text) return state
      return {
        ...state,
        turns: upsertTurn(state.turns, {
          id: eventItemId(event, `user-${state.turns.length}`),
          role: "user",
          text,
        }),
      }
    }
    case "response.output_audio_transcript.delta":
      return {
        ...state,
        phase: "responding",
        assistantDraft: state.assistantDraft + (event.delta ?? ""),
      }
    case "response.output_audio_transcript.done": {
      const text = (event.transcript ?? state.assistantDraft).trim()
      if (!text) return { ...state, assistantDraft: "" }
      return {
        ...state,
        assistantDraft: "",
        turns: upsertTurn(state.turns, {
          id: eventItemId(event, `assistant-${state.turns.length}`),
          role: "assistant",
          text,
        }),
      }
    }
    case "error":
      return {
        ...state,
        phase: "error",
        error: event.error?.message ?? "Realtime voice session failed",
      }
    default:
      return state
  }
}

interface ClientSecretResponse {
  value: string
}

async function createClientSecret(config: LiveVoiceConfig): Promise<string> {
  const safeInstructions = screenLiveVoiceText(config.instructions ?? "") ?? ""
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke<ClientSecretResponse>("voice_live_client_secret", {
      request: {
        model: config.model,
        voice: config.voice,
        instructions: safeInstructions,
      },
    })
    return result.value
  }

  const apiKey = await getProviderKey("openai")
  if (!apiKey) throw new Error("OpenAI API key is required")
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildClientSecretBody({ ...config, instructions: safeInstructions })),
  })
  if (!response.ok) {
    throw new Error((await response.text()) || `Client secret request failed (${response.status})`)
  }
  const data = (await response.json()) as ClientSecretResponse
  if (!data.value) throw new Error("Realtime client secret response is missing a value")
  return data.value
}

export function buildClientSecretBody(config: LiveVoiceConfig): Record<string, unknown> {
  const safeInstructions = screenLiveVoiceText(config.instructions ?? "")
  return {
    session: {
      type: "realtime",
      model: config.model,
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
        output: { voice: config.voice },
      },
      instructions:
        safeInstructions ||
        "Be concise, conversational, and action-oriented. Confirm before consequential actions.",
    },
  }
}

export class RealtimeVoiceSession {
  private peer: RTCPeerConnection | null = null
  private stream: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private channel: RTCDataChannel | null = null
  private state = createInitialLiveVoiceState()

  constructor(private readonly onState: (state: LiveVoiceState) => void) {}

  async start(config: LiveVoiceConfig): Promise<void> {
    if (this.peer) return
    this.update({ ...createInitialLiveVoiceState(), phase: "connecting" })

    try {
      const token = await createClientSecret(config)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: config.microphoneId ? { deviceId: { exact: config.microphoneId } } : true,
      })
      const peer = new RTCPeerConnection()
      const audio = document.createElement("audio")
      audio.autoplay = true
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void audio.play().catch(() => undefined)
      }
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream)

      const channel = peer.createDataChannel("oai-events")
      channel.onmessage = (message) => this.handleMessage(message.data)
      channel.onerror = () => {
        this.update({ ...this.state, phase: "error", error: "Realtime data channel failed" })
      }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
          this.update({ ...this.state, phase: "error", error: "Realtime connection was lost" })
        }
      }

      this.peer = peer
      this.stream = stream
      this.audio = audio
      this.channel = channel

      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp ?? "",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/sdp",
        },
      })
      if (!response.ok) {
        throw new Error(
          (await response.text()) || `Realtime connection failed (${response.status})`
        )
      }
      await peer.setRemoteDescription({
        type: "answer",
        sdp: await response.text(),
      })
    } catch (error) {
      this.stop(false)
      this.update({
        ...this.state,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted
    this.update({ ...this.state, muted })
  }

  stop(reset = true): void {
    this.channel?.close()
    this.channel = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.peer?.close()
    this.peer = null
    if (this.audio) {
      this.audio.pause()
      this.audio.srcObject = null
      this.audio.remove()
      this.audio = null
    }
    if (reset) this.update(createInitialLiveVoiceState())
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return
    try {
      this.update(reduceLiveVoiceEvent(this.state, JSON.parse(raw) as RealtimeServerEvent))
    } catch {
      // Ignore malformed control events; the media connection remains usable.
    }
  }

  private update(state: LiveVoiceState): void {
    this.state = state
    this.onState(state)
  }
}
