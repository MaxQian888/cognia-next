/**
 * @jest-environment jsdom
 */

import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  BUILTIN_ISSUE_LABELS,
  createLabel,
  deleteLabel,
  findLabelByName,
  getLabel,
  getLabelsByIds,
  listLabels,
  reorderLabels,
  seedBuiltinIssueLabels,
  updateLabel,
} from "./labels"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("createLabel", () => {
  it("creates a label with a deterministic default colour", async () => {
    const label = await createLabel({ scope: "issue", name: "bug" })
    expect(label).toMatchObject({ scope: "issue", name: "bug", sortOrder: 0 })
    expect(label.color).toMatch(/^oklch\(/)

    const again = await createLabel({ scope: "issue", name: "other" })
    expect(again.color).toMatch(/^oklch\(/)
  })

  it("trims the name and rejects a blank one", async () => {
    expect((await createLabel({ scope: "issue", name: "  spaced  " })).name).toBe("spaced")
    await expect(createLabel({ scope: "issue", name: "   " })).rejects.toThrow(/required/i)
  })

  it("is idempotent by (scope, name) — re-creating returns the existing row", async () => {
    // GitHub label import and boot-time seeding both re-run; duplicating the
    // catalogue on every launch would be the obvious failure mode.
    const first = await createLabel({ scope: "issue", name: "bug" })
    const second = await createLabel({ scope: "issue", name: "BUG" })
    expect(second.id).toBe(first.id)
    expect(await listLabels("issue")).toHaveLength(1)
  })

  it("lets the same name exist once per scope", async () => {
    const issue = await createLabel({ scope: "issue", name: "bug" })
    const conversation = await createLabel({ scope: "conversation", name: "bug" })
    expect(conversation.id).not.toBe(issue.id)
  })

  it("defaults sortOrder to the count within the scope only", async () => {
    await createLabel({ scope: "conversation", name: "a" })
    await createLabel({ scope: "conversation", name: "b" })
    expect((await createLabel({ scope: "issue", name: "first-issue" })).sortOrder).toBe(0)
  })

  it("honours an explicit id, for the v170 migration's id preservation", async () => {
    const label = await createLabel({ scope: "conversation", name: "kept", id: "lbl-fixed" })
    expect(label.id).toBe("lbl-fixed")
  })
})

describe("reads", () => {
  it("gets by id and by name (case-insensitively, within a scope)", async () => {
    const label = await createLabel({ scope: "issue", name: "Bug" })
    expect(await getLabel(label.id)).toMatchObject({ name: "Bug" })
    expect(await findLabelByName("issue", "bug")).toMatchObject({ id: label.id })
    expect(await findLabelByName("conversation", "bug")).toBeUndefined()
  })

  it("lists a scope in manual order, then alphabetically", async () => {
    await createLabel({ scope: "issue", name: "zeta", sortOrder: 0 })
    await createLabel({ scope: "issue", name: "alpha", sortOrder: 0 })
    await createLabel({ scope: "issue", name: "beta", sortOrder: 1 })
    expect((await listLabels("issue")).map((l) => l.name)).toEqual(["alpha", "zeta", "beta"])
  })

  it("never leaks rows across scopes", async () => {
    await createLabel({ scope: "conversation", name: "vip" })
    expect(await listLabels("issue")).toEqual([])
  })

  it("resolves a set of ids, skipping unknown ones", async () => {
    const a = await createLabel({ scope: "issue", name: "a" })
    expect(await getLabelsByIds([])).toEqual([])
    expect((await getLabelsByIds([a.id, "missing"])).map((l) => l.name)).toEqual(["a"])
  })
})

describe("updateLabel", () => {
  it("patches only the given fields and bumps updatedAt", async () => {
    const label = await createLabel({ scope: "issue", name: "bug", color: "#111" })
    await updateLabel(label.id, { name: "  defect ", color: "#222" })
    const reloaded = await getLabel(label.id)
    expect(reloaded).toMatchObject({ name: "defect", color: "#222", scope: "issue" })
    expect(reloaded!.updatedAt).toBeGreaterThanOrEqual(label.updatedAt)
  })

  it("is a no-op for an unknown id", async () => {
    await expect(updateLabel("nope", { name: "x" })).resolves.toBeUndefined()
  })
})

describe("deleteLabel", () => {
  it("strips the id from issues that carry it", async () => {
    const label = await createLabel({ scope: "issue", name: "bug" })
    const db = getDb()
    await db.issues.put({
      id: "i1",
      identifier: "K-1",
      number: 1,
      projectId: "w1",
      issueProjectId: "p1",
      title: "t",
      status: "todo",
      statusCategory: "unstarted",
      priority: "none",
      createdBy: { kind: "human" },
      labelIds: [label.id, "other"],
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    })

    await deleteLabel(label.id)

    expect(await getLabel(label.id)).toBeUndefined()
    expect((await db.issues.get("i1"))!.labelIds).toEqual(["other"])
  })

  it("refuses to delete a built-in label and leaves it in place", async () => {
    const label = await createLabel({ scope: "issue", name: "bug", builtin: true })
    await expect(deleteLabel(label.id)).rejects.toThrow(/built-in/i)
    expect(await getLabel(label.id)).toBeDefined()
  })

  it("is a no-op for an unknown id", async () => {
    await expect(deleteLabel("nope")).resolves.toBeUndefined()
  })
})

describe("reorderLabels", () => {
  it("rewrites sortOrder from the given sequence", async () => {
    const a = await createLabel({ scope: "issue", name: "a" })
    const b = await createLabel({ scope: "issue", name: "b" })
    await reorderLabels("issue", [b.id, a.id])
    expect((await listLabels("issue")).map((l) => l.name)).toEqual(["b", "a"])
  })

  it("ignores ids from another scope or that do not exist", async () => {
    const issue = await createLabel({ scope: "issue", name: "a" })
    const conversation = await createLabel({ scope: "conversation", name: "vip" })
    await reorderLabels("issue", ["missing", conversation.id, issue.id])
    expect((await getLabel(conversation.id))!.sortOrder).toBe(0)
  })
})

describe("seedBuiltinIssueLabels", () => {
  it("seeds the starter catalogue as protected built-ins", async () => {
    await seedBuiltinIssueLabels()
    const labels = await listLabels("issue")
    expect(labels.map((l) => l.name)).toEqual(BUILTIN_ISSUE_LABELS.map((l) => l.name))
    expect(labels.every((l) => l.builtin)).toBe(true)
  })

  it("is idempotent across boots", async () => {
    await seedBuiltinIssueLabels()
    await seedBuiltinIssueLabels()
    expect(await listLabels("issue")).toHaveLength(BUILTIN_ISSUE_LABELS.length)
  })

  it("does not touch the conversation scope", async () => {
    await seedBuiltinIssueLabels()
    expect(await listLabels("conversation")).toEqual([])
  })
})
