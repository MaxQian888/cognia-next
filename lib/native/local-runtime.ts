/**
 * Local-runtime diagnostics — captures the environment in which the app is
 * running so crash bundles surface the platform, build flavor, and any
 * available Tauri identity. Cognia exposes a richer local-runtime status
 * surface (Ollama / vLLM / native servers it hosts); cognia-next has no
 * embedded local-runtime concept yet, so this returns a portable snapshot
 * with `status: 'ok'` until subsystems plug in their own checks.
 */

import { isTauri } from "@/lib/tauri"
import type { LocalRuntimeDiagnostics } from "@/lib/logging/crash-log"

export type { LocalRuntimeDiagnostics }

async function readTauriEnv(): Promise<Record<string, unknown>> {
  if (!isTauri()) return {}

  const env: Record<string, unknown> = {}
  try {
    const os = await import("@tauri-apps/plugin-os")
    // platform/version/arch/family are synchronous in plugin-os v2; only
    // locale and hostname remain async.
    try {
      env.platform = os.platform()
    } catch {
      /* unsupported */
    }
    try {
      env.osVersion = os.version()
    } catch {
      /* unsupported */
    }
    try {
      env.arch = os.arch()
    } catch {
      /* unsupported */
    }
    try {
      env.family = os.family()
    } catch {
      /* unsupported */
    }
    env.locale = await os.locale().catch(() => undefined)
    env.hostname = await os.hostname().catch(() => undefined)
  } catch {
    // OS plugin not registered — leave env minimal.
  }

  try {
    const { getName, getVersion, getTauriVersion } = await import("@tauri-apps/api/app")
    env.appName = await getName().catch(() => undefined)
    env.appVersion = await getVersion().catch(() => undefined)
    env.tauriVersion = await getTauriVersion().catch(() => undefined)
  } catch {
    // App module unavailable — skip.
  }

  return env
}

function readWebEnv(): Record<string, unknown> {
  if (typeof navigator === "undefined") {
    return { runtime: "server" }
  }
  return {
    runtime: "browser",
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: typeof navigator.platform === "string" ? navigator.platform : undefined,
    online: typeof navigator.onLine === "boolean" ? navigator.onLine : undefined,
  }
}

export async function getLocalRuntimeDiagnostics(): Promise<LocalRuntimeDiagnostics | null> {
  try {
    const tauriEnv = await readTauriEnv()
    const webEnv = readWebEnv()
    return {
      status: "ok",
      capturedAt: new Date().toISOString(),
      isTauri: isTauri(),
      ...webEnv,
      ...tauriEnv,
    }
  } catch (err) {
    return {
      status: "error",
      lastError: err instanceof Error ? err.message : String(err),
      capturedAt: new Date().toISOString(),
      isTauri: isTauri(),
    }
  }
}
