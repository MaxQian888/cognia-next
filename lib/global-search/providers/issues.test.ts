import type { Issue } from "@/types/issues"
import { __resetGlobalSearchCachesForTesting } from "../cache"
import { makeProviderInput, makeTestContext, TEST_NOW } from "../testing"
import { createIssuesProvider, ISSUES_PROVIDER_ID, issuesProvider } from "./issues"

jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn(async () => []) }))

const issues = [
  {
    id: "i1",
    identifier: "MERC-1",
    title: "Ship the board",
    description: "the whole thing",
    status: "in_progress",
    statusCategory: "started",
    priority: "high",
    assignee: { kind: "agent", id: "c", label: "Ada" },
    updatedAt: TEST_NOW,
  },
  {
    id: "i2",
    identifier: "MERC-2",
    title: "Old thing",
    status: "done",
    statusCategory: "completed",
    priority: "none",
    updatedAt: TEST_NOW - 10,
  },
] as unknown as Issue[]

describe("issues provider", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("matches identifier and title, opens the issue, flags finished ones", async () => {
    const seen: string[] = []
    const provider = createIssuesProvider({
      listIssues: async (projectId) => {
        seen.push(projectId)
        return issues
      },
    })
    expect(provider.id).toBe(ISSUES_PROVIDER_ID)
    const out = await provider.search(makeProviderInput("merc-1"))
    expect(seen).toEqual(["p1"])
    expect(out.items[0]).toMatchObject({
      id: "issue:i1",
      kind: "issue",
      title: "MERC-1 Ship the board",
      subtitle: "the whole thing",
      meta: "issues.status.in_progress",
      extra: { archived: false },
      action: { type: "navigate", href: "/issues?id=i1" },
    })
    expect(out.items[0]!.timestamp).toBe(TEST_NOW)

    const byAssignee = await provider.search(makeProviderInput("ada"))
    expect(byAssignee.items[0]!.id).toBe("issue:i1")

    const old = await provider.search(makeProviderInput("old thing"))
    expect(old.items[0]!.extra?.archived).toBe(true)
    expect(old.items[0]!.subtitle).toBeUndefined()
  })

  it("returns nothing without an active workspace", async () => {
    const provider = createIssuesProvider({ listIssues: async () => issues })
    const out = await provider.search(
      makeProviderInput("merc", { ctx: makeTestContext({ activeProjectId: null }) })
    )
    expect(out.items).toEqual([])
  })

  it("wires the Dexie reader by default", async () => {
    const out = await issuesProvider.search(makeProviderInput("anything"))
    expect(out.items).toEqual([])
  })
})
