import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  getDocumentTemplate,
  listDocumentTemplates,
  subscribeDocumentTemplates,
  updateDocumentTemplate,
} from "./document-templates"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const draft = {
  name: "  Weekly update ",
  description: " Every Friday ",
  content: "# Week\n\n- Done\n",
  language: "markdown" as const,
  type: "text" as const,
}

describe("document templates", () => {
  it("creates a trimmed row at revision 1 and lists newest-edited first", async () => {
    const first = await createDocumentTemplate(draft, 10)
    expect(first).toMatchObject({
      name: "Weekly update",
      description: "Every Friday",
      revision: 1,
      createdAt: 10,
      updatedAt: 10,
    })
    expect(first.id).toMatch(/^dtpl_/)
    const second = await createDocumentTemplate({ ...draft, name: "Notes" }, 20)
    expect((await listDocumentTemplates()).map((row) => row.id)).toEqual([second.id, first.id])
    expect(await getDocumentTemplate(first.id)).toEqual(first)
  })

  it("refuses a blank name", async () => {
    await expect(createDocumentTemplate({ ...draft, name: "  " })).rejects.toMatchObject({
      code: "document_template_name_required",
    })
    expect(await getDb().documentTemplates.count()).toBe(0)
  })

  it("bumps the revision for a content edit only, and can clear the description", async () => {
    const row = await createDocumentTemplate(draft, 10)
    const renamed = await updateDocumentTemplate(row.id, { name: "Friday", description: "" }, 11)
    expect(renamed).toMatchObject({ name: "Friday", revision: 1, updatedAt: 11 })
    expect(renamed.description).toBeUndefined()
    const edited = await updateDocumentTemplate(row.id, { content: "# New" }, 12)
    expect(edited).toMatchObject({ content: "# New", revision: 2 })
    await expect(updateDocumentTemplate(row.id, { name: " " })).rejects.toMatchObject({
      code: "document_template_name_required",
    })
    await expect(updateDocumentTemplate("dtpl_missing", { name: "x" })).rejects.toMatchObject({
      code: "document_template_not_found",
    })
  })

  it("tells subscribers about every write, and survives one that throws", async () => {
    const seen = jest.fn()
    const unsubscribeThrower = subscribeDocumentTemplates(() => {
      throw new Error("projection broke")
    })
    const unsubscribe = subscribeDocumentTemplates(seen)
    const row = await createDocumentTemplate(draft)
    await updateDocumentTemplate(row.id, { content: "x" })
    await deleteDocumentTemplate(row.id)
    expect(seen).toHaveBeenCalledTimes(3)
    expect(await getDocumentTemplate(row.id)).toBeUndefined()
    unsubscribe()
    unsubscribeThrower()
    await createDocumentTemplate(draft)
    expect(seen).toHaveBeenCalledTimes(3)
  })
})
