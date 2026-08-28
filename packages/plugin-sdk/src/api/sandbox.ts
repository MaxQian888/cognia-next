/**
 * Plugin SDK — `sandbox` capability surface.
 *
 * Two halves of the same story:
 *
 *  - `setMicrovmExec()` is the seam a sandbox PROVIDER plugin fills. The host
 *    routes confined command execution through whatever adapter is installed;
 *    a plugin that can run commands in a microVM (E2B, Firecracker, a remote
 *    runner) registers itself here and every sandboxed tool call in the app
 *    goes through it. Exactly one adapter is live at a time — `null` clears it,
 *    which is what a plugin must do on deactivate.
 *
 *  - `sandboxSessionRuntime` is the seam a sandbox CONSUMER plugin reads. It
 *    answers "is this session confined, and to what runtime?" so a tool can
 *    refuse, or downgrade, rather than quietly executing on the host. A tool
 *    that skips this check is a tool that escapes the sandbox the user asked
 *    for, which is why the runtime is exposed rather than left implicit.
 *
 * `HOST_FALLBACK_RUNTIME_REF` is the sentinel for "no sandbox installed —
 * running on the host": distinguishable from an unknown runtime, so a caller
 * can tell "unconfined by configuration" from "confined to something I cannot
 * reach".
 */

export { getMicrovmExec, MicrovmAdapterError, setMicrovmExec } from "@/lib/sandbox/microvm-bridge"

export type {
  MicrovmAdapterErrorCode,
  MicrovmCeiling,
  MicrovmCommand,
  MicrovmExecAdapter,
  MicrovmExecPayload,
  MicrovmRequest,
  MicrovmResult,
} from "@/lib/sandbox/microvm-bridge"

export {
  HOST_FALLBACK_RUNTIME_REF,
  SandboxRuntimeError,
  sandboxSessionRuntime,
  SandboxSessionRuntime,
} from "@/lib/sandbox/session-runtime"

export type {
  BindSandboxSessionInput,
  SandboxConfine,
  SandboxRuntimeErrorCode,
  SandboxRuntimeRef,
} from "@/lib/sandbox/session-runtime"

/** The checkout contract a workspace backend hands back. */
export type { E2BBackend, WorkspaceHandle } from "@/lib/github/workspace"

/**
 * The CPU / memory / wall-clock ceiling an agent run declares. A microVM
 * adapter must honour it — the host applies no ceiling of its own once
 * execution is delegated.
 */
export type { SandboxResourcePolicy } from "@cognia/agent-config-types"
