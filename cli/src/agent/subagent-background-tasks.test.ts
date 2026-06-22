/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { __resetDbForTesting, getDb, type BackgroundTaskJournalRow } from "@/lib/db/schema"
import { __resetCliDbForTesting } from "../db/bootstrap"
import {
  __clearAllCliBackgroundRunsForTesting,
  __disposeCliBackgroundJournalForTesting,
  __waitForCliBackgroundJournalForTesting,
  collectCliBackgroundResult,
  countInterruptedCliBackgroundRuns,
  countRunningCliBackgroundRuns,
  hasCliBackgroundRun,
  listCliBackgroundRuns,
  startCliBackgroundRun,
} from "./subagent-background-tasks"

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-bg-"))
}

function meta(home?: string, overrides: Partial<Parameters<typeof startCliBackgroundRun>[1]> = {}) {
  return {
    kind: "subagent" as const,
    subagentId: "reviewer",
    prompt: "check this",
    sessionId: "ses_1",
    host: "cli" as const,
    startedAt: 1000,
    home,
    ...overrides,
  }
}

function row(overrides: Partial<BackgroundTaskJournalRow> = {}): BackgroundTaskJournalRow {
  return {
    runId: "r1",
    kind: "subagent",
    subagentId: "reviewer",
    prompt: "check this",
    sessionId: "ses_1",
    host: "cli",
    status: "running",
    startedAt: 1000,
    ...overrides,
  }
}

async function resetDb(): Promise<void> {
  await __disposeCliBackgroundJournalForTesting().catch(() => undefined)
  try {
    await getDb().delete()
  } catch {
    // The first test installs fake-indexeddb through ensureCliDb lazily.
  }
  __resetDbForTesting()
  __resetCliDbForTesting()
  __clearAllCliBackgroundRunsForTesting()
}

beforeEach(async () => {
  await resetDb()
})

afterEach(async () => {
  await resetDb()
})

describe("CLI background subagent tasks", () => {
  it("parks a live string run, journals it, and collects the live value", async () => {
    const home = makeHome()
    const run = deferred<string>()

    startCliBackgroundRun("r1", meta(home), run.promise)

    expect(hasCliBackgroundRun("r1")).toBe(true)
    expect(countRunningCliBackgroundRuns()).toBe(1)
    expect(listCliBackgroundRuns()).toEqual([
      expect.objectContaining({ runId: "r1", status: "running", subagentId: "reviewer" }),
    ])
    await __waitForCliBackgroundJournalForTesting()
    await expect(getDb().backgroundTasks.get("r1")).resolves.toMatchObject({
      runId: "r1",
      host: "cli",
      status: "running",
      prompt: "check this",
    })

    const collected = collectCliBackgroundResult("r1", { home })
    run.resolve("[reviewer]\nready")

    await expect(collected).resolves.toBe("[reviewer]\nready")
    expect(hasCliBackgroundRun("r1")).toBe(false)
    await __waitForCliBackgroundJournalForTesting()
    await expect(getDb().backgroundTasks.get("r1")).resolves.toMatchObject({
      status: "done",
      resultText: "[reviewer]\nready",
    })
  })

  it("returns an error string for rejected live runs and records the error", async () => {
    const home = makeHome()

    startCliBackgroundRun("r1", meta(home), Promise.reject(new Error("boom")))

    await expect(collectCliBackgroundResult("r1", { home })).resolves.toBe("boom")
    await __waitForCliBackgroundJournalForTesting()
    await expect(getDb().backgroundTasks.get("r1")).resolves.toMatchObject({
      status: "error",
      error: "boom",
    })
  })

  it("falls back to a journaled done result after live memory is gone", async () => {
    const home = makeHome()
    await startCliBackgroundJournal(home)
    await getDb().backgroundTasks.put(
      row({
        runId: "r1",
        status: "done",
        settledAt: 2000,
        resultText: "[reviewer]\nfrom journal",
      })
    )

    await expect(collectCliBackgroundResult("r1", { home })).resolves.toBe(
      "[reviewer]\nfrom journal"
    )
  })

  it("marks persisted running records interrupted before journal fallback collection", async () => {
    const home = makeHome()
    await startCliBackgroundJournal(home)
    await getDb().backgroundTasks.put(row({ runId: "stale", status: "running" }))
    __clearAllCliBackgroundRunsForTesting()

    await expect(collectCliBackgroundResult("stale", { home })).resolves.toBe(
      'Background run "stale" was interrupted before it finished.'
    )
    await expect(countInterruptedCliBackgroundRuns({ home })).resolves.toBe(1)
    await expect(getDb().backgroundTasks.get("stale")).resolves.toMatchObject({
      status: "interrupted",
    })
  })

  it("supports live runs without an explicit CLI home", async () => {
    const run = deferred<string>()

    startCliBackgroundRun("default-home", meta(), run.promise)
    const collected = collectCliBackgroundResult("default-home")
    run.resolve("[reviewer]\ndefault")

    await expect(collected).resolves.toBe("[reviewer]\ndefault")
  })

  it("falls back to journaled error variants after live memory is gone", async () => {
    const home = makeHome()
    await startCliBackgroundJournal(home)
    await getDb().backgroundTasks.bulkPut([
      row({ runId: "with-error", status: "error", error: "journal boom" }),
      row({ runId: "with-result-text", status: "error", resultText: "fallback boom" }),
      row({ runId: "without-message", status: "error" }),
    ])

    await expect(collectCliBackgroundResult("with-error", { home })).resolves.toBe("journal boom")
    await expect(collectCliBackgroundResult("with-result-text", { home })).resolves.toBe(
      "fallback boom"
    )
    await expect(collectCliBackgroundResult("without-message", { home })).resolves.toBe(
      "Background run failed."
    )
  })

  it("ignores non-cli journal rows and reports zero interrupted rows", async () => {
    const home = makeHome()
    await startCliBackgroundJournal(home)
    await getDb().backgroundTasks.put(
      row({
        runId: "renderer-row",
        host: "renderer",
        status: "done",
        settledAt: 2000,
        resultText: "renderer result",
      })
    )

    await expect(collectCliBackgroundResult("renderer-row", { home })).resolves.toBeUndefined()
    await expect(countInterruptedCliBackgroundRuns({ home })).resolves.toBe(0)
  })
})

async function startCliBackgroundJournal(home: string): Promise<void> {
  startCliBackgroundRun("seed", meta(home), Promise.resolve("seed"))
  await collectCliBackgroundResult("seed", { home })
  await __waitForCliBackgroundJournalForTesting()
  await getDb().backgroundTasks.clear()
}
