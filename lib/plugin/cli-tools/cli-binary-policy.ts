/**
 * Trust policy for plugin-shipped CLI binaries (`binary.kind: "plugin-dir"`).
 *
 * Mirrors the LSP binary spawn policy
 * (`lib/plugin/vscode-shim/lsp-binary-policy.ts`) with CLI-specific audit rows
 * and WITHOUT the LSP dev-mode override.
 *
 * ## What changed, and why (v109 trust-model rebuild)
 *
 * This policy used to allow a silent spawn when `manifest.author.publicKey`
 * matched a row in `trustedPublishers` — the same self-assertion flaw as the
 * LSP path: the plugin named its own publisher key, the lookup was plain
 * string equality with zero cryptography, and the table was seeded with
 * `"placeholder:*"` strings committed to this repo. That branch is gone.
 *
 * ## Decision tree
 *
 *   1. binary outside the plugin install dir → prompt
 *   2. no approval in the `approvedBinaries` ledger (v109) for this exact
 *      `(pluginId, binaryPath)` → prompt
 *   3. approved but the file's SHA-256 differs from the approved hash, or
 *      cannot be computed → prompt
 *   4. approved, inside, hash matches → allow silently
 *
 * Anything that prompts routes through the consent broker for a one-time
 * session grant. Every decision lands in `automationAuditLog`
 * (surface: "plugin").
 */

import { getDb, type ApprovedBinaryRow, type AutomationAuditLogRow } from "@/lib/db/schema"

export interface CliBinaryEvaluationInput {
  pluginId: string
  /** Absolute path of the binary the tool wants to run. */
  binaryPath: string
  /** Absolute plugin install directory. */
  pluginPath: string
}

export interface CliBinaryEvaluation {
  allowed: boolean
  requiresPrompt: boolean
  reason: string
}

interface PolicyDeps {
  /** The user's approval for this exact `(pluginId, binaryPath)`, if any. */
  findApprovedBinary: (
    pluginId: string,
    binaryPath: string
  ) => Promise<ApprovedBinaryRow | undefined>
  /**
   * SHA-256 (lower-case hex) of the bytes currently on disk, or `null` when
   * the file cannot be read/hashed. `null` always prompts.
   */
  hashBinary: (binaryPath: string) => Promise<string | null>
  appendAudit: (row: AutomationAuditLogRow) => Promise<void>
  now: () => number
}

const defaultDeps = (): PolicyDeps => ({
  findApprovedBinary: async (pluginId, binaryPath) => {
    const { findApprovedBinary } = await import("@/lib/db/approved-binaries")
    return findApprovedBinary(pluginId, binaryPath)
  },
  hashBinary: async (binaryPath) => {
    const { hashBinaryFile } = await import("@/lib/plugin/security/binary-hash")
    return hashBinaryFile(binaryPath)
  },
  appendAudit: async (row) => {
    await getDb().automationAuditLog.add(row)
  },
  now: () => Date.now(),
})

let deps: PolicyDeps = defaultDeps()

export function configureCliBinaryPolicy(overrides: Partial<PolicyDeps>): void {
  deps = { ...deps, ...overrides }
}

export function __resetCliBinaryPolicyForTesting(): void {
  deps = defaultDeps()
}

function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase()
}

function isInside(child: string, parent: string): boolean {
  const c = normalisePath(child)
  const p = normalisePath(parent)
  if (c === p) return false
  return c.startsWith(p + "/")
}

function makeAuditId(): string {
  return `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Resolve the spawn decision for one plugin-dir CLI binary.
 *
 * Takes no publisher identity claim — only facts we can verify locally, plus
 * the bytes on disk.
 */
export async function evaluateCliBinary(
  input: CliBinaryEvaluationInput
): Promise<CliBinaryEvaluation> {
  let decision: CliBinaryEvaluation

  if (!isInside(input.binaryPath, input.pluginPath)) {
    // Manifest validation already rejects traversal, so an outside path here
    // means a tampered install — never silently allow.
    decision = {
      allowed: false,
      requiresPrompt: true,
      reason: "Binary path resolves outside the plugin install directory.",
    }
  } else {
    const approval = await deps.findApprovedBinary(input.pluginId, input.binaryPath)
    if (!approval) {
      decision = {
        allowed: false,
        requiresPrompt: true,
        reason: "No recorded user approval for this binary; explicit user consent required.",
      }
    } else {
      const actual = await deps.hashBinary(input.binaryPath)
      if (!actual) {
        decision = {
          allowed: false,
          requiresPrompt: true,
          reason:
            "Binary could not be read or hashed; its identity cannot be confirmed against the approval.",
        }
      } else if (actual !== approval.sha256) {
        decision = {
          allowed: false,
          requiresPrompt: true,
          reason: `Binary contents changed since it was approved (approved ${approval.sha256}, found ${actual}); re-approval required.`,
        }
      } else {
        decision = {
          allowed: true,
          requiresPrompt: false,
          reason: `User approved this exact binary (sha256 ${approval.sha256}) and it is inside the plugin install directory.`,
        }
      }
    }
  }

  await deps
    .appendAudit({
      id: makeAuditId(),
      ts: deps.now(),
      surface: "plugin",
      pluginId: input.pluginId,
      command: input.binaryPath,
      processName: input.binaryPath.split(/[\\/]/).pop() ?? null,
      windowTitle: null,
      decision: decision.allowed ? "allow" : "consent",
      reason: decision.reason,
      durationMs: 0,
      error: null,
    })
    .catch(() => {
      // Audit logging is best-effort; never block a decision.
    })

  return decision
}
