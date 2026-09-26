// Shared child-process exec primitives for built-in tools.
//
// Single home for the `promisify(execFile)` wrapper that was previously
// copy-pasted into git.mjs, process.mjs, and shell-advanced.mjs. Callers that
// need the raw rejection shape (stdout/stderr/code/signal attached on non-zero
// exit) import `execFileAsync` directly; callers that just want the
// stringified output of a successful run use `runCapped`.

import { execFile, spawn } from "node:child_process"
import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
  SpawnOptions,
} from "node:child_process"
import type { NonSharedBuffer } from "node:buffer"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AsyncLocalStorage } from "node:async_hooks"
import { ENV_ALLOWLIST, isStrippedName } from "./env.ts"

/**
 * The OS sandbox a session's native tool processes run in. `undefined` means
 * unsandboxed; a scope with `unavailableReason` means sandboxing was required
 * but cannot run, so every tool process refuses to start.
 */
export interface ProcessSandboxScope {
  launcher?: string
  writableRoots?: readonly string[]
  readableRoots?: readonly string[]
  network?: boolean
  unavailableReason?: string
}

type Env = Record<string, string | undefined>

const PROCESS_ENV_KEYS: ReadonlySet<string> = new Set([
  ...ENV_ALLOWLIST,
  "PWD",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "PNPM_HOME",
  "NVM_BIN",
  "NVM_DIR",
  "BUN_INSTALL",
  "GIT_TERMINAL_PROMPT",
  "GIT_PAGER",
  "PAGER",
  "EDITOR",
  "VISUAL",
])
const INJECTED_ENV =
  /^(?:LD_|DYLD_|NODE_OPTIONS$|GCONV_PATH$|GIT_CONFIG_|HOSTALIASES$|NLSPATH$|RESOLV_HOST_CONF$|PSMODULEPATH$|PSEXECUTIONPOLICYPREFERENCE$)/i

/** Native tools need runtime paths, not provider credentials or dynamic-loader
 * injection. Filter overrides before the launcher itself starts executing. */
export function sandboxedProcessEnv(
  parentEnv: Env,
  scope: ProcessSandboxScope | undefined,
  overrides: Env = {}
): Record<string, string | undefined> {
  if (scope === undefined) return { ...parentEnv, ...overrides }
  const base: Record<string, string> = Object.fromEntries(
    Object.entries(parentEnv).filter(
      (entry): entry is [string, string] =>
        PROCESS_ENV_KEYS.has(entry[0]) && typeof entry[1] === "string"
    )
  )
  for (const [key, value] of Object.entries(overrides)) {
    if (!INJECTED_ENV.test(key) && !isStrippedName(key) && typeof value === "string")
      base[key] = value
  }
  return Object.fromEntries(
    Object.entries(base).filter(([key]) => !INJECTED_ENV.test(key) && !isStrippedName(key))
  )
}

/** A child `cwd` as a path (Node accepts `file:` URLs there too). */
function cwdPath(cwd: string | URL | undefined): string | undefined {
  return cwd instanceof URL ? fileURLToPath(cwd) : cwd
}

interface ProcessScope {
  scope: ProcessSandboxScope | undefined
  cwd: string | undefined
}

const processScopes = new AsyncLocalStorage<ProcessScope>()

/** Each tool invocation keeps its session policy across asynchronous Git and
 * other shared-exec calls; concurrent sessions cannot overwrite this scope. */
export function withProcessSandbox<T>(
  scope: ProcessSandboxScope | undefined,
  cwd: string | undefined,
  run: () => T
): T {
  return processScopes.run({ scope, cwd }, run)
}

/** Raw streaming children (rg/AST) share the current tool's async scope. */
export function spawnInProcessSandbox(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {}
): ChildProcess {
  const context = processScopes.getStore()
  const target = sandboxedProcessTarget(
    command,
    args,
    cwdPath(options.cwd) ?? context?.cwd,
    context?.scope
  )
  return spawn(target.command, target.args, {
    ...options,
    ...(context?.scope
      ? { env: sandboxedProcessEnv(options.env ?? process.env, context.scope) }
      : {}),
  })
}

/** Preserve argv and process lifetime while placing native coding tools in the
 * existing OS sandbox. The launcher makes cwd writable, so verify its real
 * path against the host-provided roots before passing it across that boundary. */
export function sandboxedProcessTarget(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  scope: ProcessSandboxScope | undefined
): { command: string; args: string[] } {
  if (scope === undefined) return { command, args: [...args] }
  if (scope?.unavailableReason) throw new Error(scope.unavailableReason)
  if (!scope?.launcher || !path.isAbsolute(scope.launcher)) {
    throw new Error(
      "Sandbox launcher is unavailable. Reinstall cognia-agent or configure COGNIA_EXTERNAL_AGENT_LAUNCHER."
    )
  }
  try {
    fs.accessSync(scope.launcher, fs.constants.X_OK)
  } catch {
    throw new Error("Sandbox launcher is unavailable or not executable. Reinstall cognia-agent.")
  }
  const workdir = fs.realpathSync(cwd ?? process.cwd())
  const writable = (scope.writableRoots ?? []).map((root) => fs.realpathSync(root))
  if (
    !writable.some((root) => {
      const relative = path.relative(root, workdir)
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      )
    })
  )
    throw new Error("Process cwd is outside the authorized writable roots")
  return {
    command: scope.launcher,
    args: [
      "--cwd",
      workdir,
      ...writable.flatMap((root) => ["--writable", root]),
      ...(scope.readableRoots ?? []).flatMap((root) => ["--readable", root]),
      ...(scope.network === true ? ["--network"] : []),
      "--",
      command,
      ...args,
    ],
  }
}

/** `execFile` options plus an explicit stdio (normally piped on every fd). */
export type ExecOptions = ExecFileOptions & { stdio?: SpawnOptions["stdio"] }

/** Captured child output: a string, or a Buffer under `encoding: "buffer"`. */
export type ExecOutput = string | NonSharedBuffer

type ExecCallback = (
  error: ExecFileException | null,
  stdout: ExecOutput,
  stderr: ExecOutput
) => void

/**
 * Keep every standard stream connected when a tool child is launched.
 *
 * Git calls `sanitize_stdfds()` at startup and opens `/dev/null` when one of
 * fd 0/1/2 is missing. External ACP/MCP hosts can launch the bridge with a
 * closed descriptor, and a sandboxed macOS process may not be allowed to open
 * `/dev/null`. Explicit pipes prevent that fallback while preserving the
 * stdout/stderr capture contract used by every caller.
 */
function execFileWithPipedStdio(
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: ExecCallback
): ChildProcess {
  const context = processScopes.getStore()
  let command = file
  let argv = [...args]
  // Explicit process tools already rendered their launcher argv. Generic Git
  // and utility executors reach this seam with their original binary/argv.
  if (context?.scope && file !== context.scope.launcher) {
    const target = sandboxedProcessTarget(
      file,
      args,
      cwdPath(options.cwd) ?? context.cwd,
      context.scope
    )
    command = target.command
    argv = target.args
  }
  return execFile(
    command,
    argv,
    {
      ...options,
      ...(context?.scope
        ? { env: sandboxedProcessEnv(options.env ?? process.env, context.scope) }
        : {}),
      // Node forwards `stdio` to the spawned child even though ExecFileOptions omits it.
      ...({ stdio: options.stdio ?? ["pipe", "pipe", "pipe"] } as ExecFileOptions),
    },
    callback
  )
}

/** Promisified `execFile`. Rejects with `{ stdout, stderr, code, signal, killed }`
 *  attached on non-zero exit — callers that branch on those keep using this. */
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<{ stdout: ExecOutput; stderr: ExecOutput }> {
  return new Promise((resolve, reject) => {
    execFileWithPipedStdio(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Run a binary with an argv list (no shell interpolation), capped output and a
 * timeout, with `windowsHide` always set. Returns the stdout/stderr coerced to
 * strings. Throws (rejects) on non-zero exit, exactly like `execFileAsync`.
 */
export async function runCapped(
  file: string,
  args: readonly string[],
  { cwd, timeoutMs, maxBuffer }: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}
