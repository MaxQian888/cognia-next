/**
 * LSP binary spawn policy.
 *
 * VS Code extensions can ship language-server binaries (`rust-analyzer`,
 * `eslint-lsp`, `pylsp`, etc.) and spawn them via `child_process`. cognia
 * gates every such spawn through this module to avoid running arbitrary
 * executables that the user did not actively trust.
 *
 * Decision tree:
 *
 *   1. If the binary path is **inside the plugin's installation directory**
 *      AND the publisher's Ed25519 fingerprint exists in the
 *      `trustedPublishers` ledger (schema v29) → allow without prompt.
 *   2. If the publisher is known but the binary is outside the plugin
 *      directory (e.g. a globally-installed `node_modules/.bin/*`) →
 *      `requiresPrompt = true` (one-time consent through cognia's
 *      permission UI).
 *   3. If the publisher is not in the ledger → `requiresPrompt = true`.
 *   4. Theme-only / data-only extensions never reach this code path; the
 *      caller is responsible for that gate.
 *
 * Every decision is logged to `automationAuditLog` (schema v28) so the
 * user has a complete history of which extensions ran which binaries.
 *
 * The policy module is pure TypeScript: it reads from Dexie and writes
 * audit rows, but it has no Tauri dependency. The Rust capabilities
 * layer (`src-tauri/src/plugin_api/vscode/capabilities/process.rs`)
 * invokes this policy through a Tauri command before allowing
 * `Command::spawn` to proceed.
 */

import { getDb, type AutomationAuditLogRow, type TrustedPublisherRow } from "@/lib/db/schema"

export interface LspBinaryEvaluationInput {
  pluginId: string
  /** Absolute path to the binary the extension wants to spawn. */
  binaryPath: string
  /** Base64-encoded Ed25519 fingerprint from the plugin's manifest, if any. */
  publisherFingerprint?: string
  /** Absolute path to the plugin's installation directory (the unzipped
   *  .vsix). Used for the "is the binary inside the plugin?" check. */
  pluginPath: string
}

export interface LspBinaryEvaluation {
  /** True when the spawn is allowed straight away. */
  allowed: boolean
  /** True when the spawn should prompt the user. Mutually exclusive with
   *  `allowed` for the synchronous decision; once the user grants, the
   *  Rust side caches the consent and re-runs the policy with
   *  `prompted: true` injected. */
  requiresPrompt: boolean
  /** Human-readable explanation; surfaced in the consent dialog and the
   *  audit row. */
  reason: string
}

interface PolicyDeps {
  findTrustedPublisherByFingerprint: (
    fingerprint: string
  ) => Promise<TrustedPublisherRow | undefined>
  appendAudit: (row: AutomationAuditLogRow) => Promise<void>
  /**
   * Returns `true` when the user has opted-in to "allow unsigned LSP
   * binaries with one-time consent" in Settings → Developer. Production
   * builds always return `false`; dev builds consult the settings store.
   *
   * Default implementation reads `settings.developer.unsignedLspAllowed`
   * via the settings store. Tests override this with a synchronous
   * boolean.
   */
  isUnsignedLspAllowed: () => Promise<boolean>
  now: () => number
}

async function defaultIsUnsignedLspAllowed(): Promise<boolean> {
  // Production builds hide the toggle entirely — short-circuit so the
  // settings store import never even loads in a release bundle.
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return false
  try {
    const settings = await getDb().settings.get("singleton")
    return Boolean(settings?.developer?.unsignedLspAllowed)
  } catch {
    return false
  }
}

let deps: PolicyDeps = {
  findTrustedPublisherByFingerprint: async (fingerprint) => {
    return getDb().trustedPublishers.where("fingerprint").equals(fingerprint).first()
  },
  appendAudit: async (row) => {
    await getDb().automationAuditLog.add(row)
  },
  isUnsignedLspAllowed: defaultIsUnsignedLspAllowed,
  now: () => Date.now(),
}

export function configureLspBinaryPolicy(overrides: Partial<PolicyDeps>): void {
  deps = { ...deps, ...overrides }
}

export function __resetLspBinaryPolicyForTesting(): void {
  deps = {
    findTrustedPublisherByFingerprint: async (fingerprint) => {
      return getDb().trustedPublishers.where("fingerprint").equals(fingerprint).first()
    },
    appendAudit: async (row) => {
      await getDb().automationAuditLog.add(row)
    },
    isUnsignedLspAllowed: defaultIsUnsignedLspAllowed,
    now: () => Date.now(),
  }
}

/**
 * Normalise a filesystem path so prefix comparisons are stable across
 * platforms. Strips trailing slashes and folds backslashes to slashes.
 */
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
  return `lsp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function evaluateLspBinary(
  input: LspBinaryEvaluationInput
): Promise<LspBinaryEvaluation> {
  const inside = isInside(input.binaryPath, input.pluginPath)
  const trusted = input.publisherFingerprint
    ? await deps.findTrustedPublisherByFingerprint(input.publisherFingerprint)
    : undefined

  let decision: LspBinaryEvaluation
  if (trusted && inside) {
    decision = {
      allowed: true,
      requiresPrompt: false,
      reason: `Publisher fingerprint ${input.publisherFingerprint} is trusted and the binary is inside the plugin install directory.`,
    }
  } else if (trusted) {
    decision = {
      allowed: false,
      requiresPrompt: true,
      reason: `Publisher fingerprint ${input.publisherFingerprint} is trusted but the binary lives outside the plugin install directory.`,
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

  // Dev-mode override: if the user has explicitly opted-in to "allow
  // unsigned LSP binaries" in Settings → Developer, replace any
  // `allowed: false, requiresPrompt: true` decision with a one-time
  // prompt + allow grant. Already-trusted decisions and the unprompted
  // happy path are untouched. The audit reason makes the override
  // visible.
  if (!decision.allowed && decision.requiresPrompt) {
    try {
      const dev = await deps.isUnsignedLspAllowed()
      if (dev) {
        decision = {
          allowed: true,
          requiresPrompt: true,
          reason: `Dev-mode override (settings.developer.unsignedLspAllowed). Original reason: ${decision.reason}`,
        }
      }
    } catch {
      // Failure to read the toggle is treated as "off" — never relax
      // the gate when the settings store is unreadable.
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
