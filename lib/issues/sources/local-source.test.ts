/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssue } from "@/lib/db/issues"
import { createIssueProject } from "@/lib/db/issue-projects"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { createIssueSourceRegistry } from "./registry"
import {
  issueHref,
  localIssueSource,
  registerLocalIssueSource,
  toUnifiedIssue,
} from "./local-source"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const
const AGENT = { kind: "agent", id: "a1" } as const

let projectId: string

beforeEach(async () => {
  projectId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function make(over: Partial<Parameters<typeof createIssue>[0]> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: projectId,
    title: "Some issue",
    createdBy: HUMAN,
    ...over,
  })
}

describe("issueHref", () => {
  it("uses a query param, because a static export has no dynamic [id] route", () => {
    expect(issueHref("iss_1")).toBe("/issues?id=iss_1")
  })

  it("encodes the id", () => {
    expect(issueHref("a b&c")).toBe("/issues?id=a%20b%26c")
  })
})

describe("toUnifiedIssue", () => {
  it("projects every field the board renders", async () => {
    const issue = await make({ assignee: AGENT, priority: "high", status: "in_review" })
    const unified = toUnifiedIssue(issue)

    expect(unified).toMatchObject({
      unifiedId: `local:${issue.id}`,
      kind: "local",
      sourceId: issue.id,
      identifier: "MERC-1",
      title: "Some issue",
      status: "in_review",
      statusCategory: "started",
      priority: "high",
      assignee: AGENT,
      createdBy: HUMAN,
      issueProjectId: projectId,
    })
  })

  it("marks local rows as fully writable — they are the source of truth", async () => {
    expect(toUnifiedIssue(await make()).capabilities).toEqual(FULL_ISSUE_CAPABILITIES)
  })

  it("records where the row came from and how to deep-link to it", async () => {
    const issue = await make()
    expect(toUnifiedIssue(issue).origin).toEqual({
      tableName: "issues",
      deepLinkHref: `/issues?id=${issue.id}`,
    })
  })

  it("omits an absent description and assignee rather than emitting undefined keys", async () => {
    const unified = toUnifiedIssue(await make())
    expect(unified).not.toHaveProperty("description")
    expect(unified).not.toHaveProperty("assignee")
  })
})

describe("localIssueSource", () => {
  it("lists a workspace's issues", async () => {
    await make()
    await make()
    const items = await localIssueSource.list({ projectId: "w1" })
    expect(items.map((i) => i.identifier)).toEqual(["MERC-1", "MERC-2"])
  })

  it("narrows to one delivery container", async () => {
    await make()
    const other = (await createIssueProject({ projectId: "w1", name: "Cognia" })).id
    await createIssue({
      projectId: "w1",
      issueProjectId: other,
      title: "elsewhere",
      createdBy: HUMAN,
    })

    const items = await localIssueSource.list({ projectId: "w1", issueProjectId: other })
    expect(items.map((i) => i.title)).toEqual(["elsewhere"])
  })

  it("never returns another workspace's issues", async () => {
    await make()
    expect(await localIssueSource.list({ projectId: "w2" })).toEqual([])
  })

  it("returns an empty list rather than throwing on an empty workspace", async () => {
    expect(await localIssueSource.list({ projectId: "nobody" })).toEqual([])
  })
})

describe("registerLocalIssueSource", () => {
  it("registers into an explicit registry", () => {
    const registry = createIssueSourceRegistry()
    registerLocalIssueSource(registry)
    expect(registry.getSource("local")).toBe(localIssueSource)
  })

  it("makes the board's fan-out return local rows", async () => {
    await make()
    const registry = createIssueSourceRegistry()
    registerLocalIssueSource(registry)

    const { items, errors } = await registry.listAll({ projectId: "w1" })
    expect(errors).toEqual([])
    expect(items.map((i) => i.identifier)).toEqual(["MERC-1"])
  })
})
