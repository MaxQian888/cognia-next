/**
 * Host-local receipts for Cognia-managed external-Agent runtimes.
 *
 * A receipt is the proof of what is installed: which version, from which
 * provider and source, into which root, hashing to what, and whether it passed
 * its health check. Without one there is no honest answer to "what is actually
 * running", and no basis for an uninstall that removes only files Cognia owns.
 *
 * Desktop and CLI/TUI share this schema and the catalog but never a directory:
 * each host installs, certifies and removes its own copy, so a receipt is
 * meaningless off the machine that wrote it. That is also why `hostId` is
 * recorded — a receipt copied between machines must be rejected, not trusted.
 *
 * The rollback slot is deliberately singular. Keeping every previous install
 * would turn an unbounded directory into the thing nobody prunes; keeping one
 * healthy predecessor is enough to undo the update that just broke.
 *
 * @see types/agent/external-agent-lifecycle.ts
 */

import type {
  ExternalAgentRuntimeHealth,
  ExternalAgentRuntimeReceipt,
  ExternalAgentRuntimeRollbackSlot,
} from "@/types/agent/external-agent-lifecycle"
import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"

/** Where receipts are persisted. One implementation per host. */
export interface ReceiptStore {
  load(runtimeId: string): Promise<ExternalAgentRuntimeReceipt | null>
  save(receipt: ExternalAgentRuntimeReceipt): Promise<void>
  delete(runtimeId: string): Promise<void>
}

/** Deterministic receipt id for one (runtime, version, provider, install time). */
export function receiptId(
  runtimeId: string,
  version: string,
  provider: string,
  installedAt: string
): string {
  return `${runtimeId}@${version}+${provider}@${installedAt}`
}

export interface BuildReceiptInput {
  runtimeId: string
  version: string
  provider: ExternalAgentRuntimeReceipt["provider"]
  providerVersion: string
  source: string
  installRoot: string
  entrypoint: string
  treeDigest: string
  lockDigest?: string
  integrity?: ExternalAgentRuntimeReceipt["integrity"]
  health: ExternalAgentRuntimeHealth
  installedAt: string
  activatedAt?: string
  /** The receipt being replaced, if any — becomes the rollback slot. */
  replacing?: ExternalAgentRuntimeReceipt | null
}

/**
 * Build the receipt for a completed install.
 *
 * The rollback slot only ever holds a HEALTHY predecessor. Promoting an
 * unhealthy one would offer the user a rollback to something already known not
 * to work, which is worse than offering no rollback at all.
 */
export function buildReceipt(input: BuildReceiptInput): ExternalAgentRuntimeReceipt {
  const previous = rollbackSlotFrom(input.replacing)

  return {
    receiptId: receiptId(input.runtimeId, input.version, input.provider, input.installedAt),
    runtimeId: input.runtimeId,
    version: input.version,
    provider: input.provider,
    providerVersion: input.providerVersion,
    source: input.source,
    installRoot: input.installRoot,
    entrypoint: input.entrypoint,
    integrity: input.integrity,
    lockDigest: input.lockDigest,
    treeDigest: input.treeDigest,
    installedAt: input.installedAt,
    activatedAt: input.activatedAt,
    health: input.health,
    ...(previous ? { previous } : {}),
  }
}

/** Reduce a receipt to the rollback slot it would become, if it is eligible. */
export function rollbackSlotFrom(
  receipt: ExternalAgentRuntimeReceipt | null | undefined
): ExternalAgentRuntimeRollbackSlot | undefined {
  if (!receipt || !receipt.health.healthy) return undefined
  return {
    receiptId: receipt.receiptId,
    version: receipt.version,
    installRoot: receipt.installRoot,
    entrypoint: receipt.entrypoint,
    treeDigest: receipt.treeDigest,
    activatedAt: receipt.activatedAt,
  }
}

/** Does this receipt still have somewhere to roll back to? */
export function canRollback(receipt: ExternalAgentRuntimeReceipt | null | undefined): boolean {
  return Boolean(receipt?.previous)
}

/**
 * Turn a rollback slot back into the active receipt.
 *
 * The restored receipt keeps NO rollback slot of its own: the install it is
 * undoing is the thing that just failed, and offering to "roll back" to it
 * again would walk the user in a circle.
 */
export function receiptFromRollback(
  receipt: ExternalAgentRuntimeReceipt,
  activatedAt: string
): ExternalAgentRuntimeReceipt {
  const slot = receipt.previous
  if (!slot) {
    throw new ExternalAgentLifecycleError(
      "runtime_missing",
      `no rollback slot is retained for ${receipt.runtimeId}`,
      { runtimeId: receipt.runtimeId }
    )
  }

  return {
    receiptId: slot.receiptId,
    runtimeId: receipt.runtimeId,
    version: slot.version,
    provider: receipt.provider,
    providerVersion: receipt.providerVersion,
    source: receipt.source,
    installRoot: slot.installRoot,
    entrypoint: slot.entrypoint,
    treeDigest: slot.treeDigest,
    installedAt: receipt.installedAt,
    activatedAt,
    health: {
      healthy: true,
      checkedAt: activatedAt,
      findings: [],
    },
  }
}

/**
 * Has the installed tree changed since the receipt was written?
 *
 * A managed root Cognia owns should never drift. When it has, the receipt is no
 * longer a description of what would launch, and the caller must refuse rather
 * than run something unaccounted for.
 */
export function receiptMatchesTree(
  receipt: ExternalAgentRuntimeReceipt,
  observedTreeDigest: string
): boolean {
  return receipt.treeDigest === observedTreeDigest
}

/** A health result with no findings, for a check that passed cleanly. */
export function healthyAt(checkedAt: string): ExternalAgentRuntimeHealth {
  return { healthy: true, checkedAt, findings: [] }
}

/** A failed health result carrying one non-localized finding. */
export function unhealthyAt(
  checkedAt: string,
  code: string,
  detail: string
): ExternalAgentRuntimeHealth {
  return {
    healthy: false,
    checkedAt,
    findings: [{ code, severity: "error", detail }],
  }
}
