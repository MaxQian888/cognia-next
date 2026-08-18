import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import {
  LARK_DOC_SEARCH_PATH,
  LARK_SEARCH_DOCS_TYPES,
  LARK_SEARCH_MAX_COUNT,
  searchLarkDocs,
} from "./search"

interface Call {
  path: string
  body: Record<string, unknown>
}

function fakeApi(data: unknown): { api: LarkAuthedApi; calls: Call[] } {
  const calls: Call[] = []
  const api: LarkAuthedApi = {
    get: async () => {
      throw new Error("search must not GET")
    },
    post: async <T>(path: string, body: unknown) => {
      calls.push({ path, body: body as Record<string, unknown> })
      return data as T
    },
  }
  return { api, calls }
}

describe("searchLarkDocs", () => {
  it("posts the search key, the clamped count and only the readable doc types", async () => {
    const { api, calls } = fakeApi({ docs_entities: [] })
    await searchLarkDocs(api, "quarterly", 500)

    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe(LARK_DOC_SEARCH_PATH)
    expect(calls[0].body).toEqual({
      search_key: "quarterly",
      // Feishu rejects anything above 50.
      count: LARK_SEARCH_MAX_COUNT,
      docs_types: [...LARK_SEARCH_DOCS_TYPES],
    })
    // `slides` / `mindnote` have no read API — offering them would hand the
    // user a result that always fails at fetch time.
    expect(calls[0].body.docs_types).not.toContain("slides")
  })

  it("clamps a non-positive limit up to one rather than sending it", async () => {
    const { api, calls } = fakeApi({ docs_entities: [] })
    await searchLarkDocs(api, "q", 0)
    expect(calls[0].body.count).toBe(1)
  })

  it("maps docs_type onto our kinds, folding docx into doc", async () => {
    const { api } = fakeApi({
      docs_entities: [
        { docs_token: "doccnA", docs_type: "docx", title: "New doc" },
        { docs_token: "doccnB", docs_type: "doc", title: "Legacy doc" },
        { docs_token: "shtcnC", docs_type: "sheet", title: "Sheet" },
        { docs_token: "bascnD", docs_type: "bitable", title: "Base" },
      ],
    })

    expect(await searchLarkDocs(api, "q", 10)).toEqual([
      { providerId: "lark", kind: "doc", id: "doccnA", title: "New doc" },
      { providerId: "lark", kind: "doc", id: "doccnB", title: "Legacy doc" },
      { providerId: "lark", kind: "sheet", id: "shtcnC", title: "Sheet" },
      { providerId: "lark", kind: "bitable", id: "bascnD", title: "Base" },
    ])
  })

  it("drops entities we cannot open and falls back to the token for a blank title", async () => {
    const { api } = fakeApi({
      docs_entities: [
        // Returned by Feishu despite `docs_types`, and unreadable.
        { docs_token: "sldcnE", docs_type: "slides", title: "Deck" },
        { docs_token: "doccnF", docs_type: undefined, title: "Untyped" },
        { docs_token: undefined, docs_type: "docx", title: "Tokenless" },
        { docs_token: "doccnG", docs_type: "docx", title: "   " },
      ],
    })

    expect(await searchLarkDocs(api, "q", 10)).toEqual([
      { providerId: "lark", kind: "doc", id: "doccnG", title: "doccnG" },
    ])
  })

  it("treats a response with no entities array as no results", async () => {
    const { api } = fakeApi({ has_more: false, total: 0 })
    expect(await searchLarkDocs(api, "q", 10)).toEqual([])
  })
})
