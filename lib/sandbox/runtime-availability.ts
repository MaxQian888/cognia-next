import type { CodeSandboxStatus } from "@/lib/ai/code-mode/sandbox-status"
import { getMicrovmExec, subscribeMicrovmAvailability } from "@/lib/sandbox/microvm-bridge"
import type { SandboxCapabilities, SandboxConnectionRow } from "@/types/sandbox"
import { hasSandboxConnectionLifecycleAdapter } from "./connection-lifecycle"

export type SandboxAvailabilityReason =
  "available" | "probe-required" | "probe-failed" | "adapter-missing" | "workspace-required"

export interface SandboxRuntimeAvailability {
  os: {
    available: boolean
    backend: string
    reason: SandboxAvailabilityReason
    detail: string
  }
  microvm: {
    available: boolean
    reason: SandboxAvailabilityReason
    requiresWorkspace: true
  }
}

const EMPTY_STATUS: CodeSandboxStatus = { confined: false, backend: "", detail: "" }
let osStatus = EMPTY_STATUS
const listeners = new Set<() => void>()
let cachedKey = ""
let cachedSnapshot: SandboxRuntimeAvailability

export function projectSandboxRuntimeAvailability(
  status: CodeSandboxStatus,
  microvmAdapterAvailable: boolean
): SandboxRuntimeAvailability {
  return Object.freeze({
    os: Object.freeze({
      available: status.confined,
      backend: status.backend,
      reason: status.confined ? "available" : status.detail ? "probe-failed" : "probe-required",
      detail: status.detail,
    }),
    microvm: Object.freeze({
      available: microvmAdapterAvailable,
      reason: microvmAdapterAvailable ? "workspace-required" : "adapter-missing",
      requiresWorkspace: true as const,
    }),
  })
}

/**
 * Read-time capability projection for connection consumers. Stored rows may
 * retain compatibility claims, but actions are enabled only while the real
 * adapter and its client-local Tauri host are both present.
 */
export function projectSandboxConnectionCapabilities(
  row: SandboxConnectionRow,
  lifecycleHostAvailable: boolean
): SandboxCapabilities {
  const adapterAvailable = lifecycleHostAvailable && hasSandboxConnectionLifecycleAdapter(row)
  return Object.freeze(
    Object.fromEntries(
      Object.entries(row.capabilities).map(([operation, enabled]) => [
        operation,
        adapterAvailable && enabled,
      ])
    )
  ) as SandboxCapabilities
}

export function updateOsSandboxAvailability(status: CodeSandboxStatus): void {
  osStatus = status
  cachedKey = ""
  for (const listener of listeners) listener()
}

export function getSandboxRuntimeAvailability(): SandboxRuntimeAvailability {
  const microvmAvailable = getMicrovmExec() !== null
  const key = `${osStatus.confined}:${osStatus.backend}:${osStatus.detail}:${microvmAvailable}`
  if (key !== cachedKey) {
    cachedKey = key
    cachedSnapshot = projectSandboxRuntimeAvailability(osStatus, microvmAvailable)
  }
  return cachedSnapshot
}

export function subscribeSandboxRuntimeAvailability(listener: () => void): () => void {
  listeners.add(listener)
  const unsubscribeMicrovm = subscribeMicrovmAvailability(() => {
    cachedKey = ""
    listener()
  })
  return () => {
    listeners.delete(listener)
    unsubscribeMicrovm()
  }
}

export function __resetSandboxRuntimeAvailabilityForTesting(): void {
  osStatus = EMPTY_STATUS
  cachedKey = ""
  listeners.clear()
}
