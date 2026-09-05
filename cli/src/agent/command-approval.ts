/**
 * Per-command approval for the CLI's shell tools.
 *
 * The built-in tool catalogue rates a tool, not a call. `bash` is rated `high`
 * because `bash` can do anything, so every single shell call arrived at the
 * approval prompt with a `[high risk]` badge on it. Running `ls` was as
 * ceremonious as running `rm -rf`, which trains a user to hit Enter on the
 * prompt without reading it and makes the prompt worthless for the calls that
 * actually deserve one.
 *
 * The repository already has the classifier that answers the real question:
 * `lib/claude/permissions/command-safety.ts` reads the command line itself,
 * follows `&&` chains and command substitutions, understands `git status` is not
 * `git push`, escalates anything behind `sudo`, refuses to call a write redirect
 * read-only, and names catastrophes outright. It is what the desktop Auto-mode
 * runs on. This module is the seam that brings it to the CLI, so an approval
 * prompt means the call is worth reading.
 *
 * What each verdict does here:
 *   - `allow` runs without a prompt. Read-only inspection, the build and test
 *     commands a coding agent lives on, `git log`.
 *   - `ask` prompts, as before.
 *   - `deny` still prompts, and the prompt opens on Deny with the reason shown.
 *     A catastrophe is exactly the case where the person at the keyboard should
 *     decide, so this refuses to decide silently in either direction.
 *
 * Pure: no I/O, no state. Safe to call on every tool call.
 */

import {
  classifyCommand,
  type CommandClassification,
} from "@/lib/claude/permissions/command-safety"
import { extractCommand } from "@/lib/claude/permissions/command-from-tool"

/**
 * The shell tools this gate speaks for, keyed by every spelling that reaches
 * it, mapped to the name `extractCommand` knows.
 *
 * `bash` arrives namespaced from the built-in server (`mcp__cognia-tools__bash`)
 * and bare from the Anthropic SDK (`Bash`). An unlisted tool resolves to null
 * and keeps whatever approval behaviour it had.
 */
const SHELL_TOOLS: ReadonlyMap<string, string> = new Map([
  ["bash", "Bash"],
  ["Bash", "Bash"],
  ["mcp__cognia-plugin-tools__sandbox_bash", "Bash"],
  ["shell_execute_advanced", "shell_execute_advanced"],
  ["start_process", "start_process"],
])

/** Normalize only the first-party built-in server, never third-party aliases. */
export function bareToolName(name: string): string {
  const parts = name.split("__")
  return parts.length >= 3 && parts[0] === "mcp" && parts[1] === "cognia-tools"
    ? parts.slice(2).join("__")
    : name
}

/**
 * The command line a tool call would run, or null when the tool does not run
 * one. Whitespace is preserved, because the classifier parses the real text.
 */
export function shellCommandOf(toolName: string, input: unknown): string | null {
  const canonical = SHELL_TOOLS.get(bareToolName(toolName))
  if (!canonical) return null
  return extractCommand(canonical, input)
}

/** True when this tool name is one of the shell tools handled here. */
export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(bareToolName(toolName))
}

/**
 * Classify one shell tool call, or null when the call runs no command.
 *
 * A shell call with no usable command is deliberately null rather than an
 * `ask` verdict: it is a malformed payload, not a risky command, and the
 * caller's own handling of an unrecognised call is the right answer.
 */
export function classifyToolCommand(
  toolName: string,
  input: unknown
): CommandClassification | null {
  const command = shellCommandOf(toolName, input)
  if (!command) return null
  return classifyCommand(command)
}

/**
 * True when this call may run with no prompt on the strength of its command
 * alone. False for everything else, including every non-shell tool, so a caller
 * can use it as a pure widening of its existing approval rules.
 */
export function commandIsAutoApprovable(toolName: string, input: unknown): boolean {
  return classifyToolCommand(toolName, input)?.verdict === "allow"
}

/**
 * The key an "Allow always" choice is remembered under.
 *
 * A shell call is remembered as its command, not as `bash`. Approving `ls`
 * once used to buy permanent, silent permission for every future `rm -rf` and
 * `git push --force`, because the thing being remembered was the name of the
 * tool. What the user read and agreed to was a command, so a command is what
 * this stores. Internal whitespace is preserved because it can change quoted shell arguments.
 * The explicit working directory is included when supplied.
 *
 * Non-command calls include their complete payload so a file/resource grant
 * cannot authorize a different destination.
 */
export function approvalKey(toolName: string, input: unknown): string {
  const command = shellCommandOf(toolName, input)
  if (!command) return `${toolName}(${JSON.stringify(input ?? {})})`
  const workdir =
    input && typeof input === "object"
      ? ((input as Record<string, unknown>).cwd ?? (input as Record<string, unknown>).workdir)
      : undefined
  return `${toolName}(${command.trim()}${typeof workdir === "string" ? ` @ ${JSON.stringify(workdir)}` : ""})`
}

/** True when a key names one command rather than a whole tool. */
export function isCommandScopedKey(key: string): boolean {
  return key.endsWith(")") && key.includes("(")
}

/** Read back what {@link approvalKey} stored, for display. */
export function describeApprovalKey(key: string): string {
  const open = key.indexOf("(")
  if (!isCommandScopedKey(key) || open < 0) return bareToolName(key)
  return `${bareToolName(key.slice(0, open))}(${key.slice(open + 1, -1)})`
}
