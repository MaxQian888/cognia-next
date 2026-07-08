/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  diffSnapshots,
  installAgentTeamProjection,
  reconcileAgentTeamProjection,
} from "./agent-team-projection"
import { boardRowFromTask, teamMetaRowId } from "./agent-team-board"
import { getDb, __resetDbForTesting } from "./schema"

jest.mock("@/lib/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: {
      agent: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
    },
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

const flushMicrotasks = async () => {
  // The projection coalesces via queueMicrotask, then awaits Dexie writes —
  // a couple of macrotask turns settles both.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  localStorage.clear()
  useAgentTeamStore.getState().reset()
  await getDb().delete()
  __resetDbForTesting()
})

describe("diffSnapshots", () => {
  it("emits puts for changed tasks, deletes for removed ones, and refreshes dirty team meta", () => {
    const state = useAgentTeamStore.getState()
    const team = state.createTeam({ name: "T", task: "t" })
    const a = state.createTask({ teamId: team.id, title: "a", description: "" })
    const b = state.createTask({ teamId: team.id, title: "b", description: "" })
    const prev = {
      tasks: useAgentTeamStore.getState().tasks,
      teams: useAgentTeamStore.getState().teams,
      teammates: useAgentTeamStore.getState().teammates,
    }

    useAgentTeamStore.getState().updateTask(a.id, { title: "a2" })
    useAgentTeamStore.getState().deleteTask(b.id)
    const next = {
      tasks: useAgentTeamStore.getState().tasks,
      teams: useAgentTeamStore.getState().teams,
      teammates: useAgentTeamStore.getState().teammates,
    }

    const { puts, deletes } = diffSnapshots(prev, next, 999)
    const putIds = puts.map((r) => r.id).sort()
    // Changed task + the team meta row (deleteTask touched team.taskIds).
    expect(putIds).toEqual([a.id, teamMetaRowId(team.id)].sort())
    expect(deletes).toEqual([b.id])
    expect(puts.find((r) => r.id === a.id)).toMatchObject({ title: "a2", updatedAt: 999 })
  })

  it("deleting a team emits its meta-row tombstone", () => {
    const state = useAgentTeamStore.getState()
    const team = state.createTeam({ name: "T", task: "t" })
    const prev = {
      tasks: useAgentTeamStore.getState().tasks,
      teams: useAgentTeamStore.getState().teams,
      teammates: useAgentTeamStore.getState().teammates,
    }
    useAgentTeamStore.getState().deleteTeam(team.id)
    const next = {
      tasks: useAgentTeamStore.getState().tasks,
      teams: useAgentTeamStore.getState().teams,
      teammates: useAgentTeamStore.getState().teammates,
    }
    const { deletes } = diffSnapshots(prev, next, 1)
    expect(deletes).toContain(teamMetaRowId(team.id))
  })
})

describe("reconcileAgentTeamProjection", () => {
  it("projects the whole store and prunes orphan rows with tombstones", async () => {
    // Orphan row from a previous install.
    await getDb().agentTeamBoard.put(
      boardRowFromTask(
        {
          id: "orphan",
          teamId: "ghost",
          title: "o",
          description: "",
          status: "pending",
          priority: "normal",
          dependencies: [],
          tags: [],
          createdAt: new Date(),
          order: 0,
        } as never,
        1
      )
    )

    const state = useAgentTeamStore.getState()
    const team = state.createTeam({ name: "T", task: "t" })
    const a = state.createTask({ teamId: team.id, title: "a", description: "" })

    await reconcileAgentTeamProjection(500)

    const ids = (await getDb().agentTeamBoard.toCollection().primaryKeys()).sort()
    expect(ids).toEqual([a.id, teamMetaRowId(team.id)].sort())
    const tombstone = await getDb().syncTombstones.get(["agentTeamBoard", "orphan"])
    expect(tombstone).toMatchObject({ table: "agentTeamBoard", id: "orphan" })
  })
})

describe("installAgentTeamProjection", () => {
  it("write-throughs store changes and tombstones deletions until uninstalled", async () => {
    const uninstall = installAgentTeamProjection()
    await flushMicrotasks()

    const state = useAgentTeamStore.getState()
    const team = state.createTeam({ name: "T", task: "t" })
    const created = state.createTask({ teamId: team.id, title: "X", description: "" })
    await flushMicrotasks()

    const row = await getDb().agentTeamBoard.get(created.id)
    expect(row).toMatchObject({ kind: "task", title: "X", teamId: team.id })
    expect(await getDb().agentTeamBoard.get(teamMetaRowId(team.id))).toBeDefined()

    // Status flip flows through.
    useAgentTeamStore.getState().moveTask(created.id, "cancelled")
    await flushMicrotasks()
    expect((await getDb().agentTeamBoard.get(created.id))?.kind === "task").toBe(true)
    expect(await getDb().agentTeamBoard.get(created.id)).toMatchObject({ status: "cancelled" })

    // Deletion → row gone + tombstone recorded.
    useAgentTeamStore.getState().deleteTask(created.id)
    await flushMicrotasks()
    expect(await getDb().agentTeamBoard.get(created.id)).toBeUndefined()
    expect(await getDb().syncTombstones.get(["agentTeamBoard", created.id])).toMatchObject({
      table: "agentTeamBoard",
      id: created.id,
    })

    // After uninstall, further store writes stop flowing.
    uninstall()
    const late = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "late", description: "" })
    await flushMicrotasks()
    expect(await getDb().agentTeamBoard.get(late.id)).toBeUndefined()
  })
})
