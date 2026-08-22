/**
 * Everything one adapter instance leaves behind, and what happens to it when
 * the instance is removed.
 *
 * Deleting a bot used to drop two things: its own row and its heartbeats. Every
 * other table it had written to kept its rows forever — the audit trail, the
 * inbound dedup ledger, queued outbound jobs, inbox telemetry, the Lark session
 * and entry-context tables, the per-conversation policy overrides, and the
 * platform-identity directory for people only that bot had ever seen. None of
 * it is reachable once the adapter row is gone (every surface that renders it
 * is opened FROM the adapter), and none of it has a retention sweep of its own,
 * so it was unbounded invisible growth. The heartbeat reap already carried this
 * exact reasoning in its comment; this module applies it to the rest.
 *
 * ## What is deliberately kept
 *
 * - **`connectorCleanupJobs`** — retries for encrypted attachment blobs the
 *   prune could not confirm deleted. They exist precisely to outlive the
 *   adapter: reaping them would strand the ciphertext on disk with nothing left
 *   that knows the key it belongs to. This is the one table where a leaked row
 *   is the SAFE outcome.
 * - **Sessions and messages** — the operator's conversation history. Removing a
 *   bot removes the bot, not the record of what people said to it.
 *
 * Attachments and heartbeats are absent here because they already have owners:
 * `pruneAttachmentsForAdapter` (blob-confirmed, ledgered) and
 * `deleteAdapterInstance` respectively.
 *
 * Every table is reaped independently and best-effort. A table that is missing
 * on an older schema, or that throws, must not stop the others or the delete —
 * the caller reports what failed rather than aborting halfway.
 */

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { CONVERSATION_KEY_SEP } from "@/types/connectors/event"

/** The identifying fields the reaper needs; a full row satisfies it. */
export interface AdapterResidueTarget {
  id: string
  /**
   * Platform kind. `conversationKey` is `<platform>:<adapterId>:<chat>`, so
   * without it the conversation-scoped tables cannot be scanned — they are
   * reported in `failed` rather than silently skipped. Absent only when the
   * caller is removing an id whose row no longer exists.
   */
  type?: string
}

export interface AdapterResidueReport {
  /** Table name → rows deleted. Only tables that deleted something appear. */
  reaped: Record<string, number>
  /** Tables whose reap threw (missing on this schema, or a transient error). */
  failed: string[]
}

/** Tables indexed by a plain `adapterId` field. */
const BY_ADAPTER_ID = [
  "connectorAudit",
  "inboundLedger",
  "inboxTelemetryEvents",
  "larkChatSurfaces",
  "larkEntryContexts",
  "larkWebSessions",
  "feishuPrincipalBindRequests",
  "connectorInboundJobs",
] as const

/**
 * Tables whose only adapter-scoped index is compound. Reaped over the key range
 * `[adapterId, minKey] … [adapterId, maxKey]`, which is the whole adapter.
 */
const BY_ADAPTER_ID_COMPOUND: ReadonlyArray<{ table: string; index: string }> = [
  { table: "larkMessageImports", index: "[adapterId+chatId]" },
  { table: "outboundQueue", index: "[adapterId+status]" },
  { table: "platformIdentities", index: "[adapterId+remoteUserId]" },
]

/** Tables keyed by `conversationKey`, which embeds the adapter id. */
const BY_CONVERSATION_KEY = ["conversationOverrides", "conversationAssignmentEvents"] as const

/**
 * The `conversationKey` prefix every conversation of this adapter shares, or
 * `undefined` when the platform kind is unknown.
 */
export function conversationKeyPrefix(target: AdapterResidueTarget): string | undefined {
  if (!target.type) return undefined
  return `${target.type}${CONVERSATION_KEY_SEP}${target.id}${CONVERSATION_KEY_SEP}`
}

type AnyTable = {
  where: (index: string) => {
    equals: (value: string) => { delete: () => Promise<number> }
    between: (lower: unknown, upper: unknown) => { delete: () => Promise<number> }
    startsWith: (value: string) => { delete: () => Promise<number> }
  }
}

function tableOf(name: string): AnyTable | undefined {
  const db = getDb() as unknown as Record<string, unknown>
  const table = db[name]
  return table && typeof table === "object" ? (table as AnyTable) : undefined
}

async function reap(
  report: AdapterResidueReport,
  name: string,
  run: (table: AnyTable) => Promise<number>
): Promise<void> {
  const table = tableOf(name)
  if (!table) {
    report.failed.push(name)
    return
  }
  try {
    const deleted = await run(table)
    if (deleted > 0) report.reaped[name] = deleted
  } catch {
    report.failed.push(name)
  }
}

/**
 * Delete every row derived from this adapter, except the two categories the
 * module doc says are deliberately kept.
 *
 * Never throws: the caller is a removal path whose last step (dropping the
 * adapter row) must run even when a reap could not.
 */
export async function reapAdapterResidue(
  target: AdapterResidueTarget
): Promise<AdapterResidueReport> {
  const report: AdapterResidueReport = { reaped: {}, failed: [] }

  for (const name of BY_ADAPTER_ID) {
    await reap(report, name, (table) => table.where("adapterId").equals(target.id).delete())
  }

  for (const { table: name, index } of BY_ADAPTER_ID_COMPOUND) {
    await reap(report, name, (table) =>
      table.where(index).between([target.id, Dexie.minKey], [target.id, Dexie.maxKey]).delete()
    )
  }

  const prefix = conversationKeyPrefix(target)
  for (const name of BY_CONVERSATION_KEY) {
    if (!prefix) {
      // Reported, not skipped: the caller should be able to tell "nothing to
      // reap" from "could not look".
      report.failed.push(name)
      continue
    }
    await reap(report, name, (table) => table.where("conversationKey").startsWith(prefix).delete())
  }

  return report
}
