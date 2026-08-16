import { statusCategoryOf } from "@/types/issues"
import type { IssueSourceAdapter, IssueSourceKind, UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, makeUnifiedIssueId } from "@/types/issues/unified"
import {
  createIssueSourceRegistry,
  getIssueSourceRegistry,
  resetIssueSourceRegistry,
} from "./registry"

function item(kind: IssueSourceKind, sourceId: string, order = 0): UnifiedIssueItem {
  return {
    unifiedId: makeUnifiedIssueId(kind, sourceId),
    kind,
    sourceId,
    identifier: sourceId,
    title: sourceId,
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order,
    createdAt: 0,
    updatedAt: 0,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
  }
}

function stubSource(
  kind: IssueSourceKind,
  list: () => Promise<UnifiedIssueItem[]>
): IssueSourceAdapter {
  return { kind, label: kind, list }
}

const QUERY = { projectId: "w1" }

describe("IssueSourceRegistry", () => {
  it("registers, resolves and unregisters by kind", () => {
    const registry = createIssueSourceRegistry()
    const source = stubSource("local", async () => [])
    registry.register(source)

    expect(registry.has("local")).toBe(true)
    expect(registry.getSource("local")).toBe(source)
    expect(registry.listAllSources()).toEqual([source])

    registry.unregister("local")
    expect(registry.has("local")).toBe(false)
    expect(registry.getSource("local")).toBeUndefined()
  })

  it("replaces a source registered twice for the same kind", () => {
    const registry = createIssueSourceRegistry()
    const first = stubSource("local", async () => [])
    const second = stubSource("local", async () => [])
    registry.register(first)
    registry.register(second)
    expect(registry.listAllSources()).toEqual([second])
  })

  it("clears every source", () => {
    const registry = createIssueSourceRegistry()
    registry.register(stubSource("local", async () => []))
    registry.clear()
    expect(registry.listAllSources()).toEqual([])
  })

  it("passes the query through to each source", async () => {
    const registry = createIssueSourceRegistry()
    const list = jest.fn().mockResolvedValue([])
    registry.register(stubSource("local", list))
    await registry.listAll({ projectId: "w1", issueProjectId: "p1" })
    expect(list).toHaveBeenCalledWith({ projectId: "w1", issueProjectId: "p1" })
  })

  it("merges every source's items into one sorted list", async () => {
    const registry = createIssueSourceRegistry()
    registry.register(stubSource("local", async () => [item("local", "b", 1)]))
    registry.register(stubSource("github", async () => [item("github", "a", 0)]))

    const { items, errors } = await registry.listAll(QUERY)
    expect(errors).toEqual([])
    expect(items.map((i) => i.unifiedId)).toEqual(["github:a", "local:b"])
  })

  it("returns an empty result when nothing is registered", async () => {
    expect(await createIssueSourceRegistry().listAll(QUERY)).toEqual({ items: [], errors: [] })
  })

  it("keeps a healthy source's items when another source throws", async () => {
    // A broken GitHub token must never blank out the user's local issues.
    const registry = createIssueSourceRegistry()
    const boom = new Error("token expired")
    registry.register(stubSource("local", async () => [item("local", "kept")]))
    registry.register(
      stubSource("github", async () => {
        throw boom
      })
    )

    const { items, errors } = await registry.listAll(QUERY)
    expect(items.map((i) => i.sourceId)).toEqual(["kept"])
    expect(errors).toEqual([{ kind: "github", error: boom }])
  })

  it("reports every failing source, not just the first", async () => {
    const registry = createIssueSourceRegistry()
    for (const kind of ["github", "agent-team"] as const) {
      registry.register(
        stubSource(kind, async () => {
          throw new Error(kind)
        })
      )
    }
    const { items, errors } = await registry.listAll(QUERY)
    expect(items).toEqual([])
    expect(errors.map((e) => e.kind).sort()).toEqual(["agent-team", "github"])
  })
})

describe("getIssueSourceRegistry", () => {
  afterEach(resetIssueSourceRegistry)

  it("returns a stable singleton", () => {
    expect(getIssueSourceRegistry()).toBe(getIssueSourceRegistry())
  })

  it("hands out a fresh instance after a reset, so tests stay isolated", () => {
    const first = getIssueSourceRegistry()
    first.register(stubSource("local", async () => []))
    resetIssueSourceRegistry()
    expect(getIssueSourceRegistry()).not.toBe(first)
    expect(getIssueSourceRegistry().has("local")).toBe(false)
  })
})
