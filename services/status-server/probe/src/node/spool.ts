/**
 * Durable, bounded ingestion spool (plan §4.7).
 *
 * Every batch is written here before its first POST and deleted once the
 * server answers definitively, so a crash or restart loses nothing that was
 * still worth sending. Bounds: an entry older than 10 minutes (from its
 * scheduled minute, the server's late-acceptance window) or beyond 1 MiB in
 * total is dropped and counted as observer loss — it becomes a history gap,
 * never an old observation replayed as current health.
 *
 * Writes are atomic: write a temp file, fsync, rename, fsync the directory.
 */

import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"

import { LATE_OBSERVATION_MS } from "../../../../../lib/status/contract"

export const SPOOL_MAX_AGE_MS = LATE_OBSERVATION_MS
export const SPOOL_MAX_BYTES = 1024 * 1024

const FILE_VERSION = 1
const TMP_PREFIX = ".tmp-"

export interface SpoolEntry {
  runId: string
  scheduledAtMs: number
  enqueuedAtMs: number
  /** The exact JSON body bytes (as UTF-8 text) every attempt sends. */
  body: string
  /** On-disk size, counted against the byte cap. */
  bytes: number
  file: string
}

export type LossReason = "expired" | "overflow" | "corrupt"

export interface SpoolOptions {
  maxAgeMs?: number
  maxBytes?: number
  now?: () => number
  onLoss?: (entry: Pick<SpoolEntry, "runId" | "scheduledAtMs">, reason: LossReason) => void
}

function fileNameFor(scheduledAtMs: number, runId: string): string {
  return `${String(scheduledAtMs).padStart(15, "0")}-${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`
}

async function writeAtomic(dir: string, name: string, data: string): Promise<void> {
  const tmp = path.join(dir, `${TMP_PREFIX}${name}-${process.pid}-${Date.now()}`)
  const handle = await open(tmp, "wx", 0o600)
  try {
    await handle.writeFile(data, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path.join(dir, name))
  await syncDir(dir)
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unsupported on some filesystems; rename is still atomic.
  }
}

export class Spool {
  private readonly entriesByRun = new Map<string, SpoolEntry>()
  private readonly maxAgeMs: number
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(
    readonly dir: string,
    private readonly options: SpoolOptions = {}
  ) {
    this.maxAgeMs = options.maxAgeMs ?? SPOOL_MAX_AGE_MS
    this.maxBytes = options.maxBytes ?? SPOOL_MAX_BYTES
    this.now = options.now ?? Date.now
  }

  get totalBytes(): number {
    let total = 0
    for (const entry of this.entriesByRun.values()) total += entry.bytes
    return total
  }

  /** Oldest scheduled minute first. */
  entries(): SpoolEntry[] {
    return [...this.entriesByRun.values()].sort(
      (a, b) => a.scheduledAtMs - b.scheduledAtMs || a.enqueuedAtMs - b.enqueuedAtMs
    )
  }

  has(runId: string): boolean {
    return this.entriesByRun.has(runId)
  }

  /** Load what a previous process left behind, enforcing the same bounds. */
  async init(): Promise<SpoolEntry[]> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.dir)) {
      const full = path.join(this.dir, name)
      if (name.startsWith(TMP_PREFIX)) {
        // A write that crashed before rename never became an entry.
        await rm(full, { force: true })
        continue
      }
      if (!name.endsWith(".json")) continue
      const entry = await this.readEntry(name)
      if (!entry) {
        this.options.onLoss?.({ runId: name, scheduledAtMs: 0 }, "corrupt")
        await rm(full, { force: true })
        continue
      }
      this.entriesByRun.set(entry.runId, entry)
    }
    await this.expire()
    await this.enforceBytes()
    return this.entries()
  }

  private async readEntry(name: string): Promise<SpoolEntry | null> {
    try {
      const text = await readFile(path.join(this.dir, name), "utf8")
      const raw = JSON.parse(text) as Record<string, unknown>
      if (
        raw.v !== FILE_VERSION ||
        typeof raw.runId !== "string" ||
        typeof raw.body !== "string" ||
        typeof raw.scheduledAtMs !== "number" ||
        typeof raw.enqueuedAtMs !== "number"
      ) {
        return null
      }
      return {
        runId: raw.runId,
        scheduledAtMs: raw.scheduledAtMs,
        enqueuedAtMs: raw.enqueuedAtMs,
        body: raw.body,
        bytes: Buffer.byteLength(text, "utf8"),
        file: name,
      }
    } catch {
      return null
    }
  }

  /** Persist a new entry; may evict the oldest entries to honour the byte cap. */
  async add(input: {
    runId: string
    scheduledAtMs: number
    body: string
  }): Promise<SpoolEntry | null> {
    if (this.entriesByRun.has(input.runId)) return this.entriesByRun.get(input.runId)!
    const enqueuedAtMs = this.now()
    const file = fileNameFor(input.scheduledAtMs, input.runId)
    const data = JSON.stringify({ v: FILE_VERSION, ...input, enqueuedAtMs })
    const bytes = Buffer.byteLength(data, "utf8")
    if (bytes > this.maxBytes) {
      this.options.onLoss?.(input, "overflow")
      return null
    }
    await writeAtomic(this.dir, file, data)
    const entry: SpoolEntry = { ...input, enqueuedAtMs, bytes, file }
    this.entriesByRun.set(entry.runId, entry)
    await this.expire()
    await this.enforceBytes()
    return this.entriesByRun.get(entry.runId) ?? null
  }

  async remove(runId: string): Promise<void> {
    const entry = this.entriesByRun.get(runId)
    if (!entry) return
    this.entriesByRun.delete(runId)
    await rm(path.join(this.dir, entry.file), { force: true })
  }

  /** Drop entries past the late-acceptance window. Returns what was dropped. */
  async expire(): Promise<SpoolEntry[]> {
    const cutoff = this.now() - this.maxAgeMs
    const expired = this.entries().filter((entry) => entry.scheduledAtMs < cutoff)
    for (const entry of expired) {
      await this.remove(entry.runId)
      this.options.onLoss?.(entry, "expired")
    }
    return expired
  }

  private async enforceBytes(): Promise<void> {
    let total = this.totalBytes
    for (const entry of this.entries()) {
      if (total <= this.maxBytes) break
      total -= entry.bytes
      await this.remove(entry.runId)
      this.options.onLoss?.(entry, "overflow")
    }
  }
}
