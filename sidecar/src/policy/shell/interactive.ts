// MIRROR of lib/claude/permissions/interactive-command.ts, kept in sync so the
// agent `bash` tool and the browser/CLI paths flag the same commands as
// TTY-requiring. The sidecar is not in the workspace and cannot import `lib/`,
// so the segmenter (a compact port of `command-parse.ts` splitCommandSegments)
// and the rule set are duplicated here. When you change a rule on either side,
// change both.
//
// Bias: conservative. Unknown commands are non-interactive — only the
// explicitly listed families are ever flagged.

import { extractSubstitutions, splitTopLevel } from "./segments.ts"

/** Whether a command would block on a TTY, and which program makes it so. */
export interface InteractiveVerdict {
  interactive: boolean
  head?: string
  reason: string
}

interface Segment {
  head: string
  raw: string
  args: string[]
}

interface FlagSpec {
  short?: string
  long?: string
}

const MAX_DEPTH = 20
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Basename + lowercase + strip trailing `.exe`. */
function normalizeHead(token: string | undefined): string {
  let t = (token ?? "").trim()
  if (!t) return ""
  const parts = t.split(/[\\/]/)
  t = parts[parts.length - 1] ?? t
  return t.toLowerCase().replace(/\.exe$/i, "")
}

/** Quote-aware whitespace tokenizer; quotes consumed, contents kept. */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let cur = ""
  let has = false
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      else {
        cur += c
        has = true
      }
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
      else {
        cur += c
        has = true
      }
      continue
    }
    if (c === "'") {
      inSingle = true
      has = true
      continue
    }
    if (c === '"') {
      inDouble = true
      has = true
      continue
    }
    if (/\s/.test(c ?? "")) {
      if (has) {
        tokens.push(cur)
        cur = ""
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (has) tokens.push(cur)
  return tokens
}

function collect(command: string, out: Segment[], depth: number): void {
  if (depth > MAX_DEPTH) return
  for (const raw of splitTopLevel(command)) {
    const { inner, stripped } = extractSubstitutions(raw)
    const tokens = tokenize(stripped)
    let idx = 0
    while (idx < tokens.length && (tokens[idx] === "" || ENV_ASSIGN.test(tokens[idx] ?? ""))) idx++
    const headToken = tokens[idx]
    if (headToken !== undefined) {
      const head = normalizeHead(headToken)
      if (head) out.push({ head, raw: raw.trim(), args: tokens.slice(idx + 1) })
    }
    for (const sub of inner) {
      if (sub.trim()) collect(sub, out, depth + 1)
    }
  }
}

/** Break a command line into its executable segments. */
function splitCommandSegments(command: string): Segment[] {
  if (!command || !command.trim()) return []
  const out: Segment[] = []
  collect(command, out, 0)
  return out
}

// --- Rule set (mirror of interactive-command.ts) ---

const WRAPPERS: ReadonlySet<string> = new Set([
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

function peelWrappers(head: string, args: string[], depth = 0): { head: string; args: string[] } {
  if (depth < 3 && WRAPPERS.has(head)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? ""
      if (a.startsWith("-")) continue
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue
      if (/^\d+[smhd]?$/.test(a)) continue
      return peelWrappers(normalizeHead(a), args.slice(i + 1), depth + 1)
    }
  }
  return { head, args }
}

function positionalArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"))
}

function hasFlag(args: string[], spec: FlagSpec): boolean {
  const { short, long } = spec
  for (const a of args) {
    if (long && (a === `--${long}` || a.startsWith(`--${long}=`))) return true
    if (short && a.length >= 2 && a[0] === "-" && a[1] !== "-" && a.slice(1).includes(short)) {
      return true
    }
  }
  return false
}

function hasAnyFlag(args: string[], specs: FlagSpec[]): boolean {
  return specs.some((s) => hasFlag(args, s))
}

const EDITORS: ReadonlySet<string> = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "emacs",
  "pico",
  "ed",
  "micro",
])
const PAGERS: ReadonlySet<string> = new Set(["top", "htop", "less", "more", "man"])
const REPLS: ReadonlySet<string> = new Set([
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
const DB_HEADS: ReadonlySet<string> = new Set([
  "psql",
  "mysql",
  "sqlite3",
  "mongosh",
  "mongo",
  "redis-cli",
])
const DB_POSITIONAL_IS_CMD: ReadonlySet<string> = new Set(["sqlite3", "redis-cli"])
const REMOTE: ReadonlySet<string> = new Set(["ssh", "sftp", "telnet", "ftp"])
const CONTAINER: ReadonlySet<string> = new Set(["docker", "podman", "kubectl"])

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

const DB_CMD_FLAGS: FlagSpec[] = [
  { short: "c" },
  { short: "e" },
  { long: "eval" },
  { long: "command" },
  { long: "execute" },
]

const LOGIN_NONINTERACTIVE_FLAGS: FlagSpec[] = [
  { long: "token" },
  { long: "password-stdin" },
  { long: "service-principal" },
  { long: "no-input" },
  { long: "non-interactive" },
]

const SSH_VALUE_FLAGS: ReadonlySet<string> = new Set([
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

function countRemotePositionals(args: string[]): number {
  let count = 0
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ""
    if (a.startsWith("--")) continue
    if (a.startsWith("-") && a.length >= 2) {
      const last = a.charAt(a.length - 1)
      const nextIsValue = i + 1 < args.length && !(args[i + 1] ?? "").startsWith("-")
      const bareValueFlag = a.length === 2 || /^-[A-Za-z]+$/.test(a)
      if (SSH_VALUE_FLAGS.has(last) && nextIsValue && bareValueFlag) i++
      continue
    }
    count++
  }
  return count
}

function classifyLogin(head: string, args: string[]): InteractiveVerdict | null {
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

function classifyGit(args: string[]): InteractiveVerdict | null {
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

function classifyPassphrase(head: string, args: string[]): InteractiveVerdict | null {
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

function classifyContainer(head: string, args: string[]): InteractiveVerdict | null {
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

function classifyRemote(head: string, args: string[]): InteractiveVerdict | null {
  const positionals = countRemotePositionals(args)
  const isInteractive = head === "ssh" || head === "sftp" ? positionals === 1 : positionals >= 1
  if (!isInteractive) return null
  return { interactive: true, head, reason: `${head} to a host opens an interactive session` }
}

function classifySegment(head: string, args: string[]): InteractiveVerdict | null {
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
 * Decide whether a command line would block on a TTY. Any single interactive
 * segment makes the whole line interactive.
 */
export function detectInteractiveCommand(command: string): InteractiveVerdict {
  for (const seg of splitCommandSegments(command)) {
    const { head, args } = peelWrappers(seg.head, seg.args)
    const verdict = classifySegment(head, args)
    if (verdict?.interactive) return verdict
  }
  return { interactive: false, reason: "no interactive command detected" }
}
