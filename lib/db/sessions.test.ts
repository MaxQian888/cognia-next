// Coverage for session creation, focused on the default-preset auto-apply
// path added in v12 of the preset feature uplift. The non-preset behaviour
// of `createSession` was tested implicitly through the broader app; we
// exercise it directly here so the auto-apply branch can't regress.

import Dexie from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  createSession,
  getSession,
  getSessionsByIds,
  updateSession,
  setSessionActiveBranchSelection,
  listSessions,
  countSessions,
  assignSessionToFolder,
  listAgentThreadSessions,
  listScopedSessions,
  listWorkspaceSessions,
  countWorkspaceMessages,
  deleteSession,
  listSessionBranches,
  countBranchesAtMessage,
  bulkDeleteSessions,
  clearBranchSeed,
  acknowledgeImportDivergence,
  bindImportedSessionToNativeRuntime,
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
import * as chatDrafts from "./chat-drafts"
import { commitTranscriptIndexPage } from "./chat-transcript-index"
import { putSessionAsset, getSessionAsset, listSessionAssets } from "./session-assets"

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
// Typed, not `(...a: unknown[])`: a zero-arg `jest.fn` makes the spread a
// TS2556 and leaves `mock.calls` a `[]` tuple with no element to read back.
const mockRevokeClaimsForSession = jest.fn(async (_sessionId: string) => 0)
jest.mock("@/lib/memory/lifecycle/claim-deletion-closure", () => ({
  revokeClaimsForDeletedSession: (sessionId: string) => mockRevokeClaimsForSession(sessionId),
}))
jest.mock("@/lib/chat/search/indexer", () => ({
  markSessionRemoved: (sessionId: string) => markSessionRemovedMock(sessionId),
}))

const releaseSandboxSessionMock = jest.fn(async (_id: string) => undefined)
jest.mock("@/lib/sandbox/session-runtime", () => ({
  sandboxSessionRuntime: { releaseSession: (id: string) => releaseSandboxSessionMock(id) },
}))

const dbFixture = createDbTestFixture()

const deleteExternalSessionMock = jest.fn(async (_agentId: string, _sessionId: string) => undefined)
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ deleteSession: deleteExternalSessionMock }),
}))

it("removes retained external gateway state before deleting a conversation", async () => {
  const link = { agentId: "pi", sessionId: "cognia-gateway:task-1:native-1" }
  const row = await createSession({ title: "Managed task", externalAgentSession: link })
  await deleteSession(row.id)
  expect(deleteExternalSessionMock).toHaveBeenCalledWith(link.agentId, link.sessionId)
  expect(await getSession(row.id)).toBeUndefined()
})

it("deletes fresh original assets and temporary sources with their owning session", async () => {
  const session = await createSession({ title: "Source owner" })
  const asset = {
    sessionId: session.id,
    assetId: "source",
    filename: "source.txt",
    mediaType: "text/plain",
    blob: new Blob(["fresh source"]),
  }
  await putSessionAsset(asset)
  await putSessionAsset({ ...asset, assetId: "temporary", temporary: true })
  await deleteSession(session.id)
  expect(await getSessionAsset(session.id, "source")).toBeUndefined()
  expect(await getSessionAsset(session.id, "temporary")).toBeUndefined()
  expect(await listSessionAssets(session.id)).toEqual([])
  expect(await getDb().messageMedia.count()).toBe(0)
})

it("keeps the conversation link when external task cleanup fails so deletion can retry", async () => {
  const link = { agentId: "pi", sessionId: "cognia-gateway:task-2:native-2" }
  const row = await createSession({ title: "Retry deletion", externalAgentSession: link })
  deleteExternalSessionMock.mockRejectedValueOnce(new Error("Task host unavailable"))
  await expect(bulkDeleteSessions([row.id])).rejects.toThrow("Task host unavailable")
  expect((await getSession(row.id))?.externalAgentSession).toEqual(link)
  await deleteSession(row.id)
  expect(await getSession(row.id)).toBeUndefined()
})

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

  it("writes through every seeded column, not a hand-maintained subset", async () => {
    // Regression. The signature said `Partial<ChatSession>` but the body
    // persisted a hand-listed subset, so any column nobody had remembered to
    // add to that list was silently discarded — every field below was one of
    // the dropped ones. This test is the guard that the list is gone, not that
    // it grew: adding a column to `ChatSession` must not require touching
    // `createSession` again.
    const seeded = {
      squadId: "squad-1",
      providerOverride: "openai",
      accountId: "acct-1",
      toolFilter: { mode: "allow" as const, tools: ["Read"] },
      outputStyle: "concise",
      customOutputStyle: "be terse",
      executionPolicy: { maxTurns: 7 },
      sandboxEnabled: true,
      maxThinkingTokens: 4096,
      folderId: "folder-1",
      memoryUse: false,
      memoryLearn: false,
    }

    const session = await createSession({ title: "Fully seeded", ...seeded })

    expect(session).toMatchObject(seeded)
    // Not just the returned object — the row Dexie actually holds.
    await expect(getSession(session.id)).resolves.toMatchObject(seeded)
  })

  it("reads a known set of sessions in one go, dropping ids that are gone", async () => {
    const a = await createSession({ title: "A", powerPolicy: "keepScreenOn" })
    const b = await createSession({ title: "B" })

    const rows = await getSessionsByIds([a.id, "s_missing", b.id])
    expect(rows.map((row) => row.id).sort()).toEqual([a.id, b.id].sort())
    expect(rows.find((row) => row.id === a.id)?.powerPolicy).toBe("keepScreenOn")
    // The session power coordinator calls this on every turn edge, including
    // the edge where nothing is running.
    await expect(getSessionsByIds([])).resolves.toEqual([])
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

describe("createSession — external-agent default model", () => {
  const AGENT_MARKER = "cognia:external-agent:pi-local"

  it("inherits a model picked from an agent's own list before this chat existed", async () => {
    // The composer offers an external agent's catalog on a brand-new chat,
    // where the picker has no row to write to and records the choice as the
    // app default instead. Nothing carried it onto the row, and the external
    // send path reads the row, so the first turn ran on whatever model the
    // agent boots with while every surface said otherwise.
    await saveSettings({
      defaultModel: "commandcode/claude-opus-5",
      defaultProvider: AGENT_MARKER,
    })
    const session = await createSession({ title: "t" })
    expect(session.model).toBe("commandcode/claude-opus-5")
    expect(session.providerOverride).toBe(AGENT_MARKER)
    const stored = await getSession(session.id)
    expect(stored?.model).toBe("commandcode/claude-opus-5")
    expect(stored?.providerOverride).toBe(AGENT_MARKER)
  })

  it("leaves an ordinary provider default to keep following the app setting", async () => {
    // A different contract. Freezing every new row onto the app's provider
    // model would make changing the default stop reaching conversations that
    // never chose anything, which is not what this inheritance is for.
    await saveSettings({ defaultModel: "claude-sonnet-5", defaultProvider: "anthropic" })
    const session = await createSession({ title: "t" })
    expect(session.model).toBeUndefined()
    expect(session.providerOverride).toBeUndefined()
  })

  it("lets an explicit model on the call win, marker and all", async () => {
    await saveSettings({
      defaultModel: "commandcode/claude-opus-5",
      defaultProvider: AGENT_MARKER,
    })
    const session = await createSession({ title: "t", model: "a/one" })
    expect(session.model).toBe("a/one")
    expect(session.providerOverride).toBeUndefined()
  })

  it("never stamps the marker beside a model that came from a preset", async () => {
    // The pair is inherited together or not at all. A marker naming an agent
    // next to a preset's model would ask that agent for an id it never offered.
    const preset = await createPreset({ name: "p", content: "sys", model: "preset/model" })
    await setDefaultPreset(preset.id)
    await saveSettings({
      defaultModel: "commandcode/claude-opus-5",
      defaultProvider: AGENT_MARKER,
    })
    const session = await createSession({ title: "t" })
    expect(session.model).toBe("preset/model")
    expect(session.providerOverride).toBeUndefined()
  })
})

describe("forkSessionFromParent", () => {
  it("inherits the parent's message display override", async () => {
    const parent = await createSession({
      title: "Parent",
      sdkSessionId: "sdk-parent",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
      messageDisplayOverride: { preset: "focused", overrides: { actions: "hover" } },
    })

    const child = await forkSessionFromParent(parent.id)

    expect(child.messageDisplayOverride).toEqual({
      preset: "focused",
      overrides: { actions: "hover" },
    })
  })

  it("inherits the parent's full run configuration", async () => {
    // Regression. `createSession`'s whitelist dropped `providerOverride`, so
    // forking a conversation pinned to a non-default provider silently reverted
    // it to the app default — the fork then ran on a different model family
    // than the conversation it claimed to continue. The rest were lost the same
    // way. Field list mirrors `buildChildRow` in `lib/chat/branch-session.ts`.
    const parent = await createSession({
      title: "Parent",
      sdkSessionId: "sdk-parent",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
      providerOverride: "openai",
      accountId: "acct-7",
      squadId: "squad-9",
      activePresetId: "preset-3",
      outputStyle: "concise",
      customOutputStyle: "be terse",
      sandboxEnabled: true,
      sandboxTier: "microvm",
      maxThinkingTokens: 8192,
      toolFilter: { mode: "deny", tools: ["Bash"] },
      effort: "high",
    })

    const child = await forkSessionFromParent(parent.id)

    expect(child).toMatchObject({
      providerOverride: "openai",
      accountId: "acct-7",
      squadId: "squad-9",
      activePresetId: "preset-3",
      outputStyle: "concise",
      customOutputStyle: "be terse",
      sandboxEnabled: true,
      sandboxTier: "microvm",
      maxThinkingTokens: 8192,
      toolFilter: { mode: "deny", tools: ["Bash"] },
      effort: "high",
      forkedFromSdkSessionId: "sdk-parent",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
    })
  })

  it("carries the parent's sandbox tier so isolation cannot silently drop", async () => {
    // `forkSessionFromParent` already carried a comment saying branch/fork
    // carry their source's tier and that "Fork never did" — sitting above the
    // wrong line, with no column and no test under it. Asserted on the field
    // directly: `toMatchObject` above cannot see a column nobody listed.
    const parent = await createSession({
      title: "Parent",
      sdkSessionId: "sdk-parent",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
      sandboxEnabled: true,
      sandboxTier: "microvm",
    })

    const child = await forkSessionFromParent(parent.id)

    expect(child.sandboxTier).toBe("microvm")
  })

  it("files the fork in the parent's workspace, not the UI-active one", async () => {
    // `listScopedSessions` reads through `[projectId+updatedAt]`, so a fork
    // stamped with whichever workspace happens to be active shows up in the
    // wrong conversation list — the same rule `buildChildRow` spells out.
    const parent = await createSession({
      title: "Parent",
      projectId: "proj-elsewhere",
      sdkSessionId: "sdk-parent",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
    })

    const child = await forkSessionFromParent(parent.id)

    expect(child.projectId).toBe("proj-elsewhere")
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

  it("freezeImportedSession marks Cognia ownership (idempotent)", async () => {
    const now = Date.now()
    await getDb().sessions.put({
      id: "import:codex:x1",
      title: "Imported",
      createdAt: now,
      updatedAt: now,
    })
    await freezeImportedSession("import:codex:x1")
    expect(await getSession("import:codex:x1")).toMatchObject({
      importFrozen: true,
      importOwnership: "cognia-owned",
    })
    // Re-freezing stays true (no throw, no flip).
    await freezeImportedSession("import:codex:x1")
    expect((await getSession("import:codex:x1"))?.importFrozen).toBe(true)
  })

  it("bindImportedSessionToNativeRuntime records a resumable native-bound session", async () => {
    const now = Date.now()
    await getDb().sessions.put({
      id: "import:codex:native",
      title: "Imported",
      importFrozen: true,
      importOwnership: "cognia-owned",
      createdAt: now,
      updatedAt: now,
    })

    await bindImportedSessionToNativeRuntime("import:codex:native", {
      nativeSessionId: "thread-7",
      presetId: "codex-app-server",
      cwd: "/repo",
      resumeMethod: "protocol",
      verifiedAt: "2026-08-29T00:00:00.000Z",
    })

    expect(await getSession("import:codex:native")).toMatchObject({
      importFrozen: true,
      importOwnership: "native-bound",
      importRuntimeBinding: {
        nativeSessionId: "thread-7",
        presetId: "codex-app-server",
        cwd: "/repo",
        resumeMethod: "protocol",
      },
      sdkSessionId: "thread-7",
    })
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
  async function seedOwnedState(sessionId: string, hashes: string[]) {
    const db = getDb()
    await db.messages.put({
      id: `message-${sessionId}`,
      sessionId,
      role: "user",
      parts: hashes.map((hash) => ({ type: "image", ref: `cognia-media:${hash}` })),
      createdAt: 1,
    } as never)
    await db.messageMediaRefs.bulkPut(
      hashes.map((hash) => ({ messageId: `message-${sessionId}`, sessionId, hash }))
    )
    await db.sessionState.put({ sessionId, lastReadAt: 1, unreadCount: 2 })
    await db.chatDrafts.put({ sessionId, text: "unsent", updatedAt: 1 })
    await db.chatInputHistory.add({ sessionId, text: "sent", createdAt: 1 })
    await commitTranscriptIndexPage({
      sessionId,
      revision: 1,
      complete: true,
      items: [
        {
          kind: "completed-turn",
          itemKey: "turn",
          turnKey: "turn",
          revision: 1,
          detailRevision: 1,
          status: "completed",
          userMessages: [],
          collapsed: { exists: false, messageCount: 1, trailingCount: 0, mediaCount: 0 },
          startedAt: 1,
        },
      ],
    })
  }

  async function seedMedia(hash: string, createdAt = 1) {
    await getDb().messageMedia.put({
      hash,
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: new Blob(["image"]),
      byteSize: 5,
      createdAt,
      lastUsedAt: createdAt,
    })
  }

  it("deletes owned state and only unreferenced candidate media, preserving ordinary branches", async () => {
    const parent = await createSession({ title: "parent" })
    const child = await createSession({
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
    const branch = await createSession({ parentSessionId: parent.id })
    await assignSessionToFolder(branch.id, "surviving-folder")
    await seedOwnedState(parent.id, ["exclusive", "shared", "recent"])
    await seedOwnedState(child.id, ["child-only"])
    await seedOwnedState(branch.id, ["shared"])
    for (const hash of ["exclusive", "shared", "child-only", "unrelated-orphan"]) {
      await seedMedia(hash)
    }
    await seedMedia("recent", Date.now())
    expect(await countSessions()).toBe(3)

    await bulkDeleteSessions([parent.id, parent.id, "missing"])

    const db = getDb()
    expect(await countSessions()).toBe(1)
    expect((await getSession(branch.id))?.folderId).toBe("surviving-folder")
    for (const sessionId of [parent.id, child.id]) {
      expect(await db.messages.where("sessionId").equals(sessionId).count()).toBe(0)
      expect(await db.messageMediaRefs.where("sessionId").equals(sessionId).count()).toBe(0)
      expect(await db.sessionState.get(sessionId)).toBeUndefined()
      expect(await db.chatDrafts.get(sessionId)).toBeUndefined()
      expect(await db.chatInputHistory.where("sessionId").equals(sessionId).count()).toBe(0)
      expect(await db.chatTurnSummaries.where("sessionId").equals(sessionId).count()).toBe(0)
      expect(await db.chatTranscriptIndexState.get(sessionId)).toBeUndefined()
    }
    expect(await db.sessionState.get(branch.id)).toBeDefined()
    expect(await db.chatDrafts.get(branch.id)).toBeDefined()
    expect(await db.chatInputHistory.where("sessionId").equals(branch.id).count()).toBe(1)
    expect(await db.chatTurnSummaries.where("sessionId").equals(branch.id).count()).toBe(1)
    expect(await db.chatTranscriptIndexState.get(branch.id)).toBeDefined()
    expect(await db.messageMediaRefs.toArray()).toEqual([
      { messageId: `message-${branch.id}`, sessionId: branch.id, hash: "shared" },
    ])
    expect((await db.messageMedia.toArray()).map((row) => row.hash).sort()).toEqual([
      "recent",
      "shared",
      "unrelated-orphan",
    ])
    expect(
      (await db.syncTombstones.where("table").equals("sessionState").toArray())
        .map((row) => row.id)
        .sort()
    ).toEqual([parent.id, child.id].sort())
  })

  it("rolls back all owned state when the delete transaction fails", async () => {
    const session = await createSession()
    await seedOwnedState(session.id, ["rollback"])
    await seedMedia("rollback")
    const db = getDb()
    const failDelete = () => {
      throw new Error("session delete failed")
    }
    db.sessions.hook("deleting", failDelete)
    try {
      await expect(deleteSession(session.id)).rejects.toThrow("session delete failed")
    } finally {
      db.sessions.hook("deleting").unsubscribe(failDelete)
    }
    expect(await getSession(session.id)).toBeDefined()
    expect(await db.messages.where("sessionId").equals(session.id).count()).toBe(1)
    expect(await db.messageMediaRefs.where("sessionId").equals(session.id).count()).toBe(1)
    expect(await db.messageMedia.get("rollback")).toBeDefined()
    expect(await db.sessionState.get(session.id)).toBeDefined()
    expect(await db.chatDrafts.get(session.id)).toBeDefined()
    expect(await db.chatInputHistory.where("sessionId").equals(session.id).count()).toBe(1)
    expect(await db.chatTurnSummaries.where("sessionId").equals(session.id).count()).toBe(1)
    expect(await db.chatTranscriptIndexState.get(session.id)).toBeDefined()
    expect(await db.syncTombstones.count()).toBe(0)
    expect(markSessionRemovedMock).not.toHaveBeenCalled()
  })

  it("reports deletion as committed when candidate media cleanup fails", async () => {
    const session = await createSession()
    await seedOwnedState(session.id, ["cleanup-failure"])
    await seedMedia("cleanup-failure")
    const db = getDb()
    const failDelete = () => {
      throw new Error("media unavailable")
    }
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    db.messageMedia.hook("deleting", failDelete)
    try {
      await expect(deleteSession(session.id)).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith("session media cleanup failed", {
        sessionIds: [session.id],
        error: "Error: media unavailable",
      })
    } finally {
      db.messageMedia.hook("deleting").unsubscribe(failDelete)
      warn.mockRestore()
    }
    expect(await getSession(session.id)).toBeUndefined()
    expect(await db.messageMediaRefs.count()).toBe(0)
    expect(await db.messageMedia.get("cleanup-failure")).toBeDefined()
    expect(markSessionRemovedMock).toHaveBeenCalledWith(session.id)
  })

  it("cancels a pending draft save after deleting its session", async () => {
    const session = await createSession()
    const setTimer = jest.spyOn(globalThis, "setTimeout")
    chatDrafts.setDraftDebounced(session.id, "must not return", [], 1000)
    const timer = setTimer.mock.results.at(-1)?.value
    setTimer.mockRestore()
    const clearTimer = jest.spyOn(globalThis, "clearTimeout")
    try {
      await deleteSession(session.id)
      expect(clearTimer).toHaveBeenCalledWith(timer)
      expect(await getDb().chatDrafts.get(session.id)).toBeUndefined()
    } finally {
      clearTimer.mockRestore()
      await chatDrafts.clearDraft(session.id, { hostAlreadyCleared: true })
    }
  })

  it("keeps a committed deletion successful when draft timer cleanup fails", async () => {
    const session = await createSession()
    await seedOwnedState(session.id, [])
    const clearDraft = jest
      .spyOn(getDb().chatDrafts, "delete")
      .mockRejectedValueOnce(new Error("closed"))
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    try {
      await expect(deleteSession(session.id)).resolves.toBeUndefined()
      expect(await getSession(session.id)).toBeUndefined()
      expect(await getDb().chatDrafts.get(session.id)).toBeUndefined()
      expect(warn).toHaveBeenCalledWith("session draft cleanup failed", {
        sessionId: session.id,
        error: "Error: closed",
      })
    } finally {
      clearDraft.mockRestore()
      warn.mockRestore()
    }
  })

  it("revokes the claims that cited each deleted conversation", async () => {
    // Post-commit, alongside the other derived-view cleanups: a claim whose
    // whole source conversation is gone must stop being injected.
    const a = await createSession({ title: "a" })
    const b = await createSession({ title: "b" })
    mockRevokeClaimsForSession.mockClear()
    await bulkDeleteSessions([a.id, b.id])
    expect(mockRevokeClaimsForSession.mock.calls.map(([id]) => id).sort()).toEqual(
      [a.id, b.id].sort()
    )
  })

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

  // A paired client's history arrives from the host with no workspace at all,
  // and so does every conversation older than workspaces. Scoped by index
  // alone, the list showed a paired client nothing.
  it("listWorkspaceSessions adds the sessions of no workspace, newest-first", async () => {
    await saveSettings({ activeProjectId: "proj-A" })
    const a1 = await createSession({ title: "a1" })
    const b1 = await createSession({ title: "b1", projectId: "proj-B" })
    const legacy = await createSession({ title: "legacy" })
    await getDb().sessions.update(legacy.id, { projectId: undefined, updatedAt: a1.updatedAt + 5 })
    const hostRow = await createSession({ title: "from host" })
    await getDb().sessions.update(hostRow.id, { projectId: undefined, updatedAt: a1.updatedAt - 5 })

    const rows = await listWorkspaceSessions("proj-A")
    expect(rows.map((s) => s.id)).toEqual([legacy.id, a1.id, hostRow.id])
    expect(rows.some((s) => s.id === b1.id)).toBe(false)
    // Another workspace sees the same workspace-less rows, and only its own.
    expect((await listWorkspaceSessions("proj-B")).map((s) => s.id)).toEqual([
      legacy.id,
      b1.id,
      hostRow.id,
    ])
  })

  it("listWorkspaceSessions re-emits in a liveQuery when a workspace-less row changes", async () => {
    await saveSettings({ activeProjectId: "proj-A" })
    const legacy = await createSession({ title: "legacy" })
    await getDb().sessions.update(legacy.id, { projectId: undefined })
    const emissions: string[][] = []
    const sub = Dexie.liveQuery(() => listWorkspaceSessions("proj-A")).subscribe({
      next: (rows) => emissions.push(rows.map((r) => r.title)),
    })
    await waitUntil(() => emissions.length >= 1)
    await getDb().sessions.update(legacy.id, { title: "renamed" })
    await waitUntil(() => emissions.at(-1)?.[0] === "renamed")
    sub.unsubscribe()
    expect(emissions.at(-1)).toEqual(["renamed"])
  })
})

describe("countWorkspaceMessages", () => {
  async function putMessages(sessionId: string, count: number) {
    await getDb().messages.bulkPut(
      Array.from({ length: count }, (_, index) => ({
        id: `${sessionId}-m${index}`,
        sessionId,
        role: "user",
        parts: [],
        createdAt: index + 1,
      })) as never
    )
  }

  it("counts the messages of the conversations the workspace's chat list shows", async () => {
    await saveSettings({ activeProjectId: "proj-A" })
    const own = await createSession({ title: "own" })
    const legacy = await createSession({ title: "legacy" })
    await getDb().sessions.update(legacy.id, { projectId: undefined })
    const other = await createSession({ title: "other", projectId: "proj-B" })
    const subagent = await createSession({ title: "subagent" })
    await getDb().sessions.update(subagent.id, { kind: "subagent" })
    const empty = await createSession({ title: "empty" })
    await putMessages(own.id, 3)
    await putMessages(legacy.id, 2)
    await putMessages(other.id, 5)
    await putMessages(subagent.id, 7)

    // Own + workspace-less; not another workspace's, not an embedded
    // transcript, and a conversation with no messages adds nothing.
    expect(await countWorkspaceMessages("proj-A")).toBe(5)
    expect(await countWorkspaceMessages("proj-B")).toBe(7)
    expect(empty.projectId).toBe("proj-A")
  })

  it("is zero for a workspace with no conversations", async () => {
    expect(await countWorkspaceMessages("proj-empty")).toBe(0)
  })

  it("re-emits in a liveQuery when a message lands or a conversation joins", async () => {
    await saveSettings({ activeProjectId: "proj-A" })
    const own = await createSession({ title: "own" })
    await putMessages(own.id, 1)
    const emissions: number[] = []
    const sub = Dexie.liveQuery(() => countWorkspaceMessages("proj-A")).subscribe({
      next: (count) => emissions.push(count),
    })
    await waitUntil(() => emissions.at(-1) === 1)

    await getDb().messages.put({
      id: "late",
      sessionId: own.id,
      role: "assistant",
      parts: [],
      createdAt: 9,
    } as never)
    await waitUntil(() => emissions.at(-1) === 2)

    // A conversation moved in from another workspace brings its messages.
    const moved = await createSession({ title: "moved", projectId: "proj-B" })
    await putMessages(moved.id, 4)
    await getDb().sessions.update(moved.id, { projectId: "proj-A" })
    await waitUntil(() => emissions.at(-1) === 6)

    sub.unsubscribe()
    expect(emissions.at(-1)).toBe(6)
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

describe("thread handoff write guard", () => {
  beforeEach(async () => {
    await getDb().sessions.put({
      id: "handoff-locked",
      title: "Frozen",
      kind: "direct",
      projectId: "p1",
      sdkSessionId: "sdk-1",
      handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession)
  })

  it("blocks metadata, branching, and deletion", async () => {
    await expect(updateSession("handoff-locked", { title: "Changed" })).rejects.toMatchObject({
      code: "session_handoff_locked",
    })
    await expect(forkSessionFromParent("handoff-locked")).rejects.toMatchObject({
      code: "session_handoff_locked",
    })
    await expect(deleteSession("handoff-locked")).rejects.toMatchObject({
      code: "session_handoff_locked",
    })
    expect((await getDb().sessions.get("handoff-locked"))?.title).toBe("Frozen")
  })
})
