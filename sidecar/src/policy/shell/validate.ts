// The allowlist gate for `shell_execute_advanced` and `start_process`.

import { ALLOWED_COMMANDS, BLOCKED_COMMANDS, DANGEROUS_PATTERNS } from "./rules.ts"

export type ShellValidation = { safe: true } | { safe: false; reason: string }

/**
 * Validate that a command name + argv is safe to execute under the
 * shell-advanced policy. Returns `{ safe: true }` on success or
 * `{ safe: false, reason }` with a user-readable explanation otherwise.
 */
export function validateShellCommand(command: unknown, args: unknown): ShellValidation {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { safe: false, reason: "command must be a non-empty string" }
  }
  // Strip a `.exe` suffix for Windows-friendly comparisons.
  const cmdLower = command.toLowerCase().replace(/\.exe$/i, "")
  if (BLOCKED_COMMANDS.has(cmdLower)) {
    return {
      safe: false,
      // Only name tools that actually exist. This used to steer the model to a
      // `file_delete` tool that has never existed anywhere in the repo.
      reason: `Command '${command}' is blocked. Use the directory_delete / file_move / terminate_process tools (with approval) instead.`,
    }
  }
  if (!ALLOWED_COMMANDS.has(cmdLower)) {
    return {
      safe: false,
      reason: `Command '${command}' is not in the allowed command list. Allowed examples: git, npm, node, python, grep, ls, cat, curl, docker, kubectl.`,
    }
  }
  const argv: unknown[] = Array.isArray(args) ? args : []
  // Reject arg arrays that contain anything but strings — anything else is
  // either a serialisation bug or a shell-injection attempt via object form.
  for (const a of argv) {
    if (typeof a !== "string") {
      return { safe: false, reason: "every argument must be a string" }
    }
  }
  const joined = argv.join(" ")
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(joined)) {
      return {
        safe: false,
        reason: `Dangerous argument pattern detected. Shell injection or chaining with destructive commands is not allowed.`,
      }
    }
  }
  return { safe: true }
}
