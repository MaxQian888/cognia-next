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
}

export type CliBackgroundTaskMeta = BackgroundTaskStartMeta & {
  host: "cli"
  home?: string
}

const runHomes = new Map<string, string | undefined>()
const collectedRunIds = new Set<string>()
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
  registry.start(runId, journalMeta, promise, controls)
}

export function hasCliBackgroundRun(runId: string): boolean {
  return registry.has(runId)
}

export async function collectCliBackgroundResult(
  runId: string,
  options: { home?: string } = {}
): Promise<string | undefined> {
  if (collectedRunIds.has(runId)) return undefined
  try {
    const live = await registry.collect(runId)
    if (live !== undefined) {
      collectedRunIds.add(runId)
      return live
    }
  } catch (err) {
    collectedRunIds.add(runId)
    return errorMessage(err)
  } finally {
    runHomes.delete(runId)
  }

  const record = await readJournalRecord(runId, options.home)
  if (!record || record.host !== "cli") return undefined
  if (record.status === "done") return record.resultText ?? ""
  if (record.status === "error")
    return record.error ?? record.resultText ?? "Background run failed."
  if (record.status === "interrupted") return backgroundTaskInterruptedMessage(runId)
  return undefined
}

export function listCliBackgroundRuns(): CliBackgroundRunInfo[] {
  return registry.list().map((entry) => ({
    runId: entry.runId,
    subagentId: entry.subagentId,
    status: entry.status,
    startedAt: entry.startedAt,
  }))
}

export function countRunningCliBackgroundRuns(): number {
  return registry.countRunning()
}

export async function countInterruptedCliBackgroundRuns(
  options: { home?: string } = {}
): Promise<number> {
  const records = await readJournalRecords(options.home)
  return records.filter((record) => record.host === "cli" && record.status === "interrupted").length
}

export function __clearAllCliBackgroundRunsForTesting(): void {
  registry.__clearForTesting()
  runHomes.clear()
  collectedRunIds.clear()
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
