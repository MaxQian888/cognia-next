/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

import { appendBotRunLog, appendBotRunProgress } from "./journal"

const NOW = 1_700_000_000_000
const now = () => NOW

beforeEach(async () => {
  __resetDbForTesting()
  const db = getDb()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
  await createExecutionRun({
    id: "run_1",
    kind: "bot",
    sourceId: "boti_1",
    title: "Digest",
    status: "running",
    currentRevision: 0,
    startedAt: NOW,
    updatedAt: NOW,
  })
})

async function settle(): Promise<void> {
  // The appends are fire-and-forget; give them a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("appendBotRunLog", () => {
  it("journals info lines as step.progress and error lines as step.failed", async () => {
    appendBotRunLog("run_1", "info", "Fetched revision", { count: 3 }, now)
    appendBotRunLog("run_1", "error", "Verification failed", undefined, now)
    await settle()

    const events = await runEventJournal.replay("run_1")
    const progress = events.find((event) => event.type === "step.progress")
    const failure = events.find((event) => event.type === "step.failed")
    expect(progress?.payload).toMatchObject({ message: "Fetched revision" })
    expect(failure?.payload).toMatchObject({ message: "Verification failed" })
  })
})

describe("appendBotRunProgress", () => {
  it("journals the update as step.progress", async () => {
    appendBotRunProgress("run_1", { fraction: 0.5, message: "halfway" }, now)
    await settle()

    const events = await runEventJournal.replay("run_1")
    expect(events).toEqual([expect.objectContaining({ type: "step.progress" })])
  })
})

describe("fire-and-forget", () => {
  it("swallows a journal failure rather than rejecting the handler's work", async () => {
    // No execution run "missing" exists, so the append rejects — and must be
    // swallowed, or a logging call would crash the run it describes.
    appendBotRunLog("missing", "info", "dropped", undefined, now)
    appendBotRunProgress("missing", { fraction: 1 }, now)
    await settle()
    expect(await runEventJournal.replay("missing")).toEqual([])
  })
})
