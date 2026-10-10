/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { getDocumentTemplate, type DocumentTemplateRow } from "@/lib/db/document-templates"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

import {
  builtinDocumentTemplateOptions,
  createDocumentFromTemplate,
  documentTemplateOptions,
  editDocumentTemplateDetails,
  saveDocumentAsTemplate,
  userDocumentTemplateOption,
} from "./service"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

function row(
  id: string,
  updatedAt: number,
  extra: Partial<DocumentTemplateRow> = {}
): DocumentTemplateRow {
  return {
    id,
    name: id,
    content: `# ${id}`,
    language: "markdown",
    type: "text",
    revision: 1,
    createdAt: 1,
    updatedAt,
    ...extra,
  }
}

const builtins = builtinDocumentTemplateOptions((id) => ({
  name: `name:${id}`,
  description: `desc:${id}`,
  content: `# ${id}`,
}))

describe("document template options", () => {
  it("lists the built-ins in order with the caller's copy", () => {
    expect(builtins.map((option) => option.id)).toEqual([
      "guide",
      "todo",
      "project-tracker",
      "weekly-update",
      "meeting-notes",
    ])
    expect(builtins[4]).toEqual({
      id: "meeting-notes",
      source: "builtin",
      name: "name:meeting-notes",
      description: "desc:meeting-notes",
      content: "# meeting-notes",
      language: "markdown",
      type: "text",
      icon: "meeting",
    })
  })

  it("puts saved templates after the built-ins, newest first", () => {
    const options = documentTemplateOptions(builtins, [row("dtpl_a", 1), row("dtpl_b", 5)])
    expect(options.map((option) => option.id).slice(5)).toEqual(["dtpl_b", "dtpl_a"])
    expect(userDocumentTemplateOption(row("dtpl_c", 3, { description: "d" }))).toEqual({
      id: "dtpl_c",
      source: "user",
      name: "dtpl_c",
      description: "d",
      content: "# dtpl_c",
      language: "markdown",
      type: "text",
      icon: "saved",
      updatedAt: 3,
    })
  })
})

describe("createDocumentFromTemplate", () => {
  it("makes a canvas document the person owns, named after the template", () => {
    const createCanvasDocument = jest.fn(() => "doc-1")
    expect(createDocumentFromTemplate(builtins[0]!, { createCanvasDocument })).toBe("doc-1")
    expect(createCanvasDocument).toHaveBeenCalledWith({
      title: "name:guide",
      content: "# guide",
      language: "markdown",
      type: "text",
      createdBy: "user",
    })
  })
})

describe("saving and editing", () => {
  it("saves a document's text, trimming an empty description away", async () => {
    const saved = await saveDocumentAsTemplate({
      name: " Postmortem ",
      description: "  ",
      content: "# P",
      language: "markdown",
      type: "text",
    })
    expect(saved).toMatchObject({ name: "Postmortem", content: "# P", revision: 1 })
    expect(saved.description).toBeUndefined()
  })

  it("edits name and description without touching the content or revision", async () => {
    const saved = await saveDocumentAsTemplate({
      name: "A",
      description: "first",
      content: "# A",
      language: "markdown",
      type: "text",
    })
    await editDocumentTemplateDetails(saved.id, { name: "B", description: "" })
    expect(await getDocumentTemplate(saved.id)).toMatchObject({
      name: "B",
      content: "# A",
      revision: 1,
    })
    expect((await getDocumentTemplate(saved.id))?.description).toBeUndefined()
  })

  it("refuses an empty name", async () => {
    await expect(
      saveDocumentAsTemplate({ name: " ", content: "x", language: "markdown", type: "text" })
    ).rejects.toMatchObject({ code: "document_template_name_required" })
  })
})
