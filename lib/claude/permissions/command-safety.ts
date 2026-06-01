/**
 * Deterministic command-safety classifier — the "rules" tier of the agent
 * Auto-mode (`auto-mode.ts`). Given a command line it returns an
 * allow / ask / deny verdict purely from static rules, mirroring the
 * allowlist/blocklist/dangerous-pattern model the sidecar already ships for
 * `shell_execute_advanced` (`sidecar/builtin-tools/safety.mjs`) but richer:
 *
 *  - compound-command aware (via `splitCommandSegments`) — the worst verdict
 *    across the chain wins, and destructive commands hidden inside
 *    substitutions still surface;
 *  - subcommand aware for `git` / `npm`-family / `cargo`, so `git status`
 *    is allowed while `git push` asks;
 *  - privilege aware — a `sudo`-wrapped safe command escalates to `ask`;
 *  - catastrophe aware — `rm -rf /`, `dd of=/dev/…`, `mkfs`, pipe-to-shell,
 *    and fork bombs are denied outright.
 *
 * This is the fast, offline gate. When it returns `ask`, the orchestrator may
 * additionally consult the small-model judge (`command-judge.ts`). Pure: no
 * I/O, safe to run on every keystroke / tool call.
 */

import { splitCommandSegments } from "./command-parse"

export type CommandVerdict = "allow" | "ask" | "deny"

export interface SegmentClassification {
  head: string
  verdict: CommandVerdict
  reason: string
}

export interface CommandClassification {
  verdict: CommandVerdict
  /** Reason for the most severe finding (English, dev/log facing). */
  reason: string
  /** The head command that drove the verdict, when applicable. */
  matched?: string
  /** Per-segment breakdown (for display / debugging). */
  segments: SegmentClassification[]
}

const RANK: Record<CommandVerdict, number> = { allow: 0, ask: 1, deny: 2 }

/** Read-only / safe-by-default executables — auto-allowed. */
const SAFE_HEADS = new Set([
  // Inspection.
  "ls",
  "dir",
  "pwd",
  "cat",
  "bat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "where",
  "whereis",
  "type",
  "tree",
  "less",
  "more",
  "echo",
  "printf",
  "true",
  "false",
  "clear",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "test",
  "seq",
  "cal",
  "history",
  "sleep",
  // Text processing (read-only by default).
  "grep",
  "rg",
  "ag",
  "fd",
  "find",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "comm",
  "strings",
  "hexdump",
  "xxd",
  "jq",
  "yq",
  "awk",
  "sed",
  "fold",
  "nl",
  "tac",
  "column",
  "paste",
  "join",
  // System info (read-only).
  "date",
  "whoami",
  "id",
  "hostname",
  "uname",
  "env",
  "printenv",
  "ps",
  "pgrep",
  "top",
  "htop",
  "uptime",
  "free",
  "lscpu",
  "lsblk",
  "lsof",
  "systeminfo",
  "tasklist",
  "ver",
  "getconf",
  // Filesystem creation (non-destructive).
  "mkdir",
  "touch",
  "cp",
  "ln",
  // Interpreters / build / test / lint (a coding agent's bread and butter).
  "node",
  "python",
  "python3",
  "ruby",
  "deno",
  "perl",
  "php",
  "lua",
  "tsc",
  "eslint",
  "prettier",
  "jest",
  "vitest",
  "biome",
  "oxlint",
  "dprint",
  "ruff",
  "black",
  "mypy",
  "flake8",
  "pylint",
  "isort",
  "clippy",
  "rustfmt",
  "gofmt",
  "golint",
  "golangci-lint",
  "playwright",
  "pytest",
  "tox",
  "rspec",
  "swiftc",
  "kotlinc",
  "javac",
  "rustc",
  "gcc",
  "g++",
  "clang",
  "cmake",
  "dotnet",
  "mvn",
  "gradle",
  "go",
  "swift",
  "kotlin",
  "flutter",
  "dart",
  // VCS read paths (git/gh subcommands refined below).
  "git",
  "gh",
  "hg",
  "svn",
  // Package runners (subcommand refined below).
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "pnpx",
  "bunx",
  "cargo",
  "uv",
  "poetry",
])

/** Executables that always need confirmation (mutate broadly / side effects). */
const ASK_HEADS = new Set([
  // Deletion / move.
  "mv",
  "rename",
  // Permissions / ownership.
  "chmod",
  "chown",
  "chgrp",
  "chattr",
  "icacls",
  "attrib",
  "takeown",
  // Process / service control.
  "kill",
  "killall",
  "pkill",
  "taskkill",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "systemctl",
  "service",
  "launchctl",
  "sc",
  // Scheduling.
  "crontab",
  "at",
  "schtasks",
  // User / auth management.
  "useradd",
  "userdel",
  "usermod",
  "passwd",
  "visudo",
  "adduser",
  "deluser",
  // Networking changes.
  "mount",
  "umount",
  "ifconfig",
  "ip",
  "route",
  "netsh",
  "iptables",
  "firewall-cmd",
  "ufw",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "sftp",
  "telnet",
  "nc",
  "ncat",
  "socat",
  "wget",
  // OS / global package managers.
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "brew",
  "pacman",
  "apk",
  "snap",
  "choco",
  "winget",
  "scoop",
  "pip",
  "pip3",
  "pipx",
  "gem",
  "make",
  // Cloud / infra / containers.
  "docker",
  "docker-compose",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "ansible",
  "vagrant",
  "aws",
  "az",
  "gcloud",
  "heroku",
  "vercel",
  "netlify",
  // Windows system.
  "reg",
  "regedit",
  "wmic",
  "bcdedit",
  "diskpart",
  "setx",
  "powercfg",
  // Disk (non-catastrophic but risky).
  "fdisk",
  "parted",
  "format",
  "tee",
])

/** Deletion heads handled by the dedicated rm classifier. */
const DELETE_HEADS = new Set(["rm", "rmdir", "del", "erase", "unlink"])

const GIT_ASK_SUBS = new Set([
  "push",
  "reset",
  "clean",
  "rebase",
  "filter-branch",
  "filter-repo",
  "update-ref",
  "gc",
  "prune",
])

const PM_ASK_SUBS = new Set([
  "publish",
  "login",
  "logout",
  "adduser",
  "unpublish",
  "token",
  "owner",
  "access",
  "deprecate",
  "yank",
])

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

/** Targets that make a recursive force-delete catastrophic. */
const CRITICAL_RM_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "~/",
  "*",
  ".",
  "..",
  "./",
  "$home",
  "${home}",
  "%userprofile%",
])
const CRITICAL_RM_PREFIX =
  /^\/(bin|etc|usr|var|boot|lib|lib64|sys|proc|dev|root|home|opt|sbin|system|windows)\b/i

const ALLOW_REASON = "read-only / safe command"

/** Strip quoted spans so catastrophic patterns don't match quoted literals. */
function stripQuotes(s: string): string {
  return s.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ")
}

/** Whole-command catastrophic scan (returns a reason, or null). */
function matchCatastrophic(command: string): string | null {
  const s = stripQuotes(command)
  // Pipe downloaded/arbitrary content straight into a shell interpreter.
  if (/\|\s*(sudo\s+)?(sh|bash|zsh|ksh|dash|fish|pwsh|powershell|cmd)\b/i.test(s)) {
    return "pipes content into a shell interpreter (remote-code-execution risk)"
  }
  // Fork bomb `:(){ :|:& };:` and close variants.
  if (/\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*:?/.test(s) && /:\s*\(\s*\)/.test(s)) {
    return "resource-exhausting fork bomb"
  }
  return null
}

function flagsOf(args: string[]): string {
  return args
    .filter((a) => a.startsWith("-") && !a.startsWith("--"))
    .join("")
    .toLowerCase()
}

function hasLongFlag(args: string[], name: string): boolean {
  return args.some((a) => a === `--${name}`)
}

function bareArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"))
}

function classifyRm(head: string, args: string[]): SegmentClassification {
  const flags = flagsOf(args)
  const recursive = flags.includes("r") || hasLongFlag(args, "recursive")
  const force = flags.includes("f") || hasLongFlag(args, "force")
  const targets = bareArgs(args)
  const critical = targets.some(
    (t) => CRITICAL_RM_TARGETS.has(t.toLowerCase()) || CRITICAL_RM_PREFIX.test(t)
  )
  if ((recursive || head === "rmdir") && force && critical) {
    return { head, verdict: "deny", reason: "recursive force-delete of a critical path" }
  }
  return { head, verdict: "ask", reason: "deletes files" }
}

function gitSubcommand(args: string[]): string | undefined {
  const valueOpts = new Set(["-c", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "-c" || valueOpts.has(a)) {
      i++
      continue
    }
    if (a.startsWith("-")) continue
    return a.toLowerCase()
  }
  return undefined
}

function classifyGit(args: string[]): SegmentClassification {
  const sub = gitSubcommand(args)
  if (sub && GIT_ASK_SUBS.has(sub)) {
    return {
      head: "git",
      verdict: "ask",
      reason: `git ${sub} mutates remote/history or deletes work`,
    }
  }
  return { head: "git", verdict: "allow", reason: ALLOW_REASON }
}

function classifyPackageManager(head: string, args: string[]): SegmentClassification {
  const sub = bareArgs(args)[0]?.toLowerCase()
  if (sub && PM_ASK_SUBS.has(sub)) {
    return { head, verdict: "ask", reason: `${head} ${sub} publishes or changes registry auth` }
  }
  return { head, verdict: "allow", reason: ALLOW_REASON }
}

function classifyCargo(args: string[]): SegmentClassification {
  const sub = bareArgs(args)[0]?.toLowerCase()
  if (sub === "install" || (sub && PM_ASK_SUBS.has(sub))) {
    return { head: "cargo", verdict: "ask", reason: `cargo ${sub} installs/publishes globally` }
  }
  return { head: "cargo", verdict: "allow", reason: ALLOW_REASON }
}

function classifyCurl(args: string[]): SegmentClassification {
  const joined = args.join(" ").toLowerCase()
  const mutatingMethod = /(^|\s)(-x|--request)\s+(post|put|delete|patch)\b/.test(joined)
  const sendsData = args.some((a) =>
    [
      "-d",
      "--data",
      "--data-binary",
      "--data-raw",
      "--data-urlencode",
      "-f",
      "--form",
      "-t",
      "--upload-file",
    ].includes(a.toLowerCase())
  )
  const writesFile = args.some(
    (a) => ["-o", "--output", "-o".toUpperCase()].includes(a) || a === "-O"
  )
  if (mutatingMethod || sendsData || writesFile) {
    return {
      head: "curl",
      verdict: "ask",
      reason: "curl sends data / writes a file (network side effects)",
    }
  }
  return { head: "curl", verdict: "allow", reason: "read-only network fetch" }
}

function classifyDd(args: string[]): SegmentClassification {
  const ofDevice = args.some((a) => /^of=(\/dev\/|\\\\\.\\)/i.test(a))
  if (ofDevice) {
    return { head: "dd", verdict: "deny", reason: "writes raw bytes to a block device" }
  }
  return { head: "dd", verdict: "ask", reason: "low-level disk copy" }
}

/** Classify a single resolved head + args (after wrapper unwrapping). */
function classifyHead(head: string, args: string[]): SegmentClassification {
  if (DELETE_HEADS.has(head)) return classifyRm(head, args)
  if (head === "git") return classifyGit(args)
  if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
    return classifyPackageManager(head, args)
  }
  if (head === "cargo") return classifyCargo(args)
  if (head === "curl") return classifyCurl(args)
  if (head === "dd") return classifyDd(args)
  if (head.startsWith("mkfs")) {
    return { head, verdict: "deny", reason: "formats a filesystem" }
  }
  if (SAFE_HEADS.has(head)) return { head, verdict: "allow", reason: ALLOW_REASON }
  if (ASK_HEADS.has(head))
    return { head, verdict: "ask", reason: "has system / network side effects" }
  return { head, verdict: "ask", reason: "unrecognized command" }
}

/** Find the wrapped command after a privilege/util wrapper (sudo, env, …). */
function unwrap(args: string[]): { head: string; args: string[] } | null {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a.startsWith("-")) {
      i++
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      i++
      continue
    }
    // timeout/watch/nice take a leading numeric/duration arg.
    if (/^\d+[smhd]?$/.test(a)) {
      i++
      continue
    }
    return {
      head: a
        .toLowerCase()
        .replace(/.*[\\/]/, "")
        .replace(/\.exe$/i, ""),
      args: args.slice(i + 1),
    }
  }
  return null
}

function classifySegmentInner(head: string, args: string[], depth: number): SegmentClassification {
  if (depth < 3 && WRAPPERS.has(head)) {
    const inner = unwrap(args)
    if (!inner) {
      return { head, verdict: "ask", reason: "privilege/util wrapper with no inner command" }
    }
    const sub = classifySegmentInner(inner.head, inner.args, depth + 1)
    if (head === "sudo" || head === "doas") {
      // Privilege escalation never *lowers* the verdict; a safe command still
      // needs confirmation when run as root.
      if (RANK[sub.verdict] < RANK.ask) {
        return { head: inner.head, verdict: "ask", reason: "runs with elevated privileges (sudo)" }
      }
      return sub
    }
    return sub
  }
  return classifyHead(head, args)
}

/**
 * Classify a (possibly compound) command line into an allow/ask/deny verdict.
 * The worst verdict across all segments — including those inside command
 * substitutions and subshells — wins.
 */
export function classifyCommand(command: string): CommandClassification {
  const parsed = splitCommandSegments(command)
  const segments: SegmentClassification[] = parsed.map((s) =>
    classifySegmentInner(s.head, s.args, 0)
  )

  const catastrophic = matchCatastrophic(command)

  let worst: SegmentClassification | null = null
  for (const seg of segments) {
    if (!worst || RANK[seg.verdict] > RANK[worst.verdict]) worst = seg
  }

  if (catastrophic) {
    return {
      verdict: "deny",
      reason: catastrophic,
      matched: worst?.head,
      segments,
    }
  }
  if (!worst) {
    return { verdict: "allow", reason: "no executable command", segments: [] }
  }
  return { verdict: worst.verdict, reason: worst.reason, matched: worst.head, segments }
}
