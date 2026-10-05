import type { ChatSession } from "@cognia/agent-config-types"
import type { ExternalAgentInstance } from "@/types/agent/external-agent"

import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/config/preset-identity"
import { presetIdsSharingEcosystem } from "@/lib/agent-ecosystem/runtime-link"
import { bindImportedSessionToNativeRuntime } from "@/lib/db/sessions"
import { realSessionFs } from "./fs"

export type NativeResumeFailureCode =
  | "binding-missing"
  | "preset-missing"
  | "preset-not-configured"
  | "runtime-unavailable"
  | "bound-runtime-unavailable"
  | "runtime-ambiguous"
  | "runtime-isolated"
  | "resume-unverified"
  | "cwd-missing"
  | "handshake-failed"

/** One connected configuration a resume could run on, for the caller to choose. */
export interface NativeResumeChoice {
  agentId: string
  name: string
}

export type NativeResumeResult =
  | { ok: true; agentId: string; nativeSessionId: string }
  | {
      ok: false
      code: NativeResumeFailureCode
      detail?: string
      /**
       * Present with `runtime-ambiguous`, and with `bound-runtime-unavailable`
       * when another configuration is connected: the ones to choose from.
       */
      choices?: NativeResumeChoice[]
    }

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
  deps: NativeResumeDeps = {},
  options: {
    /** The configuration the user chose after a `runtime-ambiguous` answer. */
    agentId?: string
  } = {}
): Promise<NativeResumeResult> {
  const binding = session.importRuntimeBinding
  const nativeSessionId = binding?.nativeSessionId?.trim()
  if (!binding || !nativeSessionId) return { ok: false, code: "binding-missing" }
  const presetId = binding?.presetId?.trim()
  if (!presetId) return { ok: false, code: "preset-missing" }

  const manager =
    deps.manager ??
    ((
      await import("@/lib/ai/agent/external/manager")
    ).getExternalAgentManager() as NativeResumeManager)
  // Every runtime of the recorded preset's ecosystem reads the same native
  // session store, so all of them are candidates (ADR-0217).
  const presetIds = presetIdsSharingEcosystem(presetId)
  const presetMatches = manager.getAllAgents().filter((instance) => {
    const instancePreset = externalAgentPresetIdOf(instance.config)
    return instancePreset !== undefined && presetIds.includes(instancePreset)
  })
  if (presetMatches.length === 0) {
    return { ok: false, code: "preset-not-configured", detail: presetId }
  }
  // An imported session was read from the runtime's own home (`~/.codex`, …).
  // A configuration with a private state root (ADR-0216) cannot see it there,
  // so offering it would only fail the handshake with a less honest reason.
  const candidates = presetMatches.filter(
    (instance) => instance.config.stateIsolation !== "isolated"
  )
  if (candidates.length === 0) return { ok: false, code: "runtime-isolated", detail: presetId }

  const connectedCandidates = candidates.filter(
    (instance) => instance.connectionStatus === "connected"
  )
  const choicesOf = (instances: ExternalAgentInstance[]): NativeResumeChoice[] =>
    instances.map((instance) => ({ agentId: instance.config.id, name: instance.config.name }))
  if (options.agentId && !connectedCandidates.some((c) => c.config.id === options.agentId)) {
    return { ok: false, code: "runtime-unavailable" }
  }
  // A verified resume recorded its configuration. Return to it; when it still
  // exists but is not connected, say so instead of resuming under whichever
  // other account is connected. A configuration that was deleted (or now
  // keeps its own state) no longer binds anything.
  let chosenId = options.agentId
  const boundId = binding.agentConfigId?.trim()
  if (!chosenId && boundId) {
    const bound = candidates.find((instance) => instance.config.id === boundId)
    if (bound?.connectionStatus === "connected") chosenId = bound.config.id
    else if (bound) {
      return {
        ok: false,
        code: "bound-runtime-unavailable",
        detail: bound.config.name,
        ...(connectedCandidates.length > 0 ? { choices: choicesOf(connectedCandidates) } : {}),
      }
    }
  }
  // A preset identifies a runtime family, not an account or host. Without a
  // durable instance binding choosing the first would resume on an arbitrary
  // one, so the caller is handed the choice instead.
  if (!chosenId && connectedCandidates.length > 1) {
    return {
      ok: false,
      code: "runtime-ambiguous",
      choices: choicesOf(connectedCandidates),
    }
  }
  const connected = chosenId
    ? connectedCandidates.find((c) => c.config.id === chosenId)
    : connectedCandidates[0]
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
      agentConfigId: connected.config.id,
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
