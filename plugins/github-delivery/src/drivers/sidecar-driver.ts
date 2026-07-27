/**
 * SidecarIssueLoopDriver — wires the Issue → PR loop's pluggable AI driver
 * into cognia-next's existing Claude sidecar (`sidecar/claude-host.mjs`
 * + `lib/claude/ipc.ts`). The sidecar already speaks the
 * `@anthropic-ai/claude-agent-sdk` and exposes a rich built-in tool set
 * (file / git / shell / process / environment) via the in-process
 * `cognia-tools` MCP server, so the driver itself stays thin: it
 * (a) cooks a system + user prompt, (b) hands the SDK a `cwd` pointed at
 * the cloned worktree, (c) waits for `session_ended`, and (d) extracts the
 * agent's final summary.
 *
 * The driver intentionally does NOT pre-register any custom tools — the
 * sidecar's built-ins already cover the operations Issue → PR work needs.
 *
 * The operations the system prompt forbids (`git push`, the `gh` CLI) are ALSO
 * gated at the tool layer via {@link ISSUE_LOOP_PERMISSION_RULESET}. A prompt
 * is not a boundary: the issue title/body this driver is handed is
 * attacker-controlled (anyone can open an issue), so instructions in it can
 * try to talk the agent out of the prompt's rules. `permissionRuleset` is
 * enforced by the sidecar's `canUseTool` gate, where an explicit `deny`
 * hard-rejects and cannot be escalated into an approval prompt.
 */

import { interruptSession, onClaudeMessage, sendPrompt } from "@/lib/claude/ipc"
import type { ClaudeEvent } from "@cognia/agent-config-types"
import type { IssueLoopDriver } from "../workflow/issue-loop"
import { buildIssueSystemPrompt, buildIssueUserPrompt, extractSummary } from "./system-prompt"

/**
 * Tool-layer enforcement of the two operations the Issue → PR system prompt
 * forbids ("Never `git push`, never `gh` — leave the remote untouched").
 *
 * Denying the whole `Bash` tool is not an option — the agent has to run the
 * project's build and tests — so the rules are command-scoped.
 * `resolveBashPermission` splits compound commands (`a && b`, pipes) into
 * segments and takes the WORST verdict, so `cd x && git push` is denied too.
 *
 * The host pushes and opens the PR itself after the driver returns
 * (`issue-loop.ts`), so nothing legitimate needs these commands.
 */
/**
 * Global options `git` accepts BEFORE the subcommand. Without these, `git -C
 * /tmp/clone push` sails past a rule anchored on `git push`.
 *
 * `**` (not `*`): a single star is `[^/\\]*` and therefore stops at a path
 * separator, so `-C *` would MISS `-C /tmp/clone`.
 */
const GIT_GLOBAL_OPTIONS = ["-C **", "-c **", "--git-dir=**", "--work-tree=**", "--namespace=**"]

/**
 * Programs whose whole job is to exec another program, hiding it from a glob
 * anchored on the segment head (`env gh pr create`).
 */
const EXEC_WRAPPERS = ["env", "command", "sudo", "nohup", "setsid"]
const SHELL_WRAPPERS = [
  "sh -c",
  "bash -c",
  "zsh -c",
  "cmd /c",
  "powershell -Command",
  "pwsh -Command",
]

/** Every spelling of `command` this gate must refuse. */
function denySpellings(command: string): string[] {
  const [program, ...rest] = command.split(" ")
  const subcommand = rest.join(" ")
  const spellings = [command]
  if (subcommand) {
    // `git  push` — an extra space is not a glob match but is the same command.
    spellings.push(`${program}  ${subcommand}`)
    for (const option of GIT_GLOBAL_OPTIONS) {
      spellings.push(`${program} ${option} ${subcommand}`)
    }
  }
  for (const wrapper of EXEC_WRAPPERS) spellings.push(`${wrapper} ${command}`)
  for (const wrapper of SHELL_WRAPPERS) spellings.push(`${wrapper} **${command}**`)
  // Each spelling needs both the bare and the argument-bearing form.
  return spellings.flatMap((spelling) => [spelling, `${spelling} **`])
}

/**
 * Tool-layer enforcement of the operations the Issue → PR system prompt forbids
 * ("Never `git push`, never `gh` — leave the remote untouched").
 *
 * Denying the whole `Bash` tool is not an option — the agent has to run the
 * project's build and tests — so the rules are command-scoped.
 *
 * Scope of this gate, stated honestly: glob matching over the raw segment text
 * cannot tokenize a shell command, so this enumerates the realistic spellings
 * rather than proving the absence of all of them. It is defence in depth. The
 * primary control is that the clone carries no credential (the token is
 * supplied per-operation), so a push that does slip through has nothing to
 * authenticate with. The patterns deliberately do NOT use a bare `git ** push`,
 * which would also deny `git commit -m "fix the push flow"`.
 */
export const ISSUE_LOOP_PERMISSION_RULESET = {
  Bash: Object.fromEntries(
    ["git push", "git remote", "gh"].flatMap((command) =>
      denySpellings(command).map((glob) => [glob, "deny" as const])
    )
  ),
} as const

/**
 * Dependencies the driver leans on. Defaulted to the real `lib/claude/ipc`
 * helpers; tests inject mocks so they can drive the session lifecycle
 * without spawning the real sidecar.
 */
export interface SidecarDriverDeps {
  sendPrompt?: typeof sendPrompt
  interruptSession?: typeof interruptSession
  onClaudeMessage?: typeof onClaudeMessage
  now?: () => number
}

/**
 * Polling interval for the resolution loop. Exposed for tests so they can
 * tick the run forward without waiting real time.
 */
export const DEFAULT_POLL_MS = 100

export interface SidecarDriverOptions {
  /** Override the model passed to the SDK. Defaults to undefined (SDK picks). */
  model?: string
  /** Max agentic turns inside the SDK invocation. Defaults to 60. */
  maxTurns?: number
}

export class SidecarIssueLoopDriver implements IssueLoopDriver {
  private deps: Required<
    Pick<SidecarDriverDeps, "sendPrompt" | "interruptSession" | "onClaudeMessage" | "now">
  >
  private opts: SidecarDriverOptions

  constructor(deps: SidecarDriverDeps = {}, opts: SidecarDriverOptions = {}) {
    this.deps = {
      sendPrompt: deps.sendPrompt ?? sendPrompt,
      interruptSession: deps.interruptSession ?? interruptSession,
      onClaudeMessage: deps.onClaudeMessage ?? onClaudeMessage,
      now: deps.now ?? Date.now,
    }
    this.opts = opts
  }

  async run({
    workspacePath,
    repoFullName,
    issueNumber,
    issueTitle,
    issueBody,
    signal,
  }: Parameters<IssueLoopDriver["run"]>[0]): Promise<{
    summary: string
    durationMs: number
    driverId: string
  }> {
    const sessionId = `wf:gh-issue:${repoFullName}:${issueNumber}:${this.deps.now()}`
    const systemPrompt = buildIssueSystemPrompt()
    const userPrompt = buildIssueUserPrompt({
      repoFullName,
      issueNumber,
      issueTitle,
      issueBody,
    })
    const start = this.deps.now()

    let finalSummary: string | null = null
    let failure: string | null = null

    const unlisten = await this.deps.onClaudeMessage((evt: ClaudeEvent) => {
      if (!("sessionId" in evt) || evt.sessionId !== sessionId) return
      if (evt.type === "session_ended") {
        if (evt.error) {
          failure = evt.error
        } else {
          finalSummary = extractSummary(evt.result?.result ?? "")
        }
      }
    })

    const onAbort = () => {
      void this.deps.interruptSession(sessionId).catch(() => undefined)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })

    try {
      await this.deps.sendPrompt(sessionId, userPrompt, {
        cwd: workspacePath,
        systemPrompt,
        builtinTools: {
          fileExtras: true,
          git: true,
          shellAdvanced: true,
          process: true,
          environment: true,
        },
        permissionRuleset: ISSUE_LOOP_PERMISSION_RULESET,
        maxTurns: this.opts.maxTurns ?? 60,
        model: this.opts.model,
      })
    } catch (err) {
      try {
        await Promise.resolve(unlisten())
      } catch {
        /* ignore */
      }
      throw err instanceof Error ? err : new Error(String(err))
    }

    try {
      // Tick the polling loop until session_ended fires (or the abort signal
      // cuts us short). The sidecar emits session_ended for both happy-path
      // completion and SDK-internal failure, so we cover both.
      while (finalSummary === null && failure === null) {
        if (signal.aborted) {
          throw new Error("SidecarIssueLoopDriver: aborted before session_ended")
        }
        await delay(DEFAULT_POLL_MS)
      }
    } finally {
      try {
        await Promise.resolve(unlisten())
      } catch {
        /* ignore */
      }
    }

    if (failure !== null) {
      throw new Error(`SidecarIssueLoopDriver: sidecar reported error — ${failure}`)
    }
    return {
      summary: finalSummary ?? "",
      durationMs: this.deps.now() - start,
      driverId: "claude-code",
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
