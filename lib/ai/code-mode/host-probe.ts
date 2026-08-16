/**
 * What the renderer can observe about the Code sandbox (ADR-0117, Phase 4).
 *
 * The renderer cannot inspect the sandbox itself — the sandbox is a child of
 * the sidecar, and only the sidecar's `probeSandbox()` knows whether the OS
 * confinement was actually established. This module reports what the renderer
 * *does* know, and is explicit about the rest.
 *
 * `strictSandbox` therefore defaults to **false** and is only ever raised by an
 * explicit `strictSandboxReported: true` from the caller — in production, from
 * `useCodeSandboxPresentations`, which reads the ADR-0028 active confinement
 * probe (`lib/ai/code-mode/sandbox-status.ts`). Assuming a desktop host implies
 * a strict sandbox would offer Code where confinement silently failed, which is
 * the one outcome the ADR forbids.
 */

import { canUseTauriInvoke } from "@/lib/native/utils"
import { supportedToolPresentations } from "./availability"
import type { CodeSandboxProbe } from "./availability"
import type { ToolPresentationMode } from "@cognia/agent-config-types/agent-composition"

export interface HostProbeInput {
  /**
   * The sidecar's answer to "did the strict sandbox come up?".
   *
   * Injected rather than inferred. Absent means "not reported", which is
   * treated as `false` — an unanswered probe is not a passing one.
   */
  strictSandboxReported?: boolean
  /** Injected in tests; defaults to the real host capability check. */
  hasHostProcess?: boolean
}

export function probeCodeSandboxHost(input: HostProbeInput = {}): CodeSandboxProbe {
  return {
    canSpawnProcess: input.hasHostProcess ?? canUseTauriInvoke(),
    strictSandbox: input.strictSandboxReported === true,
  }
}

/**
 * The presentations to offer in the mode picker on this host.
 *
 * A thin composition of `probeCodeSandboxHost` and `supportedToolPresentations`
 * so UI call sites have one function to call and cannot accidentally skip the
 * probe and hand the resolver an optimistic list.
 */
export function hostToolPresentations(input: HostProbeInput = {}): ToolPresentationMode[] {
  return supportedToolPresentations({ probe: probeCodeSandboxHost(input) })
}
