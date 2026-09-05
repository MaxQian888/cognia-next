/**
 * Terminal permission gate.
 *
 * The sidecar only emits a `permission_request` for tools that actually need
 * approval (read-only tools auto-run upstream), so this gate is purely the
 * approval *policy*:
 *   - `--yes` / bypass → allow everything asked.
 *   - allowlist        → allow named tools.
 *   - read-only shell  → allow, from the command itself (see below).
 *   - interactive      → ask the user via the injected `prompt`.
 *   - otherwise        → deny with an actionable message (headless default).
 *
 * The shell rung is the one that used to be missing. `bash` is a single tool
 * rated by the worst thing it can do, so a headless run denied `ls` and
 * `git status` exactly as hard as `rm -rf /`, and the only way past it was
 * `--yes`, which turns the whole gate off. Classifying the command line lets a
 * read-only call through without asking anyone to disarm anything.
 *
 * It plugs into `runAndCaptureAssistantReply`'s `onPermissionRequest` seam, so
 * the CLI reuses the desktop's exact approval round-trip.
 */

import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"

import { commandIsAutoApprovable } from "./command-approval"

export type PermissionResponder = (
  req: PermissionRequestEvent
) => Promise<CapturePermissionDecision>

export interface PermissionGateOptions {
  /** Approve every asked tool (`--yes` / non-interactive CI). */
  yes?: boolean
  /** Tool names that are always allowed (e.g. `--allow write,edit`). */
  allow?: string[]
  /**
   * Interactive approver. When provided, unmatched requests are asked instead
   * of denied. Resolves `true` to allow, `false` to deny. Throwing → deny.
   */
  prompt?: (req: PermissionRequestEvent) => Promise<boolean>
}

const allowDecision = (): CapturePermissionDecision => ({ decision: "allow" })

function denyDecision(toolName: string): CapturePermissionDecision {
  return {
    decision: "deny",
    message: `Denied "${toolName}". Re-run with --yes, or --allow ${toolName} to permit it.`,
  }
}

/** Build the permission responder for a run. */
export function createPermissionGate(opts: PermissionGateOptions): PermissionResponder {
  const allowSet = new Set(opts.allow ?? [])
  return async (req) => {
    if (opts.yes) return allowDecision()
    if (allowSet.has(req.toolName)) return allowDecision()
    if (commandIsAutoApprovable(req.toolName, req.input)) return allowDecision()
    if (opts.prompt) {
      try {
        return (await opts.prompt(req)) ? allowDecision() : denyDecision(req.toolName)
      } catch {
        return denyDecision(req.toolName)
      }
    }
    return denyDecision(req.toolName)
  }
}
