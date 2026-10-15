import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { BRANCH_SEED_MAX_CHARS } from "@/lib/chat/branch-session"

const defaultGetSession = jest.fn()
const defaultCreateAside = jest.fn()
const defaultListMessages = jest.fn()
const defaultUpdateSession = jest.fn()
const defaultDeleteAside = jest.fn()
const defaultClearArtifact = jest.fn()
const defaultSelectAside = jest.fn()
const defaultRevealSidechat = jest.fn()

jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => defaultGetSession(...args),
  updateSession: (...args: unknown[]) => defaultUpdateSession(...args),
}))
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...args: unknown[]) => defaultListMessages(...args),
}))
jest.mock("@/lib/db/resource-workbench-sessions", () => ({
  createResourceWorkbenchSession: (...args: unknown[]) => defaultCreateAside(...args),
  deleteResourceWorkbenchSession: (...args: unknown[]) => defaultDeleteAside(...args),
}))
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => ({ setActiveArtifact: defaultClearArtifact }) },
}))
jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  useContextWorkbenchStore: { getState: () => ({ setSessionOverride: defaultSelectAside }) },
}))
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: {
    getState: () => ({ revealSidechat: defaultRevealSidechat }),
  },
}))
import {
  dispatchSpawnTask,
  revealSpawnedTask,
  type SpawnTaskDispatchDeps,
  type SpawnTaskRevealDeps,
} from "./spawn-task-dispatch"

const brief = {
  title: "Fix streaming cleanup",
  tldr: "Move the cleanup into a dedicated task.",
  situation: "The stream can retain an abort controller after completion.",
  codeLocations: ["hooks/chat/use-stream.ts:42"],
  solution: "Clear the controller in the terminal event handler.",
  caveats: ["Keep retry behavior intact."],
  mode: "aside" as const,
}

function session(id: string, patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: "project-1",
    title: id,
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function dependencies(overrides: Partial<SpawnTaskDispatchDeps> = {}): SpawnTaskDispatchDeps {
  return {
    getSession: jest.fn(async (id) => session(id)),
    createAside: jest.fn(async () => session("task-1", { kind: "resource-workbench" })),
    listMessages: jest.fn(async () => []),
    updateSession: jest.fn(async () => undefined),
    deleteAside: jest.fn(async () => undefined),
    gateInheritedContent: jest.fn(() => true),
    ...overrides,
  }
}

describe("dispatchSpawnTask", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    defaultGetSession.mockResolvedValue(session("parent-1"))
    defaultCreateAside.mockResolvedValue(session("task-default", { kind: "resource-workbench" }))
    defaultListMessages.mockResolvedValue([])
    defaultUpdateSession.mockResolvedValue(undefined)
    defaultDeleteAside.mockResolvedValue(undefined)
  })

  it("creates one named aside and durably stages its context-free prompt", async () => {
    const order: string[] = []
    const deps = dependencies({
      createAside: jest.fn(async (_binding, title) => {
        order.push(`create:${title}`)
        return session("task-1", { kind: "resource-workbench" })
      }),
      listMessages: jest.fn(async (id) => {
        order.push(`messages:${id}`)
        return []
      }),
      updateSession: jest.fn(async () => {
        order.push("stage")
      }),
    })

    const result = await dispatchSpawnTask("parent-1", brief, deps)

    expect(result).toMatchObject({ ok: true, taskSessionId: "task-1", title: brief.title })
    expect(deps.createAside).toHaveBeenCalledWith(
      { kind: "session", sessionId: "parent-1" },
      brief.title
    )
    expect(deps.updateSession).toHaveBeenCalledWith("task-1", {
      spawnedTask: {
        mode: "aside",
        pendingPrompt: expect.stringContaining("# Fix streaming cleanup"),
      },
    })
    expect(order).toEqual([`create:${brief.title}`, "messages:task-1", "stage"])
  })

  it("rejects a missing parent before creating a sidechat", async () => {
    const deps = dependencies({ getSession: jest.fn(async () => undefined) })

    await expect(dispatchSpawnTask("missing", brief, deps)).rejects.toThrow(
      "Parent session missing was not found"
    )
    expect(deps.createAside).not.toHaveBeenCalled()
  })

  it("inherits gated text instead of an opaque SDK session even for a clean local mirror", async () => {
    const deps = dependencies({
      getSession: jest.fn(async () => session("parent-1", { sdkSessionId: "sdk-parent" })),
      listMessages: jest.fn(async (id) =>
        id === "parent-1"
          ? ([
              { id: "m1", role: "user", parts: [{ type: "text", text: "Safe context" }] },
            ] as UIMessage[])
          : []
      ),
    })

    await dispatchSpawnTask("parent-1", { ...brief, mode: "inherit" }, deps)

    expect(deps.gateInheritedContent).toHaveBeenCalledWith("User: Safe context")
    expect(deps.updateSession).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ branchSeed: { kind: "transcript", content: "User: Safe context" } })
    )
    expect(
      (deps.updateSession as jest.Mock).mock.calls[0][1].forkedFromSdkSessionId
    ).toBeUndefined()
  })

  it("inherits the parent config without carrying its team executor or write unlock", async () => {
    const deps = dependencies({
      getSession: jest.fn(async () =>
        session("parent-1", {
          model: "parent-model",
          providerOverride: "anthropic",
          accountId: "parent-account",
          characterId: "character-parent",
          teamId: "team-parent",
          squadId: "squad-parent",
          permissionMode: "acceptEdits",
          workingDir: "/repo",
          sandboxEnabled: true,
          sandboxTier: "microvm",
          systemPrompt: "Parent instructions",
          asideWriteAccess: true,
        })
      ),
    })

    await dispatchSpawnTask("parent-1", brief, deps)

    const patch = (deps.updateSession as jest.Mock).mock.calls[0][1]
    expect(patch).toMatchObject({
      model: "parent-model",
      providerOverride: "anthropic",
      accountId: "parent-account",
      characterId: "character-parent",
      permissionMode: "acceptEdits",
      workingDir: "/repo",
      sandboxEnabled: true,
      sandboxTier: "microvm",
      systemPrompt: "Parent instructions",
    })
    expect(patch.teamId).toBeUndefined()
    expect(patch.squadId).toBeUndefined()
    expect(patch.asideWriteAccess).toBeUndefined()
  })

  it("falls back to gated text when omitted tool payloads contain PII", async () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Safe question" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "lookup",
            toolCallId: "lookup-1",
            state: "output-available",
            input: {},
            output: { email: "alice@example.com" },
          },
        ],
      },
    ]
    const deps = dependencies({
      getSession: jest.fn(async () => session("parent-1", { sdkSessionId: "sdk-parent" })),
      listMessages: jest.fn(async (id) => (id === "parent-1" ? messages : [])),
      gateInheritedContent: hasNoLeakingPiiDeep,
    })
    expect(hasNoLeakingPiiDeep(messages)).toBe(false)

    await dispatchSpawnTask("parent-1", { ...brief, mode: "inherit" }, deps)

    const patch = (deps.updateSession as jest.Mock).mock.calls[0][1]
    expect(patch.forkedFromSdkSessionId).toBeUndefined()
    expect(patch.branchSeed).toEqual({ kind: "transcript", content: "User: Safe question" })
    expect(hasNoLeakingPiiDeep(patch.branchSeed)).toBe(true)
  })

  it("cannot recover unsafe older messages through a fork after the renderer bounds the seed", async () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "alice@example.com" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "x".repeat(BRANCH_SEED_MAX_CHARS) }],
      },
    ]
    const deps = dependencies({
      getSession: jest.fn(async () => session("parent-1", { sdkSessionId: "sdk-parent" })),
      listMessages: jest.fn(async (id) => (id === "parent-1" ? messages : [])),
      gateInheritedContent: hasNoLeakingPiiDeep,
    })

    await dispatchSpawnTask("parent-1", { ...brief, mode: "inherit" }, deps)

    const patch = (deps.updateSession as jest.Mock).mock.calls[0][1]
    expect(patch.forkedFromSdkSessionId).toBeUndefined()
    expect(patch.branchSeed.content).toHaveLength(BRANCH_SEED_MAX_CHARS)
    expect(patch.branchSeed.content).not.toContain("alice@example.com")
    expect(hasNoLeakingPiiDeep(patch.branchSeed)).toBe(true)
  })

  it("never forks retained SDK history when the local mirror is empty", async () => {
    const deps = dependencies({
      getSession: jest.fn(async () => session("parent-1", { sdkSessionId: "sdk-parent" })),
    })

    await dispatchSpawnTask("parent-1", { ...brief, mode: "inherit" }, deps)

    const patch = (deps.updateSession as jest.Mock).mock.calls[0][1]
    expect(patch.forkedFromSdkSessionId).toBeUndefined()
    expect(patch.branchSeed).toBeUndefined()
  })

  it("inherits a bounded transcript when no SDK session exists", async () => {
    const messages: UIMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Inspect the retry loop" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "The cleanup is missing" }] },
    ]
    const deps = dependencies({
      listMessages: jest.fn(async (id) => (id === "parent-1" ? messages : [])),
    })

    await dispatchSpawnTask("parent-1", { ...brief, mode: "inherit" }, deps)

    expect(deps.updateSession).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        branchSeed: {
          kind: "transcript",
          content: "User: Inspect the retry loop\n\nAssistant: The cleanup is missing",
        },
      })
    )
  })

  it.each([undefined, "sdk-parent"])(
    "blocks unsafe inherited text before creating a child (SDK session: %s)",
    async (sdkSessionId) => {
      const deps = dependencies({
        getSession: jest.fn(async () => session("parent-1", { sdkSessionId })),
        listMessages: jest.fn(async (id) =>
          id === "parent-1"
            ? [
                {
                  id: "m1",
                  role: "user",
                  parts: [{ type: "text", text: "alice@example.com" }],
                } as UIMessage,
              ]
            : []
        ),
        gateInheritedContent: hasNoLeakingPiiDeep,
      })

      await expect(
        dispatchSpawnTask("parent-1", { ...brief, mode: "inherit" }, deps)
      ).rejects.toThrow("PII redaction gate")
      expect(deps.createAside).not.toHaveBeenCalled()
      expect(deps.updateSession).not.toHaveBeenCalled()
    }
  )

  it("refuses nested workbench tasks and a non-empty new task", async () => {
    const nested = dependencies({
      getSession: jest.fn(async (id) => session(id, { kind: "resource-workbench" })),
    })
    await expect(
      dispatchSpawnTask("resource-workbench:session:parent", brief, nested)
    ).rejects.toThrow("cannot spawn another task")

    const deps = dependencies({
      listMessages: jest.fn(async (id) =>
        id === "task-1"
          ? ([
              { id: "existing", role: "user", parts: [{ type: "text", text: "occupied" }] },
            ] as UIMessage[])
          : []
      ),
    })
    await expect(dispatchSpawnTask("parent-1", brief, deps)).rejects.toThrow(
      "new task session is not empty"
    )
    expect(deps.updateSession).not.toHaveBeenCalled()
    expect(deps.deleteAside).toHaveBeenCalledWith("task-1")
  })

  it("rolls back a newly created aside when durable staging fails", async () => {
    const deps = dependencies({
      updateSession: jest.fn(async () => {
        throw new Error("write failed")
      }),
    })

    await expect(dispatchSpawnTask("parent-1", brief, deps)).rejects.toThrow("write failed")
    expect(deps.deleteAside).toHaveBeenCalledWith("task-1")
  })

  it("uses the production repositories and stores when no seams are injected", async () => {
    await dispatchSpawnTask("parent-1", brief)

    expect(defaultCreateAside).toHaveBeenCalledWith(
      { kind: "session", sessionId: "parent-1" },
      brief.title
    )
    expect(defaultUpdateSession).toHaveBeenCalledWith(
      "task-default",
      expect.objectContaining({
        spawnedTask: expect.objectContaining({
          pendingPrompt: expect.stringContaining(brief.title),
        }),
      })
    )
  })
})

describe("revealSpawnedTask", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("clears the artifact, selects the task aside, then reveals sidechat", () => {
    const order: string[] = []
    const deps: SpawnTaskRevealDeps = {
      clearArtifact: jest.fn(() => order.push("artifact")),
      selectAside: jest.fn(() => order.push("aside")),
      revealSidechat: jest.fn(() => order.push("reveal")),
    }

    revealSpawnedTask("parent-1", "task-1", deps)

    expect(deps.clearArtifact).toHaveBeenCalledWith("parent-1")
    expect(deps.selectAside).toHaveBeenCalledWith("session:parent-1", "task-1")
    expect(order).toEqual(["artifact", "aside", "reveal"])
  })

  it("uses the production dock stores when no seams are injected", () => {
    revealSpawnedTask("parent-1", "task-1")

    expect(defaultClearArtifact).toHaveBeenCalledWith(null, "parent-1")
    expect(defaultSelectAside).toHaveBeenCalledWith("session:parent-1", "task-1")
    expect(defaultRevealSidechat).toHaveBeenCalledTimes(1)
  })
})
