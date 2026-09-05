import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import {
  bitableCellDate,
  bitableCellNumber,
  bitableCellText,
  buildLarkTaskPatch,
  createBitableRecord,
  createLarkTask,
  getLarkTask,
  listBitableFields,
  listBitableRecords,
  listBitableTables,
  listLarkSections,
  listLarkTasklists,
  listLarkTasklistTasks,
  normalizeLarkTask,
  updateBitableRecord,
  updateLarkTask,
} from "./lark-api"

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

describe("normalizeLarkTask", () => {
  it("turns the wire shape into epoch numbers and drops junk", () => {
    expect(
      normalizeLarkTask({
        guid: "t1",
        summary: "Do it",
        description: "body",
        due: { timestamp: "1700000000000", is_all_day: true },
        completed_at: "0",
        members: [{ id: "ou_1", type: "user", role: "assignee", name: "Ada" }, { type: "user" }],
        tasklists: [{ tasklist_guid: "tl", section_guid: "s1" }, {}],
        url: "https://x",
        created_at: "1600000000000",
        updated_at: "1650000000000",
      })
    ).toEqual({
      guid: "t1",
      summary: "Do it",
      description: "body",
      dueAt: 1700000000000,
      dueIsAllDay: true,
      members: [{ id: "ou_1", type: "user", role: "assignee", name: "Ada" }],
      tasklists: [{ tasklistGuid: "tl", sectionGuid: "s1" }],
      url: "https://x",
      createdAt: 1600000000000,
      updatedAt: 1650000000000,
    })
    expect(normalizeLarkTask({ summary: "no guid" })).toBeNull()
    expect(normalizeLarkTask({ guid: "t2", completed_at: "1650000000001" })?.completedAt).toBe(
      1650000000001
    )
  })
})

describe("task reads", () => {
  it("pages tasklists and sections, and reads every task in full", async () => {
    const { api, calls } = fakeApi({
      "/open-apis/task/v2/tasklists?": () => ({ items: [{ guid: "tl", name: "Team" }] }),
      "/open-apis/task/v2/sections?": () => ({
        items: [{ guid: "s1", name: "Sprint 1", is_default: false }],
      }),
      "/open-apis/task/v2/tasklists/tl/tasks": () => ({
        items: [{ guid: "t1" }, { guid: "t2" }],
        has_more: false,
      }),
      "/open-apis/task/v2/tasks/t1": () => ({ task: { guid: "t1", summary: "One" } }),
      "/open-apis/task/v2/tasks/t2": () => ({ task: { guid: "t2", summary: "Two" } }),
    })
    expect(await listLarkTasklists(api)).toEqual([{ guid: "tl", name: "Team" }])
    expect(await listLarkSections(api, "tl")).toEqual([
      { guid: "s1", name: "Sprint 1", isDefault: false },
    ])
    const listed = await listLarkTasklistTasks(api, "tl")
    expect(listed.tasks.map((task) => task.summary)).toEqual(["One", "Two"])
    expect(listed.truncated).toBe(false)
    expect(calls.filter((call) => call.path.includes("/tasks/t")).map((c) => c.method)).toEqual([
      "GET",
      "GET",
    ])
    expect(await getLarkTask(api, "t1")).toMatchObject({ guid: "t1" })
  })

  it("follows page tokens", async () => {
    let page = 0
    const { api } = fakeApi({
      "/open-apis/task/v2/tasklists?": () => {
        page += 1
        return page === 1
          ? { items: [{ guid: "a", name: "A" }], has_more: true, page_token: "p2" }
          : { items: [{ guid: "b", name: "B" }], has_more: false }
      },
    })
    expect((await listLarkTasklists(api)).map((row) => row.guid)).toEqual(["a", "b"])
  })
})

describe("task writes", () => {
  it("builds a PATCH body that names only the fields it carries", () => {
    expect(buildLarkTaskPatch({ summary: "S", dueAt: null, completed: true }, 42)).toEqual({
      task: { summary: "S", due: null, completed_at: "42" },
      update_fields: ["summary", "due", "completed_at"],
    })
    expect(buildLarkTaskPatch({ completed: false, dueAt: 5 })).toEqual({
      task: { completed_at: "0", due: { timestamp: "5", is_all_day: true } },
      update_fields: ["due", "completed_at"],
    })
    expect(buildLarkTaskPatch({})).toEqual({ task: {}, update_fields: [] })
  })

  it("sends the patch and the create body to the right routes", async () => {
    const { api, calls } = fakeApi({
      "/open-apis/task/v2/tasks/t1": () => ({
        task: { guid: "t1", summary: "S", updated_at: "9" },
      }),
      "/open-apis/task/v2/tasks?": () => ({ task: { guid: "new", summary: "N", url: "u" } }),
    })
    const updated = await updateLarkTask(api, "t1", { summary: "S" }, 1)
    expect(updated?.updatedAt).toBe(9)
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: { task: { summary: "S" }, update_fields: ["summary"] },
    })
    // An empty patch is a read, not a write.
    await updateLarkTask(api, "t1", {})
    expect(calls[1].method).toBe("GET")
    const created = await createLarkTask(api, {
      tasklistGuid: "tl",
      sectionGuid: "s1",
      summary: "N",
      dueAt: 7,
    })
    expect(created?.guid).toBe("new")
    expect(calls[2]).toMatchObject({
      method: "POST",
      body: {
        summary: "N",
        due: { timestamp: "7", is_all_day: true },
        tasklists: [{ tasklist_guid: "tl", section_guid: "s1" }],
      },
    })
  })
})

describe("bitable", () => {
  it("lists tables and fields, walks record pages, and writes records", async () => {
    let searchPage = 0
    const { api, calls } = fakeApi({
      "/open-apis/bitable/v1/apps/app/tables/tbl/fields": () => ({
        items: [{ field_id: "f1", field_name: "Name", type: 1 }, { field_name: "no id" }],
      }),
      "/open-apis/bitable/v1/apps/app/tables/tbl/records/search": () => {
        searchPage += 1
        return searchPage === 1
          ? {
              items: [{ record_id: "r1", fields: { Name: "A" }, last_modified_time: 5 }],
              has_more: true,
              page_token: "n",
            }
          : { items: [{ record_id: "r2", fields: { Name: "B" } }, { fields: {} }], has_more: false }
      },
      "/open-apis/bitable/v1/apps/app/tables/tbl/records/r1": () => ({}),
      "/open-apis/bitable/v1/apps/app/tables/tbl/records": () => ({ record: { record_id: "r9" } }),
      "/open-apis/bitable/v1/apps/app/tables": () => ({
        items: [{ table_id: "tbl", name: "Backlog" }],
      }),
    })
    expect(await listBitableTables(api, "app")).toEqual([{ tableId: "tbl", name: "Backlog" }])
    expect(await listBitableFields(api, "app", "tbl")).toEqual([
      { fieldId: "f1", name: "Name", type: 1 },
    ])
    const { records, truncated } = await listBitableRecords(api, "app", "tbl")
    expect(records).toEqual([
      { recordId: "r1", fields: { Name: "A" }, lastModifiedAt: 5 },
      { recordId: "r2", fields: { Name: "B" } },
    ])
    expect(truncated).toBe(false)
    await updateBitableRecord(api, "app", "tbl", "r1", { Name: "C" })
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { fields: { Name: "C" } } })
    expect(await createBitableRecord(api, "app", "tbl", { Name: "D" })).toBe("r9")
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { fields: { Name: "D" } } })
  })

  it("flattens cells to what a person sees", () => {
    expect(bitableCellText("x")).toBe("x")
    expect(bitableCellText(3)).toBe("3")
    expect(bitableCellText([{ text: "a", type: "text" }, { text: "b" }])).toBe("a, b")
    expect(bitableCellText([{ name: "Ada", id: "ou" }])).toBe("Ada")
    expect(bitableCellText({ link: "https://x" })).toBe("https://x")
    expect(bitableCellText(null)).toBeNull()
    expect(bitableCellText([])).toBeNull()
    expect(bitableCellDate(1700000000000)).toBe(1700000000000)
    expect(bitableCellDate("1700000000000")).toBe(1700000000000)
    expect(bitableCellDate("")).toBeNull()
    expect(bitableCellNumber("3.5")).toBe(3.5)
    expect(bitableCellNumber("x")).toBeNull()
  })
})
