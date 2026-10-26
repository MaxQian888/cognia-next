/**
 * @jest-environment node
 */
// Production disk persistence is kept here rather than paid by every registry
// and journal unit test. No filesystem or database bootstrap is mocked.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

jest.setTimeout(30_000)

jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetCliDbForTesting, ensureCliDb, type CliDbHandle } from "../db/bootstrap"
import {
  __clearAllCliBackgroundRunsForTesting,
  __disposeCliBackgroundJournalForTesting,
  collectCliBackgroundResult,
  countInterruptedCliBackgroundRuns,
} from "./subagent-background-tasks"

const homes: string[] = []
let activeDb: CliDbHandle | undefined

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-bg-heavy-"))
  homes.push(home)
  return home
}

async function resetDb(): Promise<void> {
  await __disposeCliBackgroundJournalForTesting()
  await activeDb?.dispose()
  activeDb = undefined
  await getDb().delete()
  __resetDbForTesting()
  __resetCliDbForTesting()
  __clearAllCliBackgroundRunsForTesting()
}

afterEach(async () => {
  await resetDb()
  for (const home of homes.splice(0)) fs.rmSync(home, { force: true, recursive: true })
})

describe("CLI background journal disk persistence", () => {
  it("persists interrupted records and restores their result after a host restart", async () => {
    const home = makeHome()
    const handle = await ensureCliDb({ home })
    activeDb = handle
    await getDb().backgroundTasks.put({
      runId: "stale",
      kind: "subagent",
      subagentId: "reviewer",
      prompt: "check this",
      sessionId: "ses_1",
      host: "cli",
      status: "running",
      startedAt: 1000,
    })

    await expect(collectCliBackgroundResult("stale", { home })).resolves.toBe(
      "Background task interrupted because its host process stopped."
    )
    await expect(countInterruptedCliBackgroundRuns({ home })).resolves.toBe(1)
    await expect(getDb().backgroundTasks.get("stale")).resolves.toMatchObject({
      status: "interrupted",
    })
    await handle.flush()
    const tables = path.join(home, "db.json.tables")
    const journal = fs.readdirSync(tables).find((name) => name.endsWith("--backgroundTasks.json"))!
    expect(JSON.parse(fs.readFileSync(path.join(tables, journal), "utf8"))).toContainEqual(
      expect.objectContaining({ runId: "stale", status: "interrupted" })
    )

    await resetDb()
    const restarted = await ensureCliDb({ home })
    activeDb = restarted
    await expect(collectCliBackgroundResult("stale", { home, owner: "ses_1" })).resolves.toBe(
      "Background task interrupted because its host process stopped."
    )
    await expect(countInterruptedCliBackgroundRuns({ home, owner: "ses_1" })).resolves.toBe(1)
    await restarted.dispose()
  })

  it("does not rewrite unrelated tables when reconciling an empty background journal on resume", async () => {
    const home = makeHome()
    const handle = await ensureCliDb({ home })
    activeDb = handle
    await handle.flush()
    const tables = path.join(home, "db.json.tables")
    const file = path.join(
      tables,
      fs.readdirSync(tables).find((name) => name.endsWith("--memories.json"))!
    )
    fs.utimesSync(file, new Date(1000), new Date(1000))

    await expect(countInterruptedCliBackgroundRuns({ home })).resolves.toBe(0)
    await handle.flush()

    expect(fs.statSync(file).mtimeMs).toBe(1000)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([])
  })
})
