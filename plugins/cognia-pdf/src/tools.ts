import type { PluginTool } from "@cognia/plugin-sdk"
import type { PdfFieldValue } from "./pdf-engine"
import { createPdfRuntime, type PdfPluginContext } from "./runtime"

export const PDF_TOOL_NAMES = [
  "pdf_import",
  "pdf_inspect",
  "pdf_fill_form",
  "pdf_extract_pages",
  "pdf_validate",
  "pdf_preview",
  "pdf_export",
] as const

export function createPdfTools(ctx: PdfPluginContext): PluginTool[] {
  const runtime = createPdfRuntime(ctx)
  const artifactId = { type: "string", minLength: 1 } as const
  const artifactOnly = {
    type: "object",
    properties: { artifactId },
    required: ["artifactId"],
    additionalProperties: false,
  }
  return [
    tool(
      PDF_TOOL_NAMES[0],
      "Import an authorized PDF attachment or choose a PDF file.",
      {
        type: "object",
        properties: {
          handle: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          password: { type: "string" },
        },
        additionalProperties: false,
      },
      (args, toolCtx) =>
        runtime.importPdf({
          ...(args as { handle?: string; title?: string; password?: string }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        })
    ),
    tool(
      PDF_TOOL_NAMES[1],
      "Inspect PDF pages, metadata, signatures, and interactive form fields.",
      artifactOnly,
      (args) => runtime.inspect((args as { artifactId: string }).artifactId)
    ),
    tool(
      PDF_TOOL_NAMES[2],
      "Fill named PDF form fields and verify the saved values by reopening the PDF.",
      {
        type: "object",
        properties: {
          artifactId,
          expectedVersion: { type: "integer", minimum: 1 },
          values: {
            type: "object",
            additionalProperties: {
              type: ["string", "boolean", "array"],
              items: { type: "string" },
            },
          },
          password: { type: "string" },
          changeDescription: { type: "string", minLength: 1 },
        },
        required: ["artifactId", "expectedVersion", "values"],
        additionalProperties: false,
      },
      (args) =>
        runtime.fill(
          args as {
            artifactId: string
            expectedVersion: number
            values: Record<string, PdfFieldValue>
            password?: string
            changeDescription?: string
          }
        )
    ),
    tool(
      PDF_TOOL_NAMES[3],
      "Extract or combine selected pages from authorized PDF attachments.",
      {
        type: "object",
        properties: {
          handles: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          includePages: {
            type: "array",
            items: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } },
          },
          title: { type: "string", minLength: 1 },
        },
        required: ["handles", "title"],
        additionalProperties: false,
      },
      (args, toolCtx) =>
        runtime.extract({
          ...(args as { handles: string[]; includePages?: number[][]; title: string }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        })
    ),
    tool(
      PDF_TOOL_NAMES[4],
      "Reopen and validate PDF structure and expected field values.",
      artifactOnly,
      (args) => runtime.validate((args as { artifactId: string }).artifactId)
    ),
    tool(PDF_TOOL_NAMES[5], "Open the plugin-owned read-only PDF preview.", artifactOnly, (args) =>
      runtime.preview((args as { artifactId: string }).artifactId)
    ),
    tool(
      PDF_TOOL_NAMES[6],
      "Validate and save a native PDF file.",
      {
        type: "object",
        properties: { artifactId, suggestedName: { type: "string", minLength: 1 } },
        required: ["artifactId"],
        additionalProperties: false,
      },
      (args) => {
        const input = args as { artifactId: string; suggestedName?: string }
        return runtime.exportPdf(input.artifactId, input.suggestedName)
      }
    ),
  ]
}

function tool(
  name: string,
  description: string,
  parametersSchema: Record<string, unknown>,
  execute: (...args: Parameters<PluginTool["execute"]>) => unknown | Promise<unknown>
): PluginTool {
  return {
    name,
    pluginId: "cognia-pdf",
    definition: { name, description, parametersSchema },
    execute: async (...args) => execute(...args),
  }
}
