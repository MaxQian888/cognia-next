/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  pruneTerminalHistory,
  queryTerminalHistory,
  recordTerminalHistory,
} from "./terminal-history"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

const base = {
  shell: "pwsh.exe",
  cwd: "D:/repo",
  exitCode: 0,
  sessionId: "s1",
  projectId: "p1",
}

describe("recordTerminalHistory", () => {
  it("adds a row with uses=1 and trims the command", async () => {
    await recordTerminalHistory({ ...base, command: "  git status  ", ts: 1000 })
    const rows = await getDb().terminalHistory.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].command).toBe("git status")
    expect(rows[0].uses).toBe(1)
    expect(rows[0].projectId).toBe("p1")
  })

  it("ignores blank commands", async () => {
    await recordTerminalHistory({ ...base, command: "   " })
    expect(await getDb().terminalHistory.count()).toBe(0)
  })

  it("bumps ts/uses for a re-run instead of duplicating", async () => {
    await recordTerminalHistory({ ...base, command: "git status", ts: 1000 })
    await recordTerminalHistory({ ...base, command: "git status", ts: 2000, exitCode: 1 })
    const rows = await getDb().terminalHistory.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].uses).toBe(2)
    expect(rows[0].ts).toBe(2000)
    expect(rows[0].exitCode).toBe(1)
  })

  it("stores projectId as empty string for project-less sessions", async () => {
    await recordTerminalHistory({ ...base, projectId: null, command: "ls", ts: 1 })
    const rows = await getDb().terminalHistory.toArray()
    expect(rows[0].projectId).toBe("")
    // Dedup still works for the null-project bucket.
    await recordTerminalHistory({ ...base, projectId: null, command: "ls", ts: 2 })
    expect(await getDb().terminalHistory.count()).toBe(1)
  })

  it("keeps the same command in different projects distinct", async () => {
    await recordTerminalHistory({ ...base, projectId: "p1", command: "ls", ts: 1 })
    await recordTerminalHistory({ ...base, projectId: "p2", command: "ls", ts: 2 })
    expect(await getDb().terminalHistory.count()).toBe(2)
  })
})

describe("pruneTerminalHistory", () => {
  it("drops the least-recently-used rows beyond the cap", async () => {
    const table = getDb().terminalHistory
    const rows = Array.from({ length: 5005 }, (_, i) => ({
      id: `id_${i}`,
      command: `cmd ${i}`,
      projectId: "",
      shell: "bash",
      cwd: null,
      exitCode: 0,
      ts: i,
      uses: 1,
      sessionId: "s1",
    }))
    await table.bulkAdd(rows)
    await pruneTerminalHistory()
    expect(await table.count()).toBe(5000)
    const oldest = await table.orderBy("ts").first()
    expect(oldest?.ts).toBe(5)
  })
})

describe("queryTerminalHistory", () => {
  it("returns [] for a blank prefix", async () => {
    expect(await queryTerminalHistory({ prefix: "  " })).toEqual([])
  })

  it("prefix-matches case-insensitively and excludes exact-equal commands", async () => {
    await recordTerminalHistory({ ...base, command: "Git Status", ts: 1000 })
    await recordTerminalHistory({ ...base, command: "git", ts: 1000 })
    const rows = await queryTerminalHistory({ prefix: "git", now: 2000 })
    expect(rows.map((r) => r.command)).toEqual(["Git Status"])
  })

  it("ranks recent rows above stale ones", async () => {
    const now = 100 * 86_400_000
    await recordTerminalHistory({ ...base, command: "git old", ts: now - 30 * 86_400_000 })
    await recordTerminalHistory({ ...base, command: "git new", ts: now - 1000 })
    const rows = await queryTerminalHistory({ prefix: "git", now })
    expect(rows[0].command).toBe("git new")
  })

  it("ranks frequently-used rows above one-offs of similar age", async () => {
    const now = 86_400_000
    await recordTerminalHistory({ ...base, command: "git frequent", ts: now - 5000 })
    await recordTerminalHistory({ ...base, command: "git frequent", ts: now - 4000 })
    await recordTerminalHistory({ ...base, command: "git frequent", ts: now - 3000 })
    await recordTerminalHistory({ ...base, command: "git rare", ts: now - 2000 })
    const rows = await queryTerminalHistory({ prefix: "git", now })
    expect(rows[0].command).toBe("git frequent")
  })

  it("boosts same-project and same-cwd rows", async () => {
    const now = 10_000
    await recordTerminalHistory({
      ...base,
      projectId: "other",
      cwd: "/elsewhere",
      command: "npm run a",
      ts: now - 1000,
    })
    await recordTerminalHistory({
      ...base,
      projectId: "p1",
      cwd: "/here",
      command: "npm run b",
      ts: now - 2000,
    })
    const rows = await queryTerminalHistory({ prefix: "npm", projectId: "p1", cwd: "/here", now })
    expect(rows[0].command).toBe("npm run b")
  })

  it("caps the result count", async () => {
    for (let i = 0; i < 8; i++) {
      await recordTerminalHistory({ ...base, command: `echo ${i}`, ts: i })
    }
    const rows = await queryTerminalHistory({ prefix: "echo", limit: 3, now: 100 })
    expect(rows).toHaveLength(3)
  })
})
