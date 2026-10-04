import { transport } from "@/lib/tauri"
import type { Point, Screenshot, UiAction } from "@/lib/automation/types"

export interface SandboxControlLease {
  token: string
  expiresAt: number
}

/** Dedicated binary transfer budget; ordinary command output keeps its own limit. */
export const MAX_SANDBOX_TRANSFER_BYTES = 8 * 1024 * 1024

export interface SandboxFileInfo {
  path: string
  size: number
  sha256: string
}

export interface SandboxFileDownload extends SandboxFileInfo {
  dataBase64: string
}

/**
 * Thin wrappers over the `cua_sandbox_*` Tauri commands (ADR-0020
 * remote-target). Lifecycle, workspace execution and local desktop viewing. Agent GUI actions
 * ride the existing `desktop.*` client with a `sandboxConnectionId` in their
 * `CallContext`.
 *
 * Every command here is `target: "client"` with `transports: ["internal"]`, so
 * none of them follows an active remote host: a sandbox container always
 * belongs to the machine running this renderer.
 */

/**
 * Container-level isolation, frozen in when the container is created.
 *
 * Docker fixes all of this at create time. `docker exec` cannot change a
 * running container's network mode or its cpu/memory ceiling, which is why the
 * values are recorded on the connection row and every later per-call policy
 * request is attested against them rather than assumed to hold.
 */
export interface SandboxPolicyInput {
  networkMode?: string
  cpus?: string
  memoryMb?: number
  /** Both halves are required together, or no mount is applied. */
  workspaceHostPath?: string
  workspaceContainerPath?: string
}

export interface SandboxPlacement {
  containerId: string
  /** Zero while the container is not running: Docker publishes no port then. */
  port: number
}

export interface SandboxContainerState {
  containerId: string
  /** Docker's `.State.Status`: created, running, paused, exited, and so on. */
  status: string
  running: boolean
  paused: boolean
  networkMode: string
  /** Zero means the cpu allowance is uncapped. */
  nanoCpus: number
  /** Bytes. Zero means memory is uncapped. */
  memoryBytes: number
}

export interface SandboxExecInput {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export interface SandboxExecOutcome {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  /**
   * The supervisor reached the deadline and confirmed descendant cleanup.
   * Missing cleanup confirmation rejects the call instead of returning an outcome.
   */
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export const sandboxClient = {
  /** Publish a new guest file without overwriting an existing destination. */
  uploadFile(
    connectionId: string,
    expectedContainerId: string,
    token: string,
    path: string,
    dataBase64: string
  ): Promise<SandboxFileInfo> {
    return transport.call<SandboxFileInfo>("cua_sandbox_upload_file", {
      connectionId,
      expectedContainerId,
      token,
      path,
      dataBase64,
    })
  },
  /** Read binary contents only from the specific container selected by the user. */
  downloadFile(
    connectionId: string,
    expectedContainerId: string,
    path: string
  ): Promise<SandboxFileDownload> {
    return transport.call<SandboxFileDownload>("cua_sandbox_download_file", {
      connectionId,
      expectedContainerId,
      path,
    })
  },
  desktopFrame(connectionId: string): Promise<Screenshot> {
    return transport.call<Screenshot>("cua_sandbox_desktop_capture", { connectionId })
  },
  acquireControl(connectionId: string): Promise<SandboxControlLease> {
    return transport.call<SandboxControlLease>("cua_sandbox_desktop_acquire_control", {
      connectionId,
    })
  },
  renewControl(connectionId: string, token: string): Promise<SandboxControlLease> {
    return transport.call<SandboxControlLease>("cua_sandbox_desktop_renew_control", {
      connectionId,
      token,
    })
  },
  releaseControl(connectionId: string, token: string): Promise<void> {
    return transport.call<void>("cua_sandbox_desktop_release_control", { connectionId, token })
  },
  controlInput(
    connectionId: string,
    token: string,
    point: Point | null,
    action: UiAction
  ): Promise<void> {
    return transport.call<void>("cua_sandbox_desktop_input", { connectionId, token, point, action })
  },
  /** Provision the container without starting it. */
  create(
    connectionId: string,
    image: string,
    policy?: SandboxPolicyInput
  ): Promise<SandboxPlacement> {
    return transport.call<SandboxPlacement>("cua_sandbox_create", {
      connectionId,
      image,
      policy,
    })
  },
  /**
   * Bring the container to running. Adopts an existing container of the same
   * deterministic name rather than creating a second machine.
   */
  start(
    connectionId: string,
    image: string,
    policy?: SandboxPolicyInput
  ): Promise<SandboxPlacement> {
    return transport.call<SandboxPlacement>("cua_sandbox_start", {
      connectionId,
      image,
      policy,
    })
  },
  /** `docker pause`. Memory stays resident, so the desktop session survives. */
  suspend(connectionId: string): Promise<void> {
    return transport.call<void>("cua_sandbox_suspend", { connectionId })
  },
  resume(connectionId: string): Promise<SandboxPlacement> {
    return transport.call<SandboxPlacement>("cua_sandbox_resume", { connectionId })
  },
  /** Stop the container. It keeps existing, along with its filesystem. */
  stop(connectionId: string): Promise<void> {
    return transport.call<void>("cua_sandbox_stop", { connectionId })
  },
  /** Destroy the container and everything in it not on a bind mount. */
  delete(connectionId: string): Promise<void> {
    return transport.call<void>("cua_sandbox_delete", { connectionId })
  },
  /** Docker's own view of the container, or null when it does not exist. */
  inspect(connectionId: string): Promise<SandboxContainerState | null> {
    return transport.call<SandboxContainerState | null>("cua_sandbox_inspect", { connectionId })
  },
  /** Whether supervised execution and desktop capture both answer. */
  health(connectionId: string): Promise<boolean> {
    return transport.call<boolean>("cua_sandbox_health", { connectionId })
  },
  /** Run one command inside the machine. `argv` is never joined into a shell string. */
  exec(connectionId: string, input: SandboxExecInput): Promise<SandboxExecOutcome> {
    return transport.call<SandboxExecOutcome>("cua_sandbox_exec", {
      connectionId,
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
    })
  },
  /** Read one file from inside the machine. */
  readFile(connectionId: string, path: string, maxBytes?: number): Promise<string> {
    return transport.call<string>("cua_sandbox_read_file", { connectionId, path, maxBytes })
  },
}

export type SandboxClient = typeof sandboxClient
