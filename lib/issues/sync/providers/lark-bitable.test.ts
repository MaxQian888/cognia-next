import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type { IssueProject, LarkBitableFieldMap } from "@/types/issues"
import type { IssueSyncBinding } from "../types"
import {
  bitableFieldsFromIssue,
  bitableFieldsFromPatch,
  bitableRecordToRemote,
  createLarkBitableSyncProvider,
  mappedFields,
} from "./lark-bitable"

jest.mock("@/lib/connectors/adapters/lark/authed-api", () => ({
  withLarkAuthedApi: jest.fn(),
}))

const fieldMap: LarkBitableFieldMap = {
  title: "Name",
  description: "Notes",
  status: "State",
  statusValues: { todo: "To do", done: "Finished" },
  priority: "Priority",
  assignee: "Owner",
  dueDate: "Due",
  estimate: "Points",
}

const resource = {
  kind: "lark-bitable" as const,
  adapterId: "cai_1",
  appToken: "app",
  tableId: "tbl",
  name: "Backlog",
  fieldMap,
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
    providerId: "lark-bitable",
    projectId: "w1",
    issueProjectId: "p1",
    projectKey: "MERC",
    resource,
    key: "cai_1:app:tbl",
  }
}

describe("pure transforms", () => {
  it("lists the fields the map covers", () => {
    expect(mappedFields({ title: "Name" })).toEqual(["title"])
    expect(mappedFields(fieldMap)).toEqual([
      "title",
      "description",
      "status",
      "priority",
      "assignee",
      "dueDate",
      "estimate",
    ])
  })

  it("maps a record through the field map, tolerating option casing and missing cells", () => {
    const remote = bitableRecordToRemote(
      {
        recordId: "r1",
        fields: {
          Name: [{ text: "Fix login" }],
          Notes: "body",
          State: "finished",
          Priority: "High",
          Owner: [{ name: "Ada" }],
          Due: 1700000000000,
          Points: "3",
        },
        lastModifiedAt: 9,
      },
      fieldMap,
      100
    )
    expect(remote).toEqual({
      externalId: "r1",
      label: "Fix login",
      title: "Fix login",
      status: "done",
      remoteUpdatedAt: 9,
      description: "body",
      priority: "high",
      assigneeLabel: "Ada",
      dueDate: 1700000000000,
      estimate: 3,
    })
    expect(
      bitableRecordToRemote({ recordId: "r2", fields: { Name: "" } }, fieldMap, 100)
    ).toBeNull()
    expect(
      bitableRecordToRemote({ recordId: "r3", fields: { Name: "x", State: "???" } }, fieldMap, 100)
    ).toMatchObject({
      status: "backlog",
      remoteUpdatedAt: 100,
      assigneeLabel: null,
      dueDate: null,
      estimate: null,
    })
  })

  it("writes only mapped columns, using the option text for status", () => {
    expect(
      bitableFieldsFromPatch(
        { title: "T", status: "todo", labels: ["x"], dueDate: null, estimate: 2 },
        fieldMap
      )
    ).toEqual({
      Name: "T",
      State: "To do",
      Due: null,
      Points: 2,
    })
    expect(
      bitableFieldsFromPatch({ status: "in_review", description: "d" }, { title: "Name" })
    ).toEqual({})
    expect(
      bitableFieldsFromIssue(
        { title: "T", status: "in_review", priority: "low" } as never,
        fieldMap
      )
    ).toEqual({
      Name: "T",
      Notes: "",
      State: "in_review",
      Priority: "low",
      Due: null,
      Points: null,
    })
  })
})

describe("provider", () => {
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

  it("binds lark-bitable resources once each", () => {
    const provider = createLarkBitableSyncProvider({ withApi: async () => undefined as never })
    expect(provider.resolveBindings([container([resource]), container([resource], "p2")])).toEqual([
      expect.objectContaining({
        providerId: "lark-bitable",
        issueProjectId: "p1",
        key: "cai_1:app:tbl",
      }),
    ])
  })

  it("pulls, pushes and creates through the bound account", async () => {
    const { api, calls } = fakeApi({
      "/open-apis/bitable/v1/apps/app/tables/tbl/records/search": () => ({
        items: [
          { record_id: "r1", fields: { Name: "A" }, last_modified_time: 50 },
          { record_id: "r0", fields: { Name: "Old" }, last_modified_time: 1 },
        ],
      }),
      "/open-apis/bitable/v1/apps/app/tables/tbl/records/r1": () => ({}),
      "/open-apis/bitable/v1/apps/app/tables/tbl/records": () => ({ record: { record_id: "r9" } }),
    })
    const provider = createLarkBitableSyncProvider({
      withApi: (async (_id: string, fn: (api: LarkAuthedApi) => Promise<unknown>) =>
        fn(api)) as never,
      now: () => 1000,
    })
    const pulled = await provider.pull(binding(), { since: 10 })
    expect(pulled.items.map((item) => item.externalId)).toEqual(["r1"])
    const outcome = await provider.push!(
      binding(),
      { provider: "lark-bitable", externalId: "r1" },
      { title: "B" },
      {} as never,
      {
        idempotencyKey: "k",
        by: { kind: "agent" },
      }
    )
    expect(outcome).toEqual({ status: "applied", remoteUpdatedAt: 1000 })
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { fields: { Name: "B" } } })
    expect(
      await provider.push!(
        binding(),
        { provider: "lark-bitable", externalId: "r1" },
        { labels: ["x"] },
        {} as never,
        { idempotencyKey: "k", by: { kind: "agent" } }
      )
    ).toEqual({ status: "applied" })
    const ref = await provider.create!(binding(), {
      title: "N",
      status: "todo",
      priority: "none",
    } as never)
    expect(ref).toMatchObject({
      provider: "lark-bitable",
      externalId: "r9",
      label: "N",
      meta: { binding: "cai_1:app:tbl" },
    })
  })
})
