/**
 * The writer for the `approvedBinaries` consent ledger (v109).
 *
 * The ledger's readers — `lib/plugin/cli-tools/cli-binary-policy.ts` and
 * `lib/plugin/vscode-shim/lsp-binary-policy.ts` — landed with the v109 trust
 * rebuild, but nothing wrote to them, so their allow-branch was dead code and
 * every plugin binary re-prompted forever. This module is the only thing that
 * writes a row, and it does so on exactly one condition: the user ticked
 * "remember this binary" on the consent prompt.
 *
 * ## Why this isn't wired into the existing consent path
 *
 * It would have been a two-line change to persist a grant from
 * `execute-cli-tool.ts`'s existing broker call — and it would have been the
 * same bug we just removed. That call is **session-scoped**: "Allow once" and
 * "Always allow this session" both die on reload, and a user answering them is
 * agreeing to *this run*, not to a durable grant. Promoting that answer into a
 * ledger row would manufacture consent the user never gave. Durability needs
 * its own affirmative, so the prompt asks a second, separate question and this
 * module honours only that answer.
 *
 * ## What a row actually claims
 *
 * Only what we can verify locally: *this user approved these exact bytes at
 * this exact path for this plugin*. The hash is the whole point — it is what
 * keeps the grant from decaying into "trust this plugin's binaries forever".
 * Rebuild, update, or tamper with the file and the readers' hash comparison
 * misses, and the user is asked again.
 *
 * Reuses `hashBinaryFile` (`lib/plugin/security/binary-hash.ts`) and the
 * ledger CRUD in `lib/db/approved-binaries.ts`; adds no primitives of its own.
 */

import type { PluginPermission } from "@/types/plugin"
import type { BinaryConsentOutcome } from "./consent-broker"

export type { BinaryConsentOutcome }

export interface ConfirmBinarySpawnInput {
  pluginId: string
  /** Permission the prompt is attributed to (`cli:execute`, `lsp:spawn`, …). */
  permission: PluginPermission
  /** Absolute path of the binary about to be spawned. */
  binaryPath: string
  /** Manifest-relative path — what the user recognises from the plugin. */
  relPath: string
  /** Policy reason that triggered the prompt. */
  reason?: string
}

interface BinaryConsentDeps {
  prompt: (input: {
    pluginId: string
    permission: PluginPermission
    reason?: string
    binary: { path: string; relPath: string }
  }) => Promise<BinaryConsentOutcome>
  hashBinary: (binaryPath: string) => Promise<string | null>
  recordApproval: (input: {
    pluginId: string
    binaryPath: string
    sha256: string
  }) => Promise<unknown>
}

const defaultDeps = (): BinaryConsentDeps => ({
  prompt: async (input) => {
    const { getPluginConsentBroker } = await import("./consent-broker")
    return getPluginConsentBroker().requestBinary(input)
  },
  hashBinary: async (binaryPath) => {
    const { hashBinaryFile } = await import("./binary-hash")
    return hashBinaryFile(binaryPath)
  },
  recordApproval: async (input) => {
    const { recordBinaryApproval } = await import("@/lib/db/approved-binaries")
    return recordBinaryApproval(input)
  },
})

let deps: BinaryConsentDeps = defaultDeps()

export function configureBinaryConsent(overrides: Partial<BinaryConsentDeps>): void {
  deps = { ...deps, ...overrides }
}

export function __resetBinaryConsentForTesting(): void {
  deps = defaultDeps()
}

/**
 * Prompt for consent to spawn one plugin-shipped binary, and persist a durable
 * approval **only** when the user explicitly asked for one.
 *
 * The returned `remember` reports what actually happened, not what was
 * requested: if the bytes cannot be hashed we refuse to write a row (a ledger
 * entry we cannot verify later is worse than none — its hash would never match
 * and it would prompt anyway, while looking to the user like a live grant), and
 * the outcome says `remember: false`. `granted` is unaffected — failing to
 * remember never downgrades the consent the user just gave for this run.
 */
export async function confirmBinarySpawn(
  input: ConfirmBinarySpawnInput
): Promise<BinaryConsentOutcome> {
  const outcome = await deps.prompt({
    pluginId: input.pluginId,
    permission: input.permission,
    reason: input.reason,
    binary: { path: input.binaryPath, relPath: input.relPath },
  })

  // Session-scoped answers stop here — this is the branch that keeps a
  // one-off "yes" from silently becoming a permanent one.
  if (!outcome.granted || !outcome.remember) {
    return { granted: outcome.granted, remember: false }
  }

  const sha256 = await deps.hashBinary(input.binaryPath)
  if (!sha256) return { granted: true, remember: false }

  try {
    await deps.recordApproval({
      pluginId: input.pluginId,
      binaryPath: input.binaryPath,
      sha256,
    })
  } catch {
    // A failed write must not block the spawn the user just approved; the
    // grant simply stays session-scoped and they will be asked again.
    return { granted: true, remember: false }
  }
  return { granted: true, remember: true }
}

/**
 * Normalise a consent result that may be a bare boolean.
 *
 * Injection points typed `Promise<boolean | BinaryConsentOutcome>` accept both
 * shapes so callers that don't care about durability keep compiling. A bare
 * `true` reads as "granted, session-scoped" — the safe direction: the durable
 * path stays unreachable unless something explicitly asks for it.
 */
export function toBinaryConsentOutcome(
  result: boolean | BinaryConsentOutcome
): BinaryConsentOutcome {
  if (typeof result === "boolean") return { granted: result, remember: false }
  return { granted: result.granted === true, remember: result.remember === true }
}
