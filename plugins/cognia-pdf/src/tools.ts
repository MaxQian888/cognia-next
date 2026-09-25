import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
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

/** A file dialog stays open while the user decides — outlast the 30 s default. */
const FILE_DIALOG_TIMEOUT_MS = 120_000
/** pdf.js load + save + re-open of a large document can outrun the default. */
const PDF_PROCESSING_TIMEOUT_MS = 120_000
/** OCR of a scanned document runs page by page and can take minutes. */
const OCR_TIMEOUT_MS = 300_000

/**
 * A form value: a string (text/choice/radio export name), a boolean
 * (checkbox), or a string array (multi-select / checkbox group). `anyOf`, not
 * a `type` array with `items`, so every provider's schema bridge accepts it.
 */
const fieldValueSchema = {
  anyOf: [{ type: "string" }, { type: "boolean" }, { type: "array", items: { type: "string" } }],
} as const

export function createPdfTools(ctx: PdfPluginContext): PluginToolRegistration[] {
  const runtime = createPdfRuntime(ctx)
  const artifactOnly = {
    type: "object",
    properties: { artifactId },
    required: ["artifactId"],
    additionalProperties: false,
  }
  return [
    definePluginTool({
      name: PDF_TOOL_NAMES[0],
      definition: {
        name: PDF_TOOL_NAMES[0],
        description:
          "Import an authorized PDF attachment, or open the file picker when no handle is given.",
        parametersSchema: {
          type: "object",
          properties: {
            handle: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            password: { type: "string" },
          },
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args, toolCtx) =>
        runtime.importPdf({
          ...(args as { handle?: string; title?: string; password?: string }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        }),
    }),
    definePluginTool({
      name: PDF_TOOL_NAMES[1],
      definition: {
        name: PDF_TOOL_NAMES[1],
        description: "Inspect PDF pages, metadata, signatures, and interactive form fields.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.inspect((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: PDF_TOOL_NAMES[2],
      definition: {
        name: PDF_TOOL_NAMES[2],
        description:
          "Fill named PDF form fields and verify the saved values by reopening the PDF. " +
          "Value semantics per field kind: text/choice take a string (multi-select choices take a " +
          "string array); checkboxes take a boolean, or an export name / name array for checkbox " +
          "groups; radio groups take the export name of the option to select (inspect returns each " +
          "field's exportValues). Signature and push-button fields cannot be filled.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            expectedVersion: { type: "integer", minimum: 1 },
            values: { type: "object", additionalProperties: fieldValueSchema },
            password: { type: "string" },
            changeDescription: { type: "string", minLength: 1 },
          },
          required: ["artifactId", "expectedVersion", "values"],
          additionalProperties: false,
        },
        timeoutMs: PDF_PROCESSING_TIMEOUT_MS,
      },
      execute: async (args) =>
        runtime.fill(
          args as {
            artifactId: string
            expectedVersion: number
            values: Record<string, PdfFieldValue>
            password?: string
            changeDescription?: string
          }
        ),
    }),
    definePluginTool({
      name: PDF_TOOL_NAMES[3],
      definition: {
        name: PDF_TOOL_NAMES[3],
        description:
          "Extract or combine selected pages from PDF sources — authorized attachments " +
          "(handle) or existing PDF artifacts (artifactId) — into a new artifact.",
        parametersSchema: {
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
        timeoutMs: PDF_PROCESSING_TIMEOUT_MS,
      },
      execute: async (args, toolCtx) =>
        runtime.extract({
          ...(args as { sources: PdfExtractSource[]; title: string }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        }),
    }),
    definePluginTool({
      name: PDF_TOOL_NAMES[4],
      definition: {
        name: PDF_TOOL_NAMES[4],
        description:
          "Extract text (and OCR fallback for scanned pages) from a PDF artifact or " +
          'authorized attachment. Supports a pageRange like "1-3,5".',
        parametersSchema: {
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
        timeoutMs: OCR_TIMEOUT_MS,
      },
      execute: async (args) =>
        runtime.extractText(
          args as {
            artifactId?: string
            handle?: string
            pageRange?: string
            format?: "markdown" | "text" | "blocks"
            languages?: string[]
          }
        ),
    }),
    definePluginTool({
      name: PDF_TOOL_NAMES[5],
      definition: {
        name: PDF_TOOL_NAMES[5],
        description:
          "Reopen and validate PDF structure and expected field values. Encrypted documents " +
          "are skipped unless their password is supplied.",
        parametersSchema: {
          type: "object",
          properties: { artifactId, password: { type: "string" } },
          required: ["artifactId"],
          additionalProperties: false,
        },
        timeoutMs: PDF_PROCESSING_TIMEOUT_MS,
      },
      execute: async (args) => {
        const input = args as { artifactId: string; password?: string }
        return runtime.validate(input.artifactId, input.password)
      },
    }),
    definePluginTool({
      name: PDF_TOOL_NAMES[6],
      definition: {
        name: PDF_TOOL_NAMES[6],
        description: "Open the plugin-owned read-only PDF preview.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.preview((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: PDF_TOOL_NAMES[7],
      definition: {
        name: PDF_TOOL_NAMES[7],
        description:
          "Validate and save a native PDF file. Desktop shows a save dialog, mobile saves to " +
          "Documents/cognia/exports, web downloads it; relay the returned message to the user.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            suggestedName: {
              type: "string",
              minLength: 1,
              description: "File name without a path; .pdf is added when missing.",
            },
            password: { type: "string" },
          },
          required: ["artifactId"],
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args) => {
        const input = args as { artifactId: string; suggestedName?: string; password?: string }
        return runtime.exportPdf(input.artifactId, input.suggestedName, input.password)
      },
    }),
  ]
}
