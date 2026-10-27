/**
 * The plugin contract's share of `lib/plugin/api/sandbox-api.ts`, which re-exports these.
 */
import type { CallContext } from "../../automation/client"
import type {
  MicrovmExecAdapter,
  MicrovmExecPayload,
  MicrovmResult,
  SandboxRuntimeRef,
} from "@cognia/plugin-sdk/api/sandbox"

export interface PluginSandboxAPI {
  /** A typed file path may return undefined when the bound tier uses exec IO. */
  fileOperation?(
    ref: SandboxRuntimeRef,
    request: SandboxFileRequest,
    options?: { signal?: AbortSignal }
  ): Promise<SandboxFileResult | undefined>
  readonly hostFallbackRuntimeRef: SandboxRuntimeRef
  registerMicrovmAdapter(adapter: MicrovmExecAdapter): () => void
  activeRefForSession(sessionId: string | null | undefined): SandboxRuntimeRef | undefined
  decorateComputerUseContext(ref: SandboxRuntimeRef, base: CallContext): Promise<CallContext>
  execute(
    ref: SandboxRuntimeRef,
    payload: MicrovmExecPayload,
    options?: { signal?: AbortSignal }
  ): Promise<MicrovmResult>
  clampRequest<T extends MicrovmExecPayload["request"]>(ref: SandboxRuntimeRef, request: T): T
  assertWritablePath(ref: SandboxRuntimeRef, path: string, label?: string): void
}

export type SandboxFileRequest =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string; expectedHash?: string }
export interface SandboxFileResult {
  content?: string
  hash: string
}
