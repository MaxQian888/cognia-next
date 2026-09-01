"use client"

/**
 * Plugin-facing session store.
 *
 * cognia-next persists sessions in Dexie (`lib/db/sessions.ts`); the
 * authoritative active-session pointer lives in `useChatStore`. The
 * plugin Session API needs a Zustand surface with `sessions: Session[]`,
 * `activeSessionId`, and CRUD methods — we provide it here as an
 * adapter that hydrates lazily and delegates writes to the Dexie layer.
 *
 * This store is intentionally small: it does NOT replace `useChatStore`
 * for the rest of the app. Only plugin code reads through it.
 */

import { create } from "zustand"
import { useChatStore } from "./chat-store"
import {
  createSession as dbCreateSession,
  deleteSession as dbDeleteSession,
  getSession as dbGetSession,
  listSessions as dbListSessions,
  updateSession as dbUpdateSession,
} from "@/lib/db/sessions"
import { resolveThinkingLevel, thinkingLevelPatch } from "@/lib/ai/thinking-level"
import { clearActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
import { desktop } from "@/lib/automation/client"
import { isTauri } from "@/lib/tauri"
import type { Session, CreateSessionInput, UpdateSessionInput } from "@/types/plugin/_compat"

interface SessionStoreState {
  sessions: Session[]
  activeSessionId: string | null
  loaded: boolean

  /** Hydrate the in-memory cache from Dexie. Idempotent. */
  load: () => Promise<void>

  createSession: (options?: CreateSessionInput) => Session
  /**
   * Apply the patch to the in-memory row, and resolve once the Dexie write it
   * implies has landed (or reject with why it did not, having put back the
   * fields it moved).
   *
   * "Landed" includes the row still existing: Dexie resolves an update against
   * a missing key rather than refusing it, so a write to a conversation that
   * has been deleted rejects here instead of resolving on nothing.
   *
   * The in-memory half stays synchronous, so a subscriber re-renders in the
   * same tick. The returned promise is the *persistence* answer, and it is
   * returned rather than swallowed because the only production caller is the
   * plugin session API, whose authors show the user a success toast on it. A
   * `void`-returning write made "saved" and "silently lost on reload"
   * indistinguishable from the outside.
   *
   * Persistence-backed: `title`, `projectId`, `squadId`, `effort`,
   * `thinkingLevel`. Those are the fields with a `ChatSession` column, and the
   * only ones a resolved promise is a statement about. `effort` and
   * `thinkingLevel` are one setting in two halves, so naming either one writes
   * both (see `normalizeThinkingHalves`).
   *
   * In-memory only: `mode` and `metadata`. Neither has a column, so a patch of
   * just those resolves having written nothing, and the value is gone on
   * reload. That is a gap in the schema, not a silent failure of this write,
   * and it is stated here because the resolved promise cannot state it. They do
   * survive a conversation switch: the Dexie re-read merges onto the cached row
   * rather than replacing it. Both are applied to the cached row, so a
   * `getSession` straight after this call sees them, and neither advances
   * `updatedAt` on its own, because that is the sort key and a recency the
   * database never received would reorder the list until the next reload.
   *
   * `projectId` is the one field whose column is only part of the answer.
   * Moving a conversation between workspaces is three writes, so it is routed
   * through {@link moveSessionWorkspace} and can REJECT (a running or
   * handed-off conversation, an unknown destination) where a plain column
   * write could not.
   */
  updateSession: (id: string, updates: UpdateSessionInput) => Promise<void>
  deleteSession: (id: string) => void
  setActiveSession: (id: string | null) => void
}

/**
 * Synchronous-looking session creation. The plugin API expects
 * `Session` back immediately, so we mint the local row, publish it
 * into the cache, and fire a background Dexie write. If Dexie fails
 * we log; we don't rollback because the in-memory cache already has
 * what the plugin needs.
 */
function buildLocalSession(options: CreateSessionInput): Session {
  const now = Date.now()
  const id = `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    title: options.title ?? "New chat",
    kind: "direct",
    characterId: options.characterId,
    teamId: options.teamId,
    createdAt: now,
    updatedAt: now,
    mode: options.mode,
    projectId: options.projectId,
    branches: [],
  }
}

type SetState = (
  partial: Partial<SessionStoreState> | ((state: SessionStoreState) => Partial<SessionStoreState>)
) => void
type GetState = () => SessionStoreState

/**
 * Place an adopted row where `listSessions` would have put it.
 *
 * `dbListSessions` orders by `updatedAt` descending and the plugin API returns
 * `store.sessions` in array order for an unfiltered `listSessions()`, so
 * prepending an adopted row put whatever conversation the user last switched
 * to at the head of "most recent" regardless of how old it was.
 */
function insertByRecency(sessions: readonly Session[], row: Session): Session[] {
  const at = sessions.findIndex((s) => timeOf(s.updatedAt) < timeOf(row.updatedAt))
  const next = [...sessions]
  next.splice(at === -1 ? next.length : at, 0, row)
  return next
}

/** `Session` widens the timestamps to `number | Date` for plugin authors. */
function timeOf(value: number | Date | undefined): number {
  if (value instanceof Date) return value.getTime()
  return value ?? 0
}

/**
 * Does the re-read row still say what the cached one already says?
 *
 * Compares only the keys Dexie carries, because those are the only ones the
 * re-read can speak to: `mode`, `metadata` and `branches` live in memory alone
 * and are absent from `row`, so including them would report a difference on
 * every call.
 *
 * Object columns are compared by value, not by reference. IndexedDB hands back
 * a fresh structured clone on every read, so `executionContext` and its
 * neighbours are a new object each time and a reference check would report
 * "changed" for every session that has one, which is every session in a
 * workspace. Being wrong in that direction costs exactly the `set` this exists
 * to avoid, so it is not allowed to be the common case.
 */
function columnsMatch(cached: Session, row: Session): boolean {
  const keys = Object.keys(row) as (keyof Session)[]
  return keys.every((key) => {
    const before = cached[key]
    const after = row[key]
    if (Object.is(before, after)) return true
    if (typeof after !== "object" || after === null) return false
    if (typeof before !== "object" || before === null) return false
    return JSON.stringify(before) === JSON.stringify(after)
  })
}

/**
 * Re-read one session from Dexie into the cache.
 *
 * `load()` runs once and every later write to a session goes around this store:
 * new chats are minted by `useChatStore` / `lib/db/sessions`, and the composer's
 * own effort control writes straight to Dexie. Without this the cache answers
 * `null` for every conversation started after boot (so plugins see "no active
 * session" while one is open) and serves a stale tier for the rest.
 *
 * Scoped to one row rather than re-listing: it is the only one a plugin can ask
 * about, and one `get` per event is a cost the full list is not.
 *
 * Two callers, and the difference matters. A `"switch"` may ADOPT a row the
 * cache has never seen, because that is the conversation a plugin is about to
 * ask about, and it verifies the pointer has not moved on again. A `"write"`
 * refreshes the ACTIVE row only. That is the whole reason the write hook
 * exists (the composer's own effort chip writes to the open conversation, which
 * never moves the pointer), and scoping it there is what keeps the hook off the
 * hot path: the cache holds every session after `load()`, so "is it cached"
 * was true for all of them and every one of the ~30 session writes in the app,
 * a streaming title included, bought an IndexedDB `get` plus a rebuilt
 * `sessions` array that re-rendered every subscriber. A background write to
 * some other conversation is picked up by the switch instead, when a plugin
 * can actually observe it.
 */
async function hydrateSession(
  id: string | null,
  set: SetState,
  get: GetState,
  reason: "switch" | "write" = "switch"
): Promise<void> {
  if (!id) return
  if (reason === "write" && get().activeSessionId !== id) return
  try {
    const row = (await dbGetSession(id)) as Session | undefined
    if (!row) return
    // Still the active session? A fast switch away must not resurrect the row
    // it left, nor overwrite the one that replaced it.
    if (reason === "switch" && get().activeSessionId !== id) return
    // Decided with `get`, not inside the `set` updater. Zustand builds a new
    // state object and notifies every listener for an updater that returns
    // `{}` just as readily as for a real change, so "nothing to say" has to
    // mean not calling `set` at all. It is the common case: the hook behind
    // this fires on every write to the open conversation (`lib/db/messages.ts`
    // stamps `lastMessagePreview` / `lastMessageAt` on each message boundary),
    // and `onSessionChange` subscribes with no selector, so it cannot filter
    // the wake-up out for itself.
    const cached = get().sessions.find((s) => s.id === id)
    if (cached && columnsMatch(cached, row)) return
    set((state) => ({
      sessions: state.sessions.some((s) => s.id === id)
        ? // Merged, not replaced. `mode`, `metadata` and `branches` have no
          // `ChatSession` column, so a wholesale swap would erase what the write
          // path deliberately keeps in memory every time the user rounds back
          // through another conversation.
          state.sessions.map((s) => (s.id === id ? { ...s, ...row } : s))
        : insertByRecency(state.sessions, row),
    }))
  } catch (err) {
    // Non-fatal, same as `load()`: the cache keeps whatever it had.
    console.warn("session-store.hydrateSession failed", err)
  }
}

/**
 * The write path the switch subscription cannot see.
 *
 * The composer's own effort control calls `lib/db/sessions.updateSession`
 * directly, around this cache, and that is a SAME-session write: it never moves
 * the active pointer, so nothing above ever fires. Without this the dial and the
 * host's chip end up reporting different tiers for the same conversation.
 *
 * Deferred with a macrotask rather than read inline: the `updating` hook runs
 * *during* the write, so a read from inside it would still see the pre-write
 * row. After the turn of the loop the transaction has settled, and re-reading is
 * correct whether it committed or aborted.
 */
let sessionWriteHookInstalled = false
async function installSessionWriteHook(set: SetState, get: GetState): Promise<void> {
  if (sessionWriteHookInstalled) return
  sessionWriteHookInstalled = true
  try {
    const { db } = await import("@/lib/db")
    const refresh = (primaryKey: unknown) => {
      const id = typeof primaryKey === "string" ? primaryKey : null
      if (!id) return
      setTimeout(() => void hydrateSession(id, set, get, "write"), 0)
    }
    /**
     * A delete needs the OPPOSITE of a re-read. `refresh` bails on a row it
     * cannot find, so pointing it at this hook made it a no-op by construction:
     * the UI's own conversation delete goes through `lib/db/sessions`, not this
     * store, and the deleted row then sat in the cache for the life of the
     * process, with `listSessions` / `getSession` handing plugins a
     * conversation the user had closed.
     *
     * Confirmed against Dexie rather than assumed, on the same macrotask delay
     * and for the same reason: the hook fires DURING the transaction, and an
     * aborted delete leaves the row exactly where it was.
     */
    const evict = (primaryKey: unknown) => {
      const id = typeof primaryKey === "string" ? primaryKey : null
      if (!id) return
      setTimeout(() => {
        void (async () => {
          try {
            if (await dbGetSession(id)) return
          } catch {
            return
          }
          // Read before writing. Zustand builds a new state object and notifies
          // every listener for a `set` of `{}` just as readily as for a real
          // change, so the "already gone" branch has to not call it at all.
          if (!get().sessions.some((s) => s.id === id)) return
          set((state) => ({
            sessions: state.sessions.filter((s) => s.id !== id),
            activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
          }))
        })()
      }, 0)
    }
    db.sessions.hook("updating", (_mods, primaryKey) => refresh(primaryKey))
    db.sessions.hook("deleting", (primaryKey) => evict(primaryKey))
  } catch (err) {
    // A shell without Dexie (or a suite that stubs it) simply keeps the
    // switch-driven refresh. Never fatal.
    sessionWriteHookInstalled = false
    console.warn("session-store.installSessionWriteHook failed", err)
  }
}

/**
 * Test-only: let a suite re-arm the once-per-process hook.
 *
 * Guarded like `__resetPermissionGuardForTesting`, and for the same reason: the
 * flag is the only thing stopping a second `updating` / `deleting` handler
 * being registered on `db.sessions`, and every extra handler doubles the
 * refresh work behind every session write in the app.
 */
export function __resetSessionWriteHookForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetSessionWriteHookForTesting is only callable in NODE_ENV=test")
  }
  sessionWriteHookInstalled = false
}

/**
 * Reduce whatever the caller said about the reasoning tier to one coherent pair.
 *
 * `effort` is what every existing consumer reads and `thinkingLevel` carries the
 * tier identity it cannot express (`off` vs unset, and `ultracode` as `xhigh`
 * plus the workflow-tool suite). They are only ever guaranteed to agree because
 * one function writes both, so every shape a plugin can hand over is collapsed
 * here rather than persisted as a disagreement.
 *
 * A NAMED tier is what decides anything. Keying off `"thinkingLevel" in updates`
 * made a key carrying `undefined` a choice, so the idiomatic
 * `{ title, thinkingLevel: draft.level }` with an unset draft read as "set this
 * conversation to off" and quietly dropped it from `ultracode` to standby. The
 * meaningless keys are stripped instead, so they cannot reach Dexie either.
 *
 * When BOTH halves are named the tier still decides, including when the two
 * disagree. `{ effort: "high", thinkingLevel: "ultracode" }` used to be written
 * verbatim, which is a row whose name switches the `wf_*` suite on while the
 * wire carries a shallower depth than the name promises. The tier is the
 * richer half, so it is the half that survives.
 */
function normalizeThinkingHalves(updates: UpdateSessionInput): UpdateSessionInput {
  const level = updates.thinkingLevel
  const effort = updates.effort
  if (level !== undefined) return { ...updates, ...thinkingLevelPatch(level) }
  if (effort !== undefined) {
    // Only a raw effort. `resolveThinkingLevel` is the same derivation legacy
    // rows get, so the tier it implies is never invented here.
    return { ...updates, thinkingLevel: resolveThinkingLevel({ effort }) }
  }
  if (!("effort" in updates) && !("thinkingLevel" in updates)) return updates
  const rest = { ...updates }
  delete rest.effort
  delete rest.thinkingLevel
  return rest
}

/**
 * Refuse a write to a conversation that is no longer there.
 *
 * `lib/db/sessions.updateSession` cannot answer this: `Table.update` on a
 * missing key resolves with `0`, and the write guard it calls first
 * short-circuits on a falsy row. One `get` per plugin write is the price of the
 * promise meaning what its docstring says it means, and plugin writes are not a
 * hot path (the Dexie hook, which is, does not go through here).
 */
async function assertSessionExists(id: string): Promise<void> {
  if (await dbGetSession(id)) return
  throw new Error(`session ${id} no longer exists`)
}

/**
 * Undo one failed write without stepping on a later one that succeeded.
 *
 * Only the keys this call actually sent to Dexie, and only where the row still
 * holds the value this call put there. A key some other update has since moved
 * is left where that update put it.
 */
function rollbackFields(
  set: SetState,
  id: string,
  dbPatch: Parameters<typeof dbUpdateSession>[1],
  applied: Session,
  previous: Session
): void {
  const keys = Object.keys(dbPatch) as (keyof Session)[]
  set((state) => ({
    sessions: state.sessions.map((s) => {
      if (s.id !== id) return s
      const restored: Session = { ...s }
      const writable = restored as Record<string, unknown>
      let changed = false
      for (const key of keys) {
        if (!Object.is(restored[key], applied[key])) continue
        writable[key as string] = previous[key]
        changed = true
      }
      // `updatedAt` was stamped by this call alone, so it goes back with the
      // fields it was stamped for, and only while nothing newer has moved it.
      if (Object.is(restored.updatedAt, applied.updatedAt)) {
        restored.updatedAt = previous.updatedAt
        changed = true
      }
      return changed ? restored : s
    }),
  }))
}

/**
 * The workspace half of a plugin's `updateSession`.
 *
 * Attribution is three writes, not one. `components/chat/session-workspace-move.tsx`
 * performs all three: the `projectId` column, an `executionContext` rebuilt
 * against the destination's root, and the `Project.sessionIds` roster on both
 * sides, which is also what fires `sessionLinked`. Writing the column alone
 * left the conversation listed under the workspace it had left, its counts
 * wrong on both sides, and still RUNNING in the old workspace's directory,
 * which is the exact mis-attribution `planSessionMove` exists to prevent.
 *
 * So it reuses that planner rather than open-coding a second, shorter move that
 * only plugins can reach, and inherits its refusals with it: a running
 * conversation holds a turn lease against the old workspace, and a handed-off
 * one is read-only by contract (ADR-0103). A refusal rejects, which is what the
 * returned promise is for.
 *
 * Imported lazily so a store the plugin API constructs for every plugin context
 * does not pull the project store, the planner and the execution broker into
 * its module graph for the writes that are not moves.
 */
async function moveSessionWorkspace(
  id: string,
  previous: Session | undefined,
  targetId: string | undefined,
  dbPatch: Parameters<typeof dbUpdateSession>[1]
): Promise<void> {
  const { useProjectStore } = await import("@/stores/project/project-store")
  // Awaited, not assumed. `project-store`'s own `persist()` is gated on
  // `loaded`, so a roster write issued before the boot initializer has hydrated
  // silently reaches no row: the session's `projectId` column would name the
  // new workspace while both rosters still described the old one. `load()`
  // guards on its own flag, so this costs nothing once it has run.
  await useProjectStore.getState().load()
  const store = useProjectStore.getState()

  const [{ planSessionMove }, { getExecutionBroker }] = await Promise.all([
    import("@/lib/chat/move-session-workspace"),
    import("@/lib/execution/broker"),
  ])
  // The same two refusals for both directions. Unlinking has no destination to
  // plan against, but a running turn holds its lease and a handed-off row is
  // read-only whichever way attribution is moving, and detaching mid-turn is
  // the very mis-attribution this function routes through the planner to
  // prevent. `assertSessionWritable` catches only the handoff, and only as a
  // "metadata" write.
  if (!targetId) {
    if (previous?.handoffLock) throw new Error("session workspace move refused: session-locked")
    if (getExecutionBroker().hasActiveSession(id)) {
      throw new Error("session workspace move refused: session-running")
    }
    // The old context named the workspace the conversation has just left, so
    // leaving it in place would keep the next turn running in that directory
    // under a row that belongs to no workspace at all. Cleared rather than
    // rebuilt: there is no destination to rebuild it against.
    await dbUpdateSession(id, { ...dbPatch, executionContext: undefined })
    if (previous?.projectId) store.removeSessionFromProject(previous.projectId, id)
    return
  }

  const plan = planSessionMove({
    session: {
      id,
      projectId: previous?.projectId,
      executionContext: previous?.executionContext,
      handoffLock: previous?.handoffLock,
    },
    target: store.projects.find((project) => project.id === targetId) ?? null,
    // The broker rather than a store slice, for the reason the UI path states:
    // a conversation with no open pane keeps streaming into Dexie, so a
    // store-only check would call a running background turn idle.
    running: getExecutionBroker().hasActiveSession(id),
    now: Date.now(),
  })
  if (!plan.ok) throw new Error(`session workspace move refused: ${plan.reason}`)

  await dbUpdateSession(id, { ...dbPatch, executionContext: plan.executionContext })
  if (plan.previousProjectId) store.removeSessionFromProject(plan.previousProjectId, id)
  store.addSessionToProject(plan.projectId, id)
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return
    // Claimed BEFORE the await, not after. `createSessionAPI` calls this once
    // per plugin context and startup activates dozens of built-ins, so a guard
    // that only closed once Dexie answered let every one of them through and
    // left a permanent chat-store listener behind. Each of those then re-ran the
    // hydrate below on every conversation switch.
    set({ loaded: true })
    try {
      const rows = await dbListSessions()
      set({ sessions: rows as Session[] })
    } catch (err) {
      // Non-fatal: plugin code can still operate on the empty list.
      console.warn("session-store.load failed", err)
    }
    void installSessionWriteHook(set, get)
    // Track the chat store's active session pointer.
    const bootId = useChatStore.getState().activeSessionId
    set({ activeSessionId: bootId })
    // The boot pointer needs the same re-read as every later one. A chat started
    // at launch is minted by `useChatStore` while `dbCreateSession` is still in
    // flight, so the listing above can miss it and a plugin would answer "no
    // active session" for a conversation that is plainly open.
    void hydrateSession(bootId, set, get)
    useChatStore.subscribe((state) => {
      const current = get().activeSessionId
      if (state.activeSessionId === current) return
      set({ activeSessionId: state.activeSessionId })
      void hydrateSession(state.activeSessionId, set, get)
    })
  },

  createSession: (options = {}) => {
    const session = buildLocalSession(options)
    set((state) => ({ sessions: [session, ...state.sessions] }))
    void dbCreateSession({
      title: session.title,
      characterId: session.characterId,
      teamId: session.teamId,
      kind: session.kind,
    }).catch((err) => console.warn("dbCreateSession failed", err))
    return session
  },

  updateSession: (id, updates) => {
    // `effort` and `thinkingLevel` are two halves of ONE setting, and
    // `ChatSession.thinkingLevel` names `thinkingLevelPatch` as its only
    // supported writer. The plugin-facing input type cannot express that, so a
    // plugin can hand over half a tier: `{ effort: "high" }` onto a session at
    // `thinkingLevel: "medium"` would render as Patrol while the wire carried
    // `high`, and a lone `{ thinkingLevel: "ultracode" }` would switch the
    // workflow-tool suite on at whatever depth the stale `effort` still held.
    // Fill in the missing half here, at the one place a plugin can reach.
    const patch = normalizeThinkingHalves(updates)
    const previous = get().sessions.find((s) => s.id === id)

    const dbPatch: Parameters<typeof dbUpdateSession>[1] = {}
    if (patch.title !== undefined) dbPatch.title = patch.title
    if ("effort" in patch) dbPatch.effort = patch.effort
    if ("thinkingLevel" in patch) dbPatch.thinkingLevel = patch.thinkingLevel
    // `projectId` has had its own `ChatSession` column since the workspace
    // isolation bump. The tag this used to pack into `scratchpad` never made
    // the link survive a reload (nothing read it back) and did overwrite the
    // notes an imported session carries in that field. The column is only part
    // of a move, though, so it is routed rather than appended.
    const moving = "projectId" in patch && patch.projectId !== previous?.projectId
    if (moving) dbPatch.projectId = patch.projectId
    // `squadId` is on the accepted-input whitelist and has a column, so a
    // plugin handing a conversation to a Squad has to reach Dexie. Dropping it
    // made `updateSession` resolve on a handover that never happened, which is
    // exactly the "saved vs silently lost" ambiguity the returned promise is
    // supposed to remove.
    if ("squadId" in patch) dbPatch.squadId = patch.squadId
    const persists = Object.keys(dbPatch).length > 0

    // Held so a failed write can be undone FIELD BY FIELD. Restoring the whole
    // row by identity looked equivalent and was not: a concurrent update to a
    // different key replaces the object, the identity check then misses, and
    // this call's unpersisted value stays in the cache for good. Rolling back
    // only the keys this call moved, and only where the current row still holds
    // what this call put there, undoes exactly this write and leaves a later
    // one that landed alone.
    let applied: Session | undefined
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== id) return s
        const next: Session = {
          ...s,
          title: patch.title ?? s.title,
          mode: patch.mode ?? s.mode,
          // Applied like `mode`, so the docstring's "in-memory only" is a
          // statement about persistence rather than about whether the value
          // exists at all. There is no `ChatSession` column to write it to.
          metadata: patch.metadata ?? s.metadata,
          projectId: "projectId" in patch ? patch.projectId : s.projectId,
          squadId: "squadId" in patch ? patch.squadId : s.squadId,
          effort: "effort" in patch ? patch.effort : s.effort,
          thinkingLevel: "thinkingLevel" in patch ? patch.thinkingLevel : s.thinkingLevel,
          // Only when something is actually being persisted. `updatedAt` is the
          // sort key `listSessions` orders on, so stamping it for a patch that
          // reaches no column put the conversation at the top of a list on the
          // strength of a recency the database never received, and the order
          // silently changed back on the next reload or re-read.
          updatedAt: persists ? Date.now() : s.updatedAt,
        }
        applied = next
        return next
      }),
    }))

    if (!persists) return Promise.resolve()
    // Checked before the write, because Dexie will not check it for us.
    // `db.sessions.update` on an absent key resolves with a modified count of
    // `0` that nothing reads, and `assertSessionWritable` returns silently for
    // a row it was handed as `undefined`. Left alone, this promise resolved for
    // a conversation the user had already deleted, which is the "saved vs
    // silently lost" ambiguity returning the promise at all was meant to end.
    const write = assertSessionExists(id).then(() =>
      moving
        ? moveSessionWorkspace(id, previous, patch.projectId, dbPatch)
        : dbUpdateSession(id, dbPatch)
    )
    return write.catch((err) => {
      if (previous && applied) rollbackFields(set, id, dbPatch, applied, previous)
      throw err
    })
  },

  deleteSession: (id) => {
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
    }))
    void dbDeleteSession(id).catch((err) => console.warn("dbDeleteSession failed", err))
    // Screen-off Computer Use — releasing a closed session drops its cached
    // settings and tears down any virtual display it was holding (immediate
    // EXIT signal; the controller's 5-min idle release + kill switch remain as
    // safety nets). Fire-and-forget — desktop-only.
    clearActiveComputerUseSettings(id)
    if (isTauri()) {
      void desktop.virtualDisplayRelease(id).catch(() => {})
    }
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id })
    useChatStore.getState().setActiveSession(id)
  },
}))
