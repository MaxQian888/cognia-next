"use client"

/**
 * Companion sync orchestrator (M4.7 / #51).
 *
 * Drives the four per-table handlers, persists per-table cursors in
 * memory, and exposes a small status observable for the UI to show
 * "synced X seconds ago" badges. Persisted cursors are V2 work — V1's
 * in-memory map matches the issue's "no new Dexie table" constraint.
 *
 * Trigger points wired here:
 *   1. **Manual** — `runSyncDown()` is exported so the UI can call it
 *      from a "Sync now" button.
 *   2. **Foreground** — `installForegroundSync()` re-runs on
 *      `visibilitychange === 'visible'`; idempotent registration.
 *   3. **WS deltas** — `installEventDrivenSync()` subscribes to a
 *      catch-all `sync://invalidate` channel; the server emits one
 *      whenever it commits a sync-relevant write (left for HITL Rust
 *      work).
 *
 * This file does not call the transport directly — it goes through
 * `lib/tauri.ts:transport`, so the same code runs on Tauri (no-op,
 * data is local), Capacitor (real sync), and web (no-op, no companion
 * paired).
 */

import { subscribeResume } from "@/lib/capacitor/app"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"
import { companionCursorNamespace } from "@/lib/companion/credential-book/legacy-migration"
import { getDb } from "@/lib/db/schema"
import { transport } from "@/lib/tauri"
import { getCompanionConfigGeneration, loadCompanionConfig } from "@/lib/tauri/transport-companion"
import type { Transport } from "@/lib/tauri/transport-types"
import type { RunStatus } from "@/types/workflow/visual"

import { clearCursors, loadCursors, saveCursor } from "./cursor-store"
import { sleep, whenIdle, yieldToMain } from "./scheduling"
import { syncAdapterInstances } from "./handlers/adapter-instances"
import { syncAgentTeamBoard } from "./handlers/agent-team-board"
import { syncAgentTaskAttempts, syncAgentTasks } from "./handlers/agent-tasks"
import { syncAppSettings } from "./handlers/app-settings"
import { syncCharacters } from "./handlers/characters"
import { syncChatTemplates } from "./handlers/chat-templates"
import { syncConversationOverrides } from "./handlers/conversation-overrides"
import { syncSessionState } from "./handlers/session-state"
import { syncExecutionRuns } from "./handlers/execution-runs"
import { syncGoals } from "./handlers/goals"
import { syncPlans } from "./handlers/plans"
import { syncMcpServers } from "./handlers/mcp-servers"
import { syncMemories } from "./handlers/memory"
import { syncMessages } from "./handlers/messages"
import { syncPlugins } from "./handlers/plugins"
import { syncSessions } from "./handlers/sessions"
import { syncSkills } from "./handlers/skills"
import { syncConnectorDrafts } from "./handlers/connector-drafts"
import { syncOutboundQueue } from "./handlers/outbound-queue"
import { syncBotDefinitions } from "./handlers/bot-definitions"
import { syncBotEventDeliveries } from "./handlers/bot-event-deliveries"
import { syncBotInstallations } from "./handlers/bot-installations"
import { syncConnectorHeartbeats } from "./handlers/connector-heartbeats"
import { syncPlatformIdentities } from "./handlers/platform-identities"
import { syncConnectorCallbackBindings } from "./handlers/connector-callback-bindings"
import { syncWorkflowDeployments } from "./handlers/workflow-deployments"
import { syncExecutionRunBindings } from "./handlers/execution-run-bindings"
import { syncTerminalHistory } from "./handlers/terminal-history"
import { syncTwins, syncTwinDrafts } from "./handlers/twins"
import {
  syncProjects,
  syncIssues,
  syncIssueProjects,
  syncIssueCycles,
  syncIssueEvents,
  syncIssueRuns,
  syncLabels,
} from "./handlers/issues"
import { syncTwinProfile } from "./handlers/twin-profile"
import { syncWorkflows } from "./handlers/workflows"
import { syncWorkflowRuns } from "./handlers/workflow-runs"
import {
  syncTemplateDefinitions,
  syncTemplateInstances,
  syncTemplatePackages,
} from "./handlers/template-platform"
import {
  syncAgentTeamTasks,
  syncAgentTeammates,
  syncAgentTeams,
} from "./handlers/agent-team-definitions"
import type { SyncCursor, SyncFailure, SyncOutcome, SyncableTable } from "./types"

export type SyncFn = (transport: Transport, cursor: SyncCursor) => Promise<SyncOutcome>

interface RegisteredHandler {
  table: SyncableTable
  stage: SyncStage
  run: SyncFn
  /**
   * Tables that must have finished before this one starts.
   *
   * Array position used to be the only thing holding these orderings, because
   * the run was strictly sequential — so "characters before sessions" was a
   * comment and a line number, and moving a row was an undetectable
   * regression. The run is now concurrent ({@link SYNC_MAX_CONCURRENT_PULLS}),
   * which makes position meaningless and these edges load-bearing.
   *
   * An edge is a *rendering* constraint, never an authority one: it says the
   * client would paint a row with nothing to attach to (an issue whose label
   * is still a raw id, a teammate whose squad has not arrived), not that the
   * pull would be wrong. Edges naming a table outside the current run — a
   * `stages` or `only` filter excluded it — are dropped, because a barrier
   * against something that is not going to happen is a deadlock.
   */
  after?: readonly SyncableTable[]
}

/** A handler as a caller may supply it — {@link RegisteredHandler} with an optional stage. */
export type SyncHandlerOverride = Omit<RegisteredHandler, "stage"> & { stage?: SyncStage }

/**
 * Sync stages — the order a client learns about its Host.
 *
 * Every table used to be pulled in one uninterrupted run before the shell was
 * allowed to call itself online, so a paired client sat on "connecting" for as
 * long as the slowest table took, and the surfaces that were ready long before
 * the last template package landed stayed dark anyway.
 *
 * The stages answer one question per table: *what is this client unable to
 * show until this table arrives?*
 *
 *   `critical`     the first screen. Preferences, the chat list and the state
 *                  that decides how it is bucketed. Nothing renders honestly
 *                  without these, so the connection is not "online" until they
 *                  land — and there are only four of them.
 *   `interactive`  what the user reaches for next: transcripts, plans, tasks,
 *                  runs, the Inbox. Wanted within seconds, not needed to paint.
 *   `background`   libraries and configuration surfaces — skills, workflows,
 *                  memories, plugins, MCP servers, templates. A settings page
 *                  the user has not opened can afford to fill in behind them.
 *
 * A stage is a scheduling statement, not an authority one: every table still
 * has the same Host authority and the same tombstone policy
 * ({@link COMPANION_SYNC_DOMAINS}). Re-ordering a table changes when it shows
 * up, never whether it is trusted.
 */
export const SYNC_STAGES = ["critical", "interactive", "background"] as const

export type SyncStage = (typeof SYNC_STAGES)[number]

/** Stage assumed for an injected handler that does not declare one. */
const DEFAULT_HANDLER_STAGE: SyncStage = "critical"

const DEFAULT_HANDLERS: RegisteredHandler[] = [
  // ── critical ──────────────────────────────────────────────────────────
  // Device preferences first: the shell reads them while painting, and the
  // merge is a single row.
  { table: "settings", stage: "critical", run: syncAppSettings },
  // Characters before sessions: a session row names a character, and a chat
  // list that arrives first renders rows with no identity for one frame.
  { table: "characters", stage: "critical", run: syncCharacters },
  { table: "sessions", stage: "critical", run: syncSessions, after: ["characters"] },
  // v49 — Inbox optimization. Mobile reads pinned/archived/unread state
  // from conversationOverrides; without this handler the orchestrator
  // never pulls it and the mobile inbox renders every conversation as
  // unread + unpinned. It is critical for the same reason `sessions` is:
  // the list is wrong, not merely empty, without it.
  { table: "conversationOverrides", stage: "critical", run: syncConversationOverrides },
  // Unread pointers are first-screen: the tab bar draws its badge before any
  // conversation is opened, and a wrong zero there is the whole bug.
  { table: "sessionState", stage: "critical", run: syncSessionState },

  // ── interactive ───────────────────────────────────────────────────────
  // The transcript tail. Paged, and the largest payload in the pipeline —
  // which is exactly why it must not gate the first paint.
  { table: "messages", stage: "interactive", run: syncMessages },
  { table: "agentTasks", stage: "interactive", run: syncAgentTasks },
  {
    table: "agentTaskAttempts",
    stage: "interactive",
    run: syncAgentTaskAttempts,
    after: ["agentTasks"],
  },
  // ADR-0045 — AgentPlan rows. The companion mounts the approval dock and the
  // step tracker; without this pull they read an empty local table and a
  // plan-mode turn taken through the companion has nothing to approve.
  { table: "plans", stage: "interactive", run: syncPlans },
  // Companion read-mostly views (Goals console). Mobile mirrors these so the
  // phone can show goal progress from Dexie offline; authored on the desktop.
  { table: "goals", stage: "interactive", run: syncGoals },
  // v104 — Agent-Team board projection (team-board CQRS). One-way mirror of
  // the desktop task board (tasks + team-meta rows) so the mobile workspace
  // can render the kanban offline; controls travel back as Companion RPC.
  { table: "agentTeamBoard", stage: "interactive", run: syncAgentTeamBoard },
  // Canonical, remote-safe run summaries. Detailed/private event rows remain
  // on the executing host and are never part of companion sync.
  { table: "executionRuns", stage: "interactive", run: syncExecutionRuns },
  // Workflow run history — mirrors execution state so the mobile library
  // badges, runs feed, and active-runs card reflect runs (incl. phone-
  // triggered ones). Definitions sync in `background`; this is runs.
  { table: "workflowRuns", stage: "interactive", run: syncWorkflowRuns },
  // ADR-0131 cross-shell inbox relay — drafts in full (the phone edits and
  // approves them), outbound as a status projection (`syncedFromHost`), so a
  // thin client's Inbox shows delivery state without running any adapter.
  { table: "connectorDrafts", stage: "interactive", run: syncConnectorDrafts },
  { table: "outboundQueue", stage: "interactive", run: syncOutboundQueue },
  // The workspace list is a scope, not a library: the header chip, the
  // switcher and every issue read resolve against it, so it has to land
  // before the surfaces that filter on it, not alongside the settings pages.
  { table: "projects", stage: "interactive", run: syncProjects },
  // The Inbox sidebar's host-only tables. The delegation chips on every
  // conversation row and the connection-loss banner are visible the moment
  // the Inbox paints, so their tables are wanted within seconds; the contact
  // drawer, the callback inspector and the override form open on demand and
  // fill in behind them (background, below).
  // The Bot control plane. `/bots` is a rail item a paired device can land on
  // directly, and both halves of what it renders are here: the installations
  // are the list, and the deliveries are the dead-letter count the header
  // lights up for. Definitions follow in `background`, below, because a name
  // arriving a moment late leaves an orphan row rather than an empty page.
  { table: "botInstallations", stage: "interactive", run: syncBotInstallations },
  {
    table: "botEventDeliveries",
    stage: "interactive",
    run: syncBotEventDeliveries,
    after: ["botInstallations"],
  },
  {
    table: "executionRunBindings",
    stage: "interactive",
    run: syncExecutionRunBindings,
    after: ["executionRuns"],
  },
  { table: "connectorHeartbeats", stage: "interactive", run: syncConnectorHeartbeats },

  // ── background ────────────────────────────────────────────────────────
  { table: "skills", stage: "background", run: syncSkills },
  // Wave 4 / ADR-0026 — the workflow viewer, twin profile, plugin toggles and
  // connector policy: settings-shaped surfaces, served from Dexie when the
  // server is unreachable, and none of them on the first screen.
  { table: "workflows", stage: "background", run: syncWorkflows },
  { table: "twinProfile", stage: "background", run: syncTwinProfile },
  // The Twin registry, and the drafts awaiting review. Background because
  // `/discover` is a tab the user navigates to rather than lands on, and
  // after `twinProfile` for the same reason the squad rows come after their
  // runs: a profile keyed by a twin that has not arrived yet is a row with
  // nothing to attach to.
  { table: "twins", stage: "background", run: syncTwins, after: ["twinProfile"] },
  { table: "twinDrafts", stage: "background", run: syncTwinDrafts, after: ["twins"] },
  // The issue tracker. Labels first so the board never paints a chip as a raw
  // id, then the containers it groups by, then the issues themselves.
  { table: "labels", stage: "background", run: syncLabels },
  { table: "issueProjects", stage: "background", run: syncIssueProjects, after: ["labels"] },
  { table: "issues", stage: "background", run: syncIssues, after: ["issueProjects"] },
  // The detail sheet's two halves, after the issues they hang off: a trail
  // keyed by an issue that has not arrived is a row with nothing to attach to.
  { table: "issueEvents", stage: "background", run: syncIssueEvents, after: ["issues"] },
  { table: "issueRuns", stage: "background", run: syncIssueRuns, after: ["issues"] },
  { table: "issueCycles", stage: "background", run: syncIssueCycles, after: ["issues"] },
  { table: "plugins", stage: "background", run: syncPlugins },
  { table: "adapterInstances", stage: "background", run: syncAdapterInstances },
  // After the adapters they hang off: a contact, a binding or a deployment
  // keyed by an adapter that has not arrived is a row with nothing to attach to.
  {
    table: "platformIdentities",
    stage: "background",
    run: syncPlatformIdentities,
    after: ["adapterInstances"],
  },
  {
    table: "connectorCallbackBindings",
    stage: "background",
    run: syncConnectorCallbackBindings,
    after: ["adapterInstances"],
  },
  {
    table: "workflowDeployments",
    stage: "background",
    run: syncWorkflowDeployments,
    after: ["adapterInstances"],
  },
  // Long-term memory. Decrypts row by row against the profile DEK, so it is
  // the most CPU-expensive apply in the pipeline — last, and interruptible.
  { table: "memories", stage: "background", run: syncMemories },
  // ADR-0056 (Wave 4) — configured MCP servers. Read-only mirror so the
  // mobile `/me/mcp` page can list the desktop's servers (the phone has no
  // MCP push RPC and the standalone engine runs no MCP).
  { table: "mcpServers", stage: "background", run: syncMcpServers },
  // ADR-0039 (phase 2) — durable terminal command history. One-way read-only
  // mirror (desktop → phone) powering the mobile `/me/command-history` browse
  // /search viewer; the phone has no shell, so it never writes back.
  { table: "terminalHistory", stage: "background", run: syncTerminalHistory },
  // Saved chat templates. Background, alongside the template platform it sits
  // next to: the `/` menu that offers them is reachable the moment the
  // composer paints, but an empty menu is the state the phone was already in,
  // so this waits its turn behind the surfaces that block on their data.
  { table: "chatTemplates", stage: "background", run: syncChatTemplates },
  { table: "templateDefinitions", stage: "background", run: syncTemplateDefinitions },
  { table: "templatePackages", stage: "background", run: syncTemplatePackages },
  {
    table: "templateInstances",
    stage: "background",
    run: syncTemplateInstances,
    after: ["templateDefinitions", "templatePackages"],
  },
  // v215 — Squad definitions. Background, and after the runs they explain: a
  // roster arriving before its squad is a row with nothing to attach to.
  { table: "agentTeams", stage: "background", run: syncAgentTeams },
  { table: "agentTeammates", stage: "background", run: syncAgentTeammates, after: ["agentTeams"] },
  { table: "agentTeamTasks", stage: "background", run: syncAgentTeamTasks, after: ["agentTeams"] },
  // Locally authored Bot definitions. A plugin's are a registry overlay and
  // never cross, so a mirrored device resolves those from its own plugin state
  // or reads the installation as an orphan, which the console already renders.
  { table: "botDefinitions", stage: "background", run: syncBotDefinitions },
]

/** Which stage each table is pulled in. */
export const SYNC_TABLE_STAGES: Readonly<Record<SyncableTable, SyncStage>> = Object.freeze(
  Object.fromEntries(DEFAULT_HANDLERS.map((h) => [h.table, h.stage]))
) as Readonly<Record<SyncableTable, SyncStage>>

/**
 * The `after` edges each table declares, as a closed record.
 *
 * Exported for the same reason {@link SYNC_TABLE_STAGES} is: the registry is
 * the only place these orderings exist, and a test that has to reach into a
 * module-private array to check them is a test that stops being written. An
 * absent edge set is `[]`, never `undefined`, so a caller never has to decide
 * what a missing key means.
 */
export const SYNC_TABLE_DEPENDENCIES: Readonly<Record<SyncableTable, readonly SyncableTable[]>> =
  Object.freeze(
    Object.fromEntries(DEFAULT_HANDLERS.map((h) => [h.table, Object.freeze([...(h.after ?? [])])]))
  ) as Readonly<Record<SyncableTable, readonly SyncableTable[]>>

/** The tables in a stage, in the order the orchestrator runs them. */
export function syncTablesForStage(stage: SyncStage): readonly SyncableTable[] {
  return DEFAULT_HANDLERS.filter((h) => h.stage === stage).map((h) => h.table)
}

/**
 * Tables sync'd by the orchestrator, in execution order. Exported so the
 * Settings → Mobile Companion → "Sync status" card can list every handler
 * without hard-coding the names — keeps the UI in lock-step with the
 * registry above.
 */
export const SYNC_HANDLER_TABLES: readonly SyncableTable[] = DEFAULT_HANDLERS.map((h) => h.table)

export interface CompanionSyncDomainDescriptor {
  authority: "host"
  direction: "host-to-client"
  sensitivity: "internal" | "confidential"
  cursor: "updated-at" | "opaque"
  deletionPolicy: "tombstone" | "append-only" | "ttl"
  allowedWrites: readonly ["host"]
}

const syncDomain = (
  deletionPolicy: CompanionSyncDomainDescriptor["deletionPolicy"],
  sensitivity: CompanionSyncDomainDescriptor["sensitivity"] = "confidential",
  cursor: CompanionSyncDomainDescriptor["cursor"] = "updated-at"
): CompanionSyncDomainDescriptor => ({
  authority: "host",
  direction: "host-to-client",
  sensitivity,
  cursor,
  deletionPolicy,
  allowedWrites: ["host"],
})

/** Governance contract for every installed table handler. */
export const COMPANION_SYNC_DOMAINS: Readonly<
  Record<SyncableTable, CompanionSyncDomainDescriptor>
> = Object.freeze({
  characters: syncDomain("tombstone"),
  skills: syncDomain("tombstone"),
  sessions: syncDomain("tombstone"),
  agentTasks: syncDomain("tombstone"),
  agentTaskAttempts: syncDomain("append-only"),
  messages: syncDomain("tombstone"),
  workflows: syncDomain("tombstone"),
  twinProfile: syncDomain("tombstone"),
  twins: syncDomain("tombstone"),
  // A draft is created, reviewed once, and then deleted with its twin or its
  // job. Deletion rides a tombstone so an accepted draft stops being offered.
  twinDrafts: syncDomain("tombstone"),
  // `internal`: a workspace row is names, paths and counts, and the phone
  // picks its own active one rather than following the desktop's.
  projects: syncDomain("tombstone", "internal"),
  issues: syncDomain("tombstone"),
  issueProjects: syncDomain("tombstone"),
  labels: syncDomain("tombstone", "internal"),
  // Appended, never edited, so the cursor is `ts` and the pull only ever
  // carries rows the phone has not seen. Deletion still needs a tombstone,
  // because the cascade from a deleted issue has to reach here too.
  issueEvents: syncDomain("tombstone", "confidential", "opaque"),
  issueRuns: syncDomain("tombstone"),
  issueCycles: syncDomain("tombstone"),
  plugins: syncDomain("tombstone"),
  adapterInstances: syncDomain("tombstone"),
  settings: syncDomain("tombstone", "internal"),
  conversationOverrides: syncDomain("tombstone"),
  goals: syncDomain("tombstone"),
  plans: syncDomain("tombstone"),
  memories: syncDomain("tombstone"),
  executionRuns: syncDomain("append-only", "confidential", "opaque"),
  workflowRuns: syncDomain("append-only", "confidential", "opaque"),
  mcpServers: syncDomain("tombstone"),
  terminalHistory: syncDomain("ttl", "confidential", "opaque"),
  agentTeamBoard: syncDomain("tombstone"),
  // Deleting a template is user intent and has to reach the phone, or the `/`
  // menu keeps offering text the user removed. `recordChatTemplateUse` is the
  // one write left out of the cursor: counters, no content.
  chatTemplates: syncDomain("tombstone"),
  templateDefinitions: syncDomain("tombstone"),
  templatePackages: syncDomain("tombstone"),
  templateInstances: syncDomain("tombstone"),
  agentTeams: syncDomain("tombstone"),
  agentTeammates: syncDomain("tombstone"),
  agentTeamTasks: syncDomain("tombstone"),
  connectorDrafts: syncDomain("tombstone"),
  // Terminal projections age out client-side (handlers/outbound-queue.ts);
  // the host prunes without tombstones after 14 days.
  outboundQueue: syncDomain("ttl"),
  // `internal`: three scalars (session id, read pointer, count) and no content.
  // Deletion rides the `sessions` tombstone rather than one of its own, so an
  // orphan row is possible and harmless, see readSessionStateDelta.
  sessionState: syncDomain("append-only", "internal"),
  // Heartbeats are appended on `at`, pruned by the host after 48 h without
  // tombstones and aged out client-side on the same window.
  connectorHeartbeats: syncDomain("ttl", "internal", "opaque"),
  // A merge deletes the absorbed contact and tombstones it.
  platformIdentities: syncDomain("tombstone"),
  // Cursored on max(createdAt, consumedAt); rows expire on their own
  // `expiresAt`, client-side too, and the host never tombstones them.
  connectorCallbackBindings: syncDomain("ttl", "confidential", "opaque"),
  // Disabled in place, never deleted. `internal`: ids, environments, revisions.
  workflowDeployments: syncDomain("append-only", "internal"),
  // Settled in place, never deleted.
  executionRunBindings: syncDomain("append-only"),
  // A definition can be deleted, and a deletion has to reach the phone or the
  // console keeps naming a Bot that no longer exists.
  botDefinitions: syncDomain("tombstone"),
  // Uninstalling is user intent and tombstones like any other deletion.
  // `internal` rather than `confidential`: the projection is ids, a status and
  // a set of booleans, with the config and the credential bindings emptied.
  botInstallations: syncDomain("tombstone", "internal"),
  // Status only, no envelope. The host prunes settled rows after 14 days
  // without tombstones and the client ages them out on the same window
  // (`handlers/bot-event-deliveries.ts`). `opaque`: the cursor is a bounded
  // `receivedAt` scan filtered on `updatedAt`, not an indexed `updatedAt`.
  botEventDeliveries: syncDomain("ttl", "internal", "opaque"),
})

interface SyncState {
  /** When the last successful sync of this table finished. */
  lastSyncAt: number | null
  /** Cursor to send on the next pull. */
  since: number
  cursor?: string
  /** Last failure, retained until the next success. */
  lastError: string | null
}

const stateMap = new Map<SyncableTable, SyncState>()

/**
 * Hydration guard — `runSyncDown` awaits this once on first invocation so
 * we never serve a stale `since: 0` to the server when v44+ cursors are
 * persisted in Dexie. Tests reset this via `__resetSyncStateForTests`.
 */
let hydratePromise: Promise<void> | null = null

interface HostCursorKeys {
  /** The key this host's cursors are written under now. */
  key: string
  /** Keys the same host's cursors were written under by earlier builds. */
  legacy: readonly string[]
}

/**
 * Which host these cursors belong to (ADR-0097 D13).
 *
 * The key is the host's **cursor namespace** — `{accountNamespace}:{hostId}`
 * — not the device id it issued at pair time. Two things change with that:
 *
 *   • The same desktop reached from two local accounts no longer shares one
 *     watermark, so account A's pull cannot advance account B's cursor.
 *   • A *re-pair to the same host* keeps its watermark. `deviceId` is minted
 *     per pairing, so it used to read as a different host and forced a full
 *     re-pull of every table; `hostId` is stable across re-pairs.
 *
 * Unpaired clients get `""`, which is a real key: it keeps their (empty)
 * cursors from colliding with any host's, and the moment they pair, the key
 * changes and the reconciliation below runs.
 *
 * `legacy` carries the pre-namespace key for the *same* host so an existing
 * install can adopt its own cursors instead of mistaking them for another
 * host's — see {@link adoptLegacyCursorKeys}.
 */
function currentHostCursorKeys(): HostCursorKeys {
  const config = loadCompanionConfig()
  if (!config) return { key: "", legacy: [] }
  const key = companionCursorNamespace(config)
  const legacy = config.deviceId && config.deviceId !== key ? [config.deviceId] : []
  return { key, legacy }
}

/** The host whose cursors `stateMap` currently holds. */
let hydratedServerKey: string | null = null
let hydratedDatabase: ReturnType<typeof getDb> | null = null
let hydratedGeneration = -1

async function ensureHydrated(): Promise<void> {
  const { key: serverKey, legacy } = currentHostCursorKeys()
  const database = getDb()
  const generation = getCompanionConfigGeneration()
  const assertCurrent = () => {
    if (
      getDb() !== database ||
      getCompanionConfigGeneration() !== generation ||
      currentHostCursorKeys().key !== serverKey
    )
      throw new Error("Sync scope changed")
  }
  // The host changed under us — a re-pair, or a switch. Everything in memory
  // belongs to the previous one. The mirrored *rows* are reconciled below,
  // from the database rather than from this in-memory comparison.
  if (
    hydratedServerKey !== null &&
    (hydratedServerKey !== serverKey ||
      hydratedDatabase !== database ||
      hydratedGeneration !== generation)
  ) {
    hydratePromise = null
    stateMap.clear()
  }
  if (hydratePromise) return hydratePromise
  hydratedServerKey = serverKey
  hydratedDatabase = database
  hydratedGeneration = generation
  hydratePromise = (async () => {
    await adoptLegacyCursorKeys(serverKey, legacy, assertCurrent)
    assertCurrent()
    await resetMirrorsSharedWithAnotherHost(serverKey, assertCurrent)
    assertCurrent()
    const persisted = await loadCursors(serverKey)
    assertCurrent()
    for (const [table, row] of persisted) {
      stateMap.set(table, {
        since: row.since,
        ...(row.cursor === undefined ? {} : { cursor: row.cursor }),
        lastSyncAt: row.lastSyncAt,
        lastError: row.lastError,
      })
    }
  })()
  return hydratePromise
}

/**
 * Re-file cursors an earlier build wrote under this same host's bare device id.
 *
 * Without this, the first run after the key changed to a cursor namespace would
 * see the install's own rows under a key it no longer recognises, classify them
 * as another host's, and wipe the mirror of the host it is still paired to —
 * a full re-pull of every table on upgrade.
 *
 * The credential-book migration re-files these too, but it runs from
 * `hydrateCompanionConfig()`, and a sync tick can beat it: `loadCompanionConfig`
 * reads a cache, so the orchestrator can observe the new key before the
 * migration has moved anything. Both paths are idempotent, so whichever runs
 * first wins and the other finds nothing.
 *
 * A cursor already under the canonical key wins — it was written by this build
 * against the key we are about to resume from, so the legacy row is a stale
 * duplicate, not a newer watermark.
 */
async function adoptLegacyCursorKeys(
  serverKey: string,
  legacyKeys: readonly string[],
  assertCurrent: () => void
): Promise<void> {
  if (serverKey === "" || legacyKeys.length === 0) return
  const canonical = await loadCursors(serverKey)
  assertCurrent()
  const { clearCursorsForServer } = await import("./cursor-store")
  for (const legacyKey of legacyKeys) {
    assertCurrent()
    const rows = await loadCursors(legacyKey)
    assertCurrent()
    if (rows.size === 0) continue
    for (const [table, row] of rows) {
      if (canonical.has(table)) continue
      const adopted = { ...row, serverKey }
      assertCurrent()
      await saveCursor(adopted)
      assertCurrent()
      canonical.set(table, adopted)
    }
    assertCurrent()
    await clearCursorsForServer(legacyKey)
  }
}

/**
 * Drop the mirrored rows when this database also holds another host's state.
 *
 * Partitioning the cursors alone is not enough *when two hosts share one
 * database*. It stops a client resuming from the wrong watermark, but the
 * *rows* pulled from the previous host are still sitting in the same tables,
 * so the two hosts' sessions, messages and characters would simply pile up
 * together. These tables are a cache of a host's state, not the client's own
 * data, so clearing and re-pulling loses nothing.
 *
 * Failures are swallowed: a wipe that could not run leaves a stale cache,
 * which is what the user had before, whereas throwing here would break sync
 * entirely.
 */
async function resetMirrorsForHostChange(
  previousServerKeys: readonly string[],
  assertCurrent: () => void
): Promise<void> {
  if (previousServerKeys.length === 0) return
  try {
    const { getDb } = await import("@/lib/db/schema")
    assertCurrent()
    const db = getDb()
    await Promise.all(
      SYNC_HANDLER_TABLES.map(async (table) => {
        // `settings` is a singleton the client also writes locally; clearing it
        // would throw away device-local preferences the host never had. The
        // mirrored subset is overwritten by the first pull anyway.
        if (table === "settings") return
        try {
          await (db as unknown as Record<string, { clear: () => Promise<void> }>)[table]?.clear()
        } catch {
          // One table failing must not stop the rest.
        }
      })
    )
    const { clearCursorsForServer } = await import("./cursor-store")
    for (const key of previousServerKeys) {
      assertCurrent()
      await clearCursorsForServer(key)
    }
  } catch {
    // See jsdoc.
  }
}

/**
 * Decide whether the wipe above is needed at all, from the database itself.
 *
 * The rule is one question: **does the database we are about to sync into
 * already hold cursors for a host other than this one?** Cursors are written
 * per host on every handler run into the same database as the mirrored rows,
 * so a foreign key here means that host's rows are in these very tables, and
 * nothing else does.
 *
 * Asking the database rather than tracking the switch in memory is what lets
 * host switching stop being destructive (ADR-0061 L3 / ADR-0097 D13). Once an
 * account has runtime targets, each host's mirror lives in its *own* Dexie
 * database (`activateAccountDatabase(accountId, targetId)` — see
 * `lib/runtime/account-runtime-target.ts`), so switching activates the other
 * host's database and this scan finds nothing foreign: both hosts keep their
 * mirror and their watermark, and switching back re-pulls nothing. When the
 * two hosts *do* share one database — an install with no runtime target, and
 * the legacy account-level database — the scan finds the foreign key and the
 * wipe still fires, exactly as before.
 *
 * It also covers the switch this process never saw. Re-pairing is normally a
 * restart, and on iOS the app is routinely killed between the
 * `CompanionConfig` write and the next sync tick, so an in-memory check alone
 * let host A's rows sit in the tables while host B's cursors started from
 * zero — the exact blend per-host cursors were introduced to prevent.
 *
 * An unpaired client (`serverKey === ""`) never wipes. It is not "talking to a
 * different host" yet, and `loadCompanionConfig` reads a cache that is empty
 * until `hydrateCompanionConfig` resolves at boot — so a sync that races
 * hydration would otherwise destroy the mirror of the host it is still paired
 * to.
 */
async function resetMirrorsSharedWithAnotherHost(
  serverKey: string,
  assertCurrent: () => void
): Promise<void> {
  if (serverKey === "") return
  const { listCursorServerKeys } = await import("./cursor-store")
  assertCurrent()
  const foreign = (await listCursorServerKeys()).filter((key) => key !== serverKey)
  assertCurrent()
  await resetMirrorsForHostChange(foreign, assertCurrent)
}

function getState(table: SyncableTable): SyncState {
  let state = stateMap.get(table)
  if (!state) {
    state = { lastSyncAt: null, since: 0, lastError: null }
    stateMap.set(table, state)
  }
  return state
}

export function getSyncStateFor(table: SyncableTable): Readonly<SyncState> {
  return { ...getState(table) }
}

export function snapshotSyncStates(): Record<SyncableTable, SyncState> {
  const snapshot = {} as Record<SyncableTable, SyncState>
  for (const { table } of DEFAULT_HANDLERS) {
    snapshot[table] = { ...getState(table) }
  }
  return snapshot
}

export interface RunSyncDownOptions {
  /** Cancels queued pulls and fences replies/writes already in flight. */
  signal?: AbortSignal
  /** Override the transport (tests). */
  transport?: Transport
  /**
   * Override the handler list (tests).
   *
   * `stage` may be omitted: an injected handler that does not declare one runs
   * in `critical`, so a test that never mentions stages keeps getting the whole
   * list on every run.
   */
  handlers?: SyncHandlerOverride[]
  /**
   * Restrict the run to a subset of tables (settings UI: "Sync now"
   * for a single row). When set, the handler list is filtered to just
   * these tables in their registered order — empty array means "no
   * handlers", which resolves to an empty outcomes array.
   */
  only?: readonly SyncableTable[]
  /**
   * Restrict the run to whole stages (see {@link SYNC_STAGES}). Composes with
   * `only`: both filters apply, so a stage run can still be narrowed to one
   * table. Omitted means every stage, which is what every existing caller —
   * "Sync now", the resync coordinator, the network/resume triggers — asks
   * for and keeps getting.
   */
  stages?: readonly SyncStage[]
}

/**
 * Pull every registered table. Returns one outcome per table, in registry
 * order. Up to {@link SYNC_MAX_CONCURRENT_PULLS} run at once, honouring the
 * `after` edges the registry declares; see {@link runHandlerGraph} for why the
 * old strictly-sequential drain was protecting nothing. Re-entrant: a second
 * call while one is in flight reuses the in-flight promise.
 *
 * Per-table runs (`opts.only`) bypass the re-entrancy gate so the user
 * can sync one row from the SyncStatusCard even when a full pull is
 * already in flight — otherwise the UI would silently wait on whatever
 * the orchestrator is doing. Stage runs (`opts.stages`) bypass it for the
 * same reason: {@link runStagedSyncDown} drives its later stages while the
 * caller is already awaiting the earlier one.
 * All table pulls serialize per transport and host, with one
 * trailing pull so invalidations arriving during a snapshot are not lost.
 */
let inflight: {
  promise: Promise<SyncOutcome[]>
  host: string
  generation: number
  database: ReturnType<typeof getDb>
  signal?: AbortSignal
} | null = null

interface TablePull {
  promise: Promise<SyncOutcome>
  queued: boolean
  signal?: AbortSignal
}
let tablePulls = new WeakMap<Transport, Map<string, TablePull>>()

/** Keep one active snapshot and one trailing pull for invalidations during it. */
function scheduleTablePull(
  transport: Transport,
  scope: string,
  run: () => Promise<SyncOutcome>,
  signal?: AbortSignal
): Promise<SyncOutcome> {
  let scopes = tablePulls.get(transport)
  if (!scopes) {
    scopes = new Map()
    tablePulls.set(transport, scopes)
  }
  const previous = scopes.get(scope)
  if (previous?.queued && !previous.signal?.aborted) return previous.promise
  const promise = (previous ? previous.promise.catch(() => undefined) : Promise.resolve()).then(
    () => {
      entry.queued = false
      return run()
    }
  )
  const entry: TablePull = { queued: Boolean(previous), promise, signal }
  scopes.set(scope, entry)
  const cleanup = () => {
    if (scopes.get(scope) === entry) scopes.delete(scope)
  }
  void entry.promise.then(cleanup, cleanup)
  return entry.promise
}

/**
 * Shared read-quota cooldown.
 *
 * The host's rate limit is per DEVICE, not per table and not per run, so the
 * only useful place to hold a refusal is somewhere every caller sees it. A
 * staged bootstrap has three chains draining at once and the event-driven
 * installer can start a fourth: back off in one of them and the others keep the
 * bucket pinned, which is precisely the "never clears it" failure
 * `CompanionError.retryAfterMs` was added to describe.
 *
 * Measured against a headless host on loopback before this existed: a boot
 * drained the bucket after roughly twenty tables and then took the refusal for
 * every remaining one, so 23 of 43 tables ended each boot empty with
 * `lastError: "device exceeded the remote execution quota"`, and the next boot
 * repeated it because the cursor never advanced.
 */
let quotaCooldownUntil = 0

/** How many times one table will wait out a refusal before it is reported. */
const QUOTA_RETRIES_PER_TABLE = 3
/** Used when the host refused without saying for how long. */
const QUOTA_FALLBACK_WAIT_MS = 1_000
/** Never park a table longer than this, however long the host asked for. */
const QUOTA_MAX_WAIT_MS = 30_000

async function awaitQuotaCooldown(signal?: AbortSignal): Promise<void> {
  const remaining = quotaCooldownUntil - Date.now()
  if (remaining <= 0 || signal?.aborted) return
  if (!signal) {
    await sleep(Math.min(remaining, QUOTA_MAX_WAIT_MS))
    return
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, Math.min(remaining, QUOTA_MAX_WAIT_MS))
    signal.addEventListener("abort", finish, { once: true })
  })
}

function noteQuotaRefusal(failure: SyncFailure): void {
  const wait = Math.min(failure.retryAfterMs ?? QUOTA_FALLBACK_WAIT_MS, QUOTA_MAX_WAIT_MS)
  quotaCooldownUntil = Math.max(quotaCooldownUntil, Date.now() + wait)
}

/**
 * How many table pulls are in flight at once.
 *
 * The run used to be strictly sequential, justified as "so a slow desktop
 * server doesn't get hit with 25 simultaneous round-trips". That read the cost
 * backwards on both sides:
 *
 *   • Nothing downstream was being protected. `SyncBridge::pull`
 *     (`src-tauri/src/companion_api/sync_bridge.rs`) keys pending requests by
 *     id in a map and admits up to 128 in flight, and the Host answers each
 *     one in its own fire-and-forget task (`desktop-sync-source.ts` responds
 *     from the event listener without a queue). The serialisation was entirely
 *     on this side of the wire.
 *   • The client paid one whole round-trip per table — {@link
 *     SYNC_HANDLER_TABLES} is 47 of them — on every cold start, the
 *     empty-delta case included. That is latency, and no amount of cursor
 *     persistence removes it: a client with nothing to fetch still had to ask
 *     47 times to find that out.
 *
 * So the ceiling is about *this* process, not the Host: enough chains to hide
 * the round-trip, few enough that their Dexie applies still interleave on the
 * one main thread. The Host's read bucket (capacity 120, refilling at 10/s —
 * `rate_limit.rs:read_only_default`) absorbs a burst this size, and
 * {@link awaitQuotaCooldown} already parks every chain together when it does
 * not — a shared cooldown that was written for concurrent chains before there
 * were any.
 */
export const SYNC_MAX_CONCURRENT_PULLS = 6

interface PullBudget {
  active: number
  waiting: Array<() => void>
}
let pullBudgets = new WeakMap<Transport, Map<string, PullBudget>>()

async function withPullBudget<T>(
  transport: Transport,
  host: string,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return run()
  let hosts = pullBudgets.get(transport)
  if (!hosts) {
    hosts = new Map()
    pullBudgets.set(transport, hosts)
  }
  let budget = hosts.get(host)
  if (!budget) {
    budget = { active: 0, waiting: [] }
    hosts.set(host, budget)
  }
  if (budget.active >= SYNC_MAX_CONCURRENT_PULLS) {
    const admitted = await new Promise<boolean>((resolve) => {
      const begin = () => {
        signal?.removeEventListener("abort", cancel)
        resolve(true)
      }
      const cancel = () => {
        const index = budget.waiting.indexOf(begin)
        if (index !== -1) budget.waiting.splice(index, 1)
        resolve(false)
      }
      budget.waiting.push(begin)
      signal?.addEventListener("abort", cancel, { once: true })
    })
    if (!admitted) return run()
  } else {
    budget.active++
  }
  try {
    return await run()
  } finally {
    const next = budget.waiting.shift()
    if (next) next()
    else {
      budget.active--
      if (budget.active === 0 && hosts.get(host) === budget) hosts.delete(host)
    }
  }
}

/**
 * Run `handlers` with bounded concurrency, honouring their `after` edges.
 *
 * Outcomes come back in **registry order, never completion order**: callers
 * read them positionally against the handler list they asked for, and going
 * concurrent must not change what `results[3]` means.
 *
 * `start` receives how many pulls were started before this one, so the first
 * in a run can skip the main-thread yield the rest owe.
 *
 * A rejection is propagated after the in-flight chains settle, which keeps
 * `runStagedSyncDown().critical` rejecting on a pipeline failure the way its
 * contract promises. Per-table failures are `{ ok: false }` outcomes and are
 * not this.
 *
 * A cycle among the edges would deadlock the loop. The static registry cannot
 * contain one (pinned by `companion-sync.test.ts`), but `opts.handlers` lets a
 * caller inject any set, so a stall releases the earliest-registered blocked
 * handler instead of hanging sync forever.
 */
async function runHandlerGraph(
  handlers: readonly RegisteredHandler[],
  start: (handler: RegisteredHandler, startedBefore: number) => Promise<SyncOutcome>,
  limit = SYNC_MAX_CONCURRENT_PULLS
): Promise<SyncOutcome[]> {
  const results = new Array<SyncOutcome>(handlers.length)
  const present = new Set(handlers.map((handler) => handler.table))
  // Only an edge naming a table in *this* run is a barrier. A `stages` or
  // `only` filter that dropped the dependency drops the constraint with it —
  // waiting on a pull that is never going to be started is a deadlock, not an
  // ordering. A self-edge is discarded for the same reason.
  const blockedBy = handlers.map(
    (handler) =>
      new Set(
        (handler.after ?? []).filter((table) => table !== handler.table && present.has(table))
      )
  )
  const dependents = new Map<SyncableTable, number[]>()
  handlers.forEach((_, index) => {
    for (const table of blockedBy[index]) {
      const list = dependents.get(table)
      if (list) list.push(index)
      else dependents.set(table, [index])
    }
  })

  const remaining = new Set(handlers.map((_, index) => index))
  const ready: number[] = []
  handlers.forEach((_, index) => {
    if (blockedBy[index].size === 0) ready.push(index)
  })
  const running = new Map<number, Promise<void>>()
  let started = 0
  // A one-slot array rather than a nullable local: the only assignment happens
  // inside a rejection callback, and TypeScript narrows a `let` that a closure
  // writes to back down to its initial type at every later read.
  const failures: { error: unknown }[] = []

  const release = (index: number): void => {
    const list = dependents.get(handlers[index].table)
    if (!list) return
    for (const dependent of list) {
      blockedBy[dependent].delete(handlers[index].table)
      if (blockedBy[dependent].size === 0 && remaining.has(dependent)) ready.push(dependent)
    }
  }

  while (remaining.size > 0 || running.size > 0) {
    while (running.size < limit && ready.length > 0 && failures.length === 0) {
      const index = ready.shift() as number
      remaining.delete(index)
      const startedBefore = started++
      // Both branches settle this promise, so nothing here can surface as an
      // unhandled rejection while a sibling chain is still being awaited.
      const tracked = start(handlers[index], startedBefore).then(
        (outcome) => {
          running.delete(index)
          results[index] = outcome
          release(index)
        },
        (error: unknown) => {
          running.delete(index)
          failures.push({ error })
        }
      )
      running.set(index, tracked)
    }
    if (running.size === 0) {
      if (failures.length > 0) break
      // Nothing running, nothing ready, work left: the injected edges contain
      // a cycle. Break it at the earliest-registered blocked handler so the
      // run makes progress in a defined order rather than stalling.
      const next = Math.min(...remaining)
      blockedBy[next].clear()
      ready.push(next)
      continue
    }
    await Promise.race(running.values())
  }

  if (failures.length > 0) {
    await Promise.allSettled(running.values())
    throw failures[0].error
  }
  return results
}

export function runSyncDown(opts: RunSyncDownOptions = {}): Promise<SyncOutcome[]> {
  const isTargeted = opts.only !== undefined || opts.stages !== undefined
  const t = opts.transport ?? transport
  const requestedHostKey = currentHostCursorKeys().key
  const requestedGeneration = getCompanionConfigGeneration()
  const requestedDatabase = getDb()
  if (
    inflight &&
    !inflight.signal?.aborted &&
    !isTargeted &&
    inflight.host === requestedHostKey &&
    inflight.generation === requestedGeneration &&
    inflight.database === requestedDatabase
  )
    return inflight.promise
  let handlers: RegisteredHandler[] = opts.handlers
    ? opts.handlers.map((handler) => ({ stage: DEFAULT_HANDLER_STAGE, ...handler }))
    : DEFAULT_HANDLERS
  if (opts.stages) {
    const stageSet = new Set(opts.stages)
    handlers = handlers.filter((h) => stageSet.has(h.stage))
  }
  if (opts.only) {
    const onlySet = new Set(opts.only)
    handlers = handlers.filter((h) => onlySet.has(h.table))
  }

  const runPromise: Promise<SyncOutcome[]> = (async () => {
    await ensureHydrated()
    return runHandlerGraph(handlers, async (handler, startedBefore) => {
      const { table, run } = handler
      // Hand the thread back before every table but the first. A pull is
      // request → parse → Dexie write, and back-to-back that is one unbroken
      // run of main-thread work per table; the gap is what lets the shell
      // paint the rows that already landed while the rest are still arriving.
      // Concurrency does not retire this: the chains share one main thread, so
      // the yield is what keeps their applies from fusing into a single job.
      if (startedBefore > 0) await yieldToMain()
      const pull = async (): Promise<SyncOutcome> => {
        const hostChanged = () =>
          opts.signal?.aborted ||
          getCompanionConfigGeneration() !== requestedGeneration ||
          getDb() !== requestedDatabase ||
          currentHostCursorKeys().key !== requestedHostKey ||
          hydratedServerKey !== requestedHostKey
        const staleHost: SyncOutcome = {
          ok: false,
          failure: { table, reason: "transport", message: "Sync host changed" },
        }
        if (hostChanged()) return staleHost
        const state = getState(table)
        let resumeCursor: SyncCursor = {
          since: state.since,
          ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
        }
        // A refusal recorded by any chain parks every table, including this one,
        // before it spends a token that is not there.
        await awaitQuotaCooldown(opts.signal)
        if (hostChanged()) return staleHost
        const assertCurrent = () => {
          if (hostChanged()) throw new Error("Sync scope changed")
        }
        const guardedCursor = () => ({ ...resumeCursor, assertCurrent })
        let outcome = await run(t, guardedCursor())
        if (hostChanged()) return staleHost
        // A quota refusal says nothing about this table, so retrying it is the
        // only honest response. Bounded, because a host that keeps refusing has
        // a problem waiting cannot fix, and a table reported as rate-limited is
        // still better than a run that never ends.
        for (
          let attempt = 0;
          !outcome.ok &&
          outcome.failure.reason === "rate_limited" &&
          attempt < QUOTA_RETRIES_PER_TABLE;
          attempt++
        ) {
          noteQuotaRefusal(outcome.failure)
          if (outcome.failure.progress) {
            resumeCursor = {
              since: outcome.failure.progress.nextSince,
              cursor: outcome.failure.progress.nextCursor,
            }
            state.since = resumeCursor.since
            state.cursor = resumeCursor.cursor
          }
          await awaitQuotaCooldown(opts.signal)
          if (hostChanged()) return staleHost
          outcome = await run(t, guardedCursor())
          if (hostChanged()) return staleHost
        }
        const progress = outcome.ok ? outcome.result : outcome.failure.progress
        if (progress && progress.nextSince >= state.since) {
          state.since = progress.nextSince
          state.cursor = progress.nextCursor
        }
        if (outcome.ok) {
          state.lastSyncAt = Date.now()
          state.lastError = null
        } else {
          state.lastError = outcome.failure.message
        }
        // Fire-and-forget Dexie persistence so the next cold start can resume
        // from this cursor. Failures are swallowed by `cursor-store.saveCursor`.
        void saveCursor({
          serverKey: hydratedServerKey ?? "",
          table,
          since: state.since,
          ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
          lastSyncAt: state.lastSyncAt,
          lastError: state.lastError,
        })
        return outcome
      }
      return scheduleTablePull(
        t,
        `${requestedHostKey}:${requestedGeneration}:${table}`,
        () => withPullBudget(t, requestedHostKey, pull, opts.signal),
        opts.signal
      )
    })
  })()

  if (!isTargeted) {
    inflight = {
      promise: runPromise,
      host: requestedHostKey,
      generation: requestedGeneration,
      database: requestedDatabase,
      signal: opts.signal,
    }
    const clear = () => {
      if (inflight?.promise === runPromise) inflight = null
    }
    void runPromise.then(clear, clear)
  }

  return runPromise
}

/** What a staged run hands back. Both promises; neither rejects. */
export interface StagedSyncRun {
  /**
   * Settles when the `critical` stage has finished — the point at which the
   * client can paint its first screen honestly. This is what a boot path
   * awaits.
   *
   * It REJECTS if the pipeline itself broke (hydration, transport
   * construction). Per-table failures are not that: those are recorded as
   * `{ ok: false }` outcomes and resolve normally. Swallowing the pipeline
   * failure here would flip a client to "online" over a sync that never ran,
   * and skip the reconnect the caller schedules on exactly that rejection.
   */
  critical: Promise<SyncOutcome[]>
  /**
   * Settles when every stage has drained, with the outcomes of all of them.
   *
   * Awaiting it is for tests and for a deliberate "sync everything now"; the
   * boot path does not, which is the whole point of staging. Unlike `critical`
   * it never rejects: nobody is awaiting it, so a throw here would be an
   * unhandled rejection on a connection that is already usable. A stage that
   * breaks is skipped and the later ones still get their turn.
   */
  whenComplete: Promise<SyncOutcome[]>
}

/**
 * Pull the Host's state in stages, letting the caller continue as soon as the
 * client can honestly paint.
 *
 * This exists because the boot path used to await *everything*: a paired client
 * showed "connecting" until the last table landed, so one slow or large table
 * held the whole shell dark and the tables that had already arrived went
 * unrendered. Now `critical` settles first, the connection goes online, and
 * `interactive` then `background` fill in behind the running UI — each waiting
 * for an idle moment, so they interleave with whatever the user has started
 * doing rather than competing with it.
 *
 * Re-entrant like {@link runSyncDown}: a second staged run while one is in
 * flight reuses it, so a reconnect storm cannot stack three drains onto one
 * transport.
 */
let stagedInflight: StagedSyncRun | null = null
let stagedScope: {
  signal?: AbortSignal
  host: string
  generation: number
  database: ReturnType<typeof getDb>
} | null = null

export function runStagedSyncDown(opts: RunSyncDownOptions = {}): StagedSyncRun {
  const scope = {
    signal: opts.signal,
    host: currentHostCursorKeys().key,
    generation: getCompanionConfigGeneration(),
    database: getDb(),
  }
  const isCurrent = () =>
    !opts.signal?.aborted &&
    currentHostCursorKeys().key === scope.host &&
    getCompanionConfigGeneration() === scope.generation &&
    getDb() === scope.database
  if (
    stagedInflight &&
    !stagedScope?.signal?.aborted &&
    stagedScope?.host === scope.host &&
    stagedScope.generation === scope.generation &&
    stagedScope.database === scope.database
  )
    return stagedInflight

  const critical = runSyncDown({ ...opts, stages: ["critical"] })

  const whenComplete = (async () => {
    const outcomes: SyncOutcome[] = []
    try {
      outcomes.push(...(await critical))
    } catch {
      // The caller owns this failure — it is awaiting `critical` and reacts to
      // the rejection there. Catching it here is only so the later stages still
      // run, and so this promise stays the one that never rejects.
    }
    for (const stage of SYNC_STAGES.slice(1)) {
      try {
        // Between stages the correct answer is "later", not "next macrotask":
        // the shell is mid-first-paint and the rows this stage carries are not
        // on screen yet. The deadline inside `whenIdle` keeps a busy or
        // backgrounded tab from stalling here forever.
        await whenIdle()
        if (!isCurrent()) return outcomes
        outcomes.push(...(await runSyncDown({ ...opts, stages: [stage] })))
      } catch {
        // Per-table failures are already recorded as outcomes; reaching here
        // means the pipeline itself broke (hydration, transport construction).
        // Later stages still get their turn — one broken stage is not a reason
        // to abandon the rest of the mirror.
      }
    }
    return outcomes
  })()

  const run: StagedSyncRun = { critical, whenComplete }
  stagedInflight = run
  stagedScope = scope
  void whenComplete.finally(() => {
    if (stagedInflight === run) stagedInflight = null
  })
  return run
}

/**
 * How long the app must have been away before coming back earns a full pull.
 *
 * Below this the socket was never suspended and `installEventDrivenSync` was
 * delivering invalidations the whole time, so there is nothing to catch up on.
 */
export const FOREGROUND_SYNC_MIN_AWAY_MS = 5_000

/** Floor between two foreground pulls, however often the app is re-entered. */
export const FOREGROUND_SYNC_COOLDOWN_MS = 30_000

/**
 * Returning to the app is only worth a pull if the app was actually away.
 *
 * A full pull is one request per synced table, and nothing bounded how often
 * one could be started. `installForegroundSync` and `installResumeSync` are
 * also the SAME event on web, because `subscribeResume` falls back to
 * `visibilitychange`, so one tab switch armed two of them.
 *
 * Anything that flickers the visibility state therefore pinned the Host's rate
 * limiter, and a paired browser was measured re-pulling every table twice a
 * second for as long as it was left open. The 429s that came back landed on
 * whatever else was in flight: the host-owned agent list, for one, which made
 * a configured agent vanish from the runtime picker.
 *
 * The two floors are the pair `installResumeReconnect` already uses: away time
 * for "nothing accumulated", and a cooldown so even genuine absences cannot be
 * re-entered into a storm. The state is module-scoped rather than per
 * installer precisely because both installers observe the one return.
 *
 * `installNetworkSync` deliberately keeps neither: connectivity loss is a
 * different signal, and there really is a gap behind it.
 */
let foregroundHiddenSince: number | null = null
let lastForegroundSync = 0

/**
 * Whether this return to the foreground should pull, consuming the away time.
 *
 * An unknown away time (a mobile `resume` with no `visibilitychange` before
 * it, or the first return after install) counts as away: the cooldown is what
 * keeps that from being a hole.
 */
function claimForegroundSync(now: number): boolean {
  const awayFor = foregroundHiddenSince === null ? Infinity : now - foregroundHiddenSince
  foregroundHiddenSince = null
  if (awayFor < FOREGROUND_SYNC_MIN_AWAY_MS) return false
  if (now - lastForegroundSync < FOREGROUND_SYNC_COOLDOWN_MS) return false
  lastForegroundSync = now
  return true
}

/**
 * Re-run the sync whenever the document becomes visible. Returns a
 * teardown function that detaches the listener; safe to call inside
 * useEffect.
 */
export function installForegroundSync(
  opts: RunSyncDownOptions = {},
  now: () => number = Date.now
): () => void {
  if (typeof document === "undefined") return () => {}
  if (document.visibilityState === "hidden") foregroundHiddenSince ??= now()
  const handler = () => {
    if (document.visibilityState !== "visible") {
      foregroundHiddenSince ??= now()
      return
    }
    if (claimForegroundSync(now())) void runSyncDown(opts)
  }
  document.addEventListener("visibilitychange", handler)
  return () => document.removeEventListener("visibilitychange", handler)
}

/**
 * Subscribe to the server's `sync://invalidate` channel. Whenever the
 * desktop emits a delta event the orchestrator re-pulls the relevant
 * table. The channel design is server-defined; we accept either a
 * `{ table }` payload (selective pull) or no payload (pull all).
 */
export function installEventDrivenSync(opts: RunSyncDownOptions = {}): () => void {
  const t = opts.transport ?? transport
  // ADR-0131: a chatty connector host (an ai-run reply touches the outbound
  // row three times, an inbound burst adds N messages) still yields one
  // `sync_pull` per table per window. Keyed invalidations coalesce per table;
  // an untabled ("pull everything") frame collapses every pending window into
  // one full run.
  const pending = new Map<SyncableTable | "*", ReturnType<typeof setTimeout>>()
  let disposed = false
  const flush = (key: SyncableTable | "*"): void => {
    pending.delete(key)
    if (disposed) return
    if (key === "*") {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      // A broadcast during a full snapshot needs a trailing pull for tables
      // whose cut was already taken; the manual full-run gate only dedupes.
      void runSyncDown({ ...opts, only: opts.only ?? SYNC_HANDLER_TABLES })
      return
    }
    const only = opts.only === undefined ? [key] : opts.only.filter((table) => table === key)
    if (only.length === 0) return
    void runSyncDown({ ...opts, only })
  }
  const unsub = t.subscribe<{ table?: SyncableTable }>("sync://invalidate", (payload) => {
    if (disposed) return
    const key: SyncableTable | "*" = payload?.table ?? "*"
    if (pending.has(key)) return
    // Skip tables this installer was scoped away from — no timer, no pull.
    if (key !== "*" && opts.only !== undefined && !opts.only.includes(key)) return
    if (key === "*") {
      // A full pull supersedes every keyed window already armed.
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    } else if (pending.has("*")) {
      return
    }
    pending.set(
      key,
      setTimeout(() => flush(key), EVENT_SYNC_COALESCE_MS)
    )
  })
  return () => {
    disposed = true
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    unsub()
  }
}

const WORKFLOW_RUN_STATUS_CHANNEL = "workflow://run-status"
const WORKFLOW_RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
])
const TERMINAL_WORKFLOW_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
])

interface WorkflowRunStatusFrame {
  runId: string
  workflowId: string
  status: RunStatus
  lastStepId?: string
}

/** Apply live Host run transitions to the paired client's existing mirror. */
export function installWorkflowRunStatusSync(opts: RunSyncDownOptions = {}): () => void {
  const t = opts.transport ?? transport
  let disposed = false
  const unsubscribe = t.subscribe<WorkflowRunStatusFrame>(WORKFLOW_RUN_STATUS_CHANNEL, (frame) => {
    if (
      disposed ||
      !frame ||
      typeof frame.runId !== "string" ||
      !frame.runId ||
      typeof frame.workflowId !== "string" ||
      !frame.workflowId ||
      !WORKFLOW_RUN_STATUSES.has(frame.status)
    ) {
      return
    }
    void (async () => {
      const run = await getDb().workflowRuns.get(frame.runId)
      if (!run) {
        await runSyncDown({ ...opts, only: ["workflowRuns"] })
        return
      }
      // WS replay must never move a terminal mirror back into an active state.
      if (
        TERMINAL_WORKFLOW_RUN_STATUSES.has(run.status) &&
        !TERMINAL_WORKFLOW_RUN_STATUSES.has(frame.status)
      ) {
        return
      }
      await getDb().workflowRuns.update(frame.runId, {
        status: frame.status,
        ...(typeof frame.lastStepId === "string" && frame.lastStepId
          ? { lastCompletedStepId: frame.lastStepId }
          : {}),
      })
    })().catch(() => {
      if (!disposed) void runSyncDown({ ...opts, only: ["workflowRuns"] })
    })
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}

/** Per-table coalescing window for `sync://invalidate` → `sync_pull` (ADR-0131). */
export const EVENT_SYNC_COALESCE_MS = 100

/**
 * Re-run the sync whenever the network reports `connected: true`. This is
 * the mobile-critical trigger — sessions/messages that piled up while the
 * phone was on airplane mode are pulled the moment Wi-Fi comes back.
 *
 * Mirrors `lib/queue/outbound-queue.ts`'s subscription model so the two
 * runners share the same event source; `@capacitor/network` plugin listeners
 * are multi-subscriber-safe.
 */
export function installNetworkSync(opts: RunSyncDownOptions = {}): Promise<() => void> {
  return subscribeNetwork((status) => {
    if (status.connected) {
      void runSyncDown(opts)
    }
  })
}

/**
 * Re-run the sync whenever the OS reports the app resumed to foreground.
 * Falls back to `document.visibilitychange === "visible"` on web/Tauri.
 * Layered on top of `installForegroundSync` — the two cover slightly
 * different surfaces (the visibility API fires on web tab focus changes;
 * the `resume` event fires when the app process is restored on mobile).
 */
export function installResumeSync(
  opts: RunSyncDownOptions = {},
  now: () => number = Date.now
): Promise<() => void> {
  return subscribeResume(() => {
    if (claimForegroundSync(now())) void runSyncDown(opts)
  })
}

/** Test-only — wipes the cursor map between tests. */
export function __resetSyncStateForTests(): void {
  foregroundHiddenSince = null
  lastForegroundSync = 0
  stateMap.clear()
  inflight = null
  tablePulls = new WeakMap()
  pullBudgets = new WeakMap()
  stagedInflight = null
  stagedScope = null
  hydratePromise = null
  // Also forget which host we were hydrated for, or the next test's first
  // `ensureHydrated` would see a "host change" and wipe the tables it just
  // seeded.
  hydratedServerKey = null
  hydratedDatabase = null
  hydratedGeneration = -1
  quotaCooldownUntil = 0
  void clearCursors()
}
