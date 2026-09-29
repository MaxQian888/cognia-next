import type { ChatSession } from "@cognia/agent-config-types"
import type { Project, ProjectCoordinatorConfig } from "@/types"
import { patchCoordinatorConfig } from "./config"
import {
  ensureCoordinatorSession,
  findCoordinatorSession,
  type CoordinatorSessionDeps,
} from "./coordinator-session"

function setup(coordinator?: ProjectCoordinatorConfig, existing: ChatSession[] = []) {
  let project = { id: "p1", coordinator } as Project
  const rows = new Map(existing.map((s) => [s.id, s]))
  let seq = 0
  const deps: CoordinatorSessionDeps = {
    getProject: (id) => (id === project.id ? project : undefined),
    updateCoordinator: (_id, patch) => {
      project = { ...project, coordinator: patchCoordinatorConfig(project.coordinator, patch) }
      return project
    },
    getSession: async (id) => rows.get(id),
    listWorkspaceSessions: async () => [...rows.values()],
    startNewSession: jest.fn(async (input) => {
      const session = {
        id: `s${++seq}`,
        projectId: input.projectId,
        title: input.title ?? "",
        createdAt: 1,
        updatedAt: 1,
      } as ChatSession
      rows.set(session.id, session)
      return session
    }),
    updateSession: jest.fn(async (id, patch) => {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, ...patch })
    }),
  }
  return { deps, rows, project: () => project }
}

const coordinatorRow = (id: string, extra: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    projectId: "p1",
    projectRole: "coordinator",
    title: "Coordinator",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) as ChatSession

describe("ensureCoordinatorSession", () => {
  it("creates a local, non-activated coordinator and records the pointer", async () => {
    const { deps, rows, project } = setup({
      enabled: true,
      model: { coordinator: { modelId: "claude-sonnet-5", effort: "low" } },
    })
    const session = await ensureCoordinatorSession({ projectId: "p1", title: "Coordinator" }, deps)
    expect(deps.startNewSession).toHaveBeenCalledWith({
      projectId: "p1",
      title: "Coordinator",
      executionLocation: "local",
      rememberChoice: false,
      activate: false,
      model: "claude-sonnet-5",
    })
    expect(rows.get(session.id)).toMatchObject({
      projectRole: "coordinator",
      titleAuto: false,
      effort: "low",
      thinkingLevel: "low",
    })
    expect(project().coordinator?.sessionId).toBe(session.id)
  })

  it("returns the pointed coordinator without creating another", async () => {
    const { deps } = setup({ enabled: true, sessionId: "c1" }, [coordinatorRow("c1")])
    await expect(
      ensureCoordinatorSession({ projectId: "p1", title: "x" }, deps)
    ).resolves.toMatchObject({ id: "c1" })
    expect(deps.startNewSession).not.toHaveBeenCalled()
  })

  it("repairs a stale pointer from a coordinator found by role", async () => {
    const { deps, project } = setup({ enabled: true, sessionId: "gone" }, [
      coordinatorRow("archived", { archivedAt: 5 }),
      coordinatorRow("c2"),
    ])
    const session = await ensureCoordinatorSession({ projectId: "p1", title: "x" }, deps)
    expect(session.id).toBe("c2")
    expect(project().coordinator?.sessionId).toBe("c2")
    expect(deps.startNewSession).not.toHaveBeenCalled()
  })

  it("shares one creation between concurrent calls", async () => {
    const { deps } = setup({ enabled: true })
    const [a, b] = await Promise.all([
      ensureCoordinatorSession({ projectId: "p1", title: "x" }, deps),
      ensureCoordinatorSession({ projectId: "p1", title: "x" }, deps),
    ])
    expect(a.id).toBe(b.id)
    expect(deps.startNewSession).toHaveBeenCalledTimes(1)
  })

  it("rejects an unknown workspace", async () => {
    const { deps } = setup()
    await expect(ensureCoordinatorSession({ projectId: "zz", title: "x" }, deps)).rejects.toThrow(
      /zz/
    )
  })
})

describe("findCoordinatorSession", () => {
  it("never creates, and ignores a pointer at a non-coordinator", async () => {
    const { deps } = setup({ enabled: true, sessionId: "c1" }, [coordinatorRow("c1")])
    await expect(findCoordinatorSession("p1", deps)).resolves.toMatchObject({ id: "c1" })
    const plain = setup({ enabled: true, sessionId: "c1" }, [
      coordinatorRow("c1", { projectRole: undefined }),
    ])
    await expect(findCoordinatorSession("p1", plain.deps)).resolves.toBeUndefined()
    await expect(findCoordinatorSession("p1", setup().deps)).resolves.toBeUndefined()
  })
})
