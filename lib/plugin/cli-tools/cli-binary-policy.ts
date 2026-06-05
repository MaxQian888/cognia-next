/**
 * Trust policy for plugin-shipped CLI binaries (`binary.kind: "plugin-dir"`).
 *
 * Mirrors the LSP binary spawn policy's decision tree
 * (`lib/plugin/vscode-shim/lsp-binary-policy.ts`) with CLI-specific audit
 * rows and WITHOUT the LSP dev-mode override:
 *
 *   1. binary inside the plugin install dir AND the publisher's Ed25519
 *      fingerprint is in the `trustedPublishers` ledger → allow silently
 *   2. anything else → `requiresPrompt` (the executor routes through the
 *      consent broker for a one-time session grant)
 *
 * Every decision lands in `automationAuditLog` (surface: "plugin").
 */

import { getDb, type AutomationAuditLogRow, type TrustedPublisherRow } from "@/lib/db/schema"

export interface CliBinaryEvaluationInput {
  pluginId: string
  /** Absolute path of the binary the tool wants to run. */
  binaryPath: string
  /** Base64 Ed25519 fingerprint from `manifest.author.publicKey`, if any. */
  publisherFingerprint?: string
  /** Absolute plugin install directory. */
  pluginPath: string
}

export interface CliBinaryEvaluation {
  allowed: boolean
  requiresPrompt: boolean
  reason: string
}

interface PolicyDeps {
  findTrustedPublisherByFingerprint: (
    fingerprint: string
  ) => Promise<TrustedPublisherRow | undefined>
  appendAudit: (row: AutomationAuditLogRow) => Promise<void>
  now: () => number
}

const defaultDeps = (): PolicyDeps => ({
  findTrustedPublisherByFingerprint: async (fingerprint) =>
    getDb().trustedPublishers.where("fingerprint").equals(fingerprint).first(),
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

export async function evaluateCliBinary(
  input: CliBinaryEvaluationInput
): Promise<CliBinaryEvaluation> {
  const inside = isInside(input.binaryPath, input.pluginPath)
  const trusted = input.publisherFingerprint
    ? await deps.findTrustedPublisherByFingerprint(input.publisherFingerprint)
    : undefined

  let decision: CliBinaryEvaluation
  if (!inside) {
    // Manifest validation already rejects traversal, so an outside path here
    // means a tampered install — never silently allow.
    decision = {
      allowed: false,
      requiresPrompt: true,
      reason: "Binary path resolves outside the plugin install directory.",
    }
  } else if (trusted) {
    decision = {
      allowed: true,
      requiresPrompt: false,
      reason: `Publisher fingerprint ${input.publisherFingerprint} is trusted and the binary is inside the plugin install directory.`,
    }
  } else if (input.publisherFingerprint) {
    decision = {
      allowed: false,
      requiresPrompt: true,
      reason: `Publisher fingerprint ${input.publisherFingerprint} is not in the trustedPublishers ledger.`,
    }
  } else {
    decision = {
      allowed: false,
      requiresPrompt: true,
      reason: "Plugin manifest has no publisher fingerprint; explicit user consent required.",
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
