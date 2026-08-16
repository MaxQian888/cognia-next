import type { Project } from "@/types"

import { makeProviderInput, makeTestContext, TEST_NOW } from "../testing"
import { workspacesProvider } from "./workspaces"

const project = (over: Partial<Project>): Project =>
  ({
    id: "p",
    name: "Proj",
    roots: [],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(TEST_NOW - 10),
    updatedAt: new Date(TEST_NOW - 5),
    lastAccessedAt: new Date(TEST_NOW - 5),
    ...over,
  }) as Project

const workspaces = [
  project({
    id: "p1",
    name: "Cognia",
    roots: [{ path: "/code/cognia", isPrimary: true } as never],
    lastAccessedAt: new Date(TEST_NOW),
  }),
  project({ id: "p2", name: "Cognia archive", isArchived: true }),
  project({
    id: "p3",
    name: "Docs",
    tags: ["writing"],
    description: "prose",
    lastAccessedAt: undefined as never,
    updatedAt: "not-a-date" as never,
  }),
]

describe("workspaces provider", () => {
  it("hides archived workspaces unless is:archived, matches roots and tags", async () => {
    const ctx = makeTestContext({ workspaces, activeProjectId: "p1" })
    const out = await workspacesProvider.search(makeProviderInput("cognia", { ctx }))
    expect(out.items.map((i) => i.id)).toEqual(["workspace:p1"])
    expect(out.items[0]).toMatchObject({
      subtitle: "/code/cognia",
      extra: { current: true, archived: false },
      action: { type: "switch-workspace", projectId: "p1" },
    })
    const archived = await workspacesProvider.search(
      makeProviderInput("is:archived cognia", { ctx })
    )
    expect(archived.items.map((i) => i.id)).toEqual(["workspace:p1", "workspace:p2"])
    expect(archived.items[1]!.extra?.archived).toBe(true)
    const byRoot = await workspacesProvider.search(makeProviderInput("/code", { ctx }))
    expect(byRoot.items[0]!.id).toBe("workspace:p1")
    const byTag = await workspacesProvider.search(makeProviderInput("writing", { ctx }))
    expect(byTag.items[0]!.id).toBe("workspace:p3")
    expect(byTag.items[0]!.timestamp).toBeUndefined()
  })

  it("suggests active workspaces by last access", async () => {
    const ctx = makeTestContext({ workspaces, activeProjectId: null })
    const items = await workspacesProvider.suggest!({
      ctx,
      limit: 5,
      signal: new AbortController().signal,
    })
    expect(items.map((i) => i.id)).toEqual(["workspace:p1", "workspace:p3"])
    expect(items[0]!.extra?.current).toBe(false)
  })
})
