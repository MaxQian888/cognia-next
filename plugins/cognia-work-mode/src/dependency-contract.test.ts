// @cognia-host-integration-test
/**
 * Work mode calls cognia-office and cognia-documents tools by name through
 * `invokeDependencyTool`. Its own tests mock that seam, so a renamed tool or a
 * changed argument shape in a dependency would pass them and fail in the app.
 * This test runs each native writer's create and read contract against the
 * dependencies' real tool registrations.
 */

import type { Artifact, PluginToolRegistration } from "@cognia/plugin-sdk"
import officeManifest from "../../cognia-office/plugin.json"
import { MAX_READ_CELLS } from "../../cognia-office/src/read-range"
import { createOfficeTools, OFFICE_TOOL_NAMES } from "../../cognia-office/src/tools"
import documentsManifest from "../../cognia-documents/plugin.json"
import { createDocumentTools, DOCUMENT_TOOL_NAMES } from "../../cognia-documents/src/tools"
import manifestJson from "../plugin.json"
import {
  DOCUMENTS_DOCX_WRITER,
  NATIVE_DELIVERABLE_WRITERS,
  OFFICE_WORKBOOK_WRITER,
  REVIEW_READ_CELLS,
} from "./deliverables"

function dependencyContext(pluginId: string) {
  const artifacts = new Map<string, Artifact>()
  return {
    pluginId,
    artifact: {
      createArtifact: async (input: {
        title: string
        content: string
        kind?: string
        schemaVersion?: number
      }) => {
        const id = `${pluginId}-${artifacts.size + 1}`
        artifacts.set(id, {
          id,
          sessionId: "",
          messageId: "",
          type: "document",
          title: input.title,
          content: input.content,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {
            plugin: {
              kind: input.kind!,
              schemaVersion: input.schemaVersion ?? 1,
              ownerPluginId: pluginId,
            },
          },
        })
        return id
      },
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact: () => {},
    },
    i18n: { t: (key: string) => key },
  }
}

async function invoke(
  tools: PluginToolRegistration[],
  name: string,
  args: Record<string, unknown>
) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`dependency has no tool ${name}`)
  return tool.execute(args, { config: {} })
}

it("names only tools its dependencies register", () => {
  const registered: Record<string, readonly string[]> = {
    [officeManifest.id]: OFFICE_TOOL_NAMES,
    [documentsManifest.id]: DOCUMENT_TOOL_NAMES,
  }
  for (const writer of NATIVE_DELIVERABLE_WRITERS) {
    expect(manifestJson.dependencies).toHaveProperty(writer.pluginId)
    const tools = registered[writer.pluginId]
    expect(tools).toBeDefined()
    for (const name of [writer.create.tool, writer.read.tool, ...writer.editTools])
      expect(tools).toContain(name)
  }
})

it("reads no more workbook cells than cognia-office allows", () => {
  expect(REVIEW_READ_CELLS).toBeLessThanOrEqual(MAX_READ_CELLS)
})

it("creates a workbook from CSV and reads it back as review text", async () => {
  const tools = createOfficeTools(dependencyContext("cognia-office") as never)
  const created = (await invoke(
    tools,
    OFFICE_WORKBOOK_WRITER.create.tool,
    OFFICE_WORKBOOK_WRITER.create.args({ title: "Stock", content: "SKU,Qty\nA-1,4" })
  )) as { ok: boolean; artifactId: string }
  expect(created.ok).toBe(true)
  const read = await invoke(
    tools,
    OFFICE_WORKBOOK_WRITER.read.tool,
    OFFICE_WORKBOOK_WRITER.read.args(created.artifactId)
  )
  expect(OFFICE_WORKBOOK_WRITER.read.text(read)).toEqual({
    text: "## Sheet1 (A1:B2)\nSKU\tQty\nA-1\t4",
    truncated: false,
  })
})

it("creates a DOCX document from Markdown and reads it back as review text", async () => {
  const tools = createDocumentTools(dependencyContext("cognia-documents") as never)
  const created = (await invoke(
    tools,
    DOCUMENTS_DOCX_WRITER.create.tool,
    DOCUMENTS_DOCX_WRITER.create.args({ title: "Memo", content: "# Decision\n\n- ship it" })
  )) as { ok: boolean; artifactId: string; conversionNotes?: string[] }
  expect(created.ok).toBe(true)
  expect(created.conversionNotes).toBeUndefined()
  const read = await invoke(
    tools,
    DOCUMENTS_DOCX_WRITER.read.tool,
    DOCUMENTS_DOCX_WRITER.read.args(created.artifactId)
  )
  expect(DOCUMENTS_DOCX_WRITER.read.text(read)).toEqual({
    text: "# Decision\n\n- ship it",
    truncated: false,
  })
})
