// OS-aware shell resolution for the free-form `bash` tool.
//
// The built-in agent has ONE shell tool, but the shell it actually drives must
// match the host: a Windows box has no `/bin/sh`, and `cmd.exe` is a poor target
// (no object pipeline, weak scripting, many Windows automations need PowerShell).
// So on Windows we prefer PowerShell 7 (`pwsh`) → Windows PowerShell
// (`powershell`) → `cmd.exe`, and everywhere else `/bin/sh`. The chosen shell
// drives BOTH the spawn argv AND the tool description, so the model is told which
// syntax to write (PowerShell `$env:VAR`/`$null` vs POSIX `$VAR`/`/dev/null`).
//
// Mirrors the PATH/PATHEXT probe and the pwsh→powershell fallback in
// `src-tauri/src/terminal/session.rs::resolve_shell_binary`, kept in sync so the
// agent tool and the integrated terminal pick the same shell on a given machine.

import { existsSync } from "node:fs"
import path from "node:path"

/**
 * PowerShell environment-injection vectors. `$PSModulePath` auto-imports modules
 * from every listed directory — if it points at a workspace the agent just wrote
 * to, the next PowerShell session loads attacker-controlled `.psm1` code (the
 * Windows analogue of `LD_LIBRARY_PATH`/`LD_PRELOAD`). `$PSExecutionPolicyPreference`
 * relaxes the script-signing gate. We drop both before spawning a PowerShell
 * child (and pass `-NoProfile` so `$PROFILE` can't auto-source either), forcing
 * PowerShell to recompute its safe default module path. This is the sidecar-side
 * mirror of the Rust sandbox's `env.rs` denylist for the unsandboxed CLI path.
 */
const PS_DANGEROUS_ENV = [/^PSModulePath$/i, /^PSExecutionPolicyPreference$/i]

/** `-NoProfile -NonInteractive` keeps the run hermetic: no `$PROFILE` auto-source,
 * no interactive prompts that would hang a non-TTY child. */
const PS_PRELUDE = ["-NoProfile", "-NonInteractive", "-Command"]

const PS_SYNTAX_HINT =
  "This host runs PowerShell, NOT bash — write PowerShell syntax: `$env:VAR` (not $VAR), " +
  "`$null` (not /dev/null), `;` or `&&` to chain, backtick (`) for line continuation. " +
  "Prefer cmdlets (Get-ChildItem, Select-String, Get-Content, Remove-Item); Unix names like " +
  "ls/grep/cat may exist as aliases but their flags differ. Quote paths containing spaces."

const CMD_SYNTAX_HINT =
  "This host runs cmd.exe (no PowerShell on PATH) — write cmd.exe syntax: `%VAR%`, `&&` to " +
  "chain commands, `NUL` (not /dev/null). PowerShell cmdlets are unavailable."

/**
 * Non-interactive env hardening for the agent's one-shot shell. Every one of
 * these blocks on a TTY the agent doesn't have: `git log`/`git diff` page through
 * `$PAGER`, `git commit` with no `-m` opens `$GIT_EDITOR`, and credential/host
 * prompts wait on stdin forever. We pin them to non-blocking values so a model
 * command can never hang the turn. These specific vars are OVERRIDDEN over the
 * inherited env (that is the point — an ambient `PAGER=less` would otherwise
 * reintroduce the hang); every other var is inherited unchanged. Mirrors the
 * Rust native-git path `src-tauri/src/git/exec.rs` + the sandbox denylist
 * `src-tauri/src/sandbox/env.rs`.
 */
export const NON_INTERACTIVE_ENV = Object.freeze({
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GCM_INTERACTIVE: "never",
})

/**
 * Layer `NON_INTERACTIVE_ENV` over an env map. On POSIX also forces `TERM=dumb`
 * so curses/color programs render plainly instead of spraying escape codes into
 * captured output; left untouched on Windows where the shells ignore it. Returns
 * a new object — the input is not mutated.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ isWin?: boolean }} [descriptor]
 */
export function applyNonInteractiveEnv(env, descriptor = activeShellDescriptor()) {
  const out = { ...env, ...NON_INTERACTIVE_ENV }
  if (!descriptor.isWin) out.TERM = "dumb"
  return out
}

/** Return only the keys NOT matching any `patterns`. Returns the SAME object ref
 * when nothing was stripped, so callers can cheaply detect "unchanged". */
function stripEnvKeys(env, patterns) {
  let changed = false
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (patterns.some((re) => re.test(k))) {
      changed = true
      continue
    }
    out[k] = v
  }
  return changed ? out : env
}

function makeSh() {
  return {
    kind: "sh",
    bin: "/bin/sh",
    isWin: false,
    label: "POSIX sh",
    syntaxHint: "",
    buildArgs: (command) => ["-c", command],
    sanitizeEnv: (env) => env,
  }
}

function makePwsh(bin) {
  return {
    kind: "pwsh",
    bin,
    isWin: true,
    label: "PowerShell 7 (pwsh)",
    syntaxHint: PS_SYNTAX_HINT,
    buildArgs: (command) => [...PS_PRELUDE, command],
    sanitizeEnv: (env) => stripEnvKeys(env, PS_DANGEROUS_ENV),
  }
}

function makePowershell(bin) {
  return {
    kind: "powershell",
    bin,
    isWin: true,
    label: "Windows PowerShell",
    syntaxHint: PS_SYNTAX_HINT,
    buildArgs: (command) => [...PS_PRELUDE, command],
    sanitizeEnv: (env) => stripEnvKeys(env, PS_DANGEROUS_ENV),
  }
}

function makeCmd(bin) {
  return {
    kind: "cmd",
    bin,
    isWin: true,
    label: "cmd.exe",
    syntaxHint: CMD_SYNTAX_HINT,
    buildArgs: (command) => ["/d", "/s", "/c", command],
    sanitizeEnv: (env) => env,
  }
}

/**
 * `which`-style lookup honoring `PATHEXT` on Windows when `name` has no
 * extension (so a bare `pwsh` matches `pwsh.exe`). Returns the matched leaf
 * (`name + ext`) on a hit, else null. All inputs are injectable for tests.
 *
 * @param {string} name
 * @param {{ platform?: NodeJS.Platform, pathVar?: string, pathext?: string,
 *           exists?: (p: string) => boolean }} [opts]
 * @returns {string | null}
 */
export function findOnPathSync(name, opts = {}) {
  const platform = opts.platform ?? process.platform
  const isWin = platform === "win32"
  const pathVar = opts.pathVar ?? process.env.PATH ?? ""
  if (!pathVar) return null
  const exists = opts.exists ?? existsSync
  // Use platform-correct path semantics from the `platform` opt, not the host's
  // — `path.join`/`extname` are host-bound, which would break simulated-platform
  // unit tests (and, in theory, a non-native runner).
  const p = isWin ? path.win32 : path.posix
  const sep = isWin ? ";" : ":"
  const hasExt = p.extname(name) !== ""
  let exts
  if (isWin && !hasExt) {
    const pathext = opts.pathext ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM"
    exts = pathext.split(";").filter((s) => s.length > 0)
  } else {
    exts = [""]
  }
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      if (exists(p.join(dir, name + ext))) return name + ext
    }
  }
  return null
}

/**
 * Resolve the shell descriptor for the host. Off Windows → POSIX sh. On Windows,
 * probe PATH for `pwsh` → `powershell` → fall back to `cmd.exe`. Pure: every
 * environment dependency is injectable so the three Windows branches are unit
 * testable on any OS.
 *
 * @param {{ platform?: NodeJS.Platform,
 *           lookup?: (name: string) => string | null,
 *           comspec?: string }} [opts]
 */
export function resolveShellDescriptor(opts = {}) {
  const platform = opts.platform ?? process.platform
  if (platform !== "win32") return makeSh()
  const lookup = opts.lookup ?? ((name) => findOnPathSync(name, { platform }))
  if (lookup("pwsh.exe") || lookup("pwsh")) return makePwsh("pwsh.exe")
  if (lookup("powershell.exe") || lookup("powershell")) return makePowershell("powershell.exe")
  return makeCmd(opts.comspec ?? process.env.ComSpec ?? "cmd.exe")
}

let cached = null

/** The host shell descriptor, resolved once and cached (PATH probing is cheap
 * but not free, and the answer can't change within a process). */
export function activeShellDescriptor() {
  if (cached === null) cached = resolveShellDescriptor()
  return cached
}

/** Reset the cached descriptor — for tests exercising the resolution branches. */
export function __resetShellDetectCache() {
  cached = null
}

/**
 * Build the `bash` tool description for a given shell descriptor. The syntax hint
 * is what tells the model to write PowerShell vs POSIX — it is the prompt half of
 * the single-shell-abstraction design, read by the model every turn.
 */
export function bashToolDescription(descriptor = activeShellDescriptor()) {
  const base =
    "Execute a shell command in the session working directory and return its combined output."
  const hint = descriptor.syntaxHint ? ` ${descriptor.syntaxHint}` : ` Runs ${descriptor.label}.`
  const tail =
    "Long output keeps the tail. Set run_in_background to start a long-running command and poll it " +
    "with bash_output. Each call is approval-gated unless a permission rule allows it. " +
    "Interactive programs (REPLs, editors, ssh, login flows) do NOT work here — use terminal_repl_* for those."
  return `${base}${hint} ${tail}`
}
