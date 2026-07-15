/**
 * LSP binary spawn policy.
 *
 * VS Code extensions can ship language-server binaries (`rust-analyzer`,
 * `eslint-lsp`, `pylsp`, etc.) and spawn them via `child_process`. cognia
 * gates every such spawn through this module to avoid running arbitrary
 * executables that the user did not actively trust.
 *
 * ## What changed, and why (v109 trust-model rebuild)
 *
 * This policy used to allow a prompt-free spawn when the plugin's manifest
 * declared a `publisherKeyFingerprint` that matched a row in
 * `trustedPublishers`. That was not a trust check. The fingerprint was
 * **asserted by the extension about itself**, matched by **plain string
 * equality with zero cryptography**, against a table seeded with
 * `"placeholder:*"` strings **committed to this repo**. Any hostile `.vsix`
 * could declare `"placeholder:microsoft.vscode"` and spawn its own bundled
 * binary silently. No proof of possession existed anywhere in the chain.
 *
 * The self-asserted-fingerprint branch is gone. It is not weakened, gated, or
 * kept behind a flag — a claim a plugin makes about itself can never be
 * evidence about that plugin, so there is nothing here to salvage.
 *
 * ## Decision tree
 *
 *   1. Binary **outside** the plugin's install directory → prompt. Always.
 *      A path that escaped the install dir means a tampered install or a
 *      globally-resolved binary; neither is covered by an approval.
 *   2. Binary inside, but **no approval** in the `approvedBinaries` ledger for
 *      this exact `(pluginId, binaryPath)` → prompt.
 *   3. Binary inside and approved, but the file's **SHA-256 differs** from the
 *      approved hash (or cannot be computed) → prompt. The bytes changed since
 *      consent — an update, a swap, or tampering. Identical from here.
 *   4. Binary inside, approved, hash matches → allow, no prompt.
 *   5. Theme-only / data-only extensions never reach this code path; the
 *      caller is responsible for that gate.
 *
 * The consequence is deliberate: **every** bundled binary prompts on first
 * execution. With no honest way to establish publisher identity (see
 * `lib/db/seed/trusted-publishers.ts`), that is the only default we can state
 * truthfully.
 *
 * `isUnsignedLspAllowed` (Settings → Developer, dev builds only) still relaxes
 * a prompt into allow+prompt, and every decision is still logged to
 * `automationAuditLog` (schema v28) so the user has a complete history of
 * which extensions ran which binaries.
 *
 * The policy module is pure TypeScript: it reads from Dexie and writes audit
 * rows, but it has no Tauri dependency. The Rust capabilities layer
 * (`src-tauri/src/plugin_api/vscode/capabilities/process.rs`) invokes this
 * policy through a Tauri command before allowing `Command::spawn` to proceed.
 */

import { getDb, type ApprovedBinaryRow, type AutomationAuditLogRow } from "@/lib/db/schema"

export interface LspBinaryEvaluationInput {
  pluginId: string
  /** Absolute path to the binary the extension wants to spawn. */
  binaryPath: string
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
  /**
   * Look up the user's approval for this exact `(pluginId, binaryPath)`.
   * Returns `undefined` when the user has never approved this binary.
   */
  findApprovedBinary: (
    pluginId: string,
    binaryPath: string
  ) => Promise<ApprovedBinaryRow | undefined>
  /**
   * SHA-256 (lower-case hex) of the bytes currently on disk, or `null` when
   * the file cannot be read/hashed. `null` is treated as "identity unproven"
   * and always prompts — never as "fine".
   */
  hashBinary: (binaryPath: string) => Promise<string | null>
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

function defaultDeps(): PolicyDeps {
  return {
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
    isUnsignedLspAllowed: defaultIsUnsignedLspAllowed,
    now: () => Date.now(),
  }
}

let deps: PolicyDeps = defaultDeps()

export function configureLspBinaryPolicy(overrides: Partial<PolicyDeps>): void {
  deps = { ...deps, ...overrides }
}

export function __resetLspBinaryPolicyForTesting(): void {
  deps = defaultDeps()
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

/**
 * Resolve the spawn decision for one LSP binary.
 *
 * Note what this function does NOT accept: any publisher identity claim. The
 * input carries only facts we can verify ourselves — which plugin, which path,
 * which install dir — and the bytes on disk do the rest.
 */
export async function evaluateLspBinary(
  input: LspBinaryEvaluationInput
): Promise<LspBinaryEvaluation> {
  let decision: LspBinaryEvaluation

  if (!isInside(input.binaryPath, input.pluginPath)) {
    // Short-circuit before hashing: nothing outside the install dir can be
    // covered by an approval, so there is no point reading the file.
    decision = {
      allowed: false,
      requiresPrompt: true,
      reason:
        "Binary path resolves outside the plugin install directory; explicit user consent required.",
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

  // Dev-mode override: if the user has explicitly opted-in to "allow
  // unsigned LSP binaries" in Settings → Developer, replace any
  // `allowed: false, requiresPrompt: true` decision with a one-time
  // prompt + allow grant. Already-approved decisions and the unprompted
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
