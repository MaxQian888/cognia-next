/**
 * What one `gh` (GitHub CLI) invocation does, from its arguments alone
 * (ADR-0239 phase 2).
 *
 * - `read`: only reads GitHub or this machine (`gh pr view`, `gh api` GET).
 * - `write`: changes something on GitHub that other people see: a PR, an
 *   issue, a comment, a release, a repository's settings, a workflow run.
 *   The outbound policy reviews these; the command classifier asks.
 * - `local`: changes this machine's `gh` setup only (`gh auth login`,
 *   `gh extension install`, `gh config set`). It asks like any other local
 *   side effect, but there is no recipient to authorize.
 *
 * An invocation this table does not know (a new command, an alias, an
 * extension) is a `write`: `gh` can do anything an alias or extension tells
 * it to, so it fails closed. `--help` anywhere only prints help.
 *
 * Besides the kind it names where a write lands, as far as the arguments say:
 * the repositories (`-R` / `--repo`, a `GH_REPO` assignment, a PR or issue
 * URL, a `repos/<owner>/<repo>` API path, a `gh repo` positional) and the PR
 * or issue number. A repository-scoped write that names no repository uses
 * the working directory's checkout (`usesLocalRepository`); the caller
 * resolves that from the session's `origin` remote.
 *
 * The thread number is only ever used to recognise the origin thread, so it
 * is named only when the arguments name exactly one: a stray number in an
 * unlisted flag's value must not make a write look like a reply.
 *
 * Pure. The sidecar keeps a copy of the kind tables
 * (`sidecar/src/policy/shell/gh-writes.ts`), pinned equal by
 * `lib/policy/action-review/gh-targets.sidecar-parity.test.ts`.
 */

export type GhInvocationKind = "read" | "write" | "local"

export interface GhInvocation {
  kind: GhInvocationKind
  /** The command path, e.g. `pr create`, `api POST`, or `` for bare `gh`. */
  command: string
  /** Repositories the write names, as `[host/]owner/repo` or a URL. */
  repositories: string[]
  /** The PR or issue number, when the arguments name exactly one. */
  thread?: string
  /** A repository-scoped command that named no repository: it acts on the checkout. */
  usesLocalRepository: boolean
}

/** Environment assignments in effect for the invocation (`GH_REPO`, `GH_HOST`). */
export interface GhEnvironment {
  GH_REPO?: string
  GH_HOST?: string
}

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

/**
 * Groups that take a subcommand. A word after `gh` outside this set is a
 * top-level command (`gh status`) or an alias / extension.
 */
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

/** Groups whose writes act on one repository (the checkout's unless named). */
const REPOSITORY_GROUPS: ReadonlySet<string> = new Set([
  "pr",
  "issue",
  "release",
  "repo",
  "label",
  "run",
  "workflow",
  "secret",
  "variable",
  "cache",
  "ruleset",
])

/** Groups whose positional names a PR or issue. */
const THREAD_GROUPS: ReadonlySet<string> = new Set(["pr", "issue"])

/** `gh repo` writes whose first positional is the repository. */
const REPO_POSITIONAL: ReadonlySet<string> = new Set([
  "repo create",
  "repo delete",
  "repo edit",
  "repo fork",
  "repo rename",
  "repo archive",
  "repo unarchive",
  "repo sync",
])

/**
 * Flags of the write commands that take a value, so their value is not read
 * as a positional. Unlisted flags are treated as booleans; that can only make
 * a stray value look like a second positional, which drops the thread.
 */
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

/** `gh api` flags that take a value. `-F`, `-H` and `-h` mean other things there. */
const API_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-X",
  "--method",
  "-f",
  "--field",
  "-F",
  "--raw-field",
  "--input",
  "-H",
  "--header",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
])

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"])

/** The flag name of a `--flag=value` or `-Xvalue` token, and its inline value. */
function splitFlag(token: string): { flag: string; inline?: string } {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=")
    return eq === -1 ? { flag: token } : { flag: token.slice(0, eq), inline: token.slice(eq + 1) }
  }
  // `-R` alone, or `-Rowner/repo` with the value attached.
  return token.length > 2 ? { flag: token.slice(0, 2), inline: token.slice(2) } : { flag: token }
}

interface ParsedArgs {
  positionals: string[]
  /** Flag name → every value it was given. */
  values: Map<string, string[]>
  flags: Set<string>
}

function parseArgs(tokens: readonly string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = []
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1))
      break
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token)
      continue
    }
    const { flag, inline } = splitFlag(token)
    flags.add(flag)
    if (!valueFlags.has(flag)) continue
    const value = inline ?? tokens[i + 1]
    if (inline === undefined) i++
    if (value === undefined) continue
    values.set(flag, [...(values.get(flag) ?? []), value])
  }
  return { positionals, values, flags }
}

function valuesOf(parsed: ParsedArgs, ...names: string[]): string[] {
  return names.flatMap((name) => parsed.values.get(name) ?? [])
}

/** `https://github.com/o/r/pull/12` → the repository URL part and `12`. */
const THREAD_URL = /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/i

/** `repos/o/r/...` with an optional leading slash, and an issue or PR number. */
const API_REPO_PATH = /^\/?repos\/([^/\s?]+)\/([^/\s?]+)(?:\/(?:issues|pulls)\/(\d+))?/i

function withHost(spec: string, host: string | undefined): string {
  if (!host || /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.split("/").length !== 2) return spec
  return `${host}/${spec}`
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * The command path of the args after `gh` (`pr create`, `repo deploy-key
 * add`), and every other token. Cobra accepts flags anywhere, so
 * `gh pr -R o/r create` is `pr create`: flags met before the path is complete
 * are skipped, a value flag with its value, and kept for the caller.
 */
function commandPath(args: readonly string[]): { path: string; rest: string[] } {
  const words: string[] = []
  const flags: string[] = []
  const wantsWord = (): boolean => {
    if (words.length === 0) return true
    if (!GH_GROUPS.has(words[0])) return false
    if (words.length === 1) return true
    return words.length === 2 && GH_NESTED.has(`${words[0]} ${words[1]}`)
  }
  let i = 0
  for (; i < args.length && wantsWord(); i++) {
    const token = args[i]
    // `gh -- pr create` still runs `pr create`: fail closed, keep reading.
    if (token === "--") continue
    if (token.startsWith("-") && token !== "-") {
      flags.push(token)
      const { flag, inline } = splitFlag(token)
      if (inline === undefined && GH_VALUE_FLAGS.has(flag) && i + 1 < args.length) {
        flags.push(args[++i])
      }
      continue
    }
    words.push(token.toLowerCase())
  }
  return { path: words.join(" "), rest: [...flags, ...args.slice(i)] }
}

/** The `gh api` method: the last `-X` / `--method` written, else POST with a body, else GET. */
function apiMethod(rest: readonly string[]): { method: string; sendsBody: boolean } {
  let method: string | undefined
  let sendsBody = false
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
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

function classifyApi(rest: readonly string[], env: GhEnvironment): GhInvocation {
  const parsed = parseArgs(rest, API_VALUE_FLAGS)
  const { method, sendsBody } = apiMethod(rest)
  if (READ_METHODS.has(method) && !sendsBody) {
    return { kind: "read", command: `api ${method}`, repositories: [], usesLocalRepository: false }
  }
  const endpoint = parsed.positionals[0] ?? ""
  const host = valuesOf(parsed, "--hostname").pop() ?? env.GH_HOST
  const match = API_REPO_PATH.exec(endpoint)
  if (match) {
    const [, owner, repo, number] = match
    const placeholder = owner === "{owner}" || repo === "{repo}"
    return {
      kind: "write",
      command: `api ${method}`,
      repositories: placeholder ? [] : [withHost(`${owner}/${repo}`, host)],
      ...(number ? { thread: number } : {}),
      usesLocalRepository: placeholder,
    }
  }
  return { kind: "write", command: `api ${method}`, repositories: [], usesLocalRepository: false }
}

/**
 * Classify the arguments that follow `gh` (wrappers already peeled).
 * `env` carries a `GH_REPO` / `GH_HOST` assignment written before the command.
 */
export function classifyGhArgs(args: readonly string[], env: GhEnvironment = {}): GhInvocation {
  const help = args.some((arg) => arg === "--help" || arg === "-h")
  const { path, rest } = commandPath(args)
  if (path === "api") {
    return help
      ? { kind: "read", command: "api", repositories: [], usesLocalRepository: false }
      : classifyApi(rest, env)
  }
  if (help && path !== "") {
    // `-h` is `--homepage` on `gh repo create|edit`, so only a bare `--help`
    // or a `-h` with nothing to be the homepage of counts there.
    const homepage = (path === "repo create" || path === "repo edit") && !args.includes("--help")
    if (!homepage)
      return { kind: "read", command: path, repositories: [], usesLocalRepository: false }
  }
  // A bare group (`gh pr`, `gh repo deploy-key`) prints its usage.
  if (GH_READ_COMMANDS.has(path) || GH_GROUPS.has(path) || GH_NESTED.has(path)) {
    return { kind: "read", command: path, repositories: [], usesLocalRepository: false }
  }
  if (GH_LOCAL_COMMANDS.has(path)) {
    return { kind: "local", command: path, repositories: [], usesLocalRepository: false }
  }

  const group = path.split(" ")[0]
  const parsed = parseArgs(rest, GH_VALUE_FLAGS)
  const host = env.GH_HOST
  const repositories: string[] = valuesOf(parsed, "-R", "--repo").map((spec) =>
    withHost(spec, host)
  )
  const threads: string[] = []
  if (THREAD_GROUPS.has(group)) {
    for (const positional of parsed.positionals) {
      const url = THREAD_URL.exec(positional)
      if (url) {
        repositories.push(url[1])
        threads.push(url[2])
      } else if (/^#?[1-9]\d*$/.test(positional)) {
        threads.push(positional.replace(/^#/, ""))
      }
    }
  }
  const first = parsed.positionals[0]
  // `gh repo create name` names no owner: there is no repository to show.
  if (REPO_POSITIONAL.has(path) && first?.includes("/")) {
    repositories.push(withHost(first, host))
  }
  // Org- or user-level secrets and variables are not the checkout's.
  const elsewhere =
    (group === "secret" || group === "variable") &&
    ["--org", "-o", "--user", "-u"].some((flag) => parsed.flags.has(flag))
  if (repositories.length === 0 && env.GH_REPO && REPOSITORY_GROUPS.has(group) && !elsewhere) {
    repositories.push(withHost(env.GH_REPO, host))
  }
  const named = uniq(repositories)
  const distinctThreads = uniq(threads)
  return {
    kind: "write",
    command: path,
    repositories: named,
    ...(distinctThreads.length === 1 ? { thread: distinctThreads[0] } : {}),
    usesLocalRepository:
      named.length === 0 && REPOSITORY_GROUPS.has(group) && path !== "repo create" && !elsewhere,
  }
}
