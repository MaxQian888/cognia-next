// Which `gh` (GitHub CLI) invocations in a shell command write to GitHub
// (ADR-0239 phase 2), for the always-ask on shell `gh` writes
// (`SendOptions.alwaysExplicitShellWritesMode`, ../permission/permission-classes.ts).
//
// The sidecar's copy of the kind tables in
// `packages/plugin-contract/src/lib/claude/permissions/gh-command.ts`: it
// cannot import the host's packages. Only the kind is decided here (`read`,
// `write`, `local`); where a write lands is the host's question.
// `lib/policy/action-review/gh-targets.sidecar-parity.test.ts` pins the
// tables and the verdicts equal. An invocation the tables do not know (a new
// command, an alias, an extension) is a write: it fails closed.

import { normalizeHead, peelWrappers, tokenize } from "./interactive.ts"
import { extractSubstitutions, splitTopLevel } from "./segments.ts"

export type GhInvocationKind = "read" | "write" | "local"

/** Commands that only read. Keys are `group sub` (or `group sub sub2`). */
export const GH_READ_COMMANDS: ReadonlySet<string> = new Set([
  "",
  "help",
  "version",
  "completion",
  "status",
  "search",
  "browse",
  "pr list",
  "pr view",
  "pr diff",
  "pr checks",
  "pr status",
  "pr checkout",
  "issue list",
  "issue view",
  "issue status",
  "release list",
  "release view",
  "release download",
  "release verify",
  "release verify-asset",
  "repo view",
  "repo list",
  "repo clone",
  "repo set-default",
  "repo gitignore",
  "repo license",
  "repo deploy-key list",
  "repo autolink list",
  "repo autolink view",
  "label list",
  "gist list",
  "gist view",
  "gist clone",
  "run list",
  "run view",
  "run watch",
  "run download",
  "workflow list",
  "workflow view",
  "secret list",
  "variable list",
  "variable get",
  "cache list",
  "ruleset list",
  "ruleset view",
  "ruleset check",
  "project list",
  "project view",
  "project field-list",
  "project item-list",
  "org list",
  "codespace list",
  "codespace view",
  "codespace logs",
  "extension list",
  "extension search",
  "extension browse",
  "alias list",
  "config get",
  "config list",
  "auth status",
  "gpg-key list",
  "ssh-key list",
  "attestation verify",
  "attestation download",
  "attestation trusted-root",
])

/** Commands that change only this machine's `gh` setup. */
export const GH_LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "auth login",
  "auth logout",
  "auth refresh",
  "auth setup-git",
  "auth switch",
  "auth token",
  "config set",
  "config clear-cache",
  "alias set",
  "alias delete",
  "alias import",
  "extension install",
  "extension upgrade",
  "extension remove",
  "extension create",
  "extension exec",
])

/** Groups that take a subcommand. */
export const GH_GROUPS: ReadonlySet<string> = new Set([
  "pr",
  "issue",
  "release",
  "repo",
  "label",
  "gist",
  "run",
  "workflow",
  "secret",
  "variable",
  "cache",
  "ruleset",
  "project",
  "org",
  "codespace",
  "extension",
  "alias",
  "config",
  "auth",
  "gpg-key",
  "ssh-key",
  "attestation",
])

/** Groups with a third level (`gh repo deploy-key add`). */
export const GH_NESTED: ReadonlySet<string> = new Set(["repo deploy-key", "repo autolink"])

/** Flags that take a value, so the value is not read as a command word. */
export const GH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-R",
  "--repo",
  "-t",
  "--title",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-B",
  "--base",
  "-H",
  "--head",
  "-a",
  "--assignee",
  "--add-assignee",
  "--remove-assignee",
  "-l",
  "--label",
  "--add-label",
  "--remove-label",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "--add-project",
  "--remove-project",
  "-r",
  "--reviewer",
  "--add-reviewer",
  "--remove-reviewer",
  "-T",
  "--template",
  "--recover",
  "-c",
  "--comment",
  "--subject",
  "--match-head-commit",
  "--author-email",
  "-n",
  "--notes",
  "--notes-file",
  "--notes-start-tag",
  "--target",
  "--tag",
  "--discussion-category",
  "--reason",
  "-d",
  "--description",
  "-h",
  "--homepage",
  "--visibility",
  "--source",
  "--remote",
  "--fork-name",
  "--org",
  "-o",
  "--env",
  "-e",
  "--app",
  "-s",
  "--state",
  "--color",
  "--name",
  "-i",
  "--issue-repo",
  "--hostname",
  "-X",
  "--method",
  "-f",
  "--field",
  "--raw-field",
  "--input",
  "--header",
  "-q",
  "--jq",
  "--cache",
  "--preview",
  "--json",
  "-L",
  "--limit",
])

/** `gh api` flags that send a request body, which makes the default method POST. */
export const GH_API_BODY_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "--field",
  "-F",
  "--raw-field",
  "--input",
])

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"])

function splitFlag(token: string): { flag: string; inline?: string } {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=")
    return eq === -1 ? { flag: token } : { flag: token.slice(0, eq), inline: token.slice(eq + 1) }
  }
  return token.length > 2 ? { flag: token.slice(0, 2), inline: token.slice(2) } : { flag: token }
}

function commandPath(args: readonly string[]): { path: string; rest: string[] } {
  const words: string[] = []
  const flags: string[] = []
  const wantsWord = (): boolean => {
    if (words.length === 0) return true
    if (!GH_GROUPS.has(words[0] ?? "")) return false
    if (words.length === 1) return true
    return words.length === 2 && GH_NESTED.has(`${words[0]} ${words[1]}`)
  }
  let i = 0
  for (; i < args.length && wantsWord(); i++) {
    const token = args[i] ?? ""
    // `gh -- pr create` still runs `pr create`: fail closed, keep reading.
    if (token === "--") continue
    if (token.startsWith("-") && token !== "-") {
      flags.push(token)
      const { flag, inline } = splitFlag(token)
      if (inline === undefined && GH_VALUE_FLAGS.has(flag) && i + 1 < args.length) {
        flags.push(args[++i] ?? "")
      }
      continue
    }
    words.push(token.toLowerCase())
  }
  return { path: words.join(" "), rest: [...flags, ...args.slice(i)] }
}

/** The `gh api` method: the last `-X` / `--method`, else POST with a body, else GET. */
function apiMethod(rest: readonly string[]): { method: string; sendsBody: boolean } {
  let method: string | undefined
  let sendsBody = false
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? ""
    if (token === "--") break
    if (!token.startsWith("-") || token === "-") continue
    const { flag, inline } = splitFlag(token)
    if (GH_API_BODY_FLAGS.has(flag)) sendsBody = true
    if (flag === "-X" || flag === "--method") {
      const value = inline ?? rest[i + 1]
      if (inline === undefined) i++
      if (value !== undefined) method = value.toUpperCase()
    }
  }
  return { method: method ?? (sendsBody ? "POST" : "GET"), sendsBody }
}

/** The kind of the invocation whose arguments follow `gh` (wrappers already peeled). */
export function ghInvocationKind(args: readonly string[]): GhInvocationKind {
  const help = args.some((arg) => arg === "--help" || arg === "-h")
  const { path, rest } = commandPath(args)
  if (path === "api") {
    if (help) return "read"
    const { method, sendsBody } = apiMethod(rest)
    return READ_METHODS.has(method) && !sendsBody ? "read" : "write"
  }
  if (help && path !== "") {
    const homepage = (path === "repo create" || path === "repo edit") && !args.includes("--help")
    if (!homepage) return "read"
  }
  if (GH_READ_COMMANDS.has(path) || GH_GROUPS.has(path) || GH_NESTED.has(path)) return "read"
  if (GH_LOCAL_COMMANDS.has(path)) return "local"
  return "write"
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const MAX_DEPTH = 20

function collectKinds(command: string, out: GhInvocationKind[], depth: number): void {
  if (depth > MAX_DEPTH) return
  for (const raw of splitTopLevel(command)) {
    const { inner, stripped } = extractSubstitutions(raw)
    const tokens = tokenize(stripped)
    let idx = 0
    while (idx < tokens.length && (tokens[idx] === "" || ENV_ASSIGN.test(tokens[idx] ?? ""))) idx++
    const headToken = tokens[idx]
    if (headToken !== undefined) {
      const { head, args } = peelWrappers(normalizeHead(headToken), tokens.slice(idx + 1))
      if (head === "gh") out.push(ghInvocationKind(args))
    }
    for (const sub of inner) {
      if (sub.trim()) collectKinds(sub, out, depth + 1)
    }
  }
}

/** The kind of every `gh` invocation in a command line, in order. */
export function ghInvocationKinds(command: string): GhInvocationKind[] {
  const out: GhInvocationKind[] = []
  if (command.trim()) collectKinds(command, out, 0)
  return out
}

/** True when some `gh` invocation in the command writes to GitHub. */
export function commandHasGhWrite(command: string): boolean {
  return ghInvocationKinds(command).includes("write")
}

/** Shell tools by registered name (the last `__` segment, lowercased). */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "sandbox_bash",
  "shell_execute_advanced",
  "start_process",
])

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

/**
 * The command line a shell tool call runs, or null for any other tool. The
 * same shapes as the host's `extractCommand`: `Bash` and `sandbox_bash` carry
 * `command`, `shell_execute_advanced` a `command` plus `args`, and
 * `start_process` a `program` plus `args`.
 */
export function shellCommandOf(registeredName: string, input: unknown): string | null {
  if (!SHELL_TOOL_NAMES.has(registeredName)) return null
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  if (registeredName === "bash" || registeredName === "sandbox_bash") {
    return typeof obj.command === "string" && obj.command.trim() ? obj.command : null
  }
  const head = registeredName === "start_process" ? obj.program : obj.command
  if (typeof head !== "string" || !head.trim()) return null
  return [head, ...strings(obj.args)].join(" ").trim()
}
