/**
 * Provider-neutral reducer for live-voice conversation state.
 *
 * Consumes the AI SDK's normalized `RealtimeModelV4ServerEvent` union, so every
 * vendor's dotted wire names (`response.output_audio_transcript.delta` and
 * friends) have already been mapped by the adapter.
 *
 * Two invariants this file must keep:
 *
 * 1. **Pure.** No audio, no sockets, no tool execution. The controller watches
 *    the same event stream for those effects. That keeps every state
 *    transition testable without a Web Audio graph.
 *
 * 2. **Referentially stable.** An event that changes nothing returns the *same*
 *    state object. `useSyncExternalStore` re-renders on identity change, so
 *    returning a fresh object per ignored event would spin the UI — and the
 *    high-rate events here (`audio-delta` at ~50/s) are exactly the ignored
 *    ones.
 *
 * Transcripts pass through the fail-closed PII gate before they can reach the
 * UI or be persisted: audio cannot be screened before transcription, so the
 * resulting text is the first place a gate can act.
 */

import type { Experimental_RealtimeModelV4ServerEvent as RealtimeServerEvent } from "@ai-sdk/provider"
import { hasNoLeakingPii, hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import {
  classifyProviderErrorInfo,
  isTransientErrorClass,
} from "@cognia/provider-routing/error-classifier"

export type LiveVoicePhase =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "listening"
  | "speaking"
  | "thinking"
  | "responding"
  | "error"

export type LiveVoiceErrorCode =
  | "device-permission"
  | "device-unavailable"
  | "authentication"
  | "rate-limit"
  | "connection-timeout"
  | "network"
  | "session-expired"
  | "provider-error"

export interface LiveVoiceErrorInfo {
  code: LiveVoiceErrorCode
  message: string
  retryable: boolean
}

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
  errorInfo?: LiveVoiceErrorInfo
  reconnect?: { attempt: number; maxAttempts: number }
}

export function createInitialLiveVoiceState(): LiveVoiceState {
  return { phase: "idle", turns: [], assistantDraft: "", muted: false }
}

/** Fail-closed PII boundary shared by every live-voice text path. */
export function screenLiveVoiceText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (hasNoLeakingPii(trimmed)) return trimmed
  const redacted = redactText(trimmed).redacted.trim()
  return redacted && hasNoLeakingPii(redacted) ? redacted : null
}

/** Fail closed at structured outbound boundaries, including nested tool metadata. */
export function assertLiveVoicePayloadPiiSafe(payload: unknown): void {
  if (!hasNoLeakingPiiDeep(payload)) {
    throw new Error("live voice payload was rejected by the PII redaction gate")
  }
}

/** Normalize browser, transport and provider failures into stable UI codes. */
export function classifyLiveVoiceError(error: Error): LiveVoiceErrorInfo {
  const message = error.message || error.name || "Realtime voice session failed"
  if (
    error.name === "NotAllowedError" ||
    /permission|notallowed|microphone.{0,12}denied|denied.{0,12}microphone/i.test(message)
  ) {
    return { code: "device-permission", message, retryable: false }
  }
  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
    return { code: "device-unavailable", message, retryable: true }
  }
  if (/session.{0,12}(expired|closed)|token.{0,12}expired/i.test(message)) {
    return { code: "session-expired", message, retryable: true }
  }
  if (/connection (?:was )?(?:lost|closed)|websocket|network|offline|ECONNRESET/i.test(message)) {
    return { code: "network", message, retryable: true }
  }
  const { errorClass } = classifyProviderErrorInfo(message)
  if (errorClass === "auth") {
    return { code: "authentication", message, retryable: false }
  }
  if (errorClass === "rate-limit") {
    return { code: "rate-limit", message, retryable: true }
  }
  if (errorClass === "timeout") {
    return { code: "connection-timeout", message, retryable: true }
  }
  if (errorClass === "network" || errorClass === "server-error") {
    return { code: "network", message, retryable: isTransientErrorClass(errorClass) }
  }
  return { code: "provider-error", message, retryable: false }
}

function upsertTurn(turns: LiveVoiceTurn[], next: LiveVoiceTurn): LiveVoiceTurn[] {
  const index = turns.findIndex((turn) => turn.id === next.id)
  if (index < 0) return [...turns, next]
  const copy = [...turns]
  copy[index] = next
  return copy
}

/**
 * Fold one normalized server event into the conversation state.
 *
 * Returns `state` unchanged (same reference) for events that carry no UI
 * meaning — audio deltas, item bookkeeping, tool-call argument streaming.
 */
export function reduceLiveVoiceServerEvent(
  state: LiveVoiceState,
  event: RealtimeServerEvent
): LiveVoiceState {
  switch (event.type) {
    case "session-created":
    case "session-updated":
      return state.phase === "listening" && !state.error
        ? state
        : {
            ...state,
            phase: "listening",
            error: undefined,
            errorInfo: undefined,
            reconnect: undefined,
          }

    case "speech-started":
      // The user started talking. Barge-in: whatever the assistant was part-way
      // through saying is no longer what the conversation contains.
      return { ...state, phase: "speaking", assistantDraft: "", error: undefined }

    case "speech-stopped":
      return { ...state, phase: "thinking" }

    case "response-created":
      return { ...state, phase: "responding" }

    case "response-done":
      return { ...state, phase: "listening" }

    case "input-transcription-completed": {
      const text = screenLiveVoiceText(event.transcript ?? "")
      if (!text) return state
      return {
        ...state,
        turns: upsertTurn(state.turns, { id: event.itemId, role: "user", text }),
      }
    }

    case "audio-transcript-delta":
    case "text-delta": {
      if (!event.delta) return state
      return {
        ...state,
        phase: "responding",
        assistantDraft: state.assistantDraft + event.delta,
      }
    }

    case "audio-transcript-done":
    case "text-done": {
      const complete = event.type === "audio-transcript-done" ? event.transcript : event.text
      const raw = (complete ?? state.assistantDraft).trim()
      if (!raw) return state.assistantDraft ? { ...state, assistantDraft: "" } : state

      const text = screenLiveVoiceText(raw)
      if (!text) return { ...state, assistantDraft: "" }
      return {
        ...state,
        assistantDraft: "",
        turns: upsertTurn(state.turns, { id: event.itemId, role: "assistant", text }),
      }
    }

    case "error": {
      const errorInfo = classifyLiveVoiceError(
        new Error(event.message || "Realtime voice session failed")
      )
      return {
        ...state,
        phase: "error",
        error: errorInfo.message,
        errorInfo,
      }
    }

    default:
      // audio-delta, audio-done, output-item-*, content-part-*, audio-committed,
      // conversation-item-added, function-call-arguments-*, custom — all handled
      // by the controller, none of them change conversation state.
      return state
  }
}
