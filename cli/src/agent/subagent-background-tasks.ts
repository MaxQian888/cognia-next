import {
  BackgroundTaskRegistry,
  backgroundTaskInterruptedMessage,
  type BackgroundTaskControls,
  type BackgroundTaskJournalWriter,
  type BackgroundTaskStartMeta,
  type BackgroundTaskStatus,
} from "@/lib/background-tasks/registry-core"
import {
  createDexieBackgroundTaskJournal,
  getBackgroundTaskRecord,
  listBackgroundTaskRecords,
} from "@/lib/db/background-tasks"
import { ensureCliDb } from "../db/bootstrap"

export type CliBackgroundRunStatus = BackgroundTaskStatus

export interface CliBackgroundRunInfo {
  runId: string
  subagentId: string
  status: CliBackgroundRunStatus
  startedAt: number
  /** The chat session that started the run — the cross-session isolation key. */
  sessionId: string
}

export type CliBackgroundTaskMeta = BackgroundTaskStartMeta & {
  host: "cli"
  home?: string
}

const runHomes = new Map<string, string | undefined>()
// The session that owns each live run — the cross-session isolation key. A run
// may only be collected / listed / counted by the session that started it, so a
// second chat session (or a post-`/clear` session, which gets a fresh id) can
// never read another session's subagent output even though the registry +
// journal are process-/disk-global.
const runOwners = new Map<string, string>()
const interruptedHomes = new Set<string>()
const dexieJournal = createDexieBackgroundTaskJournal()

let journalQueue: Promise<unknown> = Promise.resolve()
let lastHandle: Awaited<ReturnType<typeof ensureCliDb>> | null = null

const journal: BackgroundTaskJournalWriter = {
  recordStart(record) {
    return enqueueJournalWrite(record.runId, async () => dexieJournal.recordStart(record))
  },
  recordSettle(runId, patch) {
    return enqueueJournalWrite(runId, async () => dexieJournal.recordSettle(runId, patch))
  },
}

const registry = new BackgroundTaskRegistry<string>({
  journal,
  projectForJournal: (value) => ({ text: value }),
})

export function startCliBackgroundRun(
  runId: string,
  meta: CliBackgroundTaskMeta,
  promise: Promise<string>,
  controls?: BackgroundTaskControls
): void {
  const { home, ...journalMeta } = meta
  runHomes.set(runId, home)
  runOwners.set(runId, journalMeta.sessionId)
  registry.start(runId, journalMeta, promise, controls)
}

export function hasCliBackgroundRun(runId: string): boolean {
  return registry.has(runId)
}

/**
 * Collect a background run's result. IDEMPOTENT: after the live entry is
 * consumed, every later collect answers from the journal (results stay
 * collectable) — a model that re-collects always gets the result instead of
 * "not found". `collectedAt` stamps the latest successful collect.
 */
export async function collectCliBackgroundResult(
  runId: string,
  options: { home?: string; owner?: string } = {}
): Promise<string | undefined> {
  // Cross-session isolation: when an owner is supplied, a run started by a
  // different session is invisible — return `undefined` (the dispatch layer then
  // reports it as an unknown run) WITHOUT consuming it, so the rightful owner can
  // still collect later. Check the live registry first, then the journal record.
  if (options.owner !== undefined) {
    const liveOwner = runOwners.get(runId)
    if (liveOwner !== undefined && liveOwner !== options.owner) return undefined
  }
  try {
    const live = await registry.collect(runId)
    if (live !== undefined) {
      markCliCollected(runId)
      runHomes.delete(runId)
      runOwners.delete(runId)
      return live
    }
  } catch (err) {
    markCliCollected(runId)
    runHomes.delete(runId)
    runOwners.delete(runId)
    return errorMessage(err)
  }

  const record = await readJournalRecord(runId, options.home)
  if (!record || record.host !== "cli") return undefined
  if (options.owner !== undefined && record.sessionId !== options.owner) return undefined
  if (record.status === "done") {
    markCliCollected(runId, options.home)
    return record.resultText ?? ""
  }
  if (record.status === "error") {
    markCliCollected(runId, options.home)
    return record.error ?? record.resultText ?? "Background run failed."
  }
  if (record.status === "interrupted") {
    markCliCollected(runId, options.home)
    return backgroundTaskInterruptedMessage(runId)
  }
  return undefined
}

/** Read a run's journal record with owner scoping (resume mode). */
export async function getCliBackgroundRecord(
  runId: string,
  options: { home?: string; owner?: string } = {}
) {
  const record = await readJournalRecord(runId, options.home)
  if (!record || record.host !== "cli") return undefined
  if (options.owner !== undefined && record.sessionId !== options.owner) return undefined
  return record
}

/** Best-effort collect bookkeeping through the serialized journal queue. */
function markCliCollected(runId: string, home?: string): void {
  void enqueueJournal(home ?? runHomes.get(runId), async (handle) => {
    await dexieJournal.update(runId, { collectedAt: Date.now() })
    handle.scheduleFlush()
  }).catch(() => undefined)
}

export function listCliBackgroundRuns(owner?: string): CliBackgroundRunInfo[] {
  return registry
    .list()
    .filter((entry) => owner === undefined || entry.sessionId === owner)
    .map((entry) => ({
      runId: entry.runId,
      subagentId: entry.subagentId,
      status: entry.status,
      startedAt: entry.startedAt,
      sessionId: entry.sessionId,
    }))
}

export function countRunningCliBackgroundRuns(owner?: string): number {
  if (owner === undefined) return registry.countRunning()
  return registry.list().filter((entry) => entry.status === "running" && entry.sessionId === owner)
    .length
}

export async function countInterruptedCliBackgroundRuns(
  options: { home?: string; owner?: string } = {}
): Promise<number> {
  const records = await readJournalRecords(options.home)
  return records.filter(
    (record) =>
      record.host === "cli" &&
      record.status === "interrupted" &&
      (options.owner === undefined || record.sessionId === options.owner)
  ).length
}

export function __clearAllCliBackgroundRunsForTesting(): void {
  registry.__clearForTesting()
  runHomes.clear()
  runOwners.clear()
  interruptedHomes.clear()
  journalQueue = Promise.resolve()
}

export async function __waitForCliBackgroundJournalForTesting(): Promise<void> {
  await journalQueue
}

export async function __disposeCliBackgroundJournalForTesting(): Promise<void> {
  await journalQueue.catch(() => undefined)
  if (lastHandle) {
    await lastHandle.dispose()
    lastHandle = null
  }
}

function enqueueJournalWrite<T>(
  runId: string | undefined,
  write: () => T | Promise<T>
): Promise<T> {
  return enqueueJournal(runHomes.get(runId ?? ""), async (handle) => {
    const result = await write()
    handle.scheduleFlush()
    return result
  })
}

function readJournalRecord(runId: string, home?: string) {
  return enqueueJournal(home, () => getBackgroundTaskRecord(runId))
}

function readJournalRecords(home?: string) {
  return enqueueJournal(home, () => listBackgroundTaskRecords({ host: "cli" }))
}

function enqueueJournal<T>(
  home: string | undefined,
  operation: (handle: Awaited<ReturnType<typeof ensureCliDb>>) => T | Promise<T>
): Promise<T> {
  const next = journalQueue.then(
    () => runWithCliDb(home, operation),
    () => runWithCliDb(home, operation)
  )
  journalQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

async function runWithCliDb<T>(
  home: string | undefined,
  operation: (handle: Awaited<ReturnType<typeof ensureCliDb>>) => T | Promise<T>
): Promise<T> {
  const handle = await ensureCliDb(home ? { home } : {})
  lastHandle = handle
  const key = home ?? "__default__"
  if (!interruptedHomes.has(key)) {
    interruptedHomes.add(key)
    await markCliRunningRowsInterrupted()
    handle.scheduleFlush()
  }
  return operation(handle)
}

async function markCliRunningRowsInterrupted(): Promise<void> {
  const now = Date.now()
  const running = await listBackgroundTaskRecords({ host: "cli", status: "running" })
  await Promise.all(
    running.map((record) =>
      dexieJournal.update(record.runId, {
        status: "interrupted",
        settledAt: now,
        error: "Background task interrupted because its host process stopped.",
      })
    )
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
