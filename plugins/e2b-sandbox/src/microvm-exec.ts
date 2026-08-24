/** Owner-scoped E2B microVM adapter for `SandboxSessionRuntime`. */

import type {
  MicrovmExecAdapter,
  MicrovmExecPayload,
  MicrovmResult,
} from "@/lib/sandbox/microvm-bridge"
import { MicrovmAdapterError } from "@/lib/sandbox/microvm-bridge"
import { E2BSandboxPool, type E2BSandboxLease } from "./sandbox-pool"

export interface MicrovmExecOptions {
  pool: E2BSandboxPool
  /** Override `Date.now()` for deterministic timing in tests. */
  now?: () => number
}

/**
 * Execution never provisions a second environment. `preflight` claims an
 * existing E2B workspace handle and every call for that runtime ref reuses it.
 */
export function buildMicrovmExec(opts: MicrovmExecOptions): MicrovmExecAdapter {
  const now = opts.now ?? Date.now
  return {
    async preflight(ownerRef, workspaceRoot, ownerGroup) {
      if (!workspaceRoot) {
        throw new MicrovmAdapterError(
          "workspace-unavailable",
          "E2B microVM execution requires an existing remote workspace handle."
        )
      }
      try {
        opts.pool.claim(ownerRef, workspaceRoot, ownerGroup ?? ownerRef)
      } catch (error) {
        throw new MicrovmAdapterError(
          "workspace-unavailable",
          error instanceof Error ? error.message : String(error),
          { cause: error }
        )
      }
    },

    async execute(ownerRef, payload): Promise<MicrovmResult> {
      const lease = leaseForOwner(opts.pool, ownerRef)
      assertSupportedPolicy(payload, lease.workspacePath, lease.network)
      const started = now()
      try {
        const result = await lease.sandbox.exec({
          cmd: buildBashCommand(payload),
          cwd: payload.command.cwd,
          timeoutMs: payload.command.timeout > 0 ? payload.command.timeout * 1000 : undefined,
        })
        return {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration: Math.max(0, now() - started),
          timed_out: false,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          exit_code: -1,
          stdout: "",
          stderr: message,
          duration: Math.max(0, now() - started),
          timed_out: /timed?[ _-]?out/i.test(message),
        }
      }
    },

    release(ownerRef) {
      return opts.pool.releaseOwner(ownerRef)
    },

    dispose() {
      return opts.pool.dispose()
    },
  }
}

function leaseForOwner(pool: E2BSandboxPool, ownerRef: string): E2BSandboxLease {
  try {
    return pool.forOwner(ownerRef)
  } catch (error) {
    throw new MicrovmAdapterError(
      "runtime-unbound",
      error instanceof Error ? error.message : String(error),
      { cause: error }
    )
  }
}

function assertSupportedPolicy(
  payload: MicrovmExecPayload,
  workspaceRoot: string,
  provisionedNetwork: "off" | "on"
): void {
  const request = payload.request
  if (request.network === "allowlist") {
    throw new MicrovmAdapterError(
      "policy-not-attested",
      "E2B microVM network allowlists are not attested by this adapter."
    )
  }
  if (request.network !== provisionedNetwork) {
    throw new MicrovmAdapterError(
      "policy-not-attested",
      `E2B workspace was provisioned with network=${provisionedNetwork}; requested network=${request.network} cannot be applied after creation.`
    )
  }
  if (request.maxCpuSeconds > 0 || request.maxMemoryMb > 0) {
    throw new MicrovmAdapterError(
      "policy-not-attested",
      "E2B microVM CPU and memory limits are not attested by this adapter."
    )
  }
  if (!isInsideWorkspace(payload.command.cwd, workspaceRoot)) {
    throw new MicrovmAdapterError(
      "workspace-boundary",
      `E2B command cwd is outside the bound remote workspace: ${payload.command.cwd}`
    )
  }
  for (const path of request.targetFiles) {
    if (!isInsideWorkspace(path, workspaceRoot)) {
      throw new MicrovmAdapterError(
        "workspace-boundary",
        `E2B target file is outside the bound remote workspace: ${path}`
      )
    }
  }
}

function isInsideWorkspace(path: string, root: string): boolean {
  const normalizedPath = normalizeAbsolutePosixPath(path)
  const normalizedRoot = normalizeAbsolutePosixPath(root)
  if (!normalizedPath || !normalizedRoot) return false
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function normalizeAbsolutePosixPath(value: string): string | null {
  if (!value.startsWith("/")) return null
  const segments: string[] = []
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join("/")}`
}

function buildBashCommand(payload: MicrovmExecPayload): string {
  const envExports = Object.entries(payload.command.env)
    .map(([key, value]) => `export ${escapeShellName(key)}=${escapeShellArg(value)};`)
    .join(" ")
  const argv = payload.command.argv.map(escapeShellArg).join(" ")
  const command = `${envExports} ${argv}`.trim()
  if (payload.command.stdin == null) return command
  return `printf %s ${escapeShellArg(payload.command.stdin)} | { ${command}; }`
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function escapeShellName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "")
}
