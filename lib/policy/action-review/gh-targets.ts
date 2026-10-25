/**
 * Where the `gh` (GitHub CLI) writes in a shell command land (ADR-0239
 * phase 2).
 *
 * Every segment counts, including ones inside `$(…)` and behind `sudo` /
 * `env` wrappers; each is classified by
 * `@cognia/plugin-contract/lib/claude/permissions/gh-command`. A write becomes
 * a `repository` target with the PR or issue it goes to as its `thread`, or
 * {@link unknownGithubTarget} when no repository can be named. A write that
 * names none lands on the checkout: the caller passes the checkout's `origin`
 * remote as `localRepository`.
 *
 * Pure, so the CLI tool host can use it. The sidecar decides the same
 * write-or-not question for its always-ask with its own copy
 * (`sidecar/src/policy/shell/gh-writes.ts`), pinned by
 * `gh-targets.sidecar-parity.test.ts`.
 */

import { splitCommandSegments } from "@/lib/claude/permissions/command-parse"
import { extractCommand } from "@/lib/claude/permissions/command-from-tool"
import { peelCommandWrappers } from "@/lib/claude/permissions/command-safety"
import { normalizeToolId, SHELL_TOOL_IDS } from "@/lib/policy/risk/outbound-tools"
import {
  classifyGhArgs,
  type GhEnvironment,
  type GhInvocation,
} from "@cognia/plugin-contract/lib/claude/permissions/gh-command"

import { repositoryTarget, unknownGithubTarget, type OutboundTarget } from "./outbound-targets"

/** Assignments written before a command's head: `GH_REPO=o/r gh pr create`. */
const LEADING_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))\s+/

function leadingAssignments(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  let rest = raw.trimStart()
  for (let match = LEADING_ASSIGNMENT.exec(rest); match; match = LEADING_ASSIGNMENT.exec(rest)) {
    out[match[1]] = match[2] ?? match[3] ?? match[4] ?? ""
    rest = rest.slice(match[0].length)
  }
  return out
}

function ghEnvironment(assignments: Record<string, string>): GhEnvironment {
  return {
    ...(assignments.GH_REPO ? { GH_REPO: assignments.GH_REPO } : {}),
    ...(assignments.GH_HOST ? { GH_HOST: assignments.GH_HOST } : {}),
  }
}

/** Every `gh` invocation in a command line, in order, with its classification. */
export function ghInvocations(command: string): GhInvocation[] {
  const out: GhInvocation[] = []
  for (const segment of splitCommandSegments(command)) {
    const peeled = peelCommandWrappers(segment.head, segment.args)
    if (!peeled || peeled.head !== "gh") continue
    const env = ghEnvironment({ ...leadingAssignments(segment.raw), ...peeled.assignments })
    out.push(classifyGhArgs(peeled.args, env))
  }
  return out
}

/** True when some segment of the command writes to GitHub with `gh`. */
export function commandHasGhWrite(command: string): boolean {
  return ghInvocations(command).some((invocation) => invocation.kind === "write")
}

export interface GhTargetContext {
  /**
   * The checkout's `origin` remote, for a write that names no repository.
   * Ignored for a command that changes directory (`cd`, `pushd`): its `gh`
   * may run in another checkout, so such a write names no repository.
   */
  localRepository?: string
}

const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"])

/** True when some segment of the command changes the working directory. */
export function commandChangesDirectory(command: string): boolean {
  return splitCommandSegments(command).some((segment) => {
    const peeled = peelCommandWrappers(segment.head, segment.args)
    return DIRECTORY_CHANGERS.has((peeled?.head ?? segment.head).toLowerCase())
  })
}

/** Each target once, a repository with different threads kept apart. */
export function dedupeGithubTargets(targets: OutboundTarget[]): OutboundTarget[] {
  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = `${target.channel}|${target.recipient}|${target.thread ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function invocationTargets(invocation: GhInvocation, context: GhTargetContext): OutboundTarget[] {
  const named =
    invocation.repositories.length > 0
      ? invocation.repositories
      : invocation.usesLocalRepository && context.localRepository
        ? [context.localRepository]
        : []
  if (named.length === 0) return [unknownGithubTarget()]
  // A thread belongs to one repository; with two named, it is no one's.
  const thread = named.length === 1 ? invocation.thread : undefined
  return named.map((spec) => repositoryTarget(spec, thread) ?? unknownGithubTarget())
}

/** Where a command's `gh` writes land, deduplicated. `[]` when it writes nothing. */
export function ghWriteTargets(command: string, context: GhTargetContext = {}): OutboundTarget[] {
  const writes = ghInvocations(command).filter((invocation) => invocation.kind === "write")
  if (writes.length === 0) return []
  const effective = commandChangesDirectory(command) ? {} : context
  return dedupeGithubTargets(
    writes.flatMap((invocation) => invocationTargets(invocation, effective))
  )
}

/** Shell tools by registered name, mapped to the input shape `extractCommand` reads. */
const SHELL_TOOLS: Readonly<Record<string, string>> = {
  bash: "Bash",
  sandbox_bash: "Bash",
  shell_execute_advanced: "shell_execute_advanced",
  start_process: "start_process",
}

/**
 * The tool names whose calls run a shell command, by registered name: the
 * shared list in `outbound-tools.ts`, each with its input shape above.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = SHELL_TOOL_IDS

/** The command line a shell tool call runs, or null for any other tool. */
export function shellCommandOf(toolName: string, input: unknown): string | null {
  const shape = SHELL_TOOLS[normalizeToolId(toolName)]
  return shape ? extractCommand(shape, input) : null
}
