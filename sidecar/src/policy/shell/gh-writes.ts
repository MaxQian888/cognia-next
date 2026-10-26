// Which `gh` (GitHub CLI) invocations in a shell command write to GitHub
// (ADR-0239 phase 2), for the always-ask on shell `gh` writes
// (`SendOptions.alwaysExplicitGithubWritesMode`, ../permission/permission-classes.ts).
//
// The classifier itself is the host's, generated into
// `./gh-command.generated.ts` from
// `packages/plugin-contract/src/lib/claude/permissions/gh-command.ts`
// (`scripts/build/gen-sidecar-gh-command.mjs`): the sidecar cannot import the
// host's packages. Only the kind is used here (`read`, `write`, `local`);
// where a write lands is the host's question. This module finds the `gh`
// invocations in a shell command line. An invocation the tables do not know
// (a new command, an alias, an extension) is a write: it fails closed.

import { classifyGhArgs, type GhInvocationKind } from "./gh-command.generated.ts"
import { normalizeHead, peelWrappers, tokenize } from "./interactive.ts"
import { extractSubstitutions, splitTopLevel } from "./segments.ts"

export {
  GH_API_BODY_FLAGS,
  GH_GROUPS,
  GH_LOCAL_COMMANDS,
  GH_NESTED,
  GH_READ_COMMANDS,
  GH_VALUE_FLAGS,
  type GhInvocationKind,
} from "./gh-command.generated.ts"

/** The kind of the invocation whose arguments follow `gh` (wrappers already peeled). */
export function ghInvocationKind(args: readonly string[]): GhInvocationKind {
  return classifyGhArgs(args).kind
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
