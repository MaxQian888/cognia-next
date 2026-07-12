/**
 * Interactive-command detector for the four one-shot-capture shell paths
 * (agent `bash` tool, GUI `!command`, TUI `!command`, and the sidecar mirror).
 *
 * None of those paths has a TTY, so a command that *needs* one (a REPL, an
 * editor, `ssh`, a `login` flow, `git rebase -i`, `psql`, `top`, …) either
 * reads EOF and fails or hangs until it is killed. This module answers one
 * question — *"would this command line block on a terminal it will not get?"* —
 * so callers can route it to a real PTY instead.
 *
 * It reuses the exported `splitCommandSegments` parser (quote/subshell/operator
 * aware) and keeps a small self-contained wrapper-peel (the reference wrapper
 * list is `command-safety.ts`'s private `WRAPPERS`; it is intentionally NOT
 * imported so this file never depends on the security-critical classifier and
 * stays symmetric with the sidecar `.mjs` mirror, which cannot import `lib/`).
 *
 * Bias: conservative. Unknown commands are non-interactive — only the
 * explicitly listed families are ever flagged, so a normal command is never
 * broken. A missed interactive command merely behaves as it does today.
 *
 * MIRROR: sidecar/builtin-tools/shared/interactive-detect.mjs is kept in sync
 * with this rule set.
 */

import { normalizeHead, splitCommandSegments } from "./command-parse"

export interface InteractiveDetection {
  /** True when at least one segment would block on a TTY. */
  interactive: boolean
  /** The effective (wrapper-peeled) head that triggered the verdict. */
  head?: string
  /** Human-facing English explanation (log / model-facing). */
  reason: string
}

/**
 * Command wrappers whose real command is the first non-flag / non-assignment /
 * non-duration argument. Mirror of `command-safety.ts` `WRAPPERS`.
 */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "nohup",
  "env",
  "time",
  "timeout",
  "nice",
  "ionice",
  "command",
  "builtin",
  "exec",
  "watch",
  "stdbuf",
  "xargs",
])

/** Peel privilege/util wrappers to the effective `{head, args}` (depth ≤ 3). */
function peelWrappers(head: string, args: string[], depth = 0): { head: string; args: string[] } {
  if (depth < 3 && WRAPPERS.has(head)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a.startsWith("-")) continue
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue
      // timeout/watch/nice take a leading numeric/duration arg.
      if (/^\d+[smhd]?$/.test(a)) continue
      return peelWrappers(normalizeHead(a), args.slice(i + 1), depth + 1)
    }
  }
  return { head, args }
}

interface FlagSpec {
  /** Single-character short flag, e.g. "m" — matched case-sensitively inside a
   * `-` cluster so `-am` and `-mMSG` both satisfy `{short:"m"}`. */
  short?: string
  /** Long flag name without dashes, e.g. "message" — matches `--message` and
   * `--message=x`. */
  long?: string
}

/** Non-flag argument tokens (positionals). */
function positionalArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"))
}

/** Whether a flag is present, honoring `--long`, `--long=v`, and `-xy` clusters. */
function hasFlag(args: string[], spec: FlagSpec): boolean {
  const { short, long } = spec
  for (const a of args) {
    if (long && (a === `--${long}` || a.startsWith(`--${long}=`))) return true
    // Short flags live in a single-dash cluster (`-it`, `-am`, `-mMSG`).
    if (short && a.length >= 2 && a[0] === "-" && a[1] !== "-" && a.slice(1).includes(short)) {
      return true
    }
  }
  return false
}

function hasAnyFlag(args: string[], specs: FlagSpec[]): boolean {
  return specs.some((s) => hasFlag(args, s))
}

const EDITORS = new Set(["vi", "vim", "nvim", "nano", "emacs", "pico", "ed", "micro"])
const PAGERS = new Set(["top", "htop", "less", "more", "man"])
const REPLS = new Set([
  "python",
  "python3",
  "node",
  "irb",
  "ruby",
  "php",
  "lua",
  "deno",
  "bun",
  "r",
  "iex",
  "ghci",
])
const DB_HEADS = new Set(["psql", "mysql", "sqlite3", "mongosh", "mongo", "redis-cli"])
/** DB heads where a positional arg is an inline command / SQL, not a DB name. */
const DB_POSITIONAL_IS_CMD = new Set(["sqlite3", "redis-cli"])
const REMOTE = new Set(["ssh", "sftp", "telnet", "ftp"])
const CONTAINER = new Set(["docker", "podman", "kubectl"])

/** Flags that give a REPL something to do instead of dropping to a prompt. */
const REPL_ACTION_FLAGS: FlagSpec[] = [
  { short: "c" },
  { short: "e" },
  { long: "eval" },
  { short: "m" },
  { long: "version" },
  { short: "v" },
  { short: "V" },
  { long: "help" },
  { short: "h" },
  { long: "check" },
]

/** Flags that hand a DB client a command to run instead of an interactive shell. */
const DB_CMD_FLAGS: FlagSpec[] = [
  { short: "c" },
  { short: "e" },
  { long: "eval" },
  { long: "command" },
  { long: "execute" },
]

/** Flags that make a `login`/`configure` flow non-interactive. */
const LOGIN_NONINTERACTIVE_FLAGS: FlagSpec[] = [
  { long: "token" },
  { long: "password-stdin" },
  { long: "service-principal" },
  { long: "no-input" },
  { long: "non-interactive" },
]

/** ssh short flags that consume the following token as their value. */
const SSH_VALUE_FLAGS = new Set([
  "p",
  "i",
  "l",
  "o",
  "F",
  "b",
  "c",
  "e",
  "m",
  "O",
  "R",
  "L",
  "D",
  "W",
  "w",
  "S",
  "J",
])

/** Count host/command positionals for an ssh-family invocation, skipping the
 * value token consumed by a trailing value-flag (`-p 22 host` → 1 positional). */
function countRemotePositionals(args: string[]): number {
  let count = 0
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) continue
    if (a.startsWith("-") && a.length >= 2) {
      const last = a[a.length - 1]
      const nextIsValue = i + 1 < args.length && !args[i + 1].startsWith("-")
      // Only a bare `-p` (or an all-letter cluster ending in a value flag)
      // consumes the next token; `-p22` carries its value attached.
      const bareValueFlag = a.length === 2 || /^-[A-Za-z]+$/.test(a)
      if (SSH_VALUE_FLAGS.has(last) && nextIsValue && bareValueFlag) i++
      continue
    }
    count++
  }
  return count
}

function classifyLogin(head: string, args: string[]): InteractiveDetection | null {
  const positional = positionalArgs(args)
  const sub = positional[0]
  const sub2 = positional[1]
  if (hasAnyFlag(args, LOGIN_NONINTERACTIVE_FLAGS)) return null
  let hit = false
  switch (head) {
    case "npm":
    case "pnpm":
    case "yarn":
      hit = sub === "login" || sub === "adduser"
      break
    case "gh":
    case "gcloud":
      hit = sub === "auth" && sub2 === "login"
      break
    case "docker":
      hit = sub === "login"
      break
    case "aws":
      hit = sub === "configure" && sub2 === undefined
      break
    case "heroku":
    case "vercel":
    case "az":
    case "firebase":
    case "netlify":
      hit = sub === "login"
      break
    default:
      return null
  }
  if (!hit) return null
  return { interactive: true, head, reason: `${head} ${sub} prompts for credentials on a TTY` }
}

function classifyGit(args: string[]): InteractiveDetection | null {
  const sub = positionalArgs(args)[0]
  let hit = false
  let why = ""
  if (sub === "rebase" && hasAnyFlag(args, [{ short: "i" }, { long: "interactive" }])) {
    hit = true
    why = "git rebase -i opens an editor"
  } else if (
    sub === "add" &&
    hasAnyFlag(args, [{ short: "i" }, { short: "p" }, { long: "interactive" }, { long: "patch" }])
  ) {
    hit = true
    why = "git add -i/-p is interactive"
  } else if (sub === "config" && hasAnyFlag(args, [{ short: "e" }, { long: "edit" }])) {
    hit = true
    why = "git config --edit opens an editor"
  } else if (
    sub === "commit" &&
    !hasAnyFlag(args, [
      { short: "m" },
      { long: "message" },
      { short: "F" },
      { long: "file" },
      { short: "C" },
      { long: "reuse-message" },
      { long: "no-edit" },
    ])
  ) {
    hit = true
    why = "git commit with no message opens an editor"
  }
  if (!hit) return null
  return { interactive: true, head: "git", reason: why }
}

function classifyPassphrase(head: string, args: string[]): InteractiveDetection | null {
  switch (head) {
    case "passwd":
    case "su":
      return { interactive: true, head, reason: `${head} prompts for a password on a TTY` }
    case "ssh-keygen":
      if (hasFlag(args, { short: "N" })) return null
      return { interactive: true, head, reason: "ssh-keygen prompts for a passphrase" }
    case "ssh-add":
      if (hasAnyFlag(args, [{ short: "l" }, { short: "L" }, { short: "D" }, { short: "d" }])) {
        return null
      }
      return { interactive: true, head, reason: "ssh-add prompts for a key passphrase" }
    case "gpg":
      if (
        hasAnyFlag(args, [
          { long: "gen-key" },
          { long: "full-generate-key" },
          { long: "generate-key" },
          { long: "edit-key" },
        ])
      ) {
        return { interactive: true, head, reason: "gpg key generation/editing is interactive" }
      }
      return null
    default:
      return null
  }
}

function classifyContainer(head: string, args: string[]): InteractiveDetection | null {
  const sub = positionalArgs(args)[0]
  const relevant =
    head === "kubectl"
      ? sub === "exec" || sub === "run" || sub === "attach"
      : sub === "run" || sub === "exec"
  if (!relevant) return null
  const i = hasFlag(args, { short: "i", long: "interactive" })
  const t = hasFlag(args, { short: "t", long: "tty" })
  if (i && t) {
    return { interactive: true, head, reason: `${head} ${sub} -it attaches an interactive TTY` }
  }
  return null
}

function classifyRemote(head: string, args: string[]): InteractiveDetection | null {
  const positionals = countRemotePositionals(args)
  // ssh/sftp: a single positional is the host (a trailing command is not
  // interactive). telnet/ftp: any host is an interactive session (a second
  // positional is a port, not a command).
  const isInteractive = head === "ssh" || head === "sftp" ? positionals === 1 : positionals >= 1
  if (!isInteractive) return null
  return { interactive: true, head, reason: `${head} to a host opens an interactive session` }
}

/** Classify one already-peeled `{head, args}`. Returns null when not interactive. */
function classifySegment(head: string, args: string[]): InteractiveDetection | null {
  if (EDITORS.has(head)) {
    return { interactive: true, head, reason: `${head} is a full-screen editor` }
  }
  if (PAGERS.has(head)) {
    return { interactive: true, head, reason: `${head} is a pager / full-screen program` }
  }
  if (REPLS.has(head)) {
    const disqualified = positionalArgs(args).length > 0 || hasAnyFlag(args, REPL_ACTION_FLAGS)
    if (!disqualified) {
      return {
        interactive: true,
        head,
        reason: `${head} with no script starts an interactive REPL`,
      }
    }
    return null
  }
  if (DB_HEADS.has(head)) {
    if (hasAnyFlag(args, DB_CMD_FLAGS)) return null
    if (DB_POSITIONAL_IS_CMD.has(head)) {
      const threshold = head === "sqlite3" ? 2 : 1
      if (positionalArgs(args).length >= threshold) return null
    }
    return { interactive: true, head, reason: `${head} opens an interactive database shell` }
  }
  const login = classifyLogin(head, args)
  if (login) return login
  if (head === "git") return classifyGit(args)
  if (REMOTE.has(head)) return classifyRemote(head, args)
  if (CONTAINER.has(head)) return classifyContainer(head, args)
  return classifyPassphrase(head, args)
}

/**
 * Decide whether a command line would block on a TTY. Any single segment being
 * interactive makes the whole line interactive.
 */
export function detectInteractiveCommand(command: string): InteractiveDetection {
  for (const seg of splitCommandSegments(command)) {
    const { head, args } = peelWrappers(seg.head, seg.args)
    const verdict = classifySegment(head, args)
    if (verdict?.interactive) return verdict
  }
  return { interactive: false, reason: "no interactive command detected" }
}
