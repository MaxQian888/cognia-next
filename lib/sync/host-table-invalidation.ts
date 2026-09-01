"use client"

/**
 * Host-side push coverage for the companion sync protocol.
 *
 * `publishSyncInvalidate` has existed since ADR-0131, but only four writers
 * ever called it — the connector inbox relay's `messages`,
 * `conversationOverrides`, `connectorDrafts` and `outboundQueue` — plus
 * `workflowRuns` from the run-event publisher. The other twenty syncable
 * tables were pull-only in practice: a session created on the Host, a plan
 * approved, a memory written, a skill installed, an MCP server configured, a
 * template imported — none of it reached a paired client until that client
 * happened to run a sync for another reason (foreground, network up, a manual
 * "Sync now"). The data was *reachable*, so it looked wired; it just arrived
 * minutes late, or not until the user went looking.
 *
 * Closing that by hand would mean finding and editing every writer of twenty
 * tables and keeping the twenty-first honest forever. Dexie already offers the
 * one place all of them pass through: the table's own `creating` / `updating` /
 * `deleting` hooks. One subscription per table, derived from the protocol's own
 * table list, and a new syncable table cannot be added without this file
 * failing to compile.
 *
 * HOST-ONLY. Install it exactly where the sync source is installed — the
 * desktop sync-source provider and its headless twin — and nowhere else. On a
 * client these same tables are a *mirror*: every row is written by the sync
 * apply step, so hooks there would publish an invalidation for the data that
 * just arrived. `publishSyncInvalidate` additionally stands down whenever this
 * process is itself a thin client of a remote host
 * (`isRemoteHostActive()`), which covers the desktop-as-client case that the
 * install site alone cannot.
 *
 * Bursts are already handled downstream: `publishSyncInvalidate` coalesces to
 * one frame per table per 150 ms, and the client coalesces again at 100 ms, so
 * a streaming turn writing `messages` on every token still costs one
 * `sync_pull` per window.
 */

import { getDb } from "@/lib/db/schema"
import { loggers } from "@cognia/logging"
import type { Table } from "dexie"

import { publishSyncInvalidate } from "./host-invalidate"
import { SYNCABLE_TABLE_NAMES, type SyncableTable } from "./types"

const log = loggers.sync

/**
 * Protocol table name → the Dexie table the sync source reads for it.
 *
 * Most are identity; the exceptions are the wire aliases (`goals` →
 * `chatGoals`, `plans` → `agentPlans`, ADR-0045) and `mcpServers`, which is a
 * *projection* table: `mcpServerSummaries` is what crosses the wire, while the
 * `mcpServers` table itself holds the full configuration and never leaves the
 * Host. Hooking the projection rather than the config is deliberate — an edit
 * to a server's secret must not announce itself to a paired phone, and the
 * projection is rewritten whenever anything the phone can see changes.
 *
 * Typed against `SyncableTable` so the protocol list and this map cannot drift:
 * adding a table to `COMPANION_SYNC_PROTOCOL_TABLE_NAMES` without a source
 * table here is a type error.
 */
export const SYNC_TABLE_SOURCES: Readonly<Record<SyncableTable, string>> = Object.freeze({
  characters: "characters",
  skills: "skills",
  sessions: "sessions",
  messages: "messages",
  workflows: "workflows",
  twinProfile: "twinProfile",
  plugins: "plugins",
  adapterInstances: "adapterInstances",
  settings: "settings",
  conversationOverrides: "conversationOverrides",
  goals: "chatGoals",
  plans: "agentPlans",
  memories: "memories",
  executionRuns: "executionRuns",
  workflowRuns: "workflowRuns",
  mcpServers: "mcpServerSummaries",
  terminalHistory: "terminalHistory",
  agentTeamBoard: "agentTeamBoard",
  agentTasks: "agentTasks",
  agentTaskAttempts: "agentTaskAttempts",
  templateDefinitions: "templateDefinitions",
  templatePackages: "templatePackages",
  templateInstances: "templateInstances",
  // Squad definitions (v215). These reached the protocol list without
  // reaching this map, so a squad edited on the Host announced nothing and
  // a paired phone only caught up on its next mount. Identity names.
  agentTeams: "agentTeams",
  agentTeammates: "agentTeammates",
  agentTeamTasks: "agentTeamTasks",
  connectorDrafts: "connectorDrafts",
  outboundQueue: "outboundQueue",
})

/** The Dexie surface this module needs — narrowed so tests can hand it a stub. */
interface HookableTable {
  hook(event: "creating" | "updating" | "deleting", handler: (...args: unknown[]) => void): unknown
}

interface HookRegistry {
  hook(event: "creating" | "updating" | "deleting"): {
    unsubscribe(handler: (...args: unknown[]) => void): void
  }
}

export interface HostTableInvalidationDeps {
  /** Resolve a Dexie table by name; defaults to the active account database. */
  getTable?: (name: string) => HookableTable | undefined
  /** Announce that a table changed; defaults to the coalescing publisher. */
  publish?: (table: SyncableTable) => void
}

const HOOK_EVENTS = ["creating", "updating", "deleting"] as const

let installed = false

/**
 * Subscribe to every syncable table's writes and announce them.
 *
 * Idempotent: a second install while one is live is a no-op that returns a
 * no-op teardown, so a provider that re-runs its effect cannot double-publish.
 * A table that is missing from the database (an older schema, a stubbed test
 * db) is skipped rather than throwing — one absent table must not cost the
 * other twenty-four their push.
 */
export function installHostTableInvalidation(deps: HostTableInvalidationDeps = {}): () => void {
  if (installed) return () => {}

  const resolveTable =
    deps.getTable ??
    ((name: string) => {
      const db = getDb() as unknown as Record<string, Table<unknown, unknown> | undefined>
      return db[name] as unknown as HookableTable | undefined
    })
  const publish = deps.publish ?? publishSyncInvalidate

  const teardowns: Array<() => void> = []

  for (const table of SYNCABLE_TABLE_NAMES) {
    const sourceName = SYNC_TABLE_SOURCES[table]
    let source: HookableTable | undefined
    try {
      source = resolveTable(sourceName)
    } catch (error) {
      log.warn("host invalidation: table unavailable", {
        table,
        source: sourceName,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (!source || typeof source.hook !== "function") continue

    for (const event of HOOK_EVENTS) {
      // One handler identity per (table, event) so the unsubscribe below can
      // find it again — Dexie removes hooks by reference, not by name.
      const handler = () => {
        try {
          publish(table)
        } catch {
          // A push failure must never fail the write that triggered it.
        }
      }
      try {
        source.hook(event, handler)
      } catch (error) {
        log.warn("host invalidation: hook rejected", {
          table,
          event,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      teardowns.push(() => {
        try {
          ;(source as unknown as HookRegistry).hook(event).unsubscribe(handler)
        } catch {
          // Teardown is best-effort; a closed database has already forgotten it.
        }
      })
    }
  }

  installed = true
  return () => {
    installed = false
    for (const teardown of teardowns) teardown()
  }
}

/** Test-only — forget the singleton guard between cases. */
export function __resetHostTableInvalidationForTests(): void {
  installed = false
}
