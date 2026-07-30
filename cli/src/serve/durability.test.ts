/**
 * Durability v1 (ADR-0059 T-B3): the write-flush middleware and the exit
 * hooks around the snapshot db.
 *
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DEFAULT_EXECUTION_CONFIG, DEFAULT_NOTIFICATION_CONFIG } from "@/types/scheduler"

import { installWriteFlush, startDurability, type DexieLike } from "./durability"
import { __resetCliDbForTesting } from "../db/bootstrap"

jest.setTimeout(30_000)

describe("installWriteFlush", () => {
  it("schedules a flush after every settled mutation, not on failures", async () => {
    const writes: string[] = []
    let middleware: {
      create(down: unknown): { table(name: string): { mutate(req: unknown): Promise<unknown> } }
    } | null = null
    const fakeDb: DexieLike = {
      use(mw) {
        middleware = mw as typeof middleware
        return fakeDb
      },
    }
    installWriteFlush(fakeDb, () => writes.push("flush"))
    expect(middleware).not.toBeNull()

    const down = {
      table: (name: string) => ({
        mutate: (req: unknown) =>
          name === "boom" ? Promise.reject(new Error("nope")) : Promise.resolve({ req }),
      }),
    }
    const core = middleware!.create(down)

    await core.table("sessions").mutate({ type: "put" })
    await core.table("messages").mutate({ type: "delete" })
    await core
      .table("boom")
      .mutate({ type: "put" })
      .catch(() => undefined)
    // onWrite runs on the settled promise's microtask.
    await new Promise((r) => setTimeout(r, 0))
    expect(writes).toEqual(["flush", "flush"])
  })

  // Excluded tables are not in the snapshot, so their writes must not drive a
  // re-dump either — otherwise `executions` (append-heavy) would keep flushing a
  // file that contains none of its rows.
  it("does not schedule a flush for ignored tables", async () => {
    const writes: string[] = []
    let middleware: {
      create(down: unknown): { table(name: string): { mutate(req: unknown): Promise<unknown> } }
    } | null = null
    const fakeDb: DexieLike = {
      use(mw) {
        middleware = mw as typeof middleware
        return fakeDb
      },
    }
    installWriteFlush(fakeDb, () => writes.push("flush"), { ignoreTables: ["executions"] })

    const core = middleware!.create({
      table: () => ({ mutate: (req: unknown) => Promise.resolve({ req }) }),
    })
    await core.table("executions").mutate({ type: "put" })
    await core.table("tasks").mutate({ type: "put" })
    await new Promise((r) => setTimeout(r, 0))
    expect(writes).toEqual(["flush"])
  })
})

describe("startDurability", () => {
  it("persists a snapshot on dispose and reports the rss gauge", async () => {
    __resetCliDbForTesting()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-durability-"))
    const listeners = new Map<string, () => void>()
    const proc = {
      on: (event: string, fn: () => void) => {
        listeners.set(event, fn)
        return proc
      },
      off: (event: string) => {
        listeners.delete(event)
        return proc
      },
      memoryUsage: () => ({ rss: 42_000_000 }) as NodeJS.MemoryUsage,
    } as unknown as Pick<NodeJS.Process, "on" | "off" | "memoryUsage">

    const durability = await startDurability({ home, accountId: "acct_test_1", proc })
    expect(listeners.has("SIGINT")).toBe(true)
    expect(listeners.has("SIGTERM")).toBe(true)

    const before = durability.rss()
    expect(before.rssBytes).toBe(42_000_000)
    expect(before.lastFlushAt).toBe(0)

    durability.notifyDbWrite()
    await durability.dispose()

    const snapshotPath = path.join(home, "db-acct_test_1.json")
    expect(fs.existsSync(snapshotPath)).toBe(true)
    expect(durability.rss().lastFlushAt).toBeGreaterThan(0)
    // Hooks detach on dispose.
    expect(listeners.size).toBe(0)

    // Idempotent.
    await durability.dispose()
    __resetCliDbForTesting()
  })

  // A brain is stopped with a signal far more often than it is disposed cleanly,
  // so the SIGTERM/beforeExit rungs must actually flush — the whole persistence
  // ladder is worthless if the exit path skips it.
  it("flushes on SIGTERM and on beforeExit", async () => {
    __resetCliDbForTesting()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-signal-"))
    const listeners = new Map<string, () => void>()
    const proc = {
      on: (event: string, fn: () => void) => {
        listeners.set(event, fn)
        return proc
      },
      off: (event: string) => {
        listeners.delete(event)
        return proc
      },
      memoryUsage: () => ({ rss: 1 }) as NodeJS.MemoryUsage,
    } as unknown as Pick<NodeJS.Process, "on" | "off" | "memoryUsage">

    try {
      const durability = await startDurability({ home, accountId: "acct_signal", proc })
      const snapshotPath = path.join(home, "db-acct_signal.json")

      // beforeExit flushes without tearing the handle down.
      listeners.get("beforeExit")!()
      await new Promise((r) => setTimeout(r, 50))
      expect(fs.existsSync(snapshotPath)).toBe(true)
      expect(durability.rss().lastFlushAt).toBeGreaterThan(0)

      // SIGTERM disposes: final flush, then every hook detaches.
      listeners.get("SIGTERM")!()
      await new Promise((r) => setTimeout(r, 50))
      expect(listeners.has("SIGTERM")).toBe(false)
      expect(listeners.has("beforeExit")).toBe(false)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // The whole point of the multi-database snapshot: a `cognia serve` brain that
  // restarts must come back with its schedule intact. Before this, the
  // scheduler's separate `CogniaSchedulerDB` was never persisted, so the brain
  // rebooted with an empty task table while still reporting the scheduler
  // runtime as running.
  it("round-trips a scheduled task across a restart, without persisting executions", async () => {
    __resetCliDbForTesting()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-sched-"))
    const snapshotPath = path.join(home, "db-acct_sched.json")
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    const now = new Date()
    const task = {
      id: "task_persist_1",
      name: "brain digest",
      type: "connection:scheduled:digest",
      trigger: { type: "interval" as const, intervalMs: 3_600_000 },
      payload: { adapterId: "a1", conversationKey: "k1", characterId: "c1", prompt: "hi" },
      config: DEFAULT_EXECUTION_CONFIG,
      notification: DEFAULT_NOTIFICATION_CONFIG,
      status: "active" as const,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    try {
      const first = await startDurability({ home, accountId: "acct_sched" })
      await schedulerDb.createTask(task as never)
      await schedulerDb.createExecution({
        id: "exec_1",
        taskId: task.id,
        taskName: task.name,
        taskType: task.type,
        status: "completed",
        retryAttempt: 0,
        startedAt: now,
        logs: [],
      } as never)
      await first.dispose()

      // The durable artifact carries the task but not the execution history.
      const written = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
      expect(written.snapshotFormat).toBe(2)
      const scheduler = written.dbs.CogniaSchedulerDB
      expect(scheduler.tables.tasks.map((r: { id: string }) => r.id)).toContain(task.id)
      expect(scheduler.tables).not.toHaveProperty("executions")

      // Simulate the restart: wipe the in-memory tables, then reopen from disk.
      await schedulerDb.tasks.clear()
      await schedulerDb.executions.clear()
      __resetCliDbForTesting()

      const second = await startDurability({ home, accountId: "acct_sched" })
      expect(await schedulerDb.getTask(task.id)).not.toBeNull()
      expect(await schedulerDb.executions.count()).toBe(0)
      await second.dispose()
    } finally {
      await schedulerDb.tasks.clear().catch(() => {})
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
