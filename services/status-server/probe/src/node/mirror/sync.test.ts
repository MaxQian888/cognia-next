import { mkdtemp, readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { HistoryRange } from "../../../../../../lib/status/contract"
import { createStatusFixture } from "../../../../../../lib/status/fixtures"
import { parsePublicSnapshot } from "../../../../../../lib/status/validate"
import type { FetchLike } from "../http"
import { memoryLogger } from "../logger"
import { MIRROR_RESOURCES, MirrorSync, readSyncState } from "./sync"

const API = "https://status.example.test/api/status/v1"
const ATOM =
  '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>'
const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'

type Override = (range: HistoryRange | "atom" | "rss") => Response | null

function source(override: Override = () => null, revision = 7): FetchLike {
  return async (url) => {
    const target = String(url)
    const range = new URL(target).searchParams.get("range") as HistoryRange | null
    const key = range ?? (target.endsWith("feed.atom") ? "atom" : "rss")
    const custom = override(key)
    if (custom) return custom
    if (range) return Response.json({ ...createStatusFixture("operational", range), revision })
    return new Response(key === "atom" ? ATOM : RSS, {
      headers: { "content-type": key === "atom" ? "application/atom+xml" : "application/rss+xml" },
    })
  }
}

async function setup(fetchImpl: FetchLike) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mirror-sync-"))
  const logger = memoryLogger()
  return {
    dataDir,
    logger,
    sync: new MirrorSync({ sourceApiBase: API, dataDir, logger, fetchImpl }),
  }
}

async function readSnapshot(dataDir: string, range: HistoryRange) {
  return JSON.parse(await readFile(path.join(dataDir, `snapshot-${range}.json`), "utf8")) as Record<
    string,
    unknown
  >
}

describe("MirrorSync", () => {
  it("copies all four ranges and both feeds, validated, with email disabled", async () => {
    const { dataDir, sync } = await setup(source())
    const outcomes = await sync.syncOnce()
    expect(Object.values(outcomes)).toEqual(MIRROR_RESOURCES.map(() => "updated"))
    for (const range of ["24h", "7d", "30d", "90d"] as const) {
      const stored = await readSnapshot(dataDir, range)
      expect(parsePublicSnapshot(stored).ok).toBe(true)
      expect(stored.range).toBe(range)
      expect((stored.capabilities as { email: boolean }).email).toBe(false)
    }
    expect(await readFile(path.join(dataDir, "feed.atom"), "utf8")).toBe(ATOM)
    expect(await readFile(path.join(dataDir, "feed.rss"), "utf8")).toBe(RSS)
    const state = await readSyncState(dataDir)
    expect(state.lastSyncOk).toBe(true)
    expect(state.lastSyncAt).not.toBeNull()
    expect((await readdir(dataDir)).filter((name) => name.startsWith(".tmp-"))).toEqual([])
  })

  it.each<[string, Override]>([
    ["HTTP error", (key) => (key === "24h" ? new Response(null, { status: 503 }) : null)],
    [
      "schema failure",
      (key) => (key === "24h" ? Response.json({ schemaVersion: 1, mode: "preview" }) : null),
    ],
    [
      "unsupported version",
      (key) =>
        key === "24h"
          ? Response.json({ ...createStatusFixture("operational", "24h"), schemaVersion: 2 })
          : null,
    ],
    [
      "range mismatch",
      (key) => (key === "24h" ? Response.json(createStatusFixture("operational", "7d")) : null),
    ],
    ["oversized body", (key) => (key === "24h" ? new Response("x".repeat(300 * 1024)) : null)],
    ["not JSON", (key) => (key === "24h" ? new Response("<html>") : null)],
    [
      "network failure",
      (key) => {
        if (key === "24h") throw new TypeError("fetch failed")
        return null
      },
    ],
  ])("keeps the previous file on %s", async (_label, override) => {
    const first = await setup(source())
    await first.sync.syncOnce()
    const before = await readFile(path.join(first.dataDir, "snapshot-24h.json"), "utf8")

    const second = new MirrorSync({
      sourceApiBase: API,
      dataDir: first.dataDir,
      logger: first.logger,
      fetchImpl: source(override, 8),
    })
    const outcomes = await second.syncOnce()
    expect(outcomes["snapshot-24h"]).toBe("failed")
    expect(outcomes["snapshot-7d"]).toBe("updated")
    expect(await readFile(path.join(first.dataDir, "snapshot-24h.json"), "utf8")).toBe(before)
    const state = await readSyncState(first.dataDir)
    expect(state.lastSyncOk).toBe(false)
    expect(state.resources["snapshot-24h"]?.lastError).toBeTruthy()
    expect(state.resources["snapshot-24h"]?.lastSuccessAt).not.toBeNull()
  })

  it("never replaces a snapshot with an older revision", async () => {
    const { dataDir, sync, logger } = await setup(source(() => null, 10))
    await sync.syncOnce()
    const older = new MirrorSync({
      sourceApiBase: API,
      dataDir,
      logger,
      fetchImpl: source(() => null, 9),
    })
    const outcomes = await older.syncOnce()
    expect(outcomes["snapshot-24h"]).toBe("unchanged")
    expect((await readSnapshot(dataDir, "24h")).revision).toBe(10)
  })

  it("rejects a feed that is not XML", async () => {
    const { dataDir, sync } = await setup(
      source((key) =>
        key === "atom"
          ? new Response("<html></html>", { headers: { "content-type": "text/html" } })
          : null
      )
    )
    const outcomes = await sync.syncOnce()
    expect(outcomes["feed.atom"]).toBe("failed")
    expect((await readdir(dataDir)).includes("feed.atom")).toBe(false)
  })

  it("syncs on start and stops cleanly", async () => {
    let calls = 0
    const { sync } = await setup(async (url, init) => {
      calls += 1
      return source()(url, init)
    })
    sync.start(60_000)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await sync.stop()
    expect(calls).toBe(MIRROR_RESOURCES.length)
  })

  it("does not record a pass cut short by shutdown as a successful sync", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const { dataDir, sync } = await setup(async (url, init) => {
      calls += 1
      if (calls === 2) {
        // Block the second resource until shutdown aborts it.
        await gate
        throw init?.signal?.reason ?? new Error("aborted")
      }
      return source()(url, init)
    })
    sync.start(60_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const stopping = sync.stop()
    release()
    await stopping
    expect((await readSyncState(dataDir)).lastSyncAt).toBeNull()
  })
})
