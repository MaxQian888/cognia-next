/**
 * OpenAI Realtime TTS — streams 24kHz PCM16 audio deltas over the OpenAI
 * Realtime WebSocket. The WS needs an `Authorization` header that browsers
 * cannot set, so synthesis runs through the `tts_realtime_synthesize` Tauri
 * command (`src-tauri/src/tts/realtime.rs`), which forwards each audio delta
 * back over a `tauri::ipc::Channel`. Desktop-only, like Edge TTS.
 *
 * This module is the thin transport adapter: it wires the Tauri channel to the
 * orchestrator's `onEvent` callback. Decoding + playback live in the
 * orchestrator (PcmPlayer), keeping all Tauri specifics here.
 */

import { isTauri } from "@/lib/tauri"
import type { TTSStreamOptions } from "@/lib/tts/providers/adapter"

/** Wire shape emitted by the Rust `RealtimeEvent` enum (serde tag/content). */
interface RealtimeWireEvent {
  event: "audio" | "done" | "error"
  /** base64 PCM16 for `audio`, message for `error`. */
  data?: string
}

export async function synthesizeRealtimeStream(opts: TTSStreamOptions): Promise<void> {
  const { text, apiKey, runtime, requestId, onEvent, signal } = opts

  if (!isTauri()) {
    onEvent({
      kind: "error",
      message: "OpenAI Realtime requires the desktop app (it streams over a Tauri-side WebSocket).",
    })
    return
  }

  const { invoke, Channel } = await import("@tauri-apps/api/core")
  const channel = new Channel<RealtimeWireEvent>()
  channel.onmessage = (msg) => {
    if (msg.event === "audio" && msg.data) {
      onEvent({ kind: "audio", audioBase64: msg.data })
    } else if (msg.event === "done") {
      onEvent({ kind: "done" })
    } else if (msg.event === "error") {
      onEvent({ kind: "error", message: msg.data ?? "Realtime synthesis failed" })
    }
  }

  const onAbort = () => {
    void invoke("tts_realtime_cancel", { requestId }).catch(() => {})
  }
  if (signal.aborted) {
    onAbort()
    return
  }
  signal.addEventListener("abort", onAbort)

  try {
    await invoke("tts_realtime_synthesize", {
      request: {
        requestId,
        apiKey,
        text,
        voice: (runtime.voice as string | undefined) ?? "marin",
        model: (runtime.model as string | undefined) ?? "gpt-realtime",
        instructions: (runtime.instructions as string | undefined) ?? "",
      },
      onEvent: channel,
    })
  } catch (error) {
    onEvent({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
