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

import { findOnPathSync } from "./which.ts"

type Env = Record<string, string | undefined>

export type ShellKind = "sh" | "pwsh" | "powershell" | "cmd"

/** The host shell the `bash` tool drives, and how to invoke it. */
export interface ShellDescriptor {
  kind: ShellKind
  bin: string
  isWin: boolean
  label: string
  /** Prompt text telling the model which syntax to write; empty for POSIX sh. */
  syntaxHint: string
  buildArgs(command: string): string[]
  /** Drops shell-specific injection vectors; returns the same ref when nothing was dropped. */
  sanitizeEnv<E extends Env>(env: E): E
}

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
const PS_DANGEROUS_ENV: readonly RegExp[] = [/^PSModulePath$/i, /^PSExecutionPolicyPreference$/i]

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
 */
export function applyNonInteractiveEnv(
  env: Env,
  descriptor: Pick<ShellDescriptor, "isWin"> = activeShellDescriptor()
): Env {
  const out: Env = { ...env, ...NON_INTERACTIVE_ENV }
  if (!descriptor.isWin) out.TERM = "dumb"
  return out
}

/** Return only the keys NOT matching any `patterns`. Returns the SAME object ref
 * when nothing was stripped, so callers can cheaply detect "unchanged". */
function stripEnvKeys<E extends Env>(env: E, patterns: readonly RegExp[]): E {
  let changed = false
  const out: Env = {}
  for (const [k, v] of Object.entries(env)) {
    if (patterns.some((re) => re.test(k))) {
      changed = true
      continue
    }
    out[k] = v
  }
  // Only keys were removed, so the copy still satisfies every key E requires.
  return changed ? (out as E) : env
}

const identityEnv = <E extends Env>(env: E): E => env
const stripPowerShellEnv = <E extends Env>(env: E): E => stripEnvKeys(env, PS_DANGEROUS_ENV)

function makeSh(): ShellDescriptor {
  return {
    kind: "sh",
    bin: "/bin/sh",
    isWin: false,
    label: "POSIX sh",
    syntaxHint: "",
    buildArgs: (command) => ["-c", command],
    sanitizeEnv: identityEnv,
  }
}

function makePwsh(bin: string): ShellDescriptor {
  return {
    kind: "pwsh",
    bin,
    isWin: true,
    label: "PowerShell 7 (pwsh)",
    syntaxHint: PS_SYNTAX_HINT,
    buildArgs: (command) => [...PS_PRELUDE, command],
    sanitizeEnv: stripPowerShellEnv,
  }
}

function makePowershell(bin: string): ShellDescriptor {
  return {
    kind: "powershell",
    bin,
    isWin: true,
    label: "Windows PowerShell",
    syntaxHint: PS_SYNTAX_HINT,
    buildArgs: (command) => [...PS_PRELUDE, command],
    sanitizeEnv: stripPowerShellEnv,
  }
}

function makeCmd(bin: string): ShellDescriptor {
  return {
    kind: "cmd",
    bin,
    isWin: true,
    label: "cmd.exe",
    syntaxHint: CMD_SYNTAX_HINT,
    buildArgs: (command) => ["/d", "/s", "/c", command],
    sanitizeEnv: identityEnv,
  }
}

export interface ResolveShellOptions {
  platform?: NodeJS.Platform
  lookup?: (name: string) => string | null
  comspec?: string
}

/**
 * Resolve the shell descriptor for the host. Off Windows → POSIX sh. On Windows,
 * probe PATH for `pwsh` → `powershell` → fall back to `cmd.exe`. Pure: every
 * environment dependency is injectable so the three Windows branches are unit
 * testable on any OS.
 */
export function resolveShellDescriptor(opts: ResolveShellOptions = {}): ShellDescriptor {
  const platform = opts.platform ?? process.platform
  if (platform !== "win32") return makeSh()
  const lookup = opts.lookup ?? ((name: string) => findOnPathSync(name, { platform }))
  if (lookup("pwsh.exe") || lookup("pwsh")) return makePwsh("pwsh.exe")
  if (lookup("powershell.exe") || lookup("powershell")) return makePowershell("powershell.exe")
  return makeCmd(opts.comspec ?? process.env.ComSpec ?? "cmd.exe")
}

let cached: ShellDescriptor | null = null

/** The host shell descriptor, resolved once and cached (PATH probing is cheap
 * but not free, and the answer can't change within a process). */
export function activeShellDescriptor(): ShellDescriptor {
  if (cached === null) cached = resolveShellDescriptor()
  return cached
}

/** Reset the cached descriptor — for tests exercising the resolution branches. */
export function __resetShellDetectCache(): void {
  cached = null
}
