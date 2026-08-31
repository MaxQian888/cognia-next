/**
 * ADR-0028 / T4 — sandboxTier routing bridge.
 *
 * One registered microVM adapter. The `cognia-e2b-sandbox`
 *      plugin calls `setMicrovmExec(impl)` on activate (it owns the
 *      `@e2b/sdk` import) and `setMicrovmExec(null)` on deactivate. When
 *      no implementation is registered AND a session asks for the
 *      microvm tier, the sandboxed-tools plugin treats it as strict-mode
 *      failure — there is no silent fallback to OS tier (matches ADR
 *      §Strict mode).
 */

export {
  MicrovmAdapterError,
  type MicrovmAdapterErrorCode,
  type MicrovmCeiling,
  type MicrovmCommand,
  type MicrovmExecAdapter,
  type MicrovmExecPayload,
  type MicrovmRequest,
  type MicrovmResult,
} from "@cognia/plugin-sdk/api/sandbox"

import type { MicrovmExecAdapter } from "@cognia/plugin-sdk/api/sandbox"

let registeredImpl: MicrovmExecAdapter | null = null
const drainingImpls = new Set<MicrovmExecAdapter>()
const availabilityListeners = new Set<() => void>()

/** Register the microvm exec adapter (called by the e2b plugin on activate). */
export function setMicrovmExec(impl: MicrovmExecAdapter | null): void {
  if (registeredImpl && registeredImpl !== impl) drainingImpls.add(registeredImpl)
  registeredImpl = impl
  for (const listener of availabilityListeners) listener()
}

export function subscribeMicrovmAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener)
  return () => availabilityListeners.delete(listener)
}

/** Force-clean active and draining adapters at the application exit boundary. */
export async function disposeMicrovmAdapters(): Promise<void> {
  const active = registeredImpl
  registeredImpl = null
  if (active) drainingImpls.add(active)
  for (const listener of availabilityListeners) listener()
  const adapters = [...drainingImpls]
  const settled = await Promise.allSettled(
    adapters.map((adapter) => Promise.resolve(adapter.dispose?.()))
  )
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") drainingImpls.delete(adapters[index])
  })
}

/** Read the currently-registered microvm exec adapter, or null. */
export function getMicrovmExec(): MicrovmExecAdapter | null {
  return registeredImpl
}

/** Test-only — wipe the adapter registry. Never called in production. */
export function __resetMicrovmBridgeForTesting(): void {
  registeredImpl = null
  drainingImpls.clear()
  availabilityListeners.clear()
}
