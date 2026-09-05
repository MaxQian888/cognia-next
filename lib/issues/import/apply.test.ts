/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssueCycle } from "@/lib/db/issue-cycles"
import { getIssue, listIssues } from "@/lib/db/issues"
import { listLabels } from "@/lib/db/labels"
import type { IssueActor } from "@/types/issues"
import { importIssues, orderForCreation } from "./apply"
import type { ImportedIssue } from "./parse"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }

let containerId: string
beforeEach(async () => {
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function row(over: Partial<ImportedIssue> & { externalId: string; title: string }): ImportedIssue {
  return { labels: [], ...over }
}

describe("orderForCreation", () => {
  it("puts parents before children and tolerates loops", () => {
    const rows = [
      row({ externalId: "c", title: "C", parentExternalId: "b" }),
      row({ externalId: "b", title: "B", parentExternalId: "a" }),
      row({ externalId: "a", title: "A" }),
      row({ externalId: "x", title: "X", parentExternalId: "y" }),
      row({ externalId: "y", title: "Y", parentExternalId: "x" }),
    ]
    expect(orderForCreation(rows).map((r) => r.externalId)).toEqual(["a", "b", "c", "y", "x"])
  })
})

describe("importIssues", () => {
  it("creates rows with labels, planning fields, refs and parents, then dedupes on re-import", async () => {
    const cycle = await createIssueCycle({ projectId: "w1", kind: "cycle", name: "S1" })
    const rows = [
      row({ externalId: "p", title: "Parent", sourceId: "MERC-1", labels: ["bug"] }),
      row({
        externalId: "c",
        title: "Child",
        parentExternalId: "p",
        status: "done",
        priority: "high",
        assigneeLabel: "Ada",
        dueDate: 5,
        estimate: 3,
        description: "d",
      }),
    ]
    const first = await importIssues({
      projectId: "w1",
      issueProjectId: containerId,
      format: "csv",
      rows,
      defaultStatus: "todo",
      cycleId: cycle.id,
      by: HUMAN,
      now: () => 99,
    })
    expect(first).toMatchObject({ created: 2, skipped: 0, failed: 0 })
    const issues = await listIssues({ projectId: "w1" })
    expect(issues).toHaveLength(2)
    const parent = (await getIssue(first.createdIds[0]))!
    const child = (await getIssue(first.createdIds[1]))!
    expect(parent).toMatchObject({ title: "Parent", status: "todo", cycleId: cycle.id })
    expect(parent.externalRefs).toEqual([
      { provider: "import:csv", externalId: "p", label: "MERC-1", syncedAt: 99 },
    ])
    expect((await listLabels("issue")).some((label) => label.name === "bug")).toBe(true)
    expect(child).toMatchObject({
      title: "Child",
      parentId: parent.id,
      status: "done",
      priority: "high",
      assignee: { kind: "human", label: "Ada" },
      dueDate: 5,
      estimate: 3,
      description: "d",
    })

    const second = await importIssues({
      projectId: "w1",
      issueProjectId: containerId,
      format: "csv",
      rows: [...rows, row({ externalId: "n", title: "New", parentExternalId: "p" })],
      by: HUMAN,
    })
    expect(second).toMatchObject({ created: 1, skipped: 2, failed: 0 })
    expect((await getIssue(second.createdIds[0]))!.parentId).toBe(parent.id)
    expect(await listIssues({ projectId: "w1" })).toHaveLength(3)
  })

  it("counts a failing row without abandoning the rest", async () => {
    const outcome = await importIssues({
      projectId: "w1",
      issueProjectId: "no-such-container",
      format: "json",
      rows: [row({ externalId: "a", title: "A" })],
      by: HUMAN,
    })
    expect(outcome).toMatchObject({ created: 0, failed: 1 })
    expect(outcome.errors[0].error).toMatch(/Unknown issue project/)
  })
})
