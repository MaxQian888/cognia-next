export type BackgroundTaskHost = "renderer" | "cli"
export type BackgroundTaskKind = "subagent"
export type BackgroundTaskStatus = "running" | "done" | "error" | "interrupted"

export interface BackgroundTaskUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  totalCostUsd?: number
}

export interface BackgroundTaskJournalRecord {
  runId: string
  kind: BackgroundTaskKind
  subagentId: string
  prompt: string
  sessionId: string
  host: BackgroundTaskHost
  status: BackgroundTaskStatus
  startedAt: number
  settledAt?: number
  resultText?: string
  error?: string
  usage?: BackgroundTaskUsage
}

export interface BackgroundTaskJournalProjection {
  text: string
  error?: string
  usage?: BackgroundTaskUsage
}

export interface BackgroundTaskJournalWriter {
  recordStart(record: BackgroundTaskJournalRecord): void | Promise<void>
  recordSettle(
    runId: string,
    patch: Partial<
      Pick<BackgroundTaskJournalRecord, "status" | "settledAt" | "resultText" | "error" | "usage">
    >
  ): void | Promise<void>
}

export interface BackgroundTaskJournal extends BackgroundTaskJournalWriter {
  list(): Promise<BackgroundTaskJournalRecord[]>
  get(runId: string): Promise<BackgroundTaskJournalRecord | undefined>
  update(
    runId: string,
    patch: Partial<
      Pick<BackgroundTaskJournalRecord, "status" | "settledAt" | "resultText" | "error" | "usage">
    >
  ): void | Promise<void>
  clearSettled(): void | Promise<void>
}

export type BackgroundTaskStartMeta = Omit<
  BackgroundTaskJournalRecord,
  "runId" | "status" | "settledAt" | "resultText" | "error" | "usage"
>

export interface BackgroundTaskListEntry extends BackgroundTaskJournalRecord {
  cancelled?: boolean
}

export interface BackgroundTaskRegistryOptions<T> {
  journal?: BackgroundTaskJournalWriter
  projectForJournal: (value: T) => BackgroundTaskJournalProjection
  now?: () => number
}

export interface BackgroundTaskControls {
  cancel?: () => void
}

interface Entry<T> {
  promise: Promise<T>
  meta: BackgroundTaskStartMeta
  status: BackgroundTaskStatus
  settledAt?: number
  resultText?: string
  error?: string
  usage?: BackgroundTaskUsage
  controls?: BackgroundTaskControls
  cancelled?: boolean
}

const INTERRUPTED_ERROR = "Background task interrupted because its host process stopped."

export class BackgroundTaskRegistry<T> {
  private readonly runs = new Map<string, Entry<T>>()
  private readonly projectForJournal: (value: T) => BackgroundTaskJournalProjection
  private readonly journal?: BackgroundTaskJournalWriter
  private readonly now: () => number

  constructor(options: BackgroundTaskRegistryOptions<T>) {
    this.projectForJournal = options.projectForJournal
    this.journal = options.journal
    this.now = options.now ?? Date.now
  }

  start(
    runId: string,
    meta: BackgroundTaskStartMeta,
    promise: Promise<T>,
    controls?: BackgroundTaskControls
  ): void {
    const entry: Entry<T> = {
      promise,
      meta,
      status: "running",
      ...(controls ? { controls } : {}),
    }
    this.runs.set(runId, entry)
    this.writeJournal(() =>
      this.journal?.recordStart({
        runId,
        ...meta,
        status: "running",
      })
    )

    promise.then(
      (value) => {
        const projection = this.projectForJournal(value)
        const settledAt = this.now()
        entry.status = "done"
        entry.settledAt = settledAt
        entry.resultText = projection.text
        entry.usage = projection.usage
        this.writeJournal(() =>
          this.journal?.recordSettle(runId, {
            status: "done",
            settledAt,
            resultText: projection.text,
            ...(projection.usage ? { usage: projection.usage } : {}),
          })
        )
      },
      (error) => {
        const message = errorMessage(error)
        const settledAt = this.now()
        entry.status = "error"
        entry.settledAt = settledAt
        entry.error = message
        this.writeJournal(() =>
          this.journal?.recordSettle(runId, {
            status: "error",
            settledAt,
            error: message,
          })
        )
      }
    )
  }

  has(runId: string): boolean {
    return this.runs.has(runId)
  }

  async collect(runId: string): Promise<T | undefined> {
    const entry = this.runs.get(runId)
    if (!entry) return undefined
    try {
      return await entry.promise
    } finally {
      this.runs.delete(runId)
    }
  }

  list(): BackgroundTaskListEntry[] {
    return [...this.runs.entries()].map(([runId, entry]) => ({
      runId,
      ...entry.meta,
      status: entry.status,
      ...(entry.settledAt !== undefined ? { settledAt: entry.settledAt } : {}),
      ...(entry.resultText !== undefined ? { resultText: entry.resultText } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(entry.cancelled ? { cancelled: entry.cancelled } : {}),
    }))
  }

  countRunning(): number {
    let count = 0
    for (const entry of this.runs.values()) {
      if (entry.status === "running") count += 1
    }
    return count
  }

  cancel(runId: string): boolean {
    const entry = this.runs.get(runId)
    if (!entry || entry.status !== "running" || !entry.controls?.cancel) return false
    entry.cancelled = true
    entry.controls.cancel()
    return true
  }

  __clearForTesting(): void {
    this.runs.clear()
  }

  private writeJournal(write: () => void | Promise<void>): void {
    try {
      const maybePromise = write()
      if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
        ;(maybePromise as Promise<void>).catch(() => undefined)
      }
    } catch {
      // Journal writes are best-effort; task lifecycle must keep its old in-memory contract.
    }
  }
}

export async function interruptRunningTasks(
  journal: BackgroundTaskJournal,
  options: { now?: () => number } = {}
): Promise<void> {
  const now = options.now ?? Date.now
  const records = await journal.list()
  await Promise.all(
    records
      .filter((record) => record.status === "running")
      .map((record) =>
        journal.update(record.runId, {
          status: "interrupted",
          settledAt: now(),
          error: INTERRUPTED_ERROR,
        })
      )
  )
}

export function backgroundTaskInterruptedMessage(runId: string): string {
  return `Background run "${runId}" was interrupted before it finished.`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
