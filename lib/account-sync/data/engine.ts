/**
 * The account sync engine for one database (ADR-0215 phase 3a).
 *
 * One window per database syncs: the engine takes a Web Lock named after the
 * database and works only while it holds it; the others wait as followers
 * (their writes are still captured into the shared outbox, which the leader
 * pushes). Without Web Locks (the headless brain, one process) it leads.
 *
 * As leader it first joins the database to the account (`join.ts`): seeds on
 * its own, or waits for the person's merge-or-replace choice. Then two lanes:
 *
 * - **Push**: a change in the outbox is pushed 1.5 s after the last write, and
 *   at most 10 s after the first one waiting.
 * - **Pull**: a live socket (protocol §6) announces new ops and list changes;
 *   without one (refused, dropped, or no WebSocket), a long-poll that waits up
 *   to 25 s, while the socket is retried with backoff.
 *
 * A removal is believed only through the verified list (`handleRevokedAnswer`):
 * then capture is disarmed and the engine stops. Integrity failures stop
 * nothing locally and change nothing; the lane backs off and tries again.
 *
 * Runs only against the profile's own database, never a companion mirror of
 * another host (the caller resolves that); framework-free, so the app and the
 * headless brain share it.
 */

import { liveQuery, type Subscription } from "dexie"

import type { DeviceKeys } from "@/lib/account-sync/crypto"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { handleRevokedAnswer } from "@/lib/account-sync/enrollment/revoked"
import { SyncApiError } from "@/lib/account-sync/sync-api"
import type { RemovalRecord } from "@/lib/account-sync/vault-store"
import type { CogniaDB } from "@/lib/db/schema"

import { parkedCounts } from "./applier"
import {
  armAndSeed,
  disarm,
  joinWithChoice,
  planJoin,
  seedClass,
  type JoinChoice,
  type JoinTarget,
  type LocalDataSummary,
  type SeedProgress,
} from "./join"
import { SyncDeviceRemovedError, runSyncRound, type SyncRoundResult } from "./sync-round"
import type {
  AccountSyncCaptureState,
  AccountSyncCursorState,
  SyncClasses,
  SyncedTableName,
} from "./types"

export const PUSH_DEBOUNCE_MS = 1_500
export const PUSH_MAX_DELAY_MS = 10_000
export const LONG_POLL_WAIT_S = 25
export const SOCKET_PING_MS = 30_000
/** The close code the Worker uses for a removed device's sockets. */
export const REVOKED_CLOSE_CODE = 4403

/** The part of the WebSocket interface the engine uses. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface LockManagerLike {
  request(
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<void>
  ): Promise<unknown>
}

export interface EngineSyncState {
  live: "socket" | "poll" | "connecting"
  /** Changes waiting to go up. */
  pending: number
  parked: { schema: number; key: number }
  lastSyncedAt: number | null
  /** Rows too large to sync as one change. */
  tooLarge: string[]
  error: string | null
  /** What this device syncs. */
  classes: SyncClasses
}

export type EngineStatus =
  | { kind: "starting" }
  /** Another window of this database syncs. */
  | { kind: "follower" }
  | { kind: "seeding"; progress: SeedProgress | null }
  | { kind: "join-choice"; local: LocalDataSummary; remoteSeq: number }
  | ({ kind: "running" } & EngineSyncState)
  | { kind: "removed"; removal: RemovalRecord }
  | { kind: "stopped" }

export interface EngineDelays {
  pushDebounceMs: number
  pushMaxDelayMs: number
  pingMs: number
  longPollWaitS: number
  /** Wait before retrying after `failures` consecutive failures. */
  retryMs: (failures: number) => number
}

export interface AccountSyncEngineDeps {
  context: AccountSyncContext
  device: DeviceKeys
  /** The profile's own database (never a companion mirror). */
  db: CogniaDB
  /** Web Locks; `null` leads without an election. Defaults to `navigator.locks`. */
  locks?: LockManagerLike | null
  /** WebSocket factory; `null` long-polls only. Defaults to the global WebSocket. */
  openSocket?: ((url: string) => SocketLike) | null
  onStatus?: (status: EngineStatus) => void
  /** Remote changes were written to these tables (refresh what reads them). */
  onApplied?: (tables: ReadonlySet<SyncedTableName>) => void
  /** The device list changed (the enrollment poller should look now). */
  onRegistryChanged?: () => void
  delays?: Partial<EngineDelays>
}

export interface AccountSyncEngine {
  status(): EngineStatus
  /**
   * The person's choice when both this device and the account hold data.
   * `backup` runs first; if it fails (or is cancelled) nothing changes and the
   * choice stays open.
   */
  join(choice: JoinChoice, backup: () => Promise<void>): Promise<void>
  /** Turns classes on or off; a class turned on is seeded and pulled again. */
  setClasses(classes: SyncClasses): Promise<void>
  /** Push and pull now. */
  syncNow(): void
  stop(): void
}

const DEFAULT_DELAYS: EngineDelays = {
  pushDebounceMs: PUSH_DEBOUNCE_MS,
  pushMaxDelayMs: PUSH_MAX_DELAY_MS,
  pingMs: SOCKET_PING_MS,
  longPollWaitS: LONG_POLL_WAIT_S,
  retryMs: (failures) => Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, failures - 1)),
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null
  const locks = (navigator as { locks?: LockManagerLike }).locks
  return locks && typeof locks.request === "function" ? locks : null
}

function defaultSocket(): ((url: string) => SocketLike) | null {
  const Socket = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  return Socket ? (url) => new Socket(url) : null
}

function messageOf(error: unknown): string {
  if (error instanceof SyncApiError) return error.code
  return error instanceof Error ? error.message : String(error)
}

export function accountSyncLockName(db: CogniaDB): string {
  return `cognia-account-sync:${db.name}`
}

export function startAccountSyncEngine(deps: AccountSyncEngineDeps): AccountSyncEngine {
  const { context, device, db } = deps
  const delays = { ...DEFAULT_DELAYS, ...deps.delays }
  const locks = deps.locks === undefined ? defaultLocks() : deps.locks
  const openSocket = deps.openSocket === undefined ? defaultSocket() : deps.openSocket
  const target: JoinTarget = {
    db,
    spaceId: context.session.spaceId,
    deviceId: device.deviceId,
    now: context.now,
  }
  const roundContext = {
    db,
    api: context.api,
    vault: context.vault,
    spaceId: context.session.spaceId,
    now: context.now,
  }

  const abort = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let current: EngineStatus = { kind: "starting" }
  let sync: EngineSyncState = {
    live: "connecting",
    pending: 0,
    parked: { schema: 0, key: 0 },
    lastSyncedAt: null,
    tooLarge: [],
    error: null,
    classes: { content: true, settings: true },
  }
  let choose: ((choice: JoinChoice) => void) | null = null
  let outboxWatch: Subscription | null = null
  let socket: SocketLike | null = null
  let socketFailures = 0
  let mode: "socket" | "poll" | "idle" = "idle"

  const stopped = () => abort.signal.aborted
  const later = (ms: number, run: () => void) => {
    if (stopped()) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!stopped()) run()
    }, ms)
    timers.add(timer)
    return timer
  }
  const cancel = (timer: ReturnType<typeof setTimeout> | null | undefined) => {
    if (!timer) return
    clearTimeout(timer)
    timers.delete(timer)
  }
  const setStatus = (status: EngineStatus) => {
    if (stopped() && status.kind !== "stopped") return
    current = status
    deps.onStatus?.(status)
  }
  const publish = (patch: Partial<EngineSyncState>) => {
    sync = { ...sync, ...patch }
    if (current.kind === "running" || current.kind === "starting" || current.kind === "seeding")
      setStatus({ kind: "running", ...sync })
  }

  async function refreshCounts(): Promise<void> {
    const [pending, parked, capture] = await Promise.all([
      db.accountSyncOutbox.count(),
      parkedCounts(db),
      db.accountSyncState.get("capture") as Promise<AccountSyncCaptureState | undefined>,
    ])
    publish({ pending, parked, ...(capture ? { classes: capture.classes } : {}) })
  }

  /** Believes a removal only through the verified list; then disarms and stops. */
  async function onRemoved(): Promise<boolean> {
    const removal = await handleRevokedAnswer(context, device)
    if (!removal) return false
    await disarm(db)
    setStatus({ kind: "removed", removal })
    shutDown()
    return true
  }

  /** Every lane's failures land here: a proven removal stops the engine, anything else is shown. */
  async function failed(error: unknown): Promise<void> {
    if (stopped()) return
    if (
      error instanceof SyncDeviceRemovedError ||
      (error instanceof SyncApiError && error.code === "device_revoked")
    ) {
      if (await onRemoved().catch(() => false)) return
    }
    publish({ error: messageOf(error) })
  }

  function absorb(result: SyncRoundResult): void {
    if (result.tables.size > 0) deps.onApplied?.(result.tables)
    publish({
      lastSyncedAt: context.now(),
      error: null,
      ...(result.tooLarge.length > 0 ? { tooLarge: result.tooLarge } : {}),
    })
  }

  // ── push lane ─────────────────────────────────────────────────────────
  let pushing = false
  let pushAgain = false
  let pushFailures = 0
  let debounce: ReturnType<typeof setTimeout> | null | undefined = null
  let deadline: ReturnType<typeof setTimeout> | null | undefined = null

  function schedulePush(): void {
    cancel(debounce)
    debounce = later(delays.pushDebounceMs, () => void push())
    if (!deadline) deadline = later(delays.pushMaxDelayMs, () => void push())
  }

  async function push(): Promise<void> {
    cancel(debounce)
    cancel(deadline)
    debounce = deadline = null
    if (stopped()) return
    if (pushing) {
      pushAgain = true
      return
    }
    pushing = true
    try {
      absorb(await runSyncRound(roundContext, device, { pushOnly: true }))
      pushFailures = 0
    } catch (error) {
      pushFailures += 1
      await failed(error)
      later(delays.retryMs(pushFailures), () => void push())
    } finally {
      pushing = false
      if (!stopped()) await refreshCounts().catch(() => undefined)
      if (pushAgain && !stopped()) {
        pushAgain = false
        void push()
      }
    }
  }

  function watchOutbox(): void {
    let first = true
    outboxWatch = liveQuery(() => db.accountSyncOutbox.count()).subscribe({
      next: (count) => {
        publish({ pending: count })
        if (count === 0) return
        if (first) void push()
        else schedulePush()
        first = false
      },
      error: (error) => void failed(error),
    })
  }

  // ── pull lane ─────────────────────────────────────────────────────────
  let pullQueue: Promise<unknown> = Promise.resolve()
  let pullFailures = 0
  let pullWanted = false
  let pollGeneration = 0

  /** One pull round; never rejects, says whether it worked. */
  async function runPull(waitS: number): Promise<boolean> {
    if (stopped()) return true
    try {
      absorb(await runSyncRound(roundContext, device, { pullOnly: true, waitS }))
      pullFailures = 0
      return true
    } catch (error) {
      pullFailures += 1
      await failed(error)
      return false
    } finally {
      if (!stopped()) await refreshCounts().catch(() => undefined)
    }
  }

  /** Runs `task` between pulls, so no pull in flight writes over what it changes. */
  function betweenPulls<T>(task: () => Promise<T>): Promise<T> {
    const next = pullQueue.then(task)
    pullQueue = next.catch(() => undefined)
    return next
  }

  /** Pulls run one at a time, in the order asked. */
  function enqueuePull(waitS: number, before?: () => void): Promise<boolean> {
    const next = pullQueue.then(() => {
      before?.()
      return runPull(waitS)
    })
    pullQueue = next
    return next
  }

  /** An immediate pull; asks made while one waits coalesce into it. */
  function pull(): Promise<void> {
    if (pullWanted) return pullQueue.then(() => undefined)
    pullWanted = true
    return enqueuePull(0, () => {
      pullWanted = false
    }).then((ok) => {
      // A socket only speaks when something changes: retry a failed pull ourselves.
      if (!ok && mode === "socket") later(delays.retryMs(pullFailures), () => void pull())
    })
  }

  async function pollLoop(generation: number): Promise<void> {
    while (generation === pollGeneration && mode === "poll" && !stopped()) {
      const ok = await enqueuePull(delays.longPollWaitS)
      if (!ok) await new Promise<void>((resolve) => later(delays.retryMs(pullFailures), resolve))
    }
  }

  function toPolling(): void {
    if (mode === "poll" || stopped()) return
    mode = "poll"
    publish({ live: "poll" })
    void pollLoop(++pollGeneration)
  }

  async function connect(): Promise<void> {
    if (stopped()) return
    if (!openSocket) {
      toPolling()
      return
    }
    let ticket: string
    try {
      ticket = (await context.api.socketTicket(device)).ticket
    } catch (error) {
      await failed(error)
      socketFailed()
      return
    }
    if (stopped()) return
    let opened: SocketLike
    try {
      opened = openSocket(context.api.socketUrl(ticket))
    } catch {
      socketFailed()
      return
    }
    socket = opened
    let ping: ReturnType<typeof setInterval> | null = null
    opened.onopen = () => {
      if (stopped()) return
      socketFailures = 0
      mode = "socket"
      publish({ live: "socket" })
      ping = setInterval(() => {
        try {
          opened.send("ping")
        } catch {
          // The close handler takes it from here.
        }
      }, delays.pingMs)
      // Anything stored while connecting.
      void pull()
    }
    opened.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return
      let message: { type?: unknown }
      try {
        message = JSON.parse(event.data) as { type?: unknown }
      } catch {
        return
      }
      if (message.type === "registry") deps.onRegistryChanged?.()
      if (message.type === "ops" || message.type === "registry") void pull()
    }
    opened.onerror = () => undefined
    opened.onclose = (event) => {
      if (ping) clearInterval(ping)
      if (socket === opened) socket = null
      if (stopped()) return
      if (event.code === REVOKED_CLOSE_CODE) {
        void onRemoved().then((removed) => {
          if (!removed) socketFailed()
        })
        return
      }
      socketFailed()
    }
  }

  /** Falls back to long-polling and tries the socket again later. */
  function socketFailed(): void {
    if (stopped()) return
    socketFailures += 1
    toPolling()
    later(delays.retryMs(socketFailures), () => {
      // A socket that opens takes over from the poll loop after its current wait.
      void connect().then(() => undefined)
    })
  }

  // ── leading ───────────────────────────────────────────────────────────
  async function startLanes(): Promise<void> {
    setStatus({ kind: "running", ...sync })
    await refreshCounts()
    watchOutbox()
    await connect()
  }

  async function lead(): Promise<void> {
    const plan = await planJoin(target, context.api, device)
    if (stopped()) return
    if (plan.kind === "seed") {
      setStatus({ kind: "seeding", progress: null })
      await armAndSeed(target, (progress) => setStatus({ kind: "seeding", progress }))
    } else if (plan.kind === "ask") {
      setStatus({ kind: "join-choice", local: plan.local, remoteSeq: plan.remoteSeq })
      const choice = await new Promise<JoinChoice>((resolve) => {
        choose = resolve
      })
      choose = null
      if (stopped()) return
      setStatus({ kind: "seeding", progress: null })
      await joinWithChoice(target, choice, {
        // `join` took the backup before handing the choice over.
        backup: async () => undefined,
        onProgress: (progress) => setStatus({ kind: "seeding", progress }),
      })
    }
    if (stopped()) return
    await startLanes()
    // Hold the lead until stopped.
    await new Promise<void>((resolve) => {
      if (stopped()) resolve()
      else abort.signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }

  async function leadSafely(): Promise<void> {
    try {
      await lead()
    } catch (error) {
      if (stopped()) return
      await failed(error)
      if (current.kind === "removed" || stopped()) return
      // Joining failed (offline): try again later.
      setStatus({ kind: "running", ...sync, error: messageOf(error) })
      await new Promise<void>((resolve) => later(delays.retryMs(1), resolve))
      if (!stopped()) await leadSafely()
    }
  }

  function shutDown(): void {
    if (stopped()) return
    abort.abort()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    outboxWatch?.unsubscribe()
    outboxWatch = null
    socket?.close(1000, "stopped")
    socket = null
    mode = "idle"
    choose?.("merge")
  }

  if (locks) {
    setStatus({ kind: "follower" })
    void locks
      .request(accountSyncLockName(db), { signal: abort.signal }, async () => {
        if (stopped()) return
        setStatus({ kind: "starting" })
        await leadSafely()
      })
      .catch(() => undefined)
  } else {
    void leadSafely()
  }

  return {
    status: () => current,
    async join(choice, backup) {
      if (!choose) throw new Error("no join choice is pending")
      await backup()
      if (!choose) throw new Error("no join choice is pending")
      choose(choice)
    },
    async setClasses(classes) {
      const turnedOn = await db.transaction("rw", db.accountSyncState, async () => {
        const state = (await db.accountSyncState.get("capture")) as
          AccountSyncCaptureState | undefined
        if (!state) throw new Error("this database is not syncing")
        await db.accountSyncState.put({ ...state, classes })
        return (["content", "settings"] as const).filter(
          (cls) => classes[cls] && !state.classes[cls]
        )
      })
      if (current.kind === "running") await refreshCounts()
      if (turnedOn.length === 0) return
      for (const cls of turnedOn) await seedClass(target, cls)
      // Pull the account again: ops of the class were passed over while it was off.
      await betweenPulls(() =>
        db.transaction("rw", db.accountSyncState, async () => {
          const cursor = (await db.accountSyncState.get("cursor")) as
            AccountSyncCursorState | undefined
          if (cursor) await db.accountSyncState.put({ ...cursor, serverSeq: 0 })
        })
      )
      if (current.kind === "running") void pull()
    },
    syncNow() {
      if (current.kind !== "running") return
      void push()
      void pull()
    },
    stop() {
      shutDown()
      setStatus({ kind: "stopped" })
    },
  }
}
