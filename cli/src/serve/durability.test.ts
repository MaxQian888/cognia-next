/**
 * Durability v1 (ADR-0059 T-B3): the write-flush middleware and the exit
 * hooks around the snapshot db.
 *
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { installWriteFlush, startDurability, type DexieLike } from "./durability"
import { __resetCliDbForTesting } from "../db/bootstrap"

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
})
