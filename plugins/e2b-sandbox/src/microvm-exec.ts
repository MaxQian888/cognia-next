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
        // The pool is keyed on the handle path a remote clone minted, so an
        // ordinary local working directory misses and reports itself as a
        // missing path. State the requirement instead: this tier isolates INTO
        // an existing E2B workspace, it does not provision one per session.
        throw new MicrovmAdapterError(
          "workspace-unavailable",
          `The microVM tier runs inside an existing E2B workspace and cannot provision one for "${workspaceRoot}". ` +
            "Use it from a session whose working directory is an E2B workspace handle, or choose the OS sandbox tier. " +
            `(${error instanceof Error ? error.message : String(error)})`,
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
  const ceiling = payload.ceiling ?? {}
  if (request.network === "allowlist" || ceiling.network === "allowlist") {
    throw new MicrovmAdapterError(
      "policy-not-attested",
      "E2B microVM network allowlists are not attested by this adapter."
    )
  }
  // Network is fixed at instance creation, so it can only be refused in the
  // direction the adapter cannot deliver:
  //   - the operator capped egress but the instance has it  → cannot attest;
  //   - the instance has no egress but the call needs it    → cannot enable.
  // A call that merely needs LESS than the instance offers is satisfied — the
  // file helpers and the default bash request always ask for `network: "off"`,
  // so refusing that direction made every file-tool call on this tier fail.
  if (ceiling.network === "off" && provisionedNetwork !== "off") {
    throw new MicrovmAdapterError(
      "policy-not-attested",
      `E2B workspace was provisioned with network=${provisionedNetwork}; the configured network=off ceiling cannot be applied after creation.`
    )
  }
  if (provisionedNetwork === "off" && request.network !== "off") {
    throw new MicrovmAdapterError(
      "policy-not-attested",
      `E2B workspace was provisioned with network=off; requested network=${request.network} cannot be enabled after creation.`
    )
  }
  // Same split for the resource caps: only a ceiling the operator configured
  // is a guarantee this adapter would be silently dropping. A clamped default
  // carries no such promise.
  if ((ceiling.maxCpuSeconds ?? 0) > 0 || (ceiling.maxMemoryMb ?? 0) > 0) {
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
    .filter(([key]) => isShellName(key))
    .map(([key, value]) => `export ${key}=${escapeShellArg(value)};`)
    .join(" ")
  const argv = payload.command.argv.map(escapeShellArg).join(" ")
  const command = `${envExports} ${argv}`.trim()
  if (payload.command.stdin == null) return command
  return `printf %s ${escapeShellArg(payload.command.stdin)} | { ${command}; }`
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * A shell identifier, exactly. Rewriting an invalid name by stripping its bad
 * characters was worse than dropping it: `1TOKEN` survives the strip unchanged
 * and `export 1TOKEN=…` is a bash syntax error that aborts the WHOLE line, so
 * one malformed env entry took the model's actual command down with it — and a
 * name made only of stripped characters produced `export =…`, the same fatal
 * error. An entry bash cannot accept is skipped, not smuggled in mangled.
 */
function isShellName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}
