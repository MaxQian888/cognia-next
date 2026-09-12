import type { PluginTool } from "@cognia/plugin-sdk"
import type { PdfFieldValue } from "./pdf-engine"
import { createPdfRuntime, type PdfExtractSource, type PdfPluginContext } from "./runtime"

export const PDF_TOOL_NAMES = [
  "pdf_import",
  "pdf_inspect",
  "pdf_fill_form",
  "pdf_extract_pages",
  "pdf_extract_text",
  "pdf_validate",
  "pdf_preview",
  "pdf_export",
] as const

const artifactId = { type: "string", minLength: 1 } as const

export function createPdfTools(ctx: PdfPluginContext): PluginTool[] {
  const runtime = createPdfRuntime(ctx)
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
      "Fill named PDF form fields and verify the saved values by reopening the PDF. " +
        "Value semantics per field kind: text/choice take a string (multi-select choices take a " +
        "string array); checkboxes take a boolean, or an export name / name array for checkbox " +
        "groups; radio groups take the export name of the option to select (inspect returns each " +
        "field's exportValues). Signature and push-button fields cannot be filled.",
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
      "Extract or combine selected pages from PDF sources — authorized attachments " +
        "(handle) or existing PDF artifacts (artifactId) — into a new artifact.",
      {
        type: "object",
        properties: {
          sources: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                handle: { type: "string", minLength: 1 },
                artifactId,
                includePages: {
                  type: "array",
                  minItems: 1,
                  items: { type: "integer", minimum: 1 },
                },
                password: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          title: { type: "string", minLength: 1 },
        },
        required: ["sources", "title"],
        additionalProperties: false,
      },
      (args, toolCtx) =>
        runtime.extract({
          ...(args as { sources: PdfExtractSource[]; title: string }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        })
    ),
    tool(
      PDF_TOOL_NAMES[4],
      "Extract text (and OCR fallback for scanned pages) from a PDF artifact or " +
        'authorized attachment. Supports a pageRange like "1-3,5".',
      {
        type: "object",
        properties: {
          artifactId,
          handle: { type: "string", minLength: 1 },
          pageRange: { type: "string", minLength: 1 },
          format: { type: "string", enum: ["markdown", "text", "blocks"] },
          languages: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
        additionalProperties: false,
      },
      (args) =>
        runtime.extractText(
          args as {
            artifactId?: string
            handle?: string
            pageRange?: string
            format?: "markdown" | "text" | "blocks"
            languages?: string[]
          }
        )
    ),
    tool(
      PDF_TOOL_NAMES[5],
      "Reopen and validate PDF structure and expected field values. Encrypted documents " +
        "are skipped unless their password is supplied.",
      {
        type: "object",
        properties: { artifactId, password: { type: "string" } },
        required: ["artifactId"],
        additionalProperties: false,
      },
      (args) => {
        const input = args as { artifactId: string; password?: string }
        return runtime.validate(input.artifactId, input.password)
      }
    ),
    tool(PDF_TOOL_NAMES[6], "Open the plugin-owned read-only PDF preview.", artifactOnly, (args) =>
      runtime.preview((args as { artifactId: string }).artifactId)
    ),
    tool(
      PDF_TOOL_NAMES[7],
      "Validate and save a native PDF file.",
      {
        type: "object",
        properties: {
          artifactId,
          suggestedName: { type: "string", minLength: 1 },
          password: { type: "string" },
        },
        required: ["artifactId"],
        additionalProperties: false,
      },
      (args) => {
        const input = args as { artifactId: string; suggestedName?: string; password?: string }
        return runtime.exportPdf(input.artifactId, input.suggestedName, input.password)
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
