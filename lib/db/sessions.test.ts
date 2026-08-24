// Coverage for session creation, focused on the default-preset auto-apply
// path added in v12 of the preset feature uplift. The non-preset behaviour
// of `createSession` was tested implicitly through the broader app; we
// exercise it directly here so the auto-apply branch can't regress.

import Dexie from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  createSession,
  getSession,
  updateSession,
  setSessionActiveBranchSelection,
  listSessions,
  listAgentThreadSessions,
  listScopedSessions,
  deleteSession,
  listSessionBranches,
  countBranchesAtMessage,
  bulkDeleteSessions,
  clearBranchSeed,
  acknowledgeImportDivergence,
  freezeImportedSession,
  archiveSession,
  unarchiveSession,
  bulkArchiveSessions,
  bulkUnarchiveSessions,
  bulkSetSessionsPinned,
  setSessionOrder,
  forkSessionFromParent,
} from "./sessions"
import { saveSettings } from "./settings"
import { createPreset, setDefaultPreset } from "./prompt-presets"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { createLoop, getLoop, listLoopsBySession } from "./loops"
import { createGoal, listGoalsBySession } from "./goals"
import {
  createSessionPeerMessage,
  listSessionInbox,
  listSessionOutbox,
} from "./session-peer-messages"
import { loggers } from "@cognia/logging"

// The /loop cascade tears down backing scheduler tasks via a dynamic
// import — mock the scheduler singleton so no real timing engine spins up.
const schedulerMock = { deleteTask: jest.fn().mockResolvedValue(true) }
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

// `purgeSessionStoreBuckets` reaches the artifact store through a dynamic
// import too. Mocked so the purge is observable without standing up the real
// persisted store — the store's own behaviour is covered by
// `stores/artifact/artifact-store.test.ts`; what matters here is that the
// cascade calls it at all, which is what was missing.
const clearSessionDataMock = jest.fn()
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => ({ clearSessionData: clearSessionDataMock }) },
}))

const markSessionRemovedMock = jest.fn()
jest.mock("@/lib/chat/search/indexer", () => ({
  markSessionRemoved: (sessionId: string) => markSessionRemovedMock(sessionId),
}))

const releaseSandboxSessionMock = jest.fn(async (_id: string) => undefined)
jest.mock("@/lib/sandbox/session-runtime", () => ({
  sandboxSessionRuntime: { releaseSession: (id: string) => releaseSandboxSessionMock(id) },
}))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  markSessionRemovedMock.mockClear()
  releaseSandboxSessionMock.mockReset().mockResolvedValue(undefined)
  await getDb().promptPresets.clear()
  // Cold open builds the full Dexie schema (now v99); can exceed the default 5s
  // hook budget under fake-indexeddb on the first test.
})
afterAll(dbFixture.dispose)

/** Poll until `pred` is true (liveQuery emissions land on microtask timing). */
async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("createSession — without default preset", () => {
  it("creates a row with caller-supplied fields", async () => {
    const session = await createSession({
      title: "Test",
      model: "claude-y",
      sdkSessionId: "sdk-native",
    })
    expect(session.id).toMatch(/^s_/)
    expect(session.title).toBe("Test")
    expect(session.model).toBe("claude-y")
    expect(session.sdkSessionId).toBe("sdk-native")
    expect(session.systemPrompt).toBeUndefined()
  })

  it("rejects working-set writes that bypass the CAS mutation service", async () => {
    await expect(
      createSession({
        title: "Unsafe",
        workingSet: { contractVersion: 1, revision: 0, entries: [], updatedAt: 0 },
      } as never)
    ).rejects.toThrow("mutateSessionWorkingSet")

    const session = await createSession({ title: "Safe" })
    await expect(
      updateSession(session.id, {
        workingSet: { contractVersion: 1, revision: 0, entries: [], updatedAt: 0 },
      } as never)
    ).rejects.toThrow("mutateSessionWorkingSet")
  })

  it("persists the recorder's controlled-trial skill alongside the session-disable list", async () => {
    // ADR-0106. `trialSkillId` is what makes the send path load a skill that is
    // still `disabled`; dropping it here would silently turn the trial back
    // into an empty chat, which is exactly the bug it was added to fix.
    const session = await createSession({
      title: "Skill trial",
      trialSkillId: "rec-1",
      disabledSkillIds: ["other-a"],
    })
    expect(session.trialSkillId).toBe("rec-1")
    await expect(getSession(session.id)).resolves.toMatchObject({
      trialSkillId: "rec-1",
      disabledSkillIds: ["other-a"],
    })
  })

  it("leaves trialSkillId unset on an ordinary session", async () => {
    const session = await createSession({ title: "Test" })
    expect(session.trialSkillId).toBeUndefined()
  })

  it("persists an Integration Inbox binding independently from platformBinding", async () => {
    const integrationBinding = {
      pluginId: "github-delivery",
      integrationId: "github",
      accountId: "acct-1",
      projectionId: "pull-request",
      threadKey: "owner/repo#42",
    }
    const session = await createSession({ title: "PR #42", integrationBinding })

    expect(session.integrationBinding).toEqual(integrationBinding)
    expect(session.platformBinding).toBeUndefined()
    await expect(getSession(session.id)).resolves.toMatchObject({ integrationBinding })
  })

  it("round-trips the durable execution context used by chat and scheduler runs", async () => {
    const executionContext = {
      location: "managedWorktree" as const,
      projectId: "project-1",
      projectRoot: "/repo",
      environmentId: "env-1",
      taskWorkspace: {
        taskId: "task-workspace:session-1",
        workspaceKey: "session-1",
      },
      baseRef: "main",
    }
    const session = await createSession({ title: "Managed", executionContext })

    expect(session.executionContext).toEqual(executionContext)
    await expect(getSession(session.id)).resolves.toMatchObject({ executionContext })
  })
})

describe("createSession — default thinking level", () => {
  it("leaves a new session without a tier when no default is configured", async () => {
    const session = await createSession({ title: "t" })
    expect(session.thinkingLevel).toBeUndefined()
    expect(session.effort).toBeUndefined()
  })

  it("stamps the configured tier onto a new session", async () => {
    // Stamped, not consulted at send time: the composer's control reads the
    // session row, so a fallback the row never carries would display as "Auto"
    // while turns quietly ran deeper.
    await saveSettings({ defaultThinkingLevel: "high" })
    const session = await createSession({ title: "t" })
    expect(session.thinkingLevel).toBe("high")
    expect(session.effort).toBe("high")
    expect((await getSession(session.id))?.thinkingLevel).toBe("high")
  })

  it("stamps ultracode as its own tier over xhigh effort", async () => {
    // The composite tier's second half (the dynamic-workflow tools) keys on
    // `thinkingLevel`, so a default of `ultracode` has to survive as itself.
    await saveSettings({ defaultThinkingLevel: "ultracode" })
    const session = await createSession({ title: "t" })
    expect(session.thinkingLevel).toBe("ultracode")
    expect(session.effort).toBe("xhigh")
  })

  it("records an explicit 'off' default rather than dropping it", async () => {
    await saveSettings({ defaultThinkingLevel: "off" })
    const session = await createSession({ title: "t" })
    expect(session.thinkingLevel).toBe("off")
    expect(session.effort).toBeUndefined()
  })

  it("lets an explicit tier on the call win over the default", async () => {
    // Branch / fork / import carry their source conversation's depth.
    await saveSettings({ defaultThinkingLevel: "max" })
    const session = await createSession({ title: "t", thinkingLevel: "low", effort: "low" })
    expect(session.thinkingLevel).toBe("low")
    expect(session.effort).toBe("low")
  })
})

describe("forkSessionFromParent", () => {
  it("inherits the parent's message display override", async () => {
    const parent = await createSession({
      title: "Parent",
      sdkSessionId: "sdk-parent",
      messageDisplayOverride: { preset: "focused", overrides: { actions: "hover" } },
    })

    const child = await forkSessionFromParent(parent.id)

    expect(child.messageDisplayOverride).toEqual({
      preset: "focused",
      overrides: { actions: "hover" },
    })
  })

  it("round-trips and resets a session override to inheritance", async () => {
    const session = await createSession({
      title: "Presentation",
      messageDisplayOverride: { preset: "inspector" },
    })
    await expect(getSession(session.id)).resolves.toMatchObject({
      messageDisplayOverride: { preset: "inspector" },
    })

    await updateSession(session.id, { messageDisplayOverride: undefined })

    expect((await getSession(session.id))?.messageDisplayOverride).toBeUndefined()
  })
})

describe("setSessionOrder", () => {
  it("writes each id's index into manualOrder without bumping updatedAt", async () => {
    const a = await createSession({ title: "A" })
    const b = await createSession({ title: "B" })
    const c = await createSession({ title: "C" })
    const beforeA = (await getSession(a.id))!.updatedAt
    await setSessionOrder([c.id, a.id, b.id], "date:today")
    expect((await getSession(c.id))?.manualOrder).toBe(0)
    expect((await getSession(a.id))?.manualOrder).toBe(1)
    expect((await getSession(b.id))?.manualOrder).toBe(2)
    // The order is tagged with the section it was dragged in, so it doesn't
    // leak into other sections the session later migrates to.
    expect((await getSession(c.id))?.manualOrderSection).toBe("date:today")
    // Ordering is organizational — recency is intentionally left untouched.
    expect((await getSession(a.id))?.updatedAt).toBe(beforeA)
  })

  it("is a no-op for an empty id list", async () => {
    await expect(setSessionOrder([], "pinned")).resolves.toBeUndefined()
  })

  // Regression: the sidebar's liveQuery must re-emit after a reorder. It broke
  // when `listScopedSessions` awaited `resolveScopeProjectId` before the Dexie
  // read even for an explicit pid — the await hops through a native promise,
  // Dexie's dependency-tracking zone is lost, and the (non-indexed)
  // `manualOrder` write never re-emits → drag-reorder visually snaps back.
  it("re-emits an explicit-pid liveQuery after a reorder", async () => {
    const a = await createSession({ title: "A" })
    const b = await createSession({ title: "B" })
    const c = await createSession({ title: "C" })
    const pid = (await getSession(a.id))!.projectId!

    const emissions: Array<Map<string, number | undefined>> = []
    // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
    // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
    // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
    const sub = Dexie.liveQuery(() => listScopedSessions(pid)).subscribe({
      next: (rows) => emissions.push(new Map(rows.map((r) => [r.id, r.manualOrder]))),
    })
    await waitUntil(() => emissions.length >= 1)
    await setSessionOrder([c.id, a.id, b.id], "date:today")
    await waitUntil(() => emissions.length >= 2)
    sub.unsubscribe()

    const last = emissions[emissions.length - 1]
    expect(last.get(c.id)).toBe(0)
    expect(last.get(a.id)).toBe(1)
    expect(last.get(b.id)).toBe(2)
  })
})

describe("createSession — default preset auto-apply", () => {
  it("copies preset payload onto an empty new session", async () => {
    const preset = await createPreset({
      name: "Default One",
      content: "You are a helpful default.",
      model: "claude-haiku-4-5",
      workingDir: "/auto/path",
    })
    await setDefaultPreset(preset.id)
    const session = await createSession()
    expect(session.systemPrompt).toBe("You are a helpful default.")
    expect(session.model).toBe("claude-haiku-4-5")
    expect(session.workingDir).toBe("/auto/path")
    // usage was recorded
    const fresh = await getDb().promptPresets.get(preset.id)
    expect(fresh?.usageCount).toBe(1)
    expect(typeof fresh?.lastUsedAt).toBe("number")
  })

  it("clearBranchSeed removes only the branchSeed field", async () => {
    const now = Date.now()
    await getDb().sessions.put({
      id: "b1",
      title: "Branch",
      parentSessionId: "p1",
      branchSeed: { kind: "summary", content: "ctx" },
      createdAt: now,
      updatedAt: now,
    })
    await clearBranchSeed("b1")
    const fresh = await getSession("b1")
    expect(fresh?.branchSeed).toBeUndefined()
    // Sibling lineage fields untouched.
    expect(fresh?.parentSessionId).toBe("p1")
  })

  it("freezeImportedSession sets importFrozen (idempotent)", async () => {
    const now = Date.now()
    await getDb().sessions.put({
      id: "import:codex:x1",
      title: "Imported",
      createdAt: now,
      updatedAt: now,
    })
    await freezeImportedSession("import:codex:x1")
    expect((await getSession("import:codex:x1"))?.importFrozen).toBe(true)
    // Re-freezing stays true (no throw, no flip).
    await freezeImportedSession("import:codex:x1")
    expect((await getSession("import:codex:x1"))?.importFrozen).toBe(true)
  })

  it("acknowledgeImportDivergence clears the flag but keeps the observed digest", async () => {
    const now = Date.now()
    await getDb().sessions.put({
      id: "import:codex:x2",
      title: "Imported",
      createdAt: now,
      updatedAt: now,
      importFrozen: true,
      importDiverged: true,
      importDivergedAt: now,
      importSourceDigest: "3:m2:1002",
    })
    await acknowledgeImportDivergence("import:codex:x2")
    const row = await getSession("import:codex:x2")
    expect(row?.importDiverged).toBeUndefined()
    expect(row?.importDivergedAt).toBeUndefined()
    // Kept on purpose: it is what stops the SAME divergence re-raising the badge
    // on the next watch event, while a LATER change still does.
    expect(row?.importSourceDigest).toBe("3:m2:1002")
    expect(row?.importFrozen).toBe(true)

    // Idempotent.
    await acknowledgeImportDivergence("import:codex:x2")
    expect((await getSession("import:codex:x2"))?.importDiverged).toBeUndefined()
  })

  it("does NOT auto-apply when a character is supplied", async () => {
    const preset = await createPreset({
      name: "Default One",
      content: "from preset",
    })
    await setDefaultPreset(preset.id)
    const session = await createSession({ characterId: "char_xx" })
    expect(session.systemPrompt).toBeUndefined()
    const fresh = await getDb().promptPresets.get(preset.id)
    expect(fresh?.usageCount).toBe(0)
  })

  it("does NOT auto-apply when caller already supplied any override", async () => {
    const preset = await createPreset({
      name: "Default One",
      content: "from preset",
      model: "claude-y",
    })
    await setDefaultPreset(preset.id)
    const session = await createSession({ workingDir: "/explicit" })
    expect(session.systemPrompt).toBeUndefined()
    expect(session.model).toBeUndefined()
    expect(session.workingDir).toBe("/explicit")
  })

  it("does NOT throw when no default preset exists", async () => {
    await createPreset({ name: "Plain", content: "x" })
    const session = await createSession()
    expect(session.systemPrompt).toBeUndefined()
  })
})

describe("updateSession + listSessions", () => {
  it("persists branch selection and increments the transcript revision", async () => {
    const session = await createSession({ title: "Branches" })

    await setSessionActiveBranchSelection(session.id, "group-1", "message-2")

    expect(await getSession(session.id)).toMatchObject({
      activeBranchByGroup: { "group-1": "message-2" },
      transcriptRevision: 1,
    })
    await setSessionActiveBranchSelection(session.id, "group-1", "message-2")
    expect((await getSession(session.id))?.transcriptRevision).toBe(1)
  })

  it("round-trips a patch", async () => {
    const session = await createSession({ title: "Test" })
    await updateSession(session.id, { title: "Renamed" })
    const fetched = await getSession(session.id)
    expect(fetched?.title).toBe("Renamed")
  })

  it("listSessions sorts newest-first by updatedAt", async () => {
    const a = await createSession({ title: "A" })
    await new Promise((r) => setTimeout(r, 5))
    const b = await createSession({ title: "B" })
    const list = await listSessions()
    expect(list[0].id).toBe(b.id)
    expect(list[1].id).toBe(a.id)
  })

  it("round-trips the pinned flag for batch pin/unpin", async () => {
    const session = await createSession({ title: "Pinnable" })
    await updateSession(session.id, { pinned: true })
    expect((await getSession(session.id))?.pinned).toBe(true)
    await updateSession(session.id, { pinned: false })
    expect((await getSession(session.id))?.pinned).toBe(false)
  })

  it("pins a batch atomically while preserving each session's activity time", async () => {
    await getDb().sessions.bulkPut([
      {
        id: "pin-a",
        title: "A",
        createdAt: 10,
        updatedAt: 100,
        lastMessageAt: 80,
      },
      { id: "pin-b", title: "B", createdAt: 20, updatedAt: 90 },
      { id: "pin-c", title: "C", createdAt: 30, updatedAt: 70, pinned: false },
    ] as ChatSession[])

    await bulkSetSessionsPinned(["pin-a", "pin-b"], true)

    const [a, b, c] = await Promise.all([
      getSession("pin-a"),
      getSession("pin-b"),
      getSession("pin-c"),
    ])
    expect(a).toMatchObject({ pinned: true, lastMessageAt: 80 })
    expect(b).toMatchObject({ pinned: true, lastMessageAt: 90 })
    expect(a!.updatedAt).toBeGreaterThan(100)
    expect(b!.updatedAt).toBe(a!.updatedAt)
    expect(c).toMatchObject({ pinned: false, updatedAt: 70 })
  })

  it("does not touch the database for an empty pin batch", async () => {
    await expect(bulkSetSessionsPinned([], true)).resolves.toBeUndefined()
  })
})

describe("bulkDeleteSessions", () => {
  it("removes every session in the list and leaves the rest untouched", async () => {
    const a = await createSession({ title: "A" })
    const b = await createSession({ title: "B" })
    const c = await createSession({ title: "C" })

    await bulkDeleteSessions([a.id, c.id])

    expect(await getSession(a.id)).toBeUndefined()
    expect(await getSession(c.id)).toBeUndefined()
    expect(await getSession(b.id)).toBeDefined()
  })

  it("silently skips ids that are already gone", async () => {
    const a = await createSession({ title: "A" })
    await deleteSession(a.id)
    await expect(bulkDeleteSessions([a.id, "s_missing"])).resolves.toBeUndefined()
  })

  it("does not cascade from a missing root into a dangling attached child", async () => {
    const child = await createSession({ title: "dangling attached child" })
    await updateSession(child.id, {
      parentSessionId: "s_missing",
      attachedChild: {
        parentSessionId: "s_missing",
        lifecycleOwnerSessionId: "s_missing",
        status: "running",
        context: { mode: "none" },
        workspace: "shared",
        createdAt: 1,
      },
    })

    await bulkDeleteSessions(["s_missing"])

    expect(await getSession(child.id)).toBeDefined()
  })

  it("is a no-op on an empty array (does not open a transaction)", async () => {
    const a = await createSession({ title: "A" })
    await bulkDeleteSessions([])
    expect(await getSession(a.id)).toBeDefined()
  })

  it("cascades attached descendants and their peer-message and goal state", async () => {
    const parent = await createSession({ title: "parent" })
    const child = await createSession({ title: "attached child" })
    const grandchild = await createSession({ title: "attached grandchild" })
    const branch = await createSession({ title: "ordinary branch" })
    await updateSession(child.id, {
      parentSessionId: parent.id,
      attachedChild: {
        parentSessionId: parent.id,
        lifecycleOwnerSessionId: parent.id,
        status: "running",
        context: { mode: "none" },
        workspace: "shared",
        createdAt: 1,
      },
    })
    await updateSession(grandchild.id, {
      parentSessionId: child.id,
      attachedChild: {
        parentSessionId: child.id,
        lifecycleOwnerSessionId: child.id,
        status: "running",
        context: { mode: "none" },
        workspace: "shared",
        createdAt: 2,
      },
    })
    await updateSession(branch.id, { parentSessionId: parent.id })
    await createGoal({
      id: "goal-attached",
      sessionId: child.id,
      rawObjective: "finish child work",
      safeObjective: "finish child work",
      redactionMapEnc: "",
      status: "stopped",
      turnsUsed: 0,
      tokensUsed: 0,
      judgeFailureCount: 0,
      config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
      generationId: "gen-attached",
    })
    await createSessionPeerMessage({
      senderSessionId: parent.id,
      receiverSessionId: child.id,
      content: "parent to child",
      intent: "note",
      origin: "user",
    })

    await bulkDeleteSessions([parent.id])

    expect(await getSession(parent.id)).toBeUndefined()
    expect(await getSession(child.id)).toBeUndefined()
    expect(await getSession(grandchild.id)).toBeUndefined()
    expect((await getSession(branch.id))?.parentSessionId).toBeUndefined()
    expect(await listGoalsBySession(child.id)).toEqual([])
    expect(await listSessionOutbox(parent.id)).toEqual([])
    expect(await listSessionInbox(child.id)).toEqual([])
  })
})

describe("deletion tombstones (companion sync v61)", () => {
  it("records session + cascaded message tombstones on deleteSession", async () => {
    const s = await createSession({ title: "X" })
    const db = getDb()
    await db.messages.bulkPut([
      { id: "m1", sessionId: s.id, role: "user", parts: [], createdAt: 1 } as never,
      { id: "m2", sessionId: s.id, role: "user", parts: [], createdAt: 2 } as never,
    ])
    await deleteSession(s.id)

    const sessionTombs = await db.syncTombstones.where("table").equals("sessions").toArray()
    expect(sessionTombs.map((t) => t.id)).toEqual([s.id])
    const messageTombs = await db.syncTombstones.where("table").equals("messages").toArray()
    expect(messageTombs.map((t) => t.id).sort()).toEqual(["m1", "m2"])
    expect(markSessionRemovedMock).toHaveBeenCalledTimes(1)
    expect(markSessionRemovedMock).toHaveBeenCalledWith(s.id)
  })

  it("records session tombstones on bulkDeleteSessions", async () => {
    const a = await createSession({ title: "A" })
    const b = await createSession({ title: "B" })
    await bulkDeleteSessions([a.id, b.id])
    const ids = (await getDb().syncTombstones.where("table").equals("sessions").toArray())
      .map((t) => t.id)
      .sort()
    expect(ids).toEqual([a.id, b.id].sort())
    expect(markSessionRemovedMock.mock.calls.map(([id]) => id).sort()).toEqual([a.id, b.id].sort())
    expect(releaseSandboxSessionMock.mock.calls.map(([id]) => id).sort()).toEqual(
      [a.id, b.id].sort()
    )
  })

  it("retries a transient sandbox provider release failure", async () => {
    const session = await createSession({ title: "Release failure" })
    releaseSandboxSessionMock.mockRejectedValueOnce(new Error("provider close failed"))

    await expect(bulkDeleteSessions([session.id])).resolves.toBeUndefined()

    expect(await getSession(session.id)).toBeUndefined()
    expect(markSessionRemovedMock).toHaveBeenCalledWith(session.id)
    expect(releaseSandboxSessionMock).toHaveBeenCalledTimes(2)
  })

  it("reports the delete as done even when the provider release keeps failing", async () => {
    const session = await createSession({ title: "Persistent release failure" })
    releaseSandboxSessionMock.mockRejectedValue(new Error("provider close failed"))

    // The transaction already committed, so the delete succeeded. Rejecting
    // would tell the caller a completed deletion failed.
    await expect(bulkDeleteSessions([session.id])).resolves.toBeUndefined()

    expect(await getSession(session.id)).toBeUndefined()
    expect(markSessionRemovedMock).toHaveBeenCalledWith(session.id)
    expect(releaseSandboxSessionMock).toHaveBeenCalledTimes(2)
  })
})

describe("deleteSession — /loop + goal cascade (v79)", () => {
  const LOOP_CONFIG = {
    maxIterations: 100,
    maxTokens: 1_000_000,
    minDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxParseFailures: 3,
  }

  it("drops the session's loops and tears down interval scheduler tasks", async () => {
    schedulerMock.deleteTask.mockClear()
    const s = await createSession({ title: "looped" })
    await createLoop({
      id: "lp_int",
      sessionId: s.id,
      mode: "interval",
      rawPrompt: "p",
      safePrompt: "p",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "active",
      iterations: 0,
      tokensUsed: 0,
      generationId: "g",
      config: LOOP_CONFIG,
      parseFailureCount: 0,
      scheduledTaskId: "task_9",
    })
    await createLoop({
      id: "lp_sp",
      sessionId: s.id,
      mode: "self_paced",
      rawPrompt: "q",
      safePrompt: "q",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "stopped",
      iterations: 2,
      tokensUsed: 0,
      generationId: "g2",
      config: LOOP_CONFIG,
      parseFailureCount: 0,
    })
    await deleteSession(s.id)
    expect(await getLoop("lp_int")).toBeUndefined()
    expect(await getLoop("lp_sp")).toBeUndefined()
    expect(schedulerMock.deleteTask).toHaveBeenCalledWith("task_9")
    expect(schedulerMock.deleteTask).toHaveBeenCalledTimes(1)
  })

  it("cascades goals on deleteSession (previously orphaned)", async () => {
    const s = await createSession({ title: "goaled" })
    await createGoal({
      id: "g_1",
      sessionId: s.id,
      rawObjective: "o",
      safeObjective: "o",
      redactionMapEnc: "",
      status: "stopped",
      turnsUsed: 1,
      tokensUsed: 0,
      judgeFailureCount: 0,
      config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
      generationId: "gen",
    })
    await deleteSession(s.id)
    expect(await listGoalsBySession(s.id)).toHaveLength(0)
  })

  it("bulkDeleteSessions runs the same cascade per id", async () => {
    schedulerMock.deleteTask.mockClear()
    const a = await createSession({ title: "a" })
    const b = await createSession({ title: "b" })
    await createLoop({
      id: "lp_a",
      sessionId: a.id,
      mode: "interval",
      rawPrompt: "p",
      safePrompt: "p",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "active",
      iterations: 0,
      tokensUsed: 0,
      generationId: "g",
      config: LOOP_CONFIG,
      parseFailureCount: 0,
      scheduledTaskId: "task_a",
    })
    await bulkDeleteSessions([a.id, b.id])
    expect(await listLoopsBySession(a.id)).toHaveLength(0)
    expect(schedulerMock.deleteTask).toHaveBeenCalledWith("task_a")
  })
})

describe("deleteSession — artifact store purge", () => {
  beforeEach(() => {
    clearSessionDataMock.mockReset()
  })

  it("drops the deleted session's artifacts from the persisted store", async () => {
    const s = await createSession({ title: "with artifacts" })
    await deleteSession(s.id)
    expect(clearSessionDataMock).toHaveBeenCalledWith(s.id)
  })

  it("purges every id on bulkDeleteSessions", async () => {
    const a = await createSession({ title: "a" })
    const b = await createSession({ title: "b" })
    await bulkDeleteSessions([a.id, b.id])
    expect(clearSessionDataMock.mock.calls.map(([id]) => id).sort()).toEqual([a.id, b.id].sort())
  })

  // Artifacts are convenience state, not the record of truth: a store that is
  // absent (SSR), stale, or throwing must never strand the session row itself.
  it("still deletes the session when the store throws", async () => {
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    clearSessionDataMock.mockImplementationOnce(() => {
      throw new Error("store unavailable")
    })
    const s = await createSession({ title: "doomed" })
    await expect(deleteSession(s.id)).resolves.toBeUndefined()
    expect(await getSession(s.id)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith("session artifact cleanup failed", {
      sessionId: s.id,
      error: "Error: store unavailable",
    })
    warn.mockRestore()
  })
})

describe("workspace (project) scoping", () => {
  it("createSession stamps the active project id", async () => {
    await saveSettings({ activeProjectId: "proj-active" })
    const s = await createSession({ title: "scoped" })
    expect(s.projectId).toBe("proj-active")
    expect((await getSession(s.id))?.projectId).toBe("proj-active")
  })

  it("createSession honours an explicit projectId override", async () => {
    await saveSettings({ activeProjectId: "proj-active" })
    const s = await createSession({ title: "explicit", projectId: "proj-other" })
    expect(s.projectId).toBe("proj-other")
  })

  it("listScopedSessions returns only the workspace's sessions, newest-first", async () => {
    await saveSettings({ activeProjectId: "proj-A" })
    const a1 = await createSession({ title: "a1" })
    await new Promise((r) => setTimeout(r, 2))
    const a2 = await createSession({ title: "a2" })
    const b1 = await createSession({ title: "b1", projectId: "proj-B" })

    const scopedA = await listScopedSessions("proj-A")
    expect(scopedA.map((s) => s.id)).toEqual([a2.id, a1.id])
    expect(scopedA.some((s) => s.id === b1.id)).toBe(false)

    // Defaulting to the active project yields the same result.
    expect((await listScopedSessions()).map((s) => s.id)).toEqual([a2.id, a1.id])
    // The unscoped escape hatch still sees every workspace.
    expect((await listSessions()).map((s) => s.id).sort()).toEqual([a1.id, a2.id, b1.id].sort())
  })
})

describe("archive / unarchive", () => {
  it("archiveSession stamps archivedAt without touching updatedAt", async () => {
    const s = await createSession({ title: "to archive" })
    const before = (await getSession(s.id))!.updatedAt
    await archiveSession(s.id)
    const after = await getSession(s.id)
    expect(typeof after?.archivedAt).toBe("number")
    expect(after?.updatedAt).toBe(before)
  })

  it("recursively closes attached descendants when their parent is archived", async () => {
    const parent = await createSession({ title: "parent" })
    const child = await createSession({
      title: "attached child",
    })
    await updateSession(child.id, {
      parentSessionId: parent.id,
      attachedChild: {
        parentSessionId: parent.id,
        lifecycleOwnerSessionId: parent.id,
        status: "running",
        context: { mode: "none" },
        workspace: "shared",
        createdAt: 1,
      },
    })
    const grandchild = await createSession({ title: "attached grandchild" })
    await updateSession(grandchild.id, {
      parentSessionId: child.id,
      attachedChild: {
        parentSessionId: child.id,
        lifecycleOwnerSessionId: child.id,
        status: "running",
        context: { mode: "none" },
        workspace: "shared",
        createdAt: 2,
      },
    })

    const childBefore = (await getSession(child.id))!.updatedAt
    const grandchildBefore = (await getSession(grandchild.id))!.updatedAt
    await new Promise((resolve) => setTimeout(resolve, 2))
    await archiveSession(parent.id)

    expect((await getSession(child.id))?.attachedChild?.status).toBe("closed")
    expect((await getSession(grandchild.id))?.attachedChild?.status).toBe("closed")
    expect((await getSession(child.id))!.updatedAt).toBeGreaterThan(childBefore)
    expect((await getSession(grandchild.id))!.updatedAt).toBeGreaterThan(grandchildBefore)
  })

  it("unarchiveSession deletes the archivedAt field outright", async () => {
    const s = await createSession({ title: "round trip" })
    await archiveSession(s.id)
    expect((await getSession(s.id))?.archivedAt).toEqual(expect.any(Number))
    await unarchiveSession(s.id)
    const after = await getSession(s.id)
    expect(after).toBeDefined()
    expect("archivedAt" in (after as object)).toBe(false)
  })

  it("bulkArchiveSessions archives every id in one pass and no-ops on empty", async () => {
    const a = await createSession({ title: "a" })
    const b = await createSession({ title: "b" })
    await bulkArchiveSessions([])
    expect((await getSession(a.id))?.archivedAt).toBeUndefined()
    await bulkArchiveSessions([a.id, b.id, "missing-id"])
    expect((await getSession(a.id))?.archivedAt).toEqual(expect.any(Number))
    expect((await getSession(b.id))?.archivedAt).toEqual(expect.any(Number))
  })

  it("bulkArchiveSessions recursively closes attached descendants", async () => {
    const parent = await createSession({ title: "parent" })
    const child = await createSession({ title: "child" })
    await updateSession(child.id, {
      parentSessionId: parent.id,
      attachedChild: {
        parentSessionId: parent.id,
        lifecycleOwnerSessionId: parent.id,
        status: "running",
        context: { mode: "none" },
        workspace: "shared",
        createdAt: 1,
      },
    })

    await bulkArchiveSessions([parent.id])

    expect((await getSession(child.id))?.attachedChild?.status).toBe("closed")
  })

  it("does not close a dangling attached child when the requested root is missing", async () => {
    const child = await createSession({ title: "dangling child" })
    await updateSession(child.id, {
      parentSessionId: "missing-parent",
      attachedChild: {
        parentSessionId: "missing-parent",
        lifecycleOwnerSessionId: "missing-parent",
        status: "running",
        context: { mode: "none" },
        workspace: "shared",
        createdAt: 1,
      },
    })

    await bulkArchiveSessions(["missing-parent"])

    expect((await getSession(child.id))?.attachedChild?.status).toBe("running")
  })

  it("bulkUnarchiveSessions deletes archivedAt for every id in one pass and no-ops on empty", async () => {
    const a = await createSession({ title: "a" })
    const b = await createSession({ title: "b" })
    await bulkArchiveSessions([a.id, b.id])
    await bulkUnarchiveSessions([])
    expect((await getSession(a.id))?.archivedAt).toEqual(expect.any(Number))
    await bulkUnarchiveSessions([a.id, b.id, "missing-id"])
    const afterA = await getSession(a.id)
    const afterB = await getSession(b.id)
    expect("archivedAt" in (afterA as object)).toBe(false)
    expect("archivedAt" in (afterB as object)).toBe(false)
  })
})

describe("listAgentThreadSessions", () => {
  const put = (row: Partial<ChatSession> & { id: string }) =>
    getDb().sessions.put({
      title: row.id,
      kind: "direct",
      projectId: "p1",
      createdAt: 1,
      updatedAt: 1,
      ...row,
    } as ChatSession)

  it("returns nothing when no subagent session exists", async () => {
    await put({ id: "plain" })
    await expect(listAgentThreadSessions()).resolves.toEqual([])
  })

  it("lists a parentless subagent on its own without a parent lookup", async () => {
    await put({ id: "plain" })
    await put({ id: "orphan", kind: "subagent" })
    await expect(listAgentThreadSessions()).resolves.toMatchObject([{ id: "orphan" }])
  })

  it("returns every subagent session plus each distinct parent, across projects", async () => {
    await put({ id: "parent-a", projectId: "p1" })
    await put({ id: "parent-b", projectId: "p2" })
    await put({ id: "unrelated" })
    await put({ id: "child-1", kind: "subagent", parentSessionId: "parent-a" })
    await put({ id: "child-2", kind: "subagent", parentSessionId: "parent-a" })
    await put({ id: "child-3", kind: "subagent", parentSessionId: "parent-b", projectId: "p2" })
    // Orphan: its parent was deleted. Still listed so the forest can root it.
    await put({ id: "child-4", kind: "subagent", parentSessionId: "gone" })
    // Nested: a subagent whose parent is itself a subagent — the parent is
    // already in the children set and must not be listed twice.
    await put({ id: "child-5", kind: "subagent", parentSessionId: "child-1" })

    const rows = await listAgentThreadSessions()
    const ids = rows.map((r) => r.id).sort()
    expect(ids).toEqual(
      ["child-1", "child-2", "child-3", "child-4", "child-5", "parent-a", "parent-b"].sort()
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("branch lineage (v81 index, reverse direction)", () => {
  const mkBranch = async (id: string, parentId: string, at?: string, createdAt = 1) => {
    await getDb().sessions.put({
      id,
      title: id,
      kind: "direct",
      projectId: "p1",
      parentSessionId: parentId,
      branchedFromMessageId: at,
      createdAt,
      updatedAt: createdAt,
    } as ChatSession)
  }

  it("lists a conversation's branches newest first", async () => {
    // The v81 `parentSessionId` index existed for exactly this and had no
    // query behind it: lineage was visible only from a child looking up.
    await getDb().sessions.put({
      id: "parent",
      title: "Parent",
      kind: "direct",
      projectId: "p1",
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession)
    await mkBranch("b1", "parent", "m1", 2)
    await mkBranch("b2", "parent", "m1", 3)
    await mkBranch("other", "somebody-else", "m1", 4)

    expect((await listSessionBranches("parent")).map((s) => s.id)).toEqual(["b2", "b1"])
  })

  it("counts only the branches cut at a given message", async () => {
    await mkBranch("b1", "parent", "m1", 2)
    await mkBranch("b2", "parent", "m2", 3)
    expect(await countBranchesAtMessage("parent", "m1")).toBe(1)
    expect(await countBranchesAtMessage("parent", "nope")).toBe(0)
  })
})

describe("deleteSession — branch survival", () => {
  const mkSession = async (id: string, parentSessionId?: string) => {
    await getDb().sessions.put({
      id,
      title: id,
      kind: "direct",
      projectId: "p1",
      parentSessionId,
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession)
  }

  it("keeps the branches and re-points them at their grandparent", async () => {
    // A branch is a standalone conversation — `direct` mode copies the messages
    // outright — so deleting the parent must neither take it down nor strand it
    // holding a pointer to a row that no longer exists.
    await mkSession("grandparent")
    await mkSession("parent", "grandparent")
    await mkSession("child-a", "parent")
    await mkSession("child-b", "parent")

    await deleteSession("parent")

    expect(await getDb().sessions.get("parent")).toBeUndefined()
    expect((await getDb().sessions.get("child-a"))?.parentSessionId).toBe("grandparent")
    expect((await getDb().sessions.get("child-b"))?.parentSessionId).toBe("grandparent")
  })

  it("clears the pointer entirely when the deleted session was top-level", async () => {
    // `undefined` deletes the field — a branch of a root conversation ends up
    // with no lineage, not a pointer to nothing.
    await mkSession("root")
    await mkSession("child", "root")

    await deleteSession("root")

    const child = await getDb().sessions.get("child")
    expect(child).toBeDefined()
    expect(child?.parentSessionId).toBeUndefined()
  })

  it("leaves unrelated sessions' lineage untouched", async () => {
    await mkSession("parent")
    await mkSession("elsewhere")
    await mkSession("theirs", "elsewhere")

    await deleteSession("parent")

    expect((await getDb().sessions.get("theirs"))?.parentSessionId).toBe("elsewhere")
  })

  it("cascades parent-owned attached children while preserving ordinary branches", async () => {
    await mkSession("parent")
    await mkSession("branch", "parent")
    await getDb().sessions.put({
      id: "attached",
      title: "attached",
      kind: "direct",
      projectId: "p1",
      parentSessionId: "parent",
      attachedChild: {
        parentSessionId: "parent",
        lifecycleOwnerSessionId: "parent",
        status: "running",
        context: { mode: "full" },
        workspace: "shared",
        createdAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession)

    await deleteSession("parent")

    expect(await getDb().sessions.get("attached")).toBeUndefined()
    expect(await getDb().sessions.get("branch")).toBeDefined()
    expect((await getDb().sessions.get("branch"))?.parentSessionId).toBeUndefined()
  })
})
