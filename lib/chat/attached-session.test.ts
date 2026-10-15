import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import {
  closeAttachedSession,
  completeAttachedSession,
  consumeStagedPrompt,
  createAttachedSession,
  interruptAttachedSession,
  type AttachedSessionDeps,
} from "./attached-session"

const parent: ChatSession = {
  id: "parent-1",
  projectId: "project-1",
  title: "Parent",
  kind: "direct",
  sdkSessionId: "sdk-parent",
  workingDir: "/repo",
  executionContext: {
    location: "local",
    workspaceBinding: { kind: "project", projectId: "project-1" },
    projectId: "project-1",
    projectRoot: "/repo",
    taskWorkspace: { taskId: "task-workspace:parent-1", workspaceKey: "parent-1" },
  },
  createdAt: 1,
  updatedAt: 1,
}

function message(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] }
}

function setup(messages: UIMessage[] = []) {
  const child: ChatSession = {
    id: "child-1",
    projectId: "project-1",
    title: "Child",
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: { kind: "session", sessionId: "parent-1" },
    createdAt: 2,
    updatedAt: 2,
  }
  const rows = new Map([
    [parent.id, parent],
    [child.id, child],
  ])
  const updates: Array<{ id: string; patch: Partial<ChatSession> }> = []
  const deleteChild = jest.fn(async (id: string) => {
    rows.delete(id)
  })
  const deps: AttachedSessionDeps = {
    getSession: async (id) => rows.get(id),
    listChildren: async (parentSessionId) =>
      [...rows.values()].filter((row) => row.parentSessionId === parentSessionId),
    createChild: async () => child,
    listMessages: async () => messages,
    updateSession: async (id, patch) => {
      updates.push({ id, patch })
      const current = rows.get(id)
      if (current) rows.set(id, { ...current, ...patch })
    },
    deleteChild,
    gateInheritedContent: () => true,
    now: () => 100,
  }
  return { child, rows, updates, deleteChild, deps }
}

describe("createAttachedSession", () => {
  it("keeps an independent child's own placement and writes extra columns atomically", async () => {
    const { deps, child, updates } = setup()
    const ownContext = {
      location: "managedWorktree" as const,
      projectId: "project-1",
      projectRoot: "/repo",
      taskWorkspace: { taskId: "task-workspace:child-1", workspaceKey: "child-1" },
    }
    child.workingDir = "/wt/child"
    child.executionContext = ownContext

    const created = await createAttachedSession(
      {
        parentSessionId: "parent-1",
        title: "Thread",
        prompt: "Do it",
        context: { mode: "none" },
        workspace: "independent",
        extra: { projectRole: "thread" },
      },
      deps
    )

    expect(updates).toHaveLength(1)
    expect(updates[0].patch).toMatchObject({
      projectRole: "thread",
      workingDir: "/wt/child",
      executionContext: ownContext,
      parentSessionId: "parent-1",
    })
    expect(created.projectRole).toBe("thread")
  })

  it("never lets extra columns override the attachment", async () => {
    const { deps, updates } = setup()
    await createAttachedSession(
      {
        parentSessionId: "parent-1",
        title: "Thread",
        prompt: "Do it",
        context: { mode: "none" },
        workspace: "independent",
        extra: { title: "renamed" } as never,
      },
      deps
    )
    expect(updates[0].patch.attachedChild?.parentSessionId).toBe("parent-1")
    expect(updates[0].patch.spawnedTask).toEqual({ mode: "aside", pendingPrompt: "Do it" })
  })

  it("creates a full-context child using gated text and a separate lifecycle link", async () => {
    const { deps, updates } = setup([message("u1", "user", "Parent context")])

    const child = await createAttachedSession(
      {
        parentSessionId: "parent-1",
        title: "Review migration",
        prompt: "Check the schema",
        context: { mode: "full" },
        workspace: "shared",
      },
      deps
    )

    expect(child.id).toBe("child-1")
    expect(updates).toEqual([
      {
        id: "child-1",
        patch: expect.objectContaining({
          parentSessionId: "parent-1",
          branchSeed: { kind: "transcript", content: "User: Parent context" },
          workingDir: "/repo",
          executionContext: expect.objectContaining({
            taskWorkspace: { taskId: "task-workspace:child-1", workspaceKey: "child-1" },
          }),
          spawnedTask: { mode: "inherit", pendingPrompt: "Check the schema" },
          attachedChild: expect.objectContaining({
            parentSessionId: "parent-1",
            lifecycleOwnerSessionId: "parent-1",
            context: { mode: "full" },
            workspace: "shared",
            status: "staged",
          }),
        }),
      },
    ])
    expect(child.forkedFromSdkSessionId).toBeUndefined()
  })

  it("inherits aside config without starting the parent's team executor", async () => {
    const { deps, rows } = setup()
    rows.set(parent.id, {
      ...parent,
      model: "parent-model",
      providerOverride: "anthropic",
      accountId: "parent-account",
      teamId: "team-parent",
      squadId: "squad-parent",
      permissionMode: "acceptEdits",
      systemPrompt: "Parent instructions",
      sandboxEnabled: true,
      sandboxTier: "microvm",
      disabledSkillIds: ["skill-1"],
    })

    const child = await createAttachedSession(
      {
        parentSessionId: parent.id,
        title: "Aside",
        prompt: "Question",
        context: { mode: "none" },
        workspace: "shared",
      },
      deps
    )

    expect(child).toMatchObject({
      model: "parent-model",
      providerOverride: "anthropic",
      accountId: "parent-account",
      permissionMode: "acceptEdits",
      systemPrompt: "Parent instructions",
      sandboxEnabled: true,
      sandboxTier: "microvm",
      disabledSkillIds: ["skill-1"],
    })
    expect(child.teamId).toBeUndefined()
    expect(child.squadId).toBeUndefined()
    expect(child.asideWriteAccess).toBeUndefined()
  })

  it("preserves a non-aside creator's explicit model and independent workspace", async () => {
    const { deps, rows, child } = setup()
    rows.set(parent.id, { ...parent, model: "parent-model", providerOverride: "anthropic" })
    child.kind = "direct"
    child.surfaceBinding = undefined
    child.model = "thread-model"
    child.providerOverride = "openai"
    child.workingDir = "/wt/thread"

    const created = await createAttachedSession(
      {
        parentSessionId: parent.id,
        title: "Thread",
        prompt: "Work",
        context: { mode: "none" },
        workspace: "independent",
      },
      deps
    )

    expect(created).toMatchObject({
      model: "thread-model",
      providerOverride: "openai",
      workingDir: "/wt/thread",
    })
  })

  it("does not fork opaque SDK history when tool payloads fail the PII gate", async () => {
    const messages: UIMessage[] = [
      message("u1", "user", "Safe question"),
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
    const { deps } = setup(messages)
    deps.gateInheritedContent = hasNoLeakingPiiDeep
    expect(hasNoLeakingPiiDeep(messages)).toBe(false)

    const child = await createAttachedSession(
      {
        parentSessionId: parent.id,
        title: "Safe fallback",
        prompt: "Question",
        context: { mode: "full" },
        workspace: "shared",
      },
      deps
    )

    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed).toEqual({ kind: "transcript", content: "User: Safe question" })
    expect(hasNoLeakingPiiDeep(child.branchSeed)).toBe(true)
  })

  it("never treats an empty local mirror as proof that an SDK session is safe", async () => {
    const { deps } = setup()
    const child = await createAttachedSession(
      {
        parentSessionId: parent.id,
        title: "Empty mirror",
        prompt: "Question",
        context: { mode: "full" },
        workspace: "shared",
      },
      deps
    )

    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed).toBeUndefined()
  })

  it("seeds only the requested tail when a partial context fork is requested", async () => {
    const { deps, updates } = setup([
      message("u1", "user", "old"),
      message("a1", "assistant", "older"),
      message("u2", "user", "recent"),
      message("a2", "assistant", "latest"),
    ])

    await createAttachedSession(
      {
        parentSessionId: "parent-1",
        title: "Tail",
        prompt: "Continue",
        context: { mode: "last-n", turns: 2 },
        workspace: "independent",
      },
      deps
    )

    const patch = updates[0].patch
    expect(patch.forkedFromSdkSessionId).toBeUndefined()
    expect(patch.executionContext).toBeUndefined()
    expect(patch.branchSeed?.content).toContain("recent")
    expect(patch.branchSeed?.content).toContain("latest")
    expect(patch.branchSeed?.content).not.toContain("older")
  })

  it("keeps a no-context child isolated from parent history", async () => {
    const { deps, updates } = setup([message("u1", "user", "secret context")])

    await createAttachedSession(
      {
        parentSessionId: "parent-1",
        title: "Isolated",
        prompt: "Start clean",
        context: { mode: "none" },
        workspace: "independent",
      },
      deps
    )

    expect(updates[0].patch.branchSeed).toBeUndefined()
    expect(updates[0].patch.forkedFromSdkSessionId).toBeUndefined()
    expect(updates[0].patch.spawnedTask).toEqual({
      mode: "aside",
      pendingPrompt: "Start clean",
    })
  })

  it("refuses inherited context when the outbound PII gate rejects it", async () => {
    const { deps } = setup([message("u1", "user", "private")])
    deps.gateInheritedContent = () => false

    await expect(
      createAttachedSession(
        {
          parentSessionId: "parent-1",
          title: "Blocked",
          prompt: "Continue",
          context: { mode: "last-n", turns: 1 },
          workspace: "shared",
        },
        deps
      )
    ).rejects.toThrow("blocked by the PII redaction gate")
  })

  it("blocks an unsafe rendered fallback even when the parent has an SDK session", async () => {
    const { deps } = setup([message("u1", "user", "alice@example.com")])
    deps.gateInheritedContent = hasNoLeakingPiiDeep
    deps.createChild = jest.fn(deps.createChild)

    await expect(
      createAttachedSession(
        {
          parentSessionId: "parent-1",
          title: "Blocked fork",
          prompt: "Continue",
          context: { mode: "full" },
          workspace: "shared",
        },
        deps
      )
    ).rejects.toThrow("blocked by the PII redaction gate")
    expect(deps.createChild).not.toHaveBeenCalled()
  })

  it("removes the embedded child if lifecycle metadata cannot be persisted", async () => {
    const { deps, deleteChild, rows } = setup()
    deps.updateSession = async () => {
      throw new Error("write failed")
    }

    await expect(
      createAttachedSession(
        {
          parentSessionId: "parent-1",
          title: "Rollback",
          prompt: "Start",
          context: { mode: "none" },
          workspace: "shared",
        },
        deps
      )
    ).rejects.toThrow("write failed")

    expect(deleteChild).toHaveBeenCalledWith("child-1")
    expect(rows.has("child-1")).toBe(false)
  })
})

describe("attached session lifecycle", () => {
  it("links a completion result back to the parent-owned child record", async () => {
    const { deps, rows } = setup()
    rows.set("child-1", {
      ...rows.get("child-1")!,
      parentSessionId: "parent-1",
      attachedChild: {
        parentSessionId: "parent-1",
        lifecycleOwnerSessionId: "parent-1",
        context: { mode: "none" },
        workspace: "independent",
        status: "running",
        createdAt: 50,
      },
    })

    await completeAttachedSession(
      "child-1",
      { summary: "Schema is valid", messageId: "answer-1" },
      deps
    )

    expect(rows.get("child-1")?.attachedChild).toMatchObject({
      status: "completed",
      result: { summary: "Schema is valid", messageId: "answer-1", completedAt: 100 },
    })
  })

  it("allows only the lifecycle owner to interrupt a child", async () => {
    const { deps, rows } = setup()
    rows.set("child-1", {
      ...rows.get("child-1")!,
      attachedChild: {
        parentSessionId: "parent-1",
        lifecycleOwnerSessionId: "parent-1",
        context: { mode: "none" },
        workspace: "independent",
        status: "running",
        createdAt: 50,
      },
    })

    await expect(interruptAttachedSession("child-1", "peer-1", deps)).rejects.toThrow(
      "does not own attached session child-1"
    )
    await interruptAttachedSession("child-1", "parent-1", deps)
    expect(rows.get("child-1")?.attachedChild?.status).toBe("interrupted")
  })

  it("recursively closes descendants owned by the attached child", async () => {
    const { deps, rows } = setup()
    rows.set("child-1", {
      ...rows.get("child-1")!,
      parentSessionId: "parent-1",
      attachedChild: {
        parentSessionId: "parent-1",
        lifecycleOwnerSessionId: "parent-1",
        context: { mode: "none" },
        workspace: "shared",
        status: "running",
        createdAt: 50,
      },
    })
    rows.set("grandchild-1", {
      id: "grandchild-1",
      title: "Grandchild",
      kind: "resource-workbench",
      parentSessionId: "child-1",
      attachedChild: {
        parentSessionId: "child-1",
        lifecycleOwnerSessionId: "child-1",
        context: { mode: "none" },
        workspace: "shared",
        status: "running",
        createdAt: 60,
      },
      createdAt: 3,
      updatedAt: 3,
    })

    await closeAttachedSession("child-1", "parent-1", deps)

    expect(rows.get("child-1")?.attachedChild?.status).toBe("closed")
    expect(rows.get("grandchild-1")?.attachedChild?.status).toBe("closed")
  })
})

describe("consumeStagedPrompt", () => {
  it("drops the staged prompt and keeps the task mode", async () => {
    const updateSession = jest.fn(async () => undefined)
    await consumeStagedPrompt("child-1", "inherit", { updateSession })
    expect(updateSession).toHaveBeenCalledWith("child-1", { spawnedTask: { mode: "inherit" } })
  })
})
