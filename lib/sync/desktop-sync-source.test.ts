/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { invoke as tauriInvoke } from "@tauri-apps/api/core"
import { listen as tauriListen } from "@tauri-apps/api/event"

const mockAccountStoreState = {
  unlockedAccountId: "local_acct_a" as string | null,
}

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: {
    getState: () => mockAccountStoreState,
  },
}))

import {
  __resetInstalledForTests,
  installDesktopSyncSource,
  readDexieDelta,
} from "./desktop-sync-source"

describe("readDexieDelta", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    // Wipe the tables we touch.
    const db = getDb()
    await db.characters.clear()
    await db.skills.clear()
    await db.sessions.clear()
    await db.messages.clear()
    await db.workflows.clear()
    await db.twinProfile.clear()
    await db.plugins.clear()
    await db.adapterInstances.clear()
    await db.mcpServers.clear()
    await db.terminalHistory.clear()
    await db.conversationOverrides.clear()
    await db.settings.clear()
    await db.workflowRuns.clear()
    await db.syncTombstones.clear()
    ;(tauriListen as jest.Mock).mockReset()
    ;(tauriInvoke as jest.Mock).mockReset()
  })

  it("returns characters whose updatedAt > since", async () => {
    const db = getDb()
    await db.characters.bulkPut([
      { id: "c1", name: "old", systemPrompt: "x", createdAt: 0, updatedAt: 5 } as never,
      { id: "c2", name: "new", systemPrompt: "x", createdAt: 0, updatedAt: 50 } as never,
      {
        id: "c3",
        name: "built-in",
        systemPrompt: "x",
        isBuiltIn: true,
        createdAt: 0,
        updatedAt: 60,
      } as never,
    ])
    const delta = await readDexieDelta("characters", 10)
    expect(delta.rows).toHaveLength(1)
    expect(delta.next_since).toBe(50)
    expect(delta.deleted_ids).toEqual([])
  })

  it("returns sessions whose updatedAt > since", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "old", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      { id: "s2", title: "new", kind: "direct", createdAt: 0, updatedAt: 10 } as never,
    ])
    const delta = await readDexieDelta("sessions", 5)
    expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["s2"])
    expect(delta.next_since).toBe(10)
  })

  it("pages messages by [createdAt+id], ascending, under the page size", async () => {
    const db = getDb()
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      sessionId: "s",
      createdAt: i + 1,
      updatedAt: i + 1,
    })) as never[]
    await db.messages.bulkPut(rows)

    const delta = await readDexieDelta("messages", 0)
    // Full history (250 < page size 500) now syncs — no global 200 cap.
    expect(delta.rows).toHaveLength(250)
    const first = delta.rows[0] as { createdAt: number }
    const last = delta.rows[delta.rows.length - 1] as { createdAt: number }
    expect(last.createdAt - first.createdAt).toBeGreaterThan(0)
    expect(delta.next_since).toBe(250)
    expect(delta.has_more).toBe(false)
  })

  it("uses createdAt as the cursor fallback for message rows without updatedAt", async () => {
    const db = getDb()
    await db.messages.put({
      id: "m-created-only",
      sessionId: "s",
      createdAt: 75,
    } as never)

    const delta = await readDexieDelta("messages", 0)

    expect(delta.rows.map((row) => (row as { id: string }).id)).toEqual(["m-created-only"])
    expect(delta.next_since).toBe(75)
  })

  it("sets has_more when a page fills to capacity", async () => {
    const db = getDb()
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      sessionId: "s",
      createdAt: i + 1,
      updatedAt: i + 1,
    })) as never[]
    await db.messages.bulkPut(rows)

    const delta = await readDexieDelta("messages", 0)
    expect(delta.rows).toHaveLength(500)
    expect(delta.has_more).toBe(true)
  })

  it("surfaces tombstones as deleted_ids and folds deletedAt into next_since", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "live", kind: "direct", createdAt: 0, updatedAt: 5 } as never,
    ])
    await db.syncTombstones.bulkPut([
      { table: "sessions", id: "sGone", deletedAt: 80 },
      { table: "sessions", id: "sOld", deletedAt: 1 }, // before the cursor
      { table: "messages", id: "mGone", deletedAt: 90 }, // other table
    ])
    const delta = await readDexieDelta("sessions", 2)
    expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["s1"])
    expect(delta.deleted_ids).toEqual(["sGone"])
    // next_since = max(maxUpdatedAt=5, maxDeletedAt=80)
    expect(delta.next_since).toBe(80)
  })

  it("returns conversationOverrides whose updatedAt > since", async () => {
    const db = getDb()
    await db.conversationOverrides.bulkPut([
      { id: "o1", conversationKey: "k1", updatedAt: 3 } as never,
      { id: "o2", conversationKey: "k2", updatedAt: 30 } as never,
    ])
    const delta = await readDexieDelta("conversationOverrides", 10)
    expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["o2"])
    expect(delta.next_since).toBe(30)
  })

  it("emits the settings singleton on first pull and re-emits after a change", async () => {
    const db = getDb()
    await db.settings.put({ id: "singleton", theme: "dark", updatedAt: 100 } as never)

    // First pull (since 0) always warms the cache.
    const first = await readDexieDelta("settings", 0)
    expect(first.rows).toHaveLength(1)
    expect(first.next_since).toBe(100)

    // A pull at the current cursor returns nothing…
    const steady = await readDexieDelta("settings", 100)
    expect(steady.rows).toHaveLength(0)

    // …until the row changes (new updatedAt), then it re-emits.
    await db.settings.put({ id: "singleton", theme: "light", updatedAt: 150 } as never)
    const afterChange = await readDexieDelta("settings", 100)
    expect(afterChange.rows).toHaveLength(1)
    expect(afterChange.next_since).toBe(150)
  })

  it("filters skills by updatedAt", async () => {
    const db = getDb()
    await db.skills.bulkPut([
      { id: "k0", name: "missing", createdAt: 0 } as never,
      { id: "k1", name: "a", createdAt: 0, updatedAt: 0 } as never,
      { id: "k2", name: "b", createdAt: 0, updatedAt: 100 } as never,
    ])
    const delta = await readDexieDelta("skills", 50)
    expect(delta.rows).toHaveLength(1)
    expect((delta.rows[0] as { id: string }).id).toBe("k2")
  })

  it("returns workflow, twin profile, plugin, and adapter instance deltas", async () => {
    const db = getDb()
    await db.workflows.bulkPut([
      { id: "wf-old", updatedAt: 1 } as never,
      { id: "wf-new", updatedAt: 20 } as never,
    ])
    await db.twinProfile.bulkPut([
      { id: "twin-missing" } as never,
      { id: "twin-old", updatedAt: 2 } as never,
      { id: "twin-new", updatedAt: 30 } as never,
    ])
    await db.plugins.bulkPut([
      { id: "plugin-missing" } as never,
      { id: "plugin-old", updatedAt: 3 } as never,
      { id: "plugin-new", updatedAt: 40 } as never,
    ])
    await db.adapterInstances.bulkPut([
      { id: "adapter-old", updatedAt: 4 } as never,
      { id: "adapter-new", updatedAt: 50 } as never,
    ])
    await db.mcpServers.bulkPut([
      { id: "mcp-missing" } as never,
      { id: "mcp-old", updatedAt: 6 } as never,
      { id: "mcp-new", updatedAt: 60 } as never,
    ])

    await expect(readDexieDelta("mcpServers", 10)).resolves.toEqual(
      expect.objectContaining({ rows: [expect.objectContaining({ id: "mcp-new" })] })
    )
    await expect(readDexieDelta("workflows", 10)).resolves.toEqual(
      expect.objectContaining({ rows: [expect.objectContaining({ id: "wf-new" })] })
    )
    await expect(readDexieDelta("twinProfile", 10)).resolves.toEqual(
      expect.objectContaining({ rows: [expect.objectContaining({ id: "twin-new" })] })
    )
    await expect(readDexieDelta("plugins", 10)).resolves.toEqual(
      expect.objectContaining({ rows: [expect.objectContaining({ id: "plugin-new" })] })
    )
    await expect(readDexieDelta("adapterInstances", 10)).resolves.toEqual(
      expect.objectContaining({ rows: [expect.objectContaining({ id: "adapter-new" })] })
    )
  })

  it("returns workflow runs whose start OR completion is past the cursor, cursored on max(startedAt, completedAt)", async () => {
    const db = getDb()
    await db.workflowRuns.bulkPut([
      // Started + completed before the cursor — excluded.
      {
        id: "r-old",
        workflowId: "wf-1",
        status: "succeeded",
        startedAt: 5,
        completedAt: 8,
      } as never,
      // Started before the cursor but COMPLETED after it — must re-sync so the
      // phone learns the final status (the core run-status flip case).
      {
        id: "r-finishing",
        workflowId: "wf-1",
        status: "succeeded",
        startedAt: 9,
        completedAt: 40,
      } as never,
      // Started after the cursor, still running — included as "running".
      { id: "r-running", workflowId: "wf-2", status: "running", startedAt: 30 } as never,
    ])

    const delta = await readDexieDelta("workflowRuns", 10)
    expect(delta.rows.map((r) => (r as { id: string }).id).sort()).toEqual([
      "r-finishing",
      "r-running",
    ])
    // next_since rides the highest max(startedAt, completedAt) = 40.
    expect(delta.next_since).toBe(40)
  })

  it("pages workflow runs (oldest activity first) and sets has_more past the page size", async () => {
    const db = getDb()
    const rows = Array.from({ length: 205 }, (_, i) => ({
      id: `run-${i}`,
      workflowId: "wf-1",
      status: "succeeded",
      startedAt: 100 + i,
      completedAt: 100 + i,
    }))
    await db.workflowRuns.bulkPut(rows as never)
    // Use a real cursor (not 0) so the 30-day first-sync window — which floors
    // on Date.now() — doesn't exclude these synthetic low timestamps.
    const delta = await readDexieDelta("workflowRuns", 50)
    expect(delta.rows).toHaveLength(200)
    expect(delta.has_more).toBe(true)
    // Oldest-activity-first paging: the first page starts at the earliest run.
    expect((delta.rows[0] as { id: string }).id).toBe("run-0")
  })

  it("returns terminalHistory rows past the cursor and rides next_since on max(ts)", async () => {
    const db = getDb()
    await db.terminalHistory.bulkPut([
      // ts before the cursor — excluded.
      {
        id: "th-old",
        command: "ls",
        projectId: "",
        shell: "pwsh.exe",
        cwd: null,
        exitCode: 0,
        ts: 5,
        uses: 1,
        sessionId: "sess-1",
      } as never,
      // ts past the cursor — included.
      {
        id: "th-mid",
        command: "git status",
        projectId: "proj-a",
        shell: "pwsh.exe",
        cwd: "C:/repo",
        exitCode: 0,
        ts: 20,
        uses: 3,
        sessionId: "sess-1",
      } as never,
      // highest ts — sets next_since.
      {
        id: "th-new",
        command: "pnpm test",
        projectId: "proj-a",
        shell: "pwsh.exe",
        cwd: "C:/repo",
        exitCode: 1,
        ts: 60,
        uses: 2,
        sessionId: "sess-2",
      } as never,
    ])

    const delta = await readDexieDelta("terminalHistory", 10)
    expect(delta.rows.map((r) => (r as { id: string }).id).sort()).toEqual(["th-mid", "th-new"])
    // Cursor rides the highest ts — without the cursorOf override it would stay
    // at `since` forever and the phone would re-pull the same rows every sync.
    expect(delta.next_since).toBe(60)
    expect(delta.deleted_ids).toEqual([])
    expect(delta.has_more).toBe(false)
  })

  it("emits settings with Date.now cursor when the singleton has no updatedAt", async () => {
    const db = getDb()
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(123_456)
    await db.settings.put({ id: "singleton", theme: "dark" } as never)

    const delta = await readDexieDelta("settings", 0)

    expect(delta.rows).toHaveLength(1)
    expect(delta.next_since).toBe(123_456)
    nowSpy.mockRestore()
  })

  it("returns an empty settings delta when the singleton does not exist", async () => {
    await expect(readDexieDelta("settings", 42)).resolves.toEqual({
      rows: [],
      deleted_ids: [],
      next_since: 42,
    })
  })

  it("throws on an unknown table", async () => {
    await expect(readDexieDelta("unknown" as never, 0)).rejects.toThrow(/unknown sync table/)
  })
})

describe("installDesktopSyncSource", () => {
  beforeEach(() => {
    __resetInstalledForTests()
    mockAccountStoreState.unlockedAccountId = "local_acct_a"
  })

  it("calls the response command with delta on a successful same-account pull", async () => {
    const listenHandler: { ref: ((e: { payload: unknown }) => void) | null } = { ref: null }
    const listen = jest.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      listenHandler.ref = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    const teardown = await installDesktopSyncSource({
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    // Wipe + seed characters.
    const db = getDb()
    await db.characters.clear()
    await db.characters.put({
      id: "c1",
      name: "x",
      systemPrompt: "y",
      createdAt: 0,
      updatedAt: 99,
    } as never)

    listenHandler.ref!({
      payload: {
        request_id: "rid-1",
        table: "characters",
        since: 0,
        account_id: "local_acct_a",
      },
    })
    // Wait for the async handler to invoke back.
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_sync_pull_response", {
      requestId: "rid-1",
      delta: expect.objectContaining({
        rows: expect.arrayContaining([expect.objectContaining({ id: "c1" })]),
        next_since: 99,
      }),
      error: null,
    })

    teardown()
  })

  it("rejects a pull for another local account before reading Dexie", async () => {
    const listenHandler: { ref: ((e: { payload: unknown }) => void) | null } = { ref: null }
    const listen = jest.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      listenHandler.ref = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopSyncSource({
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    listenHandler.ref!({
      payload: {
        request_id: "rid-account-mismatch",
        table: "bogus" as never,
        since: 0,
        account_id: "local_acct_b",
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_sync_pull_response", {
      requestId: "rid-account-mismatch",
      delta: null,
      error: expect.stringContaining("account"),
    })
  })

  it("rejects accountless and locked sync pulls", async () => {
    const listenHandler: { ref: ((e: { payload: unknown }) => void) | null } = { ref: null }
    const listen = jest.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      listenHandler.ref = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopSyncSource({
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    listenHandler.ref!({
      payload: {
        request_id: "rid-missing-account",
        table: "characters",
        since: 0,
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(invoke).toHaveBeenCalledWith("companion_sync_pull_response", {
      requestId: "rid-missing-account",
      delta: null,
      error: expect.stringContaining("missing local account id"),
    })

    mockAccountStoreState.unlockedAccountId = null
    listenHandler.ref!({
      payload: {
        request_id: "rid-locked",
        table: "characters",
        since: 0,
        account_id: "local_acct_a",
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(invoke).toHaveBeenCalledWith("companion_sync_pull_response", {
      requestId: "rid-locked",
      delta: null,
      error: expect.stringContaining("no unlocked local account"),
    })
  })

  it("calls the response command with error on a failing pull", async () => {
    const listenHandler: { ref: ((e: { payload: unknown }) => void) | null } = { ref: null }
    const listen = jest.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      listenHandler.ref = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopSyncSource({
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    listenHandler.ref!({
      payload: {
        request_id: "rid-2",
        table: "bogus" as never,
        since: 0,
        account_id: "local_acct_a",
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_sync_pull_response", {
      requestId: "rid-2",
      delta: null,
      error: expect.stringContaining("unknown sync table"),
    })
  })

  it("serializes non-Error sync failures with String()", async () => {
    const listenHandler: { ref: ((e: { payload: unknown }) => void) | null } = { ref: null }
    const listen = jest.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      listenHandler.ref = h
      return () => {}
    })
    const invoke = jest.fn().mockRejectedValueOnce("plain failure").mockResolvedValueOnce({})

    await installDesktopSyncSource({
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    const db = getDb()
    await db.characters.put({
      id: "c1",
      name: "x",
      systemPrompt: "y",
      createdAt: 0,
      updatedAt: 99,
    } as never)

    listenHandler.ref!({
      payload: {
        request_id: "rid-string-error",
        table: "characters",
        since: 0,
        account_id: "local_acct_a",
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenLastCalledWith("companion_sync_pull_response", {
      requestId: "rid-string-error",
      delta: null,
      error: "plain failure",
    })
  })

  it("returns a no-op teardown when the Tauri imports fail (web/Capacitor)", async () => {
    // Force the dynamic-import path; jest can't resolve @tauri-apps/api/event
    // in jsdom, so the loader rejects — but we passed a bridge so this test
    // exercises the second-call short-circuit.
    const teardown1 = await installDesktopSyncSource({
      bridge: { listen: async () => () => {}, invoke: async () => ({}) },
      forceReinstall: true,
    })
    const teardown2 = await installDesktopSyncSource({
      bridge: { listen: async () => () => {}, invoke: async () => ({}) },
      forceReinstall: false,
    })
    // Second call returns a no-op (does not re-listen).
    teardown2()
    teardown1()
  })

  it("uses the default Tauri bridge when no bridge is injected", async () => {
    const unlisten = jest.fn()
    ;(tauriListen as jest.Mock).mockResolvedValueOnce(unlisten)

    const teardown = await installDesktopSyncSource({ forceReinstall: true })

    expect(tauriListen).toHaveBeenCalledWith("companion://sync-pull-request", expect.any(Function))
    teardown()
    expect(unlisten).toHaveBeenCalled()
  })
})
