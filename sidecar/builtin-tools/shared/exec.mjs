// Shared child-process exec primitives for built-in tools.
//
// Single home for the `promisify(execFile)` wrapper that was previously
// copy-pasted into git.mjs, process.mjs, and shell-advanced.mjs. Callers that
// need the raw rejection shape (stdout/stderr/code/signal attached on non-zero
// exit) import `execFileAsync` directly; callers that just want the
// stringified output of a successful run use `runCapped`.

import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { ENV_ALLOWLIST, isStrippedName } from "../../dispatch/subprocess-env.mjs"

const PROCESS_ENV_KEYS = new Set([
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
export function sandboxedProcessEnv(parentEnv, scope, overrides = {}) {
  if (scope === undefined) return { ...parentEnv, ...overrides }
  const base = Object.fromEntries(
    Object.entries(parentEnv).filter(
      ([key, value]) => PROCESS_ENV_KEYS.has(key) && typeof value === "string"
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

const processScopes = new AsyncLocalStorage()

/** Each tool invocation keeps its session policy across asynchronous Git and
 * other shared-exec calls; concurrent sessions cannot overwrite this scope. */
export function withProcessSandbox(scope, cwd, run) {
  return processScopes.run({ scope, cwd }, run)
}

/** Raw streaming children (rg/AST) share the current tool's async scope. */
export function spawnInProcessSandbox(command, args, options = {}) {
  const context = processScopes.getStore()
  const target = sandboxedProcessTarget(command, args, options.cwd ?? context?.cwd, context?.scope)
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
export function sandboxedProcessTarget(command, args, cwd, scope) {
  if (scope === undefined) return { command, args }
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

/**
 * Keep every standard stream connected when a tool child is launched.
 *
 * Git calls `sanitize_stdfds()` at startup and opens `/dev/null` when one of
 * fd 0/1/2 is missing. External ACP/MCP hosts can launch the bridge with a
 * closed descriptor, and a sandboxed macOS process may not be allowed to open
 * `/dev/null`. Explicit pipes prevent that fallback while preserving the
 * stdout/stderr capture contract used by every caller.
 */
function execFileWithPipedStdio(file, args, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  const normalizedOptions = options ?? {}
  const context = processScopes.getStore()
  // Explicit process tools already rendered their launcher argv. Generic Git
  // and utility executors reach this seam with their original binary/argv.
  if (context?.scope && file !== context.scope.launcher) {
    const target = sandboxedProcessTarget(
      file,
      args,
      normalizedOptions.cwd ?? context.cwd,
      context.scope
    )
    file = target.command
    args = target.args
  }
  return execFile(
    file,
    args,
    {
      ...normalizedOptions,
      ...(context?.scope
        ? { env: sandboxedProcessEnv(normalizedOptions.env ?? process.env, context.scope) }
        : {}),
      stdio: normalizedOptions.stdio ?? ["pipe", "pipe", "pipe"],
    },
    callback
  )
}

/** Promisified `execFile`. Rejects with `{ stdout, stderr, code, signal, killed }`
 *  attached on non-zero exit — callers that branch on those keep using this. */
export function execFileAsync(file, args, options = {}) {
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
 *
 * @param {string} file Executable to run.
 * @param {ReadonlyArray<string>} args Argv list.
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runCapped(file, args, { cwd, timeoutMs, maxBuffer } = {}) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}
