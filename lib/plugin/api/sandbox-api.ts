import type { CallContext } from "@/lib/automation/client"
import { getMicrovmExec, setMicrovmExec } from "@/lib/sandbox/microvm-bridge"
import { HOST_FALLBACK_RUNTIME_REF, sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type {
  MicrovmExecAdapter,
  MicrovmExecPayload,
  MicrovmResult,
  SandboxRuntimeRef,
} from "@cognia/plugin-sdk/api/sandbox"

export interface PluginSandboxAPI {
  readonly hostFallbackRuntimeRef: SandboxRuntimeRef
  registerMicrovmAdapter(adapter: MicrovmExecAdapter): () => void
  activeRefForSession(sessionId: string | null | undefined): SandboxRuntimeRef | undefined
  decorateComputerUseContext(ref: SandboxRuntimeRef, base: CallContext): Promise<CallContext>
  execute(ref: SandboxRuntimeRef, payload: MicrovmExecPayload): Promise<MicrovmResult>
  clampRequest<T extends MicrovmExecPayload["request"]>(ref: SandboxRuntimeRef, request: T): T
  assertWritablePath(ref: SandboxRuntimeRef, path: string, label?: string): void
}

/**
 * The sandbox capability is process-global: `registerMicrovmAdapter` replaces
 * the single host exec adapter every sandboxed command routes through, and
 * `execute` runs argv on the resolved placement. The contract catalog declares
 * the required permissions but its `sandbox` namespace is `enforcement:
 * "shadow"` (audit-only), so `createGuardedAPI` — not the catalog — is what
 * actually keeps a zero-permission plugin out of them.
 *
 * The four synchronous members are `consentExempt`: they still hard-require
 * their permission, they just skip the async per-call overlay so their
 * signatures stay synchronous (`registerMicrovmAdapter` returns its disposer
 * inline, `clampRequest` returns the clamped request).
 */
export function createSandboxAPI(pluginId: string): PluginSandboxAPI {
  const api: PluginSandboxAPI = {
    hostFallbackRuntimeRef: HOST_FALLBACK_RUNTIME_REF,
    registerMicrovmAdapter: (adapter) => {
      setMicrovmExec(adapter)
      return () => {
        if (getMicrovmExec() === adapter) setMicrovmExec(null)
      }
    },
    activeRefForSession: (sessionId) => sandboxSessionRuntime.activeRefForSession(sessionId),
    decorateComputerUseContext: (ref, base) =>
      sandboxSessionRuntime.decorateComputerUseContext(ref, base),
    execute: (ref, payload) => sandboxSessionRuntime.executeSandbox(ref, payload),
    clampRequest: (ref, request) => sandboxSessionRuntime.clampRequest(ref, request),
    assertWritablePath: (ref, path, label) =>
      sandboxSessionRuntime.assertWritablePath(ref, path, label),
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      registerMicrovmAdapter: "native:process",
      execute: "native:process",
      clampRequest: "native:process",
      assertWritablePath: "native:filesystem",
      activeRefForSession: "session:read",
      decorateComputerUseContext: ["native:input", "session:read"],
    },
    {
      consentExempt: [
        "registerMicrovmAdapter",
        "activeRefForSession",
        "clampRequest",
        "assertWritablePath",
      ],
    }
  )
}
