import { invalidateTranscriptRuntime } from "@/lib/chat/transcript/revision-events"
jest.mock("@/lib/chat/transcript/revision-events", () => ({
  ...jest.requireActual("@/lib/chat/transcript/revision-events"),
  invalidateTranscriptRuntime: jest.fn(async () => undefined),
}))

import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { persistMessages, listMessages } from "./messages"
import {
  advanceResourceAsideContextCursor,
  clearResourceWorkbenchSession,
  createResourceSessionRepository,
  createResourceWorkbenchSession,
  deleteResourceWorkbenchSession,
  listResourceWorkbenchSessions,
  promoteResourceWorkbenchSession,
  renameResourceWorkbenchSession,
} from "./resource-workbench-sessions"
import {
  ensureResourceWorkbenchSession,
  resourceWorkbenchSessionId,
} from "@/lib/context-workbench/resource-session"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { emptyWorkingSet } from "@/lib/chat/working-set"
import type { UIMessage } from "ai"

// Session deletion dynamically imports the artifact Zustand store for a
// best-effort cleanup. This DB suite does not exercise that store, and paying
// its full transform graph inside a 5s test obscures the database behavior.
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: () => ({ clearSessionData: jest.fn() }),
  },
}))

const binding: SessionSurfaceBinding = { kind: "session", sessionId: "main-1" }

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  jest.mocked(invalidateTranscriptRuntime).mockReset().mockResolvedValue(undefined)
  await dbFixture.restore()
  await getDb().sessions.put({
    id: "main-1",
    title: "Main",
    kind: "direct",
    projectId: "proj-main",
    createdAt: 1,
    updatedAt: 1,
  } as ChatSession)
})
afterAll(dbFixture.dispose)

/** The aside `ensureResourceWorkbenchSession` auto-creates on first open. */
async function seedPrimary(): Promise<string> {
  const id = resourceWorkbenchSessionId(binding)
  await getDb().sessions.put({
    id,
    title: "Aside",
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: binding,
    surfaceBindingKey: "session:main-1",
    projectId: "proj-main",
    createdAt: 2,
    updatedAt: 2,
  } as ChatSession)
  return id
}

const uiMsg = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage

describe("createResourceWorkbenchSession", () => {
  it("inherits parent configuration without activating team or squad executors", async () => {
    await getDb().sessions.update("main-1", {
      model: "parent-model",
      accountId: "account",
      permissionMode: "acceptEdits",
      teamId: "team",
      squadId: "squad",
      sandboxTier: "microvm",
      systemPrompt: "Rules",
    })
    const extra = await createResourceWorkbenchSession(binding, "Aside")
    expect(extra).toMatchObject({
      model: "parent-model",
      accountId: "account",
      permissionMode: "acceptEdits",
      sandboxTier: "microvm",
      systemPrompt: "Rules",
    })
    expect(extra.teamId).toBeUndefined()
    expect(extra.squadId).toBeUndefined()
  })

  it("shares the indexed repository used by ensure and migration callers", async () => {
    await seedPrimary()
    const repository = createResourceSessionRepository()
    await expect(repository.findByBinding?.(binding)).resolves.toMatchObject({
      surfaceBindingKey: "session:main-1",
    })
    await expect(repository.resolveProjectId?.(binding)).resolves.toBe("proj-main")
  })

  it("mints a distinct row that still shares the binding key", async () => {
    const primaryId = await seedPrimary()
    const extra = await createResourceWorkbenchSession(binding, "Check the versions")

    expect(extra.id).not.toBe(primaryId)
    // Sharing the key is what makes "every aside of this conversation" one
    // indexed lookup instead of a table scan.
    expect(extra.surfaceBindingKey).toBe("session:main-1")
    expect(extra.kind).toBe("resource-workbench")
    expect(extra.visibility).toBe("embedded")
  })

  it("inherits the MAIN conversation's workspace, not the active one", async () => {
    // A row without a projectId is absent from `[projectId+updatedAt]` — hidden
    // from scoped reads AND from `deleteProjectCascade`, so it would outlive
    // the workspace it belongs to.
    await getDb().settings.put({ id: "singleton", activeProjectId: "proj-elsewhere" } as never)
    const extra = await createResourceWorkbenchSession(binding, "Aside 2")
    expect(extra.projectId).toBe("proj-main")
  })

  it("stays out of every user-facing channel", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Aside 2")
    expect(isSessionExposed(extra, "main-list")).toBe(false)
    expect(isSessionExposed(extra, "global-search")).toBe(false)
  })
})

describe("listResourceWorkbenchSessions", () => {
  it("returns every aside for the binding, oldest first", async () => {
    const primaryId = await seedPrimary()
    const a = await createResourceWorkbenchSession(binding, "A")
    const b = await createResourceWorkbenchSession(binding, "B")

    const ids = (await listResourceWorkbenchSessions(binding)).map((s) => s.id)
    // Creation order, not recency: this renders as a stable pick-list and
    // re-sorting on every send would move the entry under the cursor. Both
    // extras are created inside the same millisecond here, which is exactly the
    // case a bare `Date.now()` stamp cannot order.
    expect(ids).toEqual([primaryId, a.id, b.id])
    expect(a.createdAt).toBeLessThan(b.createdAt)
  })

  it("does not leak another resource's asides", async () => {
    await seedPrimary()
    await createResourceWorkbenchSession({ kind: "artifact", artifactId: "art-1" }, "Other")
    const ids = (await listResourceWorkbenchSessions(binding)).map((s) => s.id)
    expect(ids).toHaveLength(1)
  })
})

describe("renameResourceWorkbenchSession", () => {
  it("trims the new name", async () => {
    const id = await seedPrimary()
    await renameResourceWorkbenchSession(id, "  Renamed  ")
    expect((await getDb().sessions.get(id))?.title).toBe("Renamed")
  })

  it("rejects an empty name rather than persisting one", async () => {
    const id = await seedPrimary()
    await expect(renameResourceWorkbenchSession(id, "   ")).rejects.toThrow()
    expect((await getDb().sessions.get(id))?.title).toBe("Aside")
  })
})

describe("clearResourceWorkbenchSession", () => {
  it("clears every retained thread seed and cursor while preserving configuration and unlock", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, {
      model: "model",
      permissionMode: "acceptEdits",
      asideWriteAccess: true,
      branchSeed: { kind: "transcript", content: "Old context" },
      spawnedTask: { mode: "inherit", pendingPrompt: "Old task" },
      sdkSessionId: "sdk",
      forkedFromSdkSessionId: "parent-sdk",
      sdkSessionStorage: { backend: "filesystem" },
      externalAgentSession: { agentId: "agent", sessionId: "native-old" },
      externalAgentGatewaySessions: [{ agentId: "agent", sessionId: "native-old" }],
      asideContextCursor: { sdkSessionId: "sdk", parentMessageId: "m1", tailFingerprint: "hash" },
      runtimeTranscriptInvalidated: "old-mutation",
      workingSet: emptyWorkingSet(),
    } as Partial<ChatSession>)
    await clearResourceWorkbenchSession(id)
    const row = await getDb().sessions.get(id)
    expect(row).toMatchObject({
      model: "model",
      permissionMode: "acceptEdits",
      asideWriteAccess: true,
    })
    for (const field of [
      "branchSeed",
      "spawnedTask",
      "sdkSessionId",
      "forkedFromSdkSessionId",
      "sdkSessionStorage",
      "externalAgentSession",
      "externalAgentGatewaySessions",
      "asideContextCursor",
      "runtimeTranscriptInvalidated",
      "workingSet",
    ]) {
      expect(row).not.toHaveProperty(field)
    }
  })

  it("refuses to clear if the provider runtime cannot be stopped", async () => {
    const id = await seedPrimary()
    await persistMessages(id, [uiMsg("kept", "still here")])
    jest.mocked(invalidateTranscriptRuntime).mockRejectedValueOnce(new Error("host unavailable"))
    await expect(clearResourceWorkbenchSession(id)).rejects.toThrow("host unavailable")
    expect(await listMessages(id)).toHaveLength(1)
  })

  it("drops the messages, keeps the aside, and unlinks the SDK conversation", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk-1" })
    await persistMessages(id, [uiMsg("m1", "hello")])

    await clearResourceWorkbenchSession(id)

    expect(invalidateTranscriptRuntime).toHaveBeenCalledWith(id)
    expect(await listMessages(id)).toHaveLength(0)
    const row = await getDb().sessions.get(id)
    expect(row).toBeDefined()
    // The provider still holds the turns we deleted; resuming would reintroduce
    // exactly the context the user asked to be rid of.
    expect(row?.sdkSessionId).toBeUndefined()
  })
})

describe("deleteResourceWorkbenchSession", () => {
  it("removes the aside and its messages", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Doomed")
    await persistMessages(extra.id, [uiMsg("m1", "hello")])

    await deleteResourceWorkbenchSession(extra.id)

    expect(await getDb().sessions.get(extra.id)).toBeUndefined()
    expect(await listMessages(extra.id)).toHaveLength(0)
  })
})

describe("promoteResourceWorkbenchSession", () => {
  it("keeps a promoted primary visible and creates one fresh primary shared across windows", async () => {
    const id = await seedPrimary()
    await persistMessages(id, [uiMsg("kept-message", "Keep this conversation")])
    await promoteResourceWorkbenchSession(id)
    const repository = createResourceSessionRepository()
    const first = await ensureResourceWorkbenchSession(binding, "Fresh", repository, "window-a")
    const second = await ensureResourceWorkbenchSession(binding, "Fresh", repository, "window-b")
    expect(first.id).not.toBe(id)
    expect(second.id).toBe(first.id)
    expect((await getDb().sessions.get(id))?.kind).toBe("direct")
    expect(isSessionExposed((await getDb().sessions.get(id))!, "main-list")).toBe(true)
    expect(await listMessages(id)).toHaveLength(1)
    expect(await listMessages(first.id)).toHaveLength(0)
    expect((await listResourceWorkbenchSessions(binding)).map((row) => row.id)).toEqual([first.id])
  })

  it("clears every marker that kept it out of the rails, in place", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Worth keeping")
    await persistMessages(extra.id, [uiMsg("m1", "hello")])

    const promoted = await promoteResourceWorkbenchSession(extra.id)

    expect(promoted.kind).toBe("direct")
    expect(isSessionExposed(promoted, "main-list")).toBe(true)
    const row = await getDb().sessions.get(extra.id)
    // `isEmbeddedSession` reads kind OR visibility — clearing one and not the
    // other would leave it hidden with no surface able to render it.
    expect(row?.visibility).toBeUndefined()
    expect(row?.surfaceBinding).toBeUndefined()
    expect(row?.surfaceBindingKey).toBeUndefined()
    // Same id, so permalinks into the aside survive being promoted.
    expect(promoted.id).toBe(extra.id)
    expect(await listMessages(extra.id)).toHaveLength(1)
  })

  it("keeps the workspace so the promoted row is reachable from the sidebar", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Worth keeping")
    const promoted = await promoteResourceWorkbenchSession(extra.id)
    expect(promoted.projectId).toBe("proj-main")
  })

  it("drops out of the binding list once promoted", async () => {
    const primaryId = await seedPrimary()
    const extra = await createResourceWorkbenchSession(binding, "Leaving")
    await promoteResourceWorkbenchSession(extra.id)
    const ids = (await listResourceWorkbenchSessions(binding)).map((s) => s.id)
    expect(ids).toEqual([primaryId])
  })

  it("refuses a session that is not an aside", async () => {
    await expect(promoteResourceWorkbenchSession("main-1")).rejects.toThrow(/not an aside/)
  })

  it("refuses a missing session", async () => {
    await expect(promoteResourceWorkbenchSession("nope")).rejects.toThrow(/not found/)
  })
})

describe("advanceResourceAsideContextCursor", () => {
  const cursor = { sdkSessionId: "sdk", parentMessageId: "m1", tailFingerprint: "hash" }

  it("records a cursor for the same live session-bound aside SDK history", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk" })
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toEqual(cursor)
  })

  it("does not reintroduce a cursor after clear or SDK replacement", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk" })
    await clearResourceWorkbenchSession(id)
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toBeUndefined()
    await getDb().sessions.update(id, { sdkSessionId: "replacement" })
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toBeUndefined()
  })

  it("does not restore aside state after promotion or for another resource kind", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk" })
    await promoteResourceWorkbenchSession(id)
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toBeUndefined()
    const artifact = await createResourceWorkbenchSession(
      { kind: "artifact", artifactId: "a" },
      "Artifact"
    )
    await getDb().sessions.update(artifact.id, { sdkSessionId: "sdk" })
    await advanceResourceAsideContextCursor(artifact.id, cursor)
    expect((await getDb().sessions.get(artifact.id))?.asideContextCursor).toBeUndefined()
  })
})
