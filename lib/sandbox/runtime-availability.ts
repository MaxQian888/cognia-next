import type { CodeSandboxStatus } from "@/lib/ai/code-mode/sandbox-status"
import { getContainerExec } from "@/lib/sandbox/container-exec-adapter"
import { getMicrovmExec, subscribeMicrovmAvailability } from "@/lib/sandbox/microvm-bridge"
import type { SandboxCapabilities, SandboxConnectionRow } from "@/types/sandbox"
import { hasSandboxConnectionLifecycleAdapter } from "./connection-lifecycle"

export type SandboxAvailabilityReason =
  | "available"
  | "probe-required"
  | "probe-failed"
  | "adapter-missing"
  | "workspace-required"
  /** The `container` tier runs only on an always-on Host (ADR-0224 A8). */
  | "always-on-host-only"

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
  /** The project's runtime environment on this Host's sandbox pool. */
  container: {
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
  microvmAdapterAvailable: boolean,
  containerAdapterAvailable = false
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
    container: Object.freeze({
      available: containerAdapterAvailable,
      reason: containerAdapterAvailable ? "workspace-required" : "always-on-host-only",
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
        adapterAvailable &&
          enabled &&
          !(
            row.config.provider === "e2b" &&
            operation === "create" &&
            row.config.qualification !== "qualified"
          ),
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
  const containerAvailable = getContainerExec() !== null
  const key = `${osStatus.confined}:${osStatus.backend}:${osStatus.detail}:${microvmAvailable}:${containerAvailable}`
  if (key !== cachedKey) {
    cachedKey = key
    cachedSnapshot = projectSandboxRuntimeAvailability(
      osStatus,
      microvmAvailable,
      containerAvailable
    )
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
