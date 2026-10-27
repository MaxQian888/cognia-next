/** Node-only durability owner. Never imported by the static-export application. */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"

export const BENCHMARK_DISK_POLICY = {
  minFreeBytes: 1024 ** 3,
  reserveBytes: 64 * 1024 ** 2,
  pollMs: 30_000,
}
type DiskPolicy = typeof BENCHMARK_DISK_POLICY
type IO = typeof fs
const code = (error: unknown) => (error as NodeJS.ErrnoException).code
const missing = (error: unknown) => code(error) === "ENOENT"

export class BenchmarkStorage {
  private pending: Promise<void> = Promise.resolve()
  private failure: unknown
  private lifecycle: "open" | "closing" | "closed" = "open"
  private closePromise?: Promise<void>
  private readonly shutdown = new AbortController()
  private reservePresent = false
  private readonly nonce = randomUUID()
  private readonly owner = `${process.pid}-${this.nonce}.json`
  private readonly lock: string
  private readonly reserve: string
  private readonly journal: string
  private constructor(
    readonly dir: string,
    private readonly policy: DiskPolicy,
    private readonly io: IO
  ) {
    this.lock = path.join(dir, ".runner-lock")
    this.reserve = path.join(dir, ".emergency-reserve")
    this.journal = path.join(dir, "events.ndjson")
  }

  static async open(dir: string, policy = BENCHMARK_DISK_POLICY, overrides: Partial<IO> = {}) {
    const store = new BenchmarkStorage(dir, policy, { ...fs, ...overrides })
    await store.acquire()
    return store
  }

  private async acquire() {
    // Publish a NONEMPTY lock directory atomically. Stale reclaimers remove only
    // the exact old nonce, so they cannot unlink a newly acquired owner's file.
    const candidate = path.join(this.dir, `.runner-lock-${this.nonce}`)
    await this.io.mkdir(candidate)
    try {
      await this.io.writeFile(
        path.join(candidate, this.owner),
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          nonce: this.nonce,
        }),
        { flag: "wx" }
      )
      for (let tries = 0; tries < 3; tries++) {
        try {
          await this.io.rename(candidate, this.lock)
          return
        } catch (error) {
          if (!["ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error
        }
        const names = await this.io.readdir(this.lock)
        if (names.length > 1) throw Error("Benchmark lock has unexpected contents")
        if (names.length) {
          const file = path.join(this.lock, names[0]!)
          let owner: { pid: number; host: string }
          try {
            owner = JSON.parse(await this.io.readFile(file, "utf8"))
          } catch (error) {
            if (missing(error)) continue
            throw error
          }
          if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
            throw Error("Benchmark lock owner cannot be verified")
          try {
            process.kill(owner.pid, 0)
            throw Error("Benchmark has an active writer")
          } catch (error) {
            if (code(error) !== "ESRCH") throw error
          }
          await this.io.unlink(file).catch((error) => {
            if (!missing(error)) throw error
          })
        }
        await this.io.rmdir(this.lock).catch((error) => {
          if (!missing(error) && code(error) !== "ENOTEMPTY") throw error
        })
      }
      throw Error("Benchmark lock changed during acquisition")
    } finally {
      await this.io.rm(candidate, { recursive: true, force: true })
    }
  }

  private async withReserve(operation: () => Promise<void>) {
    try {
      await operation()
    } catch (error) {
      if (code(error) !== "ENOSPC" || !this.reservePresent) throw error
      await this.io.unlink(this.reserve)
      this.reservePresent = false
      await operation()
    }
  }

  private async syncDirectory() {
    const directory = await this.io.open(this.dir, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  private enqueue<T>(operation: () => Promise<T>, allowFailure = false): Promise<T> {
    if (this.lifecycle !== "open") return Promise.reject(Error("Benchmark storage is closed"))
    const work = this.pending.then(async () => {
      if (this.failure && !allowFailure) throw this.failure
      return operation()
    })
    this.pending = work.then(
      () => {},
      () => {}
    )
    return work
  }

  private async writeAtomic(file: string, data: string | Uint8Array) {
    const next = path.join(this.dir, `.${path.basename(file)}-${this.nonce}.next`)
    try {
      await this.withReserve(async () => {
        const handle = await this.io.open(next, "w")
        try {
          await handle.writeFile(data)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await this.io.rename(next, file)
        await this.syncDirectory()
      })
    } finally {
      await this.io.rm(next, { force: true })
    }
  }

  snapshot(data: string) {
    // A failed journal may still have returned samples to salvage atomically.
    return this.enqueue(() => this.writeAtomic(path.join(this.dir, "results.json"), data), true)
  }

  append(event: unknown) {
    return this.enqueue(async () => {
      let size: number | undefined
      try {
        try {
          size = (await this.io.stat(this.journal)).size
        } catch (error) {
          if (!missing(error)) throw error
          size = 0
        }
        const acknowledgedSize = size
        await this.withReserve(async () => {
          await this.io.truncate(this.journal, acknowledgedSize).catch((error) => {
            if (!missing(error)) throw error
          })
          await this.io.appendFile(this.journal, JSON.stringify(event) + "\n")
          const handle = await this.io.open(this.journal, "r+")
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
          await this.syncDirectory()
        })
      } catch (error) {
        this.failure = error
        if (size !== undefined) await this.io.truncate(this.journal, size).catch(() => {})
        throw error
      }
    })
  }

  replay(
    validate?: (records: Record<string, unknown>[]) => void | Promise<void>
  ): Promise<Record<string, unknown>[]> {
    return this.enqueue(async () => {
      let bytes: Buffer
      try {
        bytes = await this.io.readFile(this.journal)
      } catch (error) {
        if (missing(error)) {
          const records: Record<string, unknown>[] = []
          await validate?.(records)
          return records
        }
        throw error
      }
      const end = bytes.lastIndexOf(10) + 1
      // Fail before ANY recovery write; replacement decoding destroys evidence.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, end)
      )
      const records = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const event: unknown = JSON.parse(line)
          if (!event || typeof event !== "object" || Array.isArray(event))
            throw Error("Invalid benchmark journal record")
          return event as Record<string, unknown>
        })
      await validate?.(records)
      if (end !== bytes.length) {
        const tail = path.join(this.dir, `journal-tail-${this.nonce}.bin`)
        const handle = await this.io.open(tail, "wx")
        try {
          await handle.writeFile(bytes.subarray(end))
          await handle.sync()
        } finally {
          await handle.close()
        }
        await this.syncDirectory()
        await this.writeAtomic(this.journal, bytes.subarray(0, end))
      }
      return records
    }, true)
  }

  async waitForSpace(upstream: AbortSignal): Promise<boolean> {
    if (this.lifecycle !== "open") throw Error("Benchmark storage is closed")
    const signal = AbortSignal.any([upstream, this.shutdown.signal])
    while (!signal.aborted) {
      if (this.failure) throw this.failure
      let stat: Awaited<ReturnType<IO["statfs"]>>
      try {
        stat = await this.io.statfs(this.dir)
      } catch (error) {
        this.failure = error
        throw error
      }
      if (signal.aborted) return false
      if (
        stat.bavail * stat.bsize >=
        this.policy.minFreeBytes + (this.reservePresent ? 0 : this.policy.reserveBytes)
      ) {
        try {
          const ready = await this.enqueue(async () => {
            if (signal.aborted) return false
            if (this.reservePresent) return true
            try {
              await this.io.writeFile(this.reserve, Buffer.alloc(this.policy.reserveBytes))
              this.reservePresent = true
              return !signal.aborted
            } catch (error) {
              await this.io.rm(this.reserve, { force: true })
              if (code(error) !== "ENOSPC") {
                this.failure = error
                throw error
              }
              return false
            }
          })
          if (ready) return true
        } catch (error) {
          if (signal.aborted) return false
          throw error
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, this.policy.pollMs)
        signal.addEventListener("abort", done, { once: true })
        if (signal.aborted) done()
      })
    }
    return false
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.lifecycle = "closing"
    this.shutdown.abort()
    this.closePromise = (async () => {
      await this.pending
      const errors: unknown[] = []
      try {
        // A retained/closed predecessor must never clean a successor's files.
        await this.io.access(path.join(this.lock, this.owner))
        for (const cleanup of [
          () => this.io.rm(this.reserve, { force: true }),
          () =>
            this.io.unlink(path.join(this.lock, this.owner)).catch((error) => {
              if (!missing(error)) throw error
            }),
          () =>
            this.io.rmdir(this.lock).catch((error) => {
              if (!missing(error) && code(error) !== "ENOTEMPTY") throw error
            }),
        ])
          try {
            await cleanup()
          } catch (error) {
            errors.push(error)
          }
      } catch (error) {
        errors.push(error)
      } finally {
        this.lifecycle = "closed"
      }
      if (errors.length) throw new AggregateError(errors, "Benchmark resource cleanup failed")
    })()
    return this.closePromise
  }
}
