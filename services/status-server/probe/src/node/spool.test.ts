import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { Spool, SPOOL_MAX_AGE_MS, SPOOL_MAX_BYTES, type LossReason } from "./spool"

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "probe-spool-"))
}

function harness(dir: string, opts: { maxBytes?: number } = {}) {
  let now = Date.UTC(2026, 9, 2, 10, 0, 30)
  const losses: Array<{ runId: string; reason: LossReason }> = []
  const spool = new Spool(dir, {
    now: () => now,
    maxBytes: opts.maxBytes,
    onLoss: (entry, reason) => losses.push({ runId: entry.runId, reason }),
  })
  return {
    spool,
    losses,
    advance: (ms: number) => {
      now += ms
    },
    minute: () => Math.floor(now / 60_000) * 60_000,
  }
}

describe("Spool", () => {
  it("defaults to the plan's bounds: 10 minutes, 1 MiB", () => {
    expect(SPOOL_MAX_AGE_MS).toBe(600_000)
    expect(SPOOL_MAX_BYTES).toBe(1_048_576)
  })

  it("persists entries atomically and reloads them in scheduled order", async () => {
    const dir = await tempDir()
    const first = harness(dir)
    await first.spool.init()
    await first.spool.add({ runId: "r-b", scheduledAtMs: first.minute(), body: '{"b":1}' })
    await first.spool.add({ runId: "r-a", scheduledAtMs: first.minute() - 60_000, body: '{"a":1}' })
    const files = await readdir(dir)
    expect(files.filter((name) => name.startsWith(".tmp-"))).toEqual([])
    expect(files).toHaveLength(2)

    const second = harness(dir)
    const loaded = await second.spool.init()
    expect(loaded.map((entry) => [entry.runId, entry.body])).toEqual([
      ["r-a", '{"a":1}'],
      ["r-b", '{"b":1}'],
    ])
  })

  it("removes leftovers of a crashed write and corrupt entries on load", async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, ".tmp-000-r-x.json-1-2"), "partial")
    await writeFile(path.join(dir, "000000000000001-r-bad.json"), "{ nope")
    const { spool, losses } = harness(dir)
    expect(await spool.init()).toEqual([])
    expect(await readdir(dir)).toEqual([])
    expect(losses.map((loss) => loss.reason)).toEqual(["corrupt"])
  })

  it("drops entries older than 10 minutes as observer loss, never replays them", async () => {
    const dir = await tempDir()
    const { spool, losses, advance, minute } = harness(dir)
    await spool.init()
    await spool.add({ runId: "old", scheduledAtMs: minute(), body: "{}" })
    advance(9 * 60_000)
    await spool.add({ runId: "new", scheduledAtMs: minute(), body: "{}" })
    expect(await spool.expire()).toEqual([])
    advance(2 * 60_000)
    const expired = await spool.expire()
    expect(expired.map((entry) => entry.runId)).toEqual(["old"])
    expect(losses).toEqual([{ runId: "old", reason: "expired" }])
    expect(spool.entries().map((entry) => entry.runId)).toEqual(["new"])
    expect((await readdir(dir)).some((name) => name.includes("old"))).toBe(false)

    // Expired entries left on disk by a previous process are dropped on load too.
    const reload = harness(dir)
    reload.advance(30 * 60_000)
    expect(await reload.spool.init()).toEqual([])
    expect(reload.losses).toEqual([{ runId: "new", reason: "expired" }])
  })

  it("evicts the oldest entries once the byte cap is exceeded", async () => {
    const dir = await tempDir()
    const { spool, losses, minute } = harness(dir, { maxBytes: 600 })
    await spool.init()
    const body = JSON.stringify({ pad: "x".repeat(150) })
    for (let index = 0; index < 4; index += 1) {
      await spool.add({ runId: `r${index}`, scheduledAtMs: minute() - (4 - index) * 1_000, body })
    }
    expect(spool.totalBytes).toBeLessThanOrEqual(600)
    expect(losses.every((loss) => loss.reason === "overflow")).toBe(true)
    expect(losses.map((loss) => loss.runId)).toEqual(["r0", "r1"])
    expect(spool.entries().map((entry) => entry.runId)).toEqual(["r2", "r3"])
    expect(await readdir(dir)).toHaveLength(2)
  })

  it("keeps the exact body bytes and ignores a duplicate add", async () => {
    const dir = await tempDir()
    const { spool, minute } = harness(dir)
    await spool.init()
    const body = JSON.stringify({ text: "ünïcødé ✓", n: 1 })
    await spool.add({ runId: "r1", scheduledAtMs: minute(), body })
    await spool.add({ runId: "r1", scheduledAtMs: minute(), body: "{}" })
    expect(spool.entries()).toHaveLength(1)
    const [file] = await readdir(dir)
    expect(JSON.parse(await readFile(path.join(dir, file!), "utf8")).body).toBe(body)
    await spool.remove("r1")
    expect(await readdir(dir)).toEqual([])
  })
})
