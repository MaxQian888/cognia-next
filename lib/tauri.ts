import { setTransport, transport } from "./tauri/transport-instance"
import type { LiveVoiceDeployment, LiveVoiceProviderId } from "@cognia/agent-config-types"

// Runtime detection delegates to the canonical, framework-free source of truth
// in `lib/platform/detect`. Re-exported here so existing
// `import { isTauri, isCapacitor } from "@/lib/tauri"` call sites are untouched.
//
// - `isTauri()`     — true inside a Tauri desktop webview (`__TAURI_INTERNALS__`).
// - `isCapacitor()` — true inside a native Capacitor mobile shell
//   (`Capacitor.isNativePlatform()`), for UI-level platform branching.
export { isCapacitor, isTauri } from "@/lib/platform/detect"

// Re-export the transport so consumers can `import { transport } from "@/lib/tauri"`.
// The actual instance lives in `lib/tauri/transport-instance.ts` to stay out
// of the circular import chain that runs through this barrel. `setTransport`
// lets non-browser hosts (the agent CLI) install a custom implementation.
export { transport, setTransport }

// Type-safe wrappers for Rust commands defined in src-tauri/src/commands.rs.
// Keep this file as the SOLE authoritative seam — business code imports named
// functions from here, never `invoke` directly.

export async function greet(name: string): Promise<string> {
  return transport.call<string>("greet", { name })
}

/** Open a policy-constrained live-voice socket without exposing its key. */
export async function voiceLiveWsOpen(
  provider: LiveVoiceProviderId,
  deployment: LiveVoiceDeployment,
  handleId: string
): Promise<string> {
  const nonSecretDeployment = {
    ...(deployment.workspaceId ? { workspaceId: deployment.workspaceId } : {}),
    ...(deployment.appId ? { appId: deployment.appId } : {}),
    ...(deployment.model ? { model: deployment.model } : {}),
    ...(deployment.voice ? { voice: deployment.voice } : {}),
  }
  return transport.call<string>("voice_live_ws_open", {
    provider,
    deployment: nonSecretDeployment,
    handleId,
  })
}

// Re-export every plugin wrapper as a named import surface. Consumers can do
//   import { openExternal, notify, getOsInfo } from "@/lib/tauri"
// without knowing which sub-module they live in.
export * from "./tauri/index"
