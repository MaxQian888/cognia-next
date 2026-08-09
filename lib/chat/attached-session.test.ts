import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"

import {
  closeAttachedSession,
  completeAttachedSession,
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
  it("creates a full-context child using an SDK fork and a separate lifecycle link", async () => {
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
          forkedFromSdkSessionId: "sdk-parent",
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

  it("gates reconstructed full context before creating an SDK-backed fork", async () => {
    const { deps } = setup([message("u1", "user", "private")])
    deps.gateInheritedContent = () => false

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
