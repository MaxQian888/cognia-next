/**
 * Host-injection seam for the TTS package (ADR-0068 E3's `{ fetch, getSecret }`
 * convention, adapted to what this subsystem actually needs from its shell).
 *
 * The package is framework-agnostic: everything platform-specific — the Tauri
 * `tts_proxy_fetch` CORS/key-guarding proxy, the native-shell capability gate
 * for Edge/OpenAI-realtime synthesis, and user-visible failure toasts — is
 * supplied by the embedding app. In cognia-next the installer is
 * `lib/tts/host-bindings.ts`, imported by every app-side binding module so the
 * host is configured before any synthesis call. Unset fields degrade to the
 * pure-browser behavior (plain fetch, no native providers, silent failures),
 * which is exactly what a non-configured shell (CLI, tests) should get.
 */

import type { ProxyFetchInit, ProxyFetchResult } from "./proxy-fetch"
import type { TTSProvider } from "./types"

export interface TtsHost {
  /**
   * Native proxy fetch (Tauri `tts_proxy_fetch`). Return `null` to fall
   * through to the browser fetch — the installed hook decides per call, so
   * runtime environment checks (isTauri) keep their original call-time
   * semantics.
   */
  nativeProxyFetch?: (url: string, init: ProxyFetchInit) => Promise<ProxyFetchResult> | null
  /**
   * True when running inside a native shell whose bridges support the
   * websocket/stream providers (Edge TTS, OpenAI realtime).
   */
  isNativeShell?: () => boolean
  /** Mobile playback always uses the device/browser system synthesizer. */
  isMobileShell?: () => boolean
  /** Fail-closed app policy for text leaving the device for a cloud TTS provider. */
  allowCloudText?: (text: string, provider: TTSProvider) => boolean
  /** Surface a user-visible notification (the app binds sonner toasts). */
  notify?: {
    message: (text: string) => void
    error: (text: string) => void
  }
}

let host: TtsHost = {}

export function setTtsHost(next: TtsHost): void {
  host = next
}

export function getTtsHost(): TtsHost {
  return host
}
