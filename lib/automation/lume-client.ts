/** Client-local Lume Host seam. No SSH credential or upstream URL is exposed. */
import { localTransport } from "@/lib/tauri/transport-instance"
import type { SandboxExecRequest, SandboxExecResult } from "@/lib/sandbox/lifecycle-contract"

export interface LumeRef {
  resourceId: string
  generation: number
  bootEpoch: string
}
export interface LumeBinding extends LumeRef {
  bindingId: string
  sessionId: string
}
export interface LumeResource extends LumeRef {
  connectionId: string
  vmName: string
  state: string
  readiness: { vm: boolean; ssh: boolean; helper: boolean; gui: boolean }
  quarantine: boolean
  memoryMb: number
  lastErrorCode: string | null
  groupId: string | null
  workspaceRevision?: string | null
}
export type LumeProvision =
  | { kind: "create"; ipsw: string; cpu: number; memory_mb: number; disk_gb: number }
  | { kind: "clone"; seed_name: string; seed_storage: string }
  | { kind: "attach"; vm_name: string }
export type LumeFileOperation =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; expected_hash: string | null }
  | { kind: "replace"; path: string; expected_hash: string; old: string; new: string }
  | { kind: "insert"; path: string; expected_hash: string; line: number; text: string }
export interface LumePolicy {
  groupId: string
  workspaceRoot: string
  network: string
  maxCpuSeconds: number
  maxMemoryMb: number
  readable: string[]
  writable: string[]
}
export type LumeOperation =
  | { kind: "importWorkspace"; reference: LumeRef; host_root: string }
  | { kind: "reviewWorkspace"; reference: LumeRef }
  | { kind: "adoptWorkspace"; reference: LumeRef; review_id: string }
  | { kind: "configure"; binary: string; enabled: boolean }
  | { kind: "provision"; connection_id: string; source: LumeProvision }
  | {
      kind: "start" | "setup" | "connect" | "health" | "stop" | "delete" | "prepareSsh"
      reference: LumeRef
    }
  | { kind: "trustSsh"; reference: LumeRef; host_key: string; user: string }
  | { kind: "qualify"; reference: LumeRef; helper_hash: string; driver_version: string }
  | {
      kind: "execute"
      request: {
        binding: LumeBinding
        argv: string[]
        cwd: string
        env: Record<string, string>
        stdin: string | null
        timeoutMs: number
        network: string
        maxCpuSeconds: number
        maxMemoryMb: number
        readable: string[]
        writable: string[]
      }
    }
  | { kind: "file"; binding: LumeBinding; operation: LumeFileOperation; data_base64: string }
export interface LumeOperationStatus<T = unknown> {
  id: string
  state: "running" | "succeeded" | "failed"
  stage: string
  resource: LumeResource | null
  errorCode: string | null
  output: T | null
}
/** Progress is content-free; output stays on the terminal result only. */
export type LumeOperationProgress = Pick<LumeOperationStatus, "id" | "state" | "stage" | "resource">
export type LumeFailureKind =
  | "cancelled"
  | "authorization"
  | "capacity"
  | "version"
  | "identity"
  | "ssh"
  | "guest"
  | "workspace"
  | "writers"
  | "policy"
  | "recovery"
  | "observation"
  | "unknown"

export class LumeClientError extends Error {
  readonly code: string
  constructor(
    code: string,
    readonly operationId?: string
  ) {
    const safe = /^lume_[a-z0-9_]{1,120}$/.test(code) ? code : "lume_operation_failed"
    super(safe)
    this.name = "LumeClientError"
    this.code = safe
  }
}

export function lumeFailureKind(error: unknown): LumeFailureKind {
  const code =
    error instanceof LumeClientError
      ? error.code
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : ""
  if (!/^lume_[a-z0-9_]{1,120}$/.test(code)) return "unknown"
  if (code === "lume_operation_observation_lost") return "observation"
  if (
    /journal|cleanup_unconfirmed|stop_unconfirmed|recovery_required|guest_file_sync|guest_file_publish/.test(
      code
    )
  )
    return "recovery"
  if (/cancelled|preempted|interrupted/.test(code)) return "cancelled"
  if (/authorization|account_locked|account_changed/.test(code)) return "authorization"
  if (/capacity/.test(code)) return "capacity"
  if (/version|contract_unsupported|binary_changed|binary_unconfigured/.test(code)) return "version"
  if (code === "lume_workspace_writers_active") return "writers"
  if (/workspace/.test(code)) return "workspace"
  if (/stale|identity|ownership/.test(code)) return "identity"
  if (/ssh|host_key|guest_ip_missing/.test(code)) return "ssh"
  if (/helper|driver|gui|not_ready/.test(code)) return "guest"
  if (/policy|scope/.test(code)) return "policy"
  return "unknown"
}
export interface LumeDiagnostics {
  contractVersion: number
  lumeVersion: string
  platformSupported: boolean
  enabled: boolean
  resources: LumeResource[]
}

export interface LumeWorkspaceReview {
  reviewId: string
  sha256: string
  hostRoot: string
  patch: {
    base_revision: string
    files: Array<{ path: string; action: "write" | "delete"; content: string | null }>
  }
}

export interface LumeClient {
  diagnose(): Promise<LumeDiagnostics>
  begin<T = unknown>(operation: LumeOperation, requestKey?: string): Promise<LumeOperationStatus<T>>
  poll<T = unknown>(id: string): Promise<LumeOperationStatus<T>>
  cancel(id: string): Promise<void>
  run<T = unknown>(
    operation: LumeOperation,
    signal?: AbortSignal,
    onProgress?: (progress: LumeOperationProgress) => void
  ): Promise<LumeOperationStatus<T>>
  bind(reference: LumeRef, sessionId: string, policy: LumePolicy): Promise<LumeBinding>
  unbind(binding: LumeBinding): Promise<void>
  renew(binding: LumeBinding): Promise<void>
  execute(
    binding: LumeBinding,
    request: SandboxExecRequest,
    signal?: AbortSignal
  ): Promise<SandboxExecResult>
  file(
    binding: LumeBinding,
    operation: LumeFileOperation,
    dataBase64?: string,
    signal?: AbortSignal
  ): Promise<{ result: { hash: string }; dataBase64: string }>
}

export function createLumeClient(
  call: <T>(request: Record<string, unknown>) => Promise<T> = (request) =>
    localTransport.call("lume_sandbox_local_call", { request }),
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 250))
): LumeClient {
  const api: LumeClient = {
    diagnose: async () => {
      const result = await call<LumeDiagnostics>({ kind: "diagnose" })
      if (result.contractVersion !== 1) throw new Error("lume_contract_unsupported")
      return result
    },
    begin: (operation, requestKey = crypto.randomUUID()) =>
      call({ kind: "begin", request_key: requestKey, operation }),
    poll: (operationId) => call({ kind: "poll", operation_id: operationId }),
    cancel: (operationId) => call({ kind: "cancel", operation_id: operationId }),
    run: async <T>(
      operation: LumeOperation,
      signal?: AbortSignal,
      onProgress?: (progress: LumeOperationProgress) => void
    ) => {
      if (signal?.aborted) throw new LumeClientError("lume_operation_cancelled")
      let status = await api.begin<T>(operation)
      const id = status.id
      let cancellationRequested = false
      const cancel = () => {
        if (status.state !== "running" || cancellationRequested) return
        cancellationRequested = true
        void api.cancel(id).catch(() => undefined)
      }
      const report = () => {
        try {
          onProgress?.({
            id: status.id,
            state: status.state,
            stage: status.stage,
            resource: status.resource
              ? { ...status.resource, readiness: { ...status.resource.readiness } }
              : null,
          })
        } catch {
          /* A view observer cannot change or hide a native effect. */
        }
      }
      signal?.addEventListener("abort", cancel, { once: true })
      try {
        report()
        if (signal?.aborted) cancel()
        while (status.state === "running") {
          await pause()
          try {
            const next = await api.poll<T>(id)
            if (next.id !== id || !["running", "succeeded", "failed"].includes(next.state))
              throw new Error("invalid operation receipt")
            status = next
          } catch {
            cancel()
            throw new LumeClientError("lume_operation_observation_lost", id)
          }
          report()
        }
        if (status.state !== "succeeded")
          throw new LumeClientError(status.errorCode ?? "lume_operation_failed", id)
        // A cancellation request cannot undo an acknowledged native effect.
        // Preserve success even when abort raced with the final receipt.
        return status
      } finally {
        signal?.removeEventListener("abort", cancel)
      }
    },
    bind: (reference, sessionId, policy) =>
      call({ kind: "bind", reference, session_id: sessionId, policy }),
    unbind: (binding) => call({ kind: "unbind", binding }),
    renew: (binding) => call({ kind: "renew", binding }),
    execute: async (binding, request, signal) => {
      const policy = request.policy
      if (!policy || policy.network !== "on" || policy.maxCpuSeconds !== 0)
        throw new Error("lume_policy_unsupported")
      const result = await api.run<SandboxExecResult>(
        {
          kind: "execute",
          request: {
            binding,
            argv: request.argv,
            cwd: request.cwd ?? ".",
            env: request.env ?? {},
            stdin: request.stdin ?? null,
            timeoutMs: request.timeoutMs ?? 120_000,
            network: policy.network,
            maxCpuSeconds: policy.maxCpuSeconds,
            maxMemoryMb: policy.maxMemoryMb,
            readable: policy.readable,
            writable: policy.writable,
          },
        },
        signal
      )
      if (!result.output) throw new Error("lume_exec_reply_missing")
      return result.output
    },
    file: async (binding, operation, dataBase64 = "", signal) => {
      const result = await api.run<{ result: { hash: string }; dataBase64: string }>(
        { kind: "file", binding, operation, data_base64: dataBase64 },
        signal
      )
      if (!result.output) throw new Error("lume_file_reply_missing")
      return result.output
    },
  }
  return api
}

export const lumeClient = createLumeClient()
