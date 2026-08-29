import type { ChatSession } from "@cognia/agent-config-types"
import type { ExternalAgentInstance } from "@/types/agent/external-agent"

import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/preset-identity"
import { bindImportedSessionToNativeRuntime } from "@/lib/db/sessions"
import { realSessionFs } from "./fs"

export type NativeResumeFailureCode =
  | "binding-missing"
  | "preset-missing"
  | "preset-not-configured"
  | "runtime-unavailable"
  | "resume-unverified"
  | "cwd-missing"
  | "handshake-failed"

export type NativeResumeResult =
  | { ok: true; agentId: string; nativeSessionId: string }
  | { ok: false; code: NativeResumeFailureCode; detail?: string }

interface NativeResumeManager {
  getAllAgents(): ExternalAgentInstance[]
  resumeSession(
    agentId: string,
    sessionId: string,
    options?: { cwd?: string }
  ): Promise<{ id: string }>
}

interface NativeResumeDeps {
  manager?: NativeResumeManager
  fs?: Pick<ReturnType<typeof realSessionFs>, "exists">
  bind?: typeof bindImportedSessionToNativeRuntime
  now?: () => string
}

/**
 * Verify and resume an imported session without changing ownership on failure.
 * This intentionally never creates a preset, installs a CLI, or auto-connects.
 */
export async function resumeImportedSessionNative(
  session: ChatSession,
  deps: NativeResumeDeps = {}
): Promise<NativeResumeResult> {
  const binding = session.importRuntimeBinding
  const nativeSessionId = binding?.nativeSessionId?.trim()
  if (!nativeSessionId) return { ok: false, code: "binding-missing" }
  const presetId = binding?.presetId?.trim()
  if (!presetId) return { ok: false, code: "preset-missing" }

  const manager =
    deps.manager ??
    ((
      await import("@/lib/ai/agent/external/manager")
    ).getExternalAgentManager() as NativeResumeManager)
  const candidates = manager
    .getAllAgents()
    .filter((instance) => externalAgentPresetIdOf(instance.config) === presetId)
  if (candidates.length === 0) return { ok: false, code: "preset-not-configured", detail: presetId }

  const connected = candidates.find((instance) => instance.connectionStatus === "connected")
  if (!connected) {
    const detail = candidates.find((instance) => instance.validity?.blockingReason)?.validity
      ?.blockingReason
    return { ok: false, code: "runtime-unavailable", ...(detail ? { detail } : {}) }
  }
  const resumeSupport = connected.validity?.sessionExtensions?.["session/resume"]
  if (resumeSupport?.state !== "supported") {
    return {
      ok: false,
      code: "resume-unverified",
      ...(resumeSupport?.reason ? { detail: resumeSupport.reason } : {}),
    }
  }
  if (binding.cwd && !(await (deps.fs ?? realSessionFs()).exists(binding.cwd))) {
    return { ok: false, code: "cwd-missing", detail: binding.cwd }
  }

  try {
    await manager.resumeSession(connected.config.id, nativeSessionId, {
      ...(binding.cwd ? { cwd: binding.cwd } : {}),
    })
    const verifiedBinding = {
      ...binding,
      nativeSessionId,
      presetId,
      resumeMethod: "protocol" as const,
      verifiedAt: (deps.now ?? (() => new Date().toISOString()))(),
    }
    await (deps.bind ?? bindImportedSessionToNativeRuntime)(session.id, verifiedBinding)
    return { ok: true, agentId: connected.config.id, nativeSessionId }
  } catch (error) {
    return {
      ok: false,
      code: "handshake-failed",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
