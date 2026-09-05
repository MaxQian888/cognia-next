import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type { IssueProject } from "@/types/issues"
import type { IssueSyncBinding } from "../types"
import {
  createLarkTaskSyncProvider,
  larkTaskToRemote,
  sectionExternalId,
  statusToLarkCompleted,
  toLarkTaskPatch,
} from "./lark-task"

jest.mock("@/lib/connectors/adapters/lark/authed-api", () => ({
  withLarkAuthedApi: jest.fn(),
}))

const resource = {
  kind: "lark-tasklist" as const,
  adapterId: "cai_1",
  tasklistGuid: "tl",
  name: "Team",
  addedAt: 1,
}

function container(resources: IssueProject["resources"], id = "p1"): IssueProject {
  return {
    id,
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "backlog",
    priority: "none",
    resources,
    createdAt: 1,
    updatedAt: 1,
  }
}

function binding(): IssueSyncBinding {
  return {
    providerId: "lark-task",
    projectId: "w1",
    issueProjectId: "p1",
    projectKey: "MERC",
    resource,
    key: "cai_1:tl",
  }
}

function fakeApi(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const handle = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) })
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate))
    if (!key) throw new Error(`unexpected ${method} ${path}`)
    return Promise.resolve(routes[key](body))
  }
  const api: LarkAuthedApi = {
    get: (path) => handle("GET", path) as never,
    post: (path, body) => handle("POST", path, body) as never,
    patch: (path, body) => handle("PATCH", path, body) as never,
    put: (path, body) => handle("PUT", path, body) as never,
    delete: (path) => handle("DELETE", path) as never,
  }
  return { api, calls }
}

describe("pure transforms", () => {
  it("maps a task onto the remote shape with a coarse status", () => {
    expect(
      larkTaskToRemote(
        {
          guid: "t1",
          summary: "Do it",
          description: "d",
          dueAt: 5,
          members: [{ id: "ou", role: "assignee", name: "Ada" }],
          tasklists: [{ tasklistGuid: "tl", sectionGuid: "s1" }],
          url: "u",
          updatedAt: 9,
        },
        "tl"
      )
    ).toEqual({
      externalId: "t1",
      url: "u",
      label: "Do it",
      title: "Do it",
      description: "d",
      status: "todo",
      coarseStatus: true,
      assigneeLabel: "Ada",
      dueDate: 5,
      cycleExternalId: sectionExternalId("s1"),
      remoteUpdatedAt: 9,
    })
    expect(
      larkTaskToRemote(
        { guid: "t2", summary: "Done", completedAt: 3, members: [], tasklists: [] },
        "tl"
      )
    ).toMatchObject({
      status: "done",
      assigneeLabel: null,
      dueDate: null,
      cycleExternalId: null,
      remoteUpdatedAt: 0,
    })
  })

  it("maps status and patches onto the task's two states", () => {
    expect(statusToLarkCompleted("in_progress")).toBe(false)
    expect(statusToLarkCompleted("done")).toBe(true)
    expect(statusToLarkCompleted("canceled")).toBe(true)
    expect(
      toLarkTaskPatch({
        title: "T",
        description: null,
        dueDate: null,
        status: "done",
        labels: ["x"],
      })
    ).toEqual({
      summary: "T",
      description: "",
      dueAt: null,
      completed: true,
    })
  })
})

describe("provider", () => {
  it("binds lark-tasklist resources once each", () => {
    const provider = createLarkTaskSyncProvider({ withApi: async () => undefined as never })
    const bindings = provider.resolveBindings([
      container([resource, { kind: "github-repo", repoFullName: "o/r", addedAt: 1 }], "p2"),
      container([resource], "p1"),
    ])
    expect(bindings).toEqual([
      expect.objectContaining({ providerId: "lark-task", issueProjectId: "p1", key: "cai_1:tl" }),
    ])
  })

  it("pulls sections as cycles and tasks as items, filtered by the watermark", async () => {
    const { api } = fakeApi({
      "/open-apis/task/v2/sections?": () => ({ items: [{ guid: "s1", name: "Sprint 1" }] }),
      "/open-apis/task/v2/tasklists/tl/tasks": () => ({
        items: [{ guid: "old" }, { guid: "new" }],
      }),
      "/open-apis/task/v2/tasks/old": () => ({
        task: { guid: "old", summary: "Old", updated_at: "5" },
      }),
      "/open-apis/task/v2/tasks/new": () => ({
        task: { guid: "new", summary: "New", updated_at: "50" },
      }),
    })
    const withApi = jest.fn(async (_id: string, fn: (api: LarkAuthedApi) => Promise<unknown>) =>
      fn(api)
    )
    const provider = createLarkTaskSyncProvider({ withApi: withApi as never })
    const result = await provider.pull(binding(), { since: 10 })
    expect(withApi).toHaveBeenCalledWith("cai_1", expect.any(Function))
    expect(result.cycles).toEqual([
      { externalId: "section/s1", kind: "cycle", name: "Sprint 1", status: "active" },
    ])
    expect(result.items.map((item) => item.externalId)).toEqual(["new"])
    expect((await provider.pull(binding(), { full: true })).items).toHaveLength(2)
  })

  it("pushes through PATCH and creates through POST, returning the ref", async () => {
    const { api, calls } = fakeApi({
      "/open-apis/task/v2/tasks/t1": () => ({
        task: { guid: "t1", summary: "T", updated_at: "77" },
      }),
      "/open-apis/task/v2/tasks?": () => ({
        task: { guid: "new", summary: "N", url: "u", updated_at: "88" },
      }),
    })
    const provider = createLarkTaskSyncProvider({
      withApi: (async (_id: string, fn: (api: LarkAuthedApi) => Promise<unknown>) =>
        fn(api)) as never,
      now: () => 1000,
    })
    const outcome = await provider.push!(
      binding(),
      { provider: "lark-task", externalId: "t1" },
      { title: "T", status: "done" },
      {} as never,
      {
        idempotencyKey: "k",
        by: { kind: "agent" },
      }
    )
    expect(outcome).toEqual({ status: "applied", remoteUpdatedAt: 77 })
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: { task: { summary: "T", completed_at: "1000" } },
    })
    const ref = await provider.create!(binding(), {
      title: "N",
      description: "d",
      dueDate: 5,
    } as never)
    expect(ref).toEqual({
      provider: "lark-task",
      externalId: "new",
      url: "u",
      label: "N",
      syncedAt: 1000,
      remoteUpdatedAt: 88,
      meta: { binding: "cai_1:tl" },
    })
  })
})
