/**
 * Terminal quick fixes — faithful port of VS Code's built-in matchers
 * (`src/vs/workbench/contrib/terminalContrib/quickFix/browser/terminalQuickFixBuiltinActions.ts`).
 *
 * A quick fix is proposed when a finished command matches:
 *   1. `commandLineMatcher` against the command line,
 *   2. `commandExitResult` against the exit code (`"error"` ⇒ non-zero,
 *      `"success"` ⇒ zero — a `null` exit never matches, mirroring VS Code's
 *      requirement that shell integration reported an exit code), and
 *   3. (optional) `outputMatcher` against a window of the command output.
 *
 * `getActions` then turns the match into one or more {@link QuickFixAction}s.
 * Everything here is pure — the renderer (`terminal-instance.tsx`) supplies the
 * captured command line + output rows and dispatches the returned actions.
 *
 * Action handling (in `terminal-quick-fix.tsx`):
 *   * `run-command` — write the command into the PTY (`addNewLine` controls
 *     whether it auto-runs; suggestion-derived fixes leave it for the user to
 *     confirm, deterministic fixes auto-run, matching VS Code).
 *   * `open-url`    — open via the existing `openExternalLink` allowlist.
 *   * `kill-port`   — free the port through `remote-api.killTerminalPort`,
 *     which routes to whichever host ran the command, then re-run it (VS
 *     Code's free-port behaviour). Routed rather than `invoke`d: over
 *     ws/webrtc the busy port is the host's, not this machine's.
 */

export type CommandExitResult = "success" | "error"

export interface QuickFixOutputMatcher {
  /** Run against each line in the output window; the first match wins. */
  lineMatcher: RegExp
  /** Anchor the window at the `"top"` or `"bottom"` of the output. */
  anchor: "top" | "bottom"
  /** Rows to skip from the anchor before the window begins. */
  offset: number
  /** Window length in rows. */
  length: number
}

export interface QuickFixMatcher {
  id: string
  commandLineMatcher: RegExp
  commandExitResult: CommandExitResult
  outputMatcher?: QuickFixOutputMatcher
  getActions: (input: QuickFixActionInput) => QuickFixAction[]
}

export interface QuickFixActionInput {
  /** The full command line that was run. */
  commandLine: string
  /** All captured output rows (already trimmed of trailing blanks upstream). */
  outputLines: string[]
  /** The windowed rows the output matcher saw (per {@link QuickFixOutputMatcher}). */
  windowLines: string[]
  /** The first successful match of `outputMatcher.lineMatcher` within the window. */
  outputMatch: RegExpMatchArray | null
}

export type QuickFixAction =
  | {
      type: "run-command"
      /** Stable id (matcher id + discriminator) for React keys + dedup. */
      id: string
      /** i18n key under `terminal.quickFix.*` for the action label. */
      labelKey: string
      /** Interpolation values for the label (e.g. the suggested command). */
      labelArgs?: Record<string, string>
      command: string
      /** When true the command auto-runs (trailing `\r`); else it's filled for review. */
      addNewLine: boolean
    }
  | {
      type: "open-url"
      id: string
      labelKey: string
      labelArgs?: Record<string, string>
      url: string
    }
  | {
      type: "kill-port"
      id: string
      labelKey: string
      labelArgs?: Record<string, string>
      port: number
      /** Original command to re-run after the port is freed. */
      command: string
    }

/**
 * Slice the output rows the matcher should scan. `"bottom"` counts rows up
 * from the last line (the common case — errors print last); `"top"` counts
 * down from the first. `offset` skips rows from the anchor before the window.
 */
export function windowOutput(lines: readonly string[], matcher: QuickFixOutputMatcher): string[] {
  const { anchor, offset, length } = matcher
  if (length <= 0 || lines.length === 0) return []
  if (anchor === "bottom") {
    const end = Math.max(0, lines.length - offset)
    const start = Math.max(0, end - length)
    return lines.slice(start, end)
  }
  const start = Math.min(lines.length, offset)
  return lines.slice(start, start + length)
}

/** First line in the window that matches `lineMatcher`, with its RegExp match. */
function firstWindowMatch(
  window: readonly string[],
  lineMatcher: RegExp
): { line: string; index: number; match: RegExpMatchArray } | null {
  for (let i = 0; i < window.length; i++) {
    const match = window[i].match(lineMatcher)
    if (match) return { line: window[i], index: i, match }
  }
  return null
}

// ── Built-in matchers ──────────────────────────────────────────────────────

/** `git fcommit` → "git: 'fcommit' is not a git command. The most similar command is …". */
const gitSimilarCommand: QuickFixMatcher = {
  id: "git-similar",
  commandLineMatcher: /git/,
  commandExitResult: "error",
  outputMatcher: {
    lineMatcher: /(?:most similar commands? (?:is|are))/,
    anchor: "bottom",
    offset: 0,
    length: 10,
  },
  getActions: ({ commandLine, windowLines, outputMatch }) => {
    if (!outputMatch) return []
    const matchIndex = windowLines.findIndex((l) => l === outputMatch.input)
    // Suggestions are the indented lines that follow the "most similar" line.
    const suggestions = windowLines
      .slice(matchIndex + 1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const seen = new Set<string>()
    const actions: QuickFixAction[] = []
    for (const suggestion of suggestions) {
      // The first whitespace-delimited token is the candidate subcommand.
      const fixed = suggestion.split(/\s+/)[0]
      if (!fixed || seen.has(fixed)) continue
      seen.add(fixed)
      const command = commandLine.replace(/(\bgit\s+)([^\s]+)/, `$1${fixed}`)
      if (command === commandLine) continue
      actions.push({
        type: "run-command",
        id: `git-similar:${fixed}`,
        labelKey: "runCommand",
        labelArgs: { command },
        command,
        addNewLine: false,
      })
    }
    return actions
  },
}

/** Local branch is behind and fast-forwardable → offer `git pull`. */
const gitFastForwardPull: QuickFixMatcher = {
  id: "git-fast-forward-pull",
  commandLineMatcher: /git/,
  commandExitResult: "success",
  outputMatcher: {
    lineMatcher: /and can be fast-forwarded/,
    anchor: "bottom",
    offset: 0,
    length: 8,
  },
  getActions: () => [
    {
      type: "run-command",
      id: "git-fast-forward-pull",
      labelKey: "runCommand",
      labelArgs: { command: "git pull" },
      command: "git pull",
      addNewLine: true,
    },
  ],
}

/** `git commit -amend` → "error: did you mean `--amend` (with two dashes)?". */
const gitTwoDashes: QuickFixMatcher = {
  id: "git-two-dashes",
  commandLineMatcher: /git/,
  commandExitResult: "error",
  outputMatcher: {
    lineMatcher: /error: did you mean `--(?<dashes>[^`]+)` \(with two dashes\)/,
    anchor: "bottom",
    offset: 0,
    length: 12,
  },
  getActions: ({ commandLine, outputMatch }) => {
    const arg = outputMatch?.groups?.dashes
    if (!arg) return []
    const command = commandLine.replace(` -${arg}`, ` --${arg}`)
    if (command === commandLine) return []
    return [
      {
        type: "run-command",
        id: `git-two-dashes:${arg}`,
        labelKey: "runCommand",
        labelArgs: { command },
        command,
        addNewLine: true,
      },
    ]
  },
}

/** Any command failing with "address already in use :PORT" → free the port. */
const freePort: QuickFixMatcher = {
  id: "free-port",
  commandLineMatcher: /.+/,
  commandExitResult: "error",
  outputMatcher: {
    lineMatcher:
      /(?:address already in use (?:0\.0\.0\.0|127\.0\.0\.1|localhost|::):|Unable to bind [^ ]*:|can't listen on port |listen EADDRINUSE [^ ]*:)(?<portNumber>\d{4,5})/,
    anchor: "bottom",
    offset: 0,
    length: 30,
  },
  getActions: ({ commandLine, outputMatch }) => {
    const portStr = outputMatch?.groups?.portNumber
    const port = portStr ? Number(portStr) : Number.NaN
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return []
    return [
      {
        type: "kill-port",
        id: `free-port:${port}`,
        labelKey: "freePort",
        labelArgs: { port: String(port) },
        port,
        command: commandLine,
      },
    ]
  },
}

/** `git push` with no upstream → git prints the exact set-upstream command. */
const gitPushSetUpstream: QuickFixMatcher = {
  id: "git-push-set-upstream",
  commandLineMatcher: /git\s+push/,
  commandExitResult: "error",
  outputMatcher: {
    lineMatcher: /git push --set-upstream origin (?<branchName>[^\s]+)/,
    anchor: "bottom",
    offset: 0,
    length: 8,
  },
  getActions: ({ outputMatch }) => {
    const branch = outputMatch?.groups?.branchName
    if (!branch) return []
    const command = `git push --set-upstream origin ${branch}`
    return [
      {
        type: "run-command",
        id: `git-push-set-upstream:${branch}`,
        labelKey: "runCommand",
        labelArgs: { command },
        command,
        addNewLine: true,
      },
    ]
  },
}

/** `git push` to a fresh branch → GitHub prints a "create a pull request" URL. */
const gitCreatePr: QuickFixMatcher = {
  id: "git-create-pr",
  commandLineMatcher: /git\s+push/,
  commandExitResult: "success",
  outputMatcher: {
    lineMatcher: /remote:\s*(?<link>https:\/\/github\.com\/.+\/.+\/pull\/new\/.+)/,
    anchor: "bottom",
    offset: 0,
    length: 8,
  },
  getActions: ({ outputMatch }) => {
    const link = outputMatch?.groups?.link?.trim()
    if (!link) return []
    return [
      {
        type: "open-url",
        id: "git-create-pr",
        labelKey: "createPr",
        url: link,
      },
    ]
  },
}

/** Strip a leading/trailing single quote from a parsed token. */
function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "")
}

/** PowerShell on Unix prints `Suggestion [cmd-not-found]: …` install hints. */
const pwshUnixCommandNotFoundError: QuickFixMatcher = {
  id: "pwsh-unix-command-not-found",
  commandLineMatcher: /.+/,
  commandExitResult: "error",
  outputMatcher: {
    lineMatcher: /Suggestion \[cmd-not-found\]:/,
    anchor: "bottom",
    offset: 0,
    length: 10,
  },
  getActions: ({ windowLines }) => {
    const actions: QuickFixAction[] = []
    const seen = new Set<string>()
    const push = (command: string) => {
      const trimmed = command.trim()
      if (!trimmed || seen.has(trimmed)) return
      seen.add(trimmed)
      actions.push({
        type: "run-command",
        id: `pwsh-cmd-not-found:${trimmed}`,
        labelKey: "runCommand",
        labelArgs: { command: trimmed },
        command: trimmed,
        addNewLine: false,
      })
    }
    for (const raw of windowLines) {
      const line = raw.trim()
      // "command 'foo' from deb foo-pkg (universe)" → suggest running `foo`.
      const fromMatch = line.match(/^command\s+(['"][^'"]+['"]|\S+)\s+from\b/)
      if (fromMatch) {
        push(unquote(fromMatch[1]))
        continue
      }
      // "try: sudo apt install foo" → run the install command.
      const tryMatch = line.match(/^try:\s*(.+)$/)
      if (tryMatch) push(tryMatch[1])
    }
    return actions
  },
}

/** PowerShell's general feedback provider: `Suggestion [General]: <cmd>`. */
const pwshGeneralError: QuickFixMatcher = {
  id: "pwsh-general-error",
  commandLineMatcher: /.+/,
  commandExitResult: "error",
  outputMatcher: {
    lineMatcher: /Suggestion \[General\]:\s*(?<suggestion>.+)$/,
    anchor: "bottom",
    offset: 0,
    length: 10,
  },
  getActions: ({ outputMatch }) => {
    const suggestion = outputMatch?.groups?.suggestion?.trim()
    if (!suggestion) return []
    // The provider may list several comma-separated candidates after a colon.
    const tail = suggestion.includes(":")
      ? suggestion.slice(suggestion.indexOf(":") + 1)
      : suggestion
    const candidates = tail
      .split(/[,;]/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
    const list = candidates.length > 0 ? candidates : [suggestion]
    const seen = new Set<string>()
    const actions: QuickFixAction[] = []
    for (const command of list) {
      if (seen.has(command)) continue
      seen.add(command)
      actions.push({
        type: "run-command",
        id: `pwsh-general:${command}`,
        labelKey: "runCommand",
        labelArgs: { command },
        command,
        addNewLine: false,
      })
    }
    return actions
  },
}

/** All built-in matchers, in evaluation order. */
export const BUILTIN_QUICK_FIX_MATCHERS: readonly QuickFixMatcher[] = [
  gitSimilarCommand,
  gitFastForwardPull,
  gitTwoDashes,
  freePort,
  gitPushSetUpstream,
  gitCreatePr,
  pwshUnixCommandNotFoundError,
  pwshGeneralError,
]

export {
  gitSimilarCommand,
  gitFastForwardPull,
  gitTwoDashes,
  freePort,
  gitPushSetUpstream,
  gitCreatePr,
  pwshUnixCommandNotFoundError,
  pwshGeneralError,
  firstWindowMatch,
}
