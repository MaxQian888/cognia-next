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

jest.mock("@/lib/files/allowed-roots-sync", () => ({
  registerDialogPathInRust: jest.fn(),
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      createProject: jest.fn(),
      addSessionToProject: jest.fn(),
    }),
  },
}))

import {
  __resetInstalledForTests,
  HEARTBEAT_FIRST_SYNC_WINDOW_MS,
  HEARTBEAT_PAGE_SIZE,
  installDesktopSyncSource,
  readDexieDelta,
} from "./desktop-sync-source"
import {
  publishProvisionedTurnServers,
  resetProvisionedTurnServersForTests,
} from "@/lib/signaling/provisioned-turn-state"

describe("readDexieDelta", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    resetProvisionedTurnServersForTests()
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
    await db.mcpServerSummaries.clear()
    await db.terminalHistory.clear()
    await db.conversationOverrides.clear()
    await db.settings.clear()
    await db.workflowRuns.clear()
    await db.executionRuns.clear()
    await db.memories.clear()
    await db.syncTombstones.clear()
    await db.connectorHeartbeats.clear()
    await db.platformIdentities.clear()
    await db.connectorCallbackBindings.clear()
    await db.workflowDeployments.clear()
    await db.executionRunBindings.clear()
    ;(tauriListen as jest.Mock).mockReset()
    ;(tauriInvoke as jest.Mock).mockReset()
  })

  it("rejects memory sync clients that do not support encrypted content protocol v1", async () => {
    await expect(readDexieDelta("memories", 0)).rejects.toThrow("upgrade_required")
    await expect(readDexieDelta("memories", 0, 0)).rejects.toThrow("upgrade_required")
  })

  it("returns memory rows as ciphertext-only protocol v1 envelopes", async () => {
    await getDb().memories.add({
      id: "memory-1",
      scope: "global",
      type: "semantic",
      text: "private memory statement",
      tags: [],
      importance: 7,
      createdAt: 1,
      updatedAt: 2,
      lastAccessedAt: 2,
      accessCount: 0,
      version: 1,
      status: "active",
      pinned: false,
      provenance: "user",
    })
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const delta = await readDexieDelta("memories", 0, 1, {
      getMemoryDek: async () => ({ profileId: "memory-shared", keyId: "dek-1", key }),
    })
    const serialized = JSON.stringify(delta)

    expect(delta.rows).toHaveLength(1)
    expect(delta.rows[0]).toMatchObject({
      id: "memory-1",
      protocolVersion: 1,
      envelope: { keyId: "dek-1", algorithm: "AES-256-GCM" },
    })
    expect(serialized).not.toContain("private memory statement")
  })

  it("bounds a cold-start memory snapshot to the newest rows", async () => {
    const row = (id: string, updatedAt: number) => ({
      id,
      scope: "global" as const,
      type: "semantic" as const,
      text: `private ${id}`,
      tags: [],
      importance: 5,
      createdAt: 1,
      updatedAt,
      lastAccessedAt: updatedAt,
      accessCount: 0,
      version: 1,
      status: "active" as const,
      pinned: false,
      provenance: "user" as const,
    })
    await getDb().memories.bulkAdd([row("oldest", 1), row("middle", 2), row("newest", 3)])
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])

    const delta = await readDexieDelta("memories", 0, 1, {
      getMemoryDek: async () => ({ profileId: "memory-shared", keyId: "dek-1", key }),
      memoryColdStartLimit: 2,
    })

    expect(delta.rows.map((value) => (value as { id: string }).id).sort()).toEqual([
      "middle",
      "newest",
    ])
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

  it("never syncs a managed workspace's device-local filesystem paths", async () => {
    const db = getDb()
    await db.sessions.put({
      id: "s-managed",
      title: "Managed",
      kind: "direct",
      createdAt: 0,
      updatedAt: 10,
      executionContext: {
        location: "managedWorktree",
        workspaceBinding: { kind: "managed", workspaceId: "managed-workspace:s-managed" },
        managedWorkspace: { availability: "available", localRoot: "/Users/a/private" },
        projectId: "",
        projectRoot: "/Users/a/private",
        worktreePath: "/Users/a/private/.run",
        branch: "codex/private",
        taskWorkspace: { taskId: "task-workspace:s-managed", workspaceKey: "s-managed" },
      },
    } as never)

    const delta = await readDexieDelta("sessions", 0)
    const row = delta.rows[0] as Record<string, unknown>
    expect(row.executionContext).toEqual(
      expect.objectContaining({
        projectRoot: "",
        managedWorkspace: { availability: "missing-on-device" },
      })
    )
    expect(JSON.stringify(row)).not.toContain("/Users/a/private")
    expect(JSON.stringify(row)).not.toContain("codex/private")
  })

  it("includes embedded resource sessions in authenticated device sync without changing visibility", async () => {
    const db = getDb()
    await db.sessions.put({
      id: "resource-workbench:canvas:doc",
      title: "Canvas",
      kind: "resource-workbench",
      visibility: "embedded",
      surfaceBinding: { kind: "canvas-document", documentId: "doc" },
      createdAt: 1,
      updatedAt: 10,
    })
    const delta = await readDexieDelta("sessions", 0)
    expect(delta.rows).toContainEqual(
      expect.objectContaining({
        id: "resource-workbench:canvas:doc",
        kind: "resource-workbench",
        visibility: "embedded",
      })
    )
  })

  it("folds a cold-start message sync to the newest bounded page", async () => {
    const db = getDb()
    const rows = Array.from({ length: 750 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      sessionId: "s",
      createdAt: i + 1,
      updatedAt: i + 1,
    })) as never[]
    await db.messages.bulkPut(rows)

    const delta = await readDexieDelta("messages", 0)
    expect(delta.rows).toHaveLength(500)
    const first = delta.rows[0] as { createdAt: number }
    const last = delta.rows[delta.rows.length - 1] as { createdAt: number }
    expect(first.createdAt).toBe(251)
    expect(last.createdAt).toBe(750)
    expect(delta.next_since).toBe(750)
    // Older rows are folded behind per-session on-demand hydration rather
    // than making the generic sync handler drain the whole database at boot.
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

  it("sets has_more for a full incremental page", async () => {
    const db = getDb()
    const rows = Array.from({ length: 600 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      sessionId: "s",
      createdAt: i + 1,
      updatedAt: i + 1,
    })) as never[]
    await db.messages.bulkPut(rows)

    const delta = await readDexieDelta("messages", 50)
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

  it("returns chatTemplates whose updatedAt > since and ignores usage-only writes", async () => {
    const db = getDb()
    // Cleared here rather than in the shared beforeEach: this is the only
    // suite that touches the table.
    await db.chatTemplates.clear()
    await db.chatTemplates.bulkPut([
      {
        id: "tpl_old",
        name: "Old",
        body: "a",
        revision: 1,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 3,
      } as never,
      {
        id: "tpl_new",
        name: "New",
        body: "b",
        revision: 1,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 30,
      } as never,
    ])

    const delta = await readDexieDelta("chatTemplates", 10)
    expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["tpl_new"])
    expect(delta.next_since).toBe(30)

    // `recordChatTemplateUse` rewrites the row without touching `updatedAt`.
    // That is what keeps a per-send counter off the wire, so a pull at the
    // settled cursor has to stay empty afterwards.
    await db.chatTemplates.put({
      id: "tpl_new",
      name: "New",
      body: "b",
      revision: 1,
      usageCount: 7,
      lastUsedAt: 900,
      createdAt: 0,
      updatedAt: 30,
    } as never)
    await expect(readDexieDelta("chatTemplates", 30)).resolves.toMatchObject({
      rows: [],
      deleted_ids: [],
      next_since: 30,
    })
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

  it("mirrors host-provisioned TURN credentials without exposing the provider secret", async () => {
    const db = getDb()
    await db.settings.put({
      id: "singleton",
      updatedAt: 100,
      turnServers: [{ urls: "turn:static.example", username: "static", credential: "safe" }],
      turnProvider: {
        kind: "cloudflare-calls",
        cloudflareKeyId: "provider-key",
        secretRef: "kr:host-only-secret",
      },
    } as never)
    publishProvisionedTurnServers(
      [{ urls: "turn:ephemeral.example", username: "ephemeral", credential: "short-lived" }],
      200
    )

    const delta = await readDexieDelta("settings", 100)
    const row = delta.rows[0] as Record<string, unknown>

    expect(row.turnServers).toEqual([
      { urls: "turn:static.example", username: "static", credential: "safe" },
      { urls: "turn:ephemeral.example", username: "ephemeral", credential: "short-lived" },
    ])
    expect(row).not.toHaveProperty("turnProvider")
    expect(delta.next_since).toBe(200)
    expect(JSON.stringify(row)).not.toContain("host-only-secret")
  })

  it("never puts host credentials on the wire with the settings singleton", async () => {
    // The client only *applies* the mirrored subset, which made emitting the
    // whole row look harmless — but the row had already crossed the wire, so
    // every paired device received the host's provider credentials. Redaction
    // has to happen here, at the source: a client cannot un-receive a secret.
    const db = getDb()
    await db.settings.put({
      id: "singleton",
      updatedAt: 100,
      theme: "dark",
      signalingUrl: "wss://self-hosted.example/signaling",
      apiKey: "sk-ant-secret",
      apiBaseUrl: "https://internal.example",
      providerSettings: { openai: { apiKey: "sk-openai-secret" } },
      customProviders: [{ id: "p1", apiKey: "sk-custom-secret" }],
      searchProviders: { tavily: { apiKey: "tvly-secret" } },
      skillsShToken: "skills-secret",
      webdavSync: { url: "https://dav.example", password: "dav-secret" },
      networkProxy: { mode: "manual", username: "u", password: "proxy-secret" },
      defaultWorkingDir: "/Users/someone/private",
    } as never)

    const delta = await readDexieDelta("settings", 0)
    const row = delta.rows[0] as Record<string, unknown>

    // Mirrored fields still arrive — including the transport config the phone
    // needs to reach a self-hosted signaling server.
    expect(row.theme).toBe("dark")
    expect(row.signalingUrl).toBe("wss://self-hosted.example/signaling")
    // Envelope fields the client keys and cursors on.
    expect(row.id).toBe("singleton")
    expect(row.updatedAt).toBe(100)

    for (const secret of [
      "apiKey",
      "apiBaseUrl",
      "providerSettings",
      "customProviders",
      "searchProviders",
      "skillsShToken",
      "webdavSync",
      "networkProxy",
      "defaultWorkingDir",
    ]) {
      expect(row).not.toHaveProperty(secret)
    }
    // Belt and braces: no secret value survives anywhere in the payload.
    expect(JSON.stringify(delta)).not.toMatch(/secret|private/)
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
    await db.mcpServerSummaries.bulkPut([
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

  it("never ships an execution lease or a cancel request to another machine", async () => {
    // `lease.expiresAt` is an absolute timestamp from THIS desktop's clock, and
    // the receiving client judges it with its own `Date.now()` — so copying the
    // row whole hands a phone a lease it can call live or stale purely by clock
    // skew, owned by a process it cannot reach. `cancelRequestedAt` is a request
    // addressed to that lease holder and equally meaningless once it travels.
    const db = getDb()
    await db.workflowRuns.bulkPut([
      {
        id: "r-leased",
        workflowId: "wf-1",
        status: "running",
        startedAt: 30,
        lease: { ownerId: "exec_local", expiresAt: Date.now() + 60_000, heartbeatAt: Date.now() },
        cancelRequestedAt: 31,
      } as never,
    ])

    const delta = await readDexieDelta("workflowRuns", 10)
    const row = delta.rows.find((candidate) => (candidate as { id: string }).id === "r-leased")

    expect(row).toBeDefined()
    expect(row).not.toHaveProperty("lease")
    expect(row).not.toHaveProperty("cancelRequestedAt")
    // Everything a remote surface actually reads still travels.
    expect(row).toMatchObject({ status: "running", startedAt: 30, workflowId: "wf-1" })
  })

  it("returns canonical execution summaries without syncing private event rows", async () => {
    const db = getDb()
    await db.executionRuns.bulkPut([
      {
        id: "execution-old",
        kind: "goal",
        sourceId: "goal-old",
        title: "Old",
        status: "completed",
        currentRevision: 1,
        startedAt: 1,
        updatedAt: 5,
      },
      {
        id: "execution-new",
        kind: "plan",
        sourceId: "plan-new",
        title: "New",
        status: "running",
        currentRevision: 2,
        startedAt: 10,
        updatedAt: 30,
      },
    ] as never)
    await db.executionRunEvents.put({
      id: "private-event",
      runId: "execution-new",
      seq: 2,
      ts: 30,
      type: "step.progress",
      visibility: "private",
      payload: { detail: "host only" },
    })

    const delta = await readDexieDelta("executionRuns", 10)

    expect(delta.rows).toEqual([expect.objectContaining({ id: "execution-new" })])
    expect(JSON.stringify(delta)).not.toContain("host only")
    expect(delta.next_since).toBe(30)
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

  describe("the Inbox sidebar's host-only tables", () => {
    const beat = (id: string, at: number) => ({
      id,
      adapterId: "tg-1",
      kind: "adapter.heartbeat" as const,
      at,
      fields: { state: "healthy" },
    })

    it("pages connectorHeartbeats on `at` and floors a cold pull to the recent window", async () => {
      const now = 10_000_000_000
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now)
      try {
        await getDb().connectorHeartbeats.bulkPut([
          beat("stale", now - HEARTBEAT_FIRST_SYNC_WINDOW_MS - 1),
          beat("recent", now - 1_000),
          beat("newest", now - 10),
        ])
        const cold = await readDexieDelta("connectorHeartbeats", 0)
        expect(cold.rows.map((r) => (r as { id: string }).id)).toEqual(["recent", "newest"])
        expect(cold.next_since).toBe(now - 10)
        expect(cold.has_more).toBe(false)

        // Incremental pulls use the real cursor, never the floor.
        const warm = await readDexieDelta("connectorHeartbeats", now - 1_000)
        expect(warm.rows.map((r) => (r as { id: string }).id)).toEqual(["newest"])
      } finally {
        nowSpy.mockRestore()
      }
    })

    it("signals has_more when a heartbeat page fills to capacity", async () => {
      const now = 10_000_000_000
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now)
      try {
        await getDb().connectorHeartbeats.bulkPut(
          Array.from({ length: HEARTBEAT_PAGE_SIZE + 1 }, (_, i) => beat(`h${i}`, now - 2_000 + i))
        )
        const first = await readDexieDelta("connectorHeartbeats", 0)
        expect(first.rows).toHaveLength(HEARTBEAT_PAGE_SIZE)
        expect(first.has_more).toBe(true)
        const second = await readDexieDelta("connectorHeartbeats", first.next_since)
        expect(second.rows).toHaveLength(1)
        expect(second.has_more).toBe(false)
      } finally {
        nowSpy.mockRestore()
      }
    })

    it("cursors platformIdentities on updatedAt, falling back to lastSeenAt for legacy rows", async () => {
      await getDb().platformIdentities.bulkPut([
        {
          id: "legacy",
          platform: "telegram",
          adapterId: "tg-1",
          remoteUserId: "u1",
          lastSeenAt: 5,
        },
        // A merge rewrote this tree without a sighting: lastSeenAt is old, updatedAt is new.
        {
          id: "merged",
          platform: "telegram",
          adapterId: "tg-1",
          remoteUserId: "u2",
          lastSeenAt: 3,
          updatedAt: 20,
        },
        {
          id: "quiet",
          platform: "telegram",
          adapterId: "tg-1",
          remoteUserId: "u3",
          lastSeenAt: 8,
          updatedAt: 8,
        },
      ] as never[])
      const delta = await readDexieDelta("platformIdentities", 8)
      expect(delta.rows.map((r) => (r as { id: string }).id).sort()).toEqual(["merged"])
      expect(delta.next_since).toBe(20)
      const cold = await readDexieDelta("platformIdentities", 0)
      expect(cold.rows.map((r) => (r as { id: string }).id).sort()).toEqual([
        "legacy",
        "merged",
        "quiet",
      ])
    })

    it("cursors connectorCallbackBindings on the later of createdAt and consumedAt, skipping expired rows", async () => {
      const now = 10_000_000_000
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now)
      try {
        const base = {
          adapterId: "tg-1",
          kind: "callback_query" as const,
          surfaceId: "s",
          expiresAt: now + 1_000,
        }
        await getDb().connectorCallbackBindings.bulkPut([
          { ...base, id: "tg-1:old", actionId: "old", createdAt: 10 },
          { ...base, id: "tg-1:consumed", actionId: "consumed", createdAt: 10, consumedAt: 50 },
          { ...base, id: "tg-1:new", actionId: "new", createdAt: 60 },
          { ...base, id: "tg-1:dead", actionId: "dead", createdAt: 70, expiresAt: now - 1 },
        ])
        const delta = await readDexieDelta("connectorCallbackBindings", 40)
        expect(delta.rows.map((r) => (r as { actionId: string }).actionId).sort()).toEqual([
          "consumed",
          "new",
        ])
        expect(delta.next_since).toBe(60)
      } finally {
        nowSpy.mockRestore()
      }
    })

    it("reads workflowDeployments past the cursor on their indexed updatedAt", async () => {
      const row = (id: string, updatedAt: number) => ({
        id,
        accountId: "a",
        workflowId: `wf-${id}`,
        environment: "production",
        versionId: "v1",
        revision: 1,
        status: "active",
        createdAt: 1,
        updatedAt,
      })
      await getDb().workflowDeployments.bulkPut([row("d-old", 5), row("d-new", 15)] as never[])
      const delta = await readDexieDelta("workflowDeployments", 5)
      expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["d-new"])
      expect(delta.next_since).toBe(15)
    })

    it("reads executionRunBindings past the cursor on updatedAt", async () => {
      const row = (id: string, updatedAt: number) => ({
        id,
        runId: `run-${id}`,
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:chat",
        status: "active",
        deliveryMode: "native",
        lastProjectedRevision: 0,
        createdAt: 1,
        updatedAt,
      })
      await getDb().executionRunBindings.bulkPut([row("b-old", 5), row("b-new", 15)] as never[])
      const delta = await readDexieDelta("executionRunBindings", 5)
      expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["b-new"])
      expect(delta.next_since).toBe(15)
    })
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
