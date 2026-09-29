/** Owner-scoped E2B microVM adapter for `SandboxSessionRuntime`. */

import type {
  MicrovmConfinement,
  MicrovmExecAdapter,
  MicrovmExecPayload,
  MicrovmFileRead,
  MicrovmResult,
  MicrovmWorkspaceAcceptance,
} from "@cognia/plugin-sdk/api/sandbox"
import { MicrovmAdapterError } from "@cognia/plugin-sdk/api/sandbox"
import { E2BSandboxPool, type E2BSandboxLease } from "./sandbox-pool"

const MAX_OUTPUT_BYTES = 1_000_000
const TRUNCATION_MARKER = "\n... (truncated)"

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

    accepts(ownerRef, workspaceRoot, requirements): MicrovmWorkspaceAcceptance {
      // Exactly the question `preflight` answers, asked without claiming: the
      // pool refuses an ordinary local directory because it only knows the
      // handle paths a remote clone minted.
      const refusal = workspaceRoot
        ? opts.pool.claimRefusal(ownerRef, workspaceRoot, requirements?.ownerGroup ?? ownerRef)
        : "E2B microVM execution requires an existing remote workspace handle."
      if (refusal) {
        return { accepted: false, code: "workspace-unavailable", reason: refusal }
      }
      // Egress is fixed when the instance is created. A workspace cloned with
      // network on cannot be made network-off for one call, so a caller that
      // needs "no network" enforced cannot use it.
      const network = opts.pool.networkOf(workspaceRoot)
      if (requirements?.network === "off" && network !== "off") {
        return {
          accepted: false,
          code: "policy-not-attested",
          reason: `E2B workspace ${workspaceRoot} was provisioned with network=${network ?? "unknown"}; network=off cannot be enforced after creation.`,
        }
      }
      return { accepted: true }
    },

    async readFile(ownerRef, path, maxBytes): Promise<MicrovmFileRead> {
      const lease = leaseForOwner(opts.pool, ownerRef)
      // Lexical first, so a `..` never reaches the machine; the realpath check
      // inside the machine then refuses a symlink that leads out.
      if (!isInsideWorkspace(path, lease.workspacePath)) {
        return {
          kind: "refused",
          code: "workspace-boundary",
          message: `E2B file read is outside the bound remote workspace: ${path}`,
        }
      }
      const cap = Math.max(0, Math.floor(maxBytes))
      let result: { stdout: string; stderr: string; exitCode: number }
      try {
        result = await lease.sandbox.exec({
          cmd: buildReadFileCommand(lease.workspacePath, path, cap),
        })
      } catch (error) {
        return {
          kind: "refused",
          code: "READ_FAILED",
          message: error instanceof Error ? error.message : String(error),
        }
      }
      switch (result.exitCode) {
        case 0:
          return { kind: "ok", content: result.stdout }
        case READ_EXIT.missing:
          return { kind: "missing" }
        case READ_EXIT.tooLarge:
          return { kind: "too_large" }
        case READ_EXIT.escape:
          return {
            kind: "refused",
            code: "workspace-boundary",
            message: `E2B file read resolves outside the bound remote workspace: ${path}`,
          }
        case READ_EXIT.notFile:
          return { kind: "refused", code: "NOT_A_FILE", message: `${path} is not a regular file` }
        default:
          return {
            kind: "refused",
            code: "READ_FAILED",
            message: result.stderr || `exit ${result.exitCode}`,
          }
      }
    },

    async execute(ownerRef, payload): Promise<MicrovmResult> {
      const lease = leaseForOwner(opts.pool, ownerRef)
      assertSupportedPolicy(payload, lease.workspacePath, lease.network)
      const started = now()
      const confinement = attestedConfinement(lease.network)
      try {
        const result = await lease.sandbox.exec({
          cmd: buildBashCommand(payload),
          cwd: payload.command.cwd,
          timeoutMs: payload.command.timeout > 0 ? payload.command.timeout * 1000 : undefined,
        })
        const stdout = truncateUtf8(result.stdout, MAX_OUTPUT_BYTES)
        const stderr = truncateUtf8(result.stderr, MAX_OUTPUT_BYTES)
        return {
          exit_code: result.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          duration: Math.max(0, now() - started),
          timed_out: false,
          stdout_truncated: stdout.truncated,
          stderr_truncated: stderr.truncated,
          confinement,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const stderr = truncateUtf8(message, MAX_OUTPUT_BYTES)
        return {
          exit_code: -1,
          stdout: "",
          stderr: stderr.text,
          duration: Math.max(0, now() - started),
          timed_out: /timed?[ _-]?out/i.test(message),
          stdout_truncated: false,
          stderr_truncated: stderr.truncated,
          confinement,
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

/**
 * What this adapter can honestly attest. Egress is decided by E2B when the
 * instance is created (`allowInternetAccess`), so an instance created without
 * it really has no network for every call. CPU, memory and process ceilings
 * are not enforced per call here, so they are attested as absent.
 */
function attestedConfinement(network: "off" | "on"): MicrovmConfinement {
  return {
    networkEnforced: network === "off",
    backend: "e2b",
    maxMemoryMb: null,
    maxCpuSeconds: null,
    maxProcesses: null,
    platform: "linux",
  }
}

/** Exit codes the read command uses for its non-content answers. */
const READ_EXIT = { missing: 64, tooLarge: 65, escape: 66, notFile: 67 } as const

/**
 * One command that resolves the path inside the machine, refuses anything
 * that leaves the workspace or is not a regular file, refuses (rather than
 * cuts) a file past the cap, and only then prints it.
 */
function buildReadFileCommand(workspaceRoot: string, path: string, maxBytes: number): string {
  return [
    // Plain `realpath` after an existence check, not `realpath -e`: the flag
    // is GNU-only, and a template on BusyBox must not turn every read into a
    // refusal.
    `[ -d ${escapeShellArg(workspaceRoot)} ] || exit ${READ_EXIT.escape}`,
    `root=$(realpath -- ${escapeShellArg(workspaceRoot)}) || exit ${READ_EXIT.escape}`,
    `[ -e ${escapeShellArg(path)} ] || exit ${READ_EXIT.missing}`,
    `f=$(realpath -- ${escapeShellArg(path)}) || exit ${READ_EXIT.missing}`,
    `case "$f" in "$root"/*) ;; *) exit ${READ_EXIT.escape} ;; esac`,
    `[ -f "$f" ] || exit ${READ_EXIT.notFile}`,
    `n=$(wc -c < "$f") || exit 1`,
    `[ "$n" -le ${maxBytes} ] || exit ${READ_EXIT.tooLarge}`,
    `cat -- "$f"`,
  ].join("; ")
}

function truncateUtf8(text: string, cap: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= cap) return { text, truncated: false }
  const marker = encoder.encode(TRUNCATION_MARKER)
  const contentCap = Math.max(0, cap - marker.length)
  let end = contentCap
  // `end` is an exclusive byte index. If it lands inside a multibyte code
  // point, back up through continuation bytes and exclude that code point's
  // leading byte too. Decoding a raw slice with replacement can grow the
  // result by up to two bytes and violates both UTF-8 fidelity and the cap.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  const decoder = new TextDecoder("utf-8", { fatal: false })
  return {
    text: decoder.decode(bytes.slice(0, end)) + TRUNCATION_MARKER,
    truncated: true,
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
