import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import {
  ensureResourceWorkbenchSession,
  migrateResourceSessionBinding,
  resourceWorkbenchSessionId,
  surfaceBindingForContextResource,
} from "./resource-session"

describe("resource workbench sessions", () => {
  it("creates one embedded persistent session per resource", async () => {
    const rows = new Map<string, ChatSession>()
    const binding: SessionSurfaceBinding = { kind: "artifact", artifactId: "artifact-1" }
    const first = await ensureResourceWorkbenchSession(binding, "Artifact", {
      get: async (id) => rows.get(id),
      put: async (session) => void rows.set(session.id, session),
      update: async () => undefined,
      now: () => 42,
    })
    const second = await ensureResourceWorkbenchSession(binding, "Renamed", {
      get: async (id) => rows.get(id),
      put: async (session) => void rows.set(session.id, session),
      update: async () => undefined,
      now: () => 99,
    })

    expect(second.id).toBe(first.id)
    expect(rows.size).toBe(1)
    expect(first).toMatchObject({
      kind: "resource-workbench",
      visibility: "embedded",
      surfaceBinding: binding,
    })
  })

  it("reuses the same resource conversation across desktop, mobile, and synced hosts", () => {
    const binding: SessionSurfaceBinding = { kind: "artifact", artifactId: "artifact-1" }
    expect(resourceWorkbenchSessionId(binding, "desktop-window")).toBe(
      resourceWorkbenchSessionId(binding, "mobile-sheet")
    )
  })

  it("migrates an app-confirmed file rename without changing the thread id", async () => {
    const updates: Array<[string, Partial<ChatSession>]> = []
    await migrateResourceSessionBinding(
      "resource-workbench:project:p:r:src%2Fa.ts",
      { kind: "project-file", projectId: "p", rootId: "r", relPath: "src/b.ts" },
      { update: async (id, patch) => void updates.push([id, patch]), now: () => 100 }
    )
    expect(updates).toEqual([
      [
        "resource-workbench:project:p:r:src%2Fa.ts",
        expect.objectContaining({
          surfaceBinding: {
            kind: "project-file",
            projectId: "p",
            rootId: "r",
            relPath: "src/b.ts",
          },
        }),
      ],
    ])
  })

  it("maps every resource discriminator to a metadata-only surface binding", () => {
    expect(
      surfaceBindingForContextResource({
        kind: "canvas-document",
        documentId: "d",
        revision: "1",
        capabilities: [],
      })
    ).toEqual({ kind: "canvas-document", documentId: "d" })
    expect(
      surfaceBindingForContextResource({
        kind: "project-file",
        projectId: "p",
        rootId: "r",
        relPath: "a.ts",
        contentHash: "h",
        draftVersion: 1,
        capabilities: [],
      })
    ).toEqual({ kind: "project-file", projectId: "p", rootId: "r", relPath: "a.ts" })
    expect(
      surfaceBindingForContextResource({
        kind: "artifact",
        artifactId: "a",
        version: "1",
        capabilities: [],
      })
    ).toEqual({ kind: "artifact", artifactId: "a" })
    expect(
      surfaceBindingForContextResource({
        kind: "workflow",
        workflowId: "w",
        editorRevision: "1",
        capabilities: [],
      })
    ).toEqual({ kind: "workflow", workflowId: "w" })
  })

  it("binds a session resource so a conversation can own a sidechat", () => {
    expect(
      surfaceBindingForContextResource({
        kind: "session",
        sessionId: "s",
        capabilities: [],
      })
    ).toEqual({ kind: "session", sessionId: "s" })
  })

  it("refuses to give an aside its own aside", () => {
    // Nesting would be unbounded and no surface renders the second level.
    expect(
      surfaceBindingForContextResource({
        kind: "session",
        sessionId: "resource-workbench:session:s",
        capabilities: [],
      })
    ).toBeNull()
  })

  it("refuses the dock's no-conversation placeholder", () => {
    expect(
      surfaceBindingForContextResource({ kind: "session", sessionId: "none", capabilities: [] })
    ).toBeNull()
  })

  it("gives a session binding its own id namespace", () => {
    expect(resourceWorkbenchSessionId({ kind: "session", sessionId: "s1" })).toBe(
      "resource-workbench:session:s1"
    )
  })

  it("uses stable encoded ids and repairs an older row with the same id", async () => {
    expect(
      resourceWorkbenchSessionId({
        kind: "project-file",
        projectId: "p",
        rootId: "r",
        relPath: "src/a.ts",
      })
    ).toBe("resource-workbench:project:p:r:src%2Fa.ts")
    expect(resourceWorkbenchSessionId({ kind: "canvas-document", documentId: "d" })).toBe(
      "resource-workbench:canvas:d"
    )
    expect(resourceWorkbenchSessionId({ kind: "workflow", workflowId: "w" })).toBe(
      "resource-workbench:workflow:w"
    )

    const binding: SessionSurfaceBinding = { kind: "artifact", artifactId: "a" }
    const stale = {
      id: resourceWorkbenchSessionId(binding),
      title: "Old",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession
    const update = jest.fn().mockResolvedValue(1)
    const repaired = await ensureResourceWorkbenchSession(binding, "Artifact", {
      get: async () => stale,
      put: async () => undefined,
      update,
      now: () => 20,
    })

    expect(update).toHaveBeenCalledWith(
      stale.id,
      expect.objectContaining({ kind: "resource-workbench", visibility: "embedded" })
    )
    expect(repaired.visibility).toBe("embedded")
  })

  it("repairs a renamed row by its actual id when it is found by binding", async () => {
    const binding: SessionSurfaceBinding = {
      kind: "project-file",
      projectId: "p",
      rootId: "r",
      relPath: "new.ts",
    }
    const migrated = {
      id: "resource-workbench:project:p:r:old.ts",
      title: "Old path",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
      surfaceBinding: binding,
    } as ChatSession
    const update = jest.fn().mockResolvedValue(1)
    await ensureResourceWorkbenchSession(binding, "New path", {
      get: async () => undefined,
      findByBinding: async () => migrated,
      put: async () => undefined,
      update,
    })
    expect(update).toHaveBeenCalledWith(
      migrated.id,
      expect.objectContaining({ kind: "resource-workbench", visibility: "embedded" })
    )
  })
})
