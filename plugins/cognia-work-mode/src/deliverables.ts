/**
 * Deliverable formats and the writers behind them.
 *
 * A Work deliverable is either a host artifact this plugin writes directly
 * (Markdown for documents and reports, sandboxed HTML for presentations and
 * sites) or a native, plugin-owned artifact written by a declared dependency
 * through `ctx.agent.invokeDependencyTool` (ADR-0155): a cognia-office
 * workbook for spreadsheets, a cognia-documents DOCX document on request.
 *
 * Each native writer declares the tools it creates, reads, and edits with, so
 * create, review, and update all route through one table. Adding a native
 * format is one entry here plus the dependency in `plugin.json`.
 */

import type { Artifact, ArtifactLanguage } from "@cognia/plugin-sdk"

export type WorkDeliverableKind = "document" | "report" | "spreadsheet" | "presentation" | "site"
export type WorkDeliverableFormat = "markdown" | "docx" | "xlsx" | "html"

export const DELIVERABLE_KINDS: readonly WorkDeliverableKind[] = [
  "document",
  "report",
  "spreadsheet",
  "presentation",
  "site",
]

/** The formats each kind accepts; the first is its default. */
export const DELIVERABLE_FORMATS: Record<WorkDeliverableKind, readonly WorkDeliverableFormat[]> = {
  document: ["markdown", "docx"],
  report: ["markdown", "docx"],
  spreadsheet: ["xlsx"],
  presentation: ["html"],
  site: ["html"],
}

export const ALL_DELIVERABLE_FORMATS: readonly WorkDeliverableFormat[] = [
  "markdown",
  "docx",
  "xlsx",
  "html",
]

/**
 * Cells a review reads from a workbook. It matches cognia-office's per-read
 * ceiling; the review prompt cap still bounds the text that reaches the model.
 */
export const REVIEW_READ_CELLS = 20_000

/** A deliverable this plugin writes as a host artifact. */
export interface HostArtifactTarget {
  writer: "artifact"
  type: "text" | "html"
  language: ArtifactLanguage
  previewable: boolean
}

/** A deliverable a dependency plugin writes as its own artifact kind. */
export interface NativeDeliverableWriter {
  writer: "native"
  /** The plugin-owned artifact kind (`metadata.plugin.kind`) it produces. */
  artifactKind: string
  /** The dependency that owns that kind; must be in `plugin.json` dependencies. */
  pluginId: string
  /** What the artifact is, for errors and the review prompt. */
  label: string
  create: {
    tool: string
    args: (input: { title: string; content: string }) => Record<string, unknown>
  }
  /** How a review reads the artifact as text. */
  read: {
    tool: string
    args: (artifactId: string) => Record<string, unknown>
    text: (result: unknown) => { text: string; truncated: boolean }
  }
  /** The dependency's own tools for follow-up edits, edit tool first. */
  editTools: readonly [edit: string, read: string]
}

export type DeliverableTarget = HostArtifactTarget | NativeDeliverableWriter

function field<T>(result: unknown, name: string, check: (value: unknown) => value is T): T {
  const value = (result as Record<string, unknown> | null)?.[name]
  if (!check(value)) throw new Error(`dependency read returned no ${name}`)
  return value
}

const isString = (value: unknown): value is string => typeof value === "string"

export const OFFICE_WORKBOOK_WRITER: NativeDeliverableWriter = {
  writer: "native",
  artifactKind: "cognia-office/workbook",
  pluginId: "cognia-office",
  label: "workbook",
  create: {
    tool: "office_create_workbook",
    // CSV/TSV content seeds the first sheet; Office infers types.
    args: ({ title, content }) => ({ title, content }),
  },
  read: {
    tool: "office_read_range",
    args: (artifactId) => ({ artifactId, format: "text", maxCells: REVIEW_READ_CELLS }),
    text: (result) => ({
      text: field(result, "text", isString),
      truncated: (result as { truncated?: unknown }).truncated === true,
    }),
  },
  editTools: ["office_apply_operations", "office_read_range"],
}

export const DOCUMENTS_DOCX_WRITER: NativeDeliverableWriter = {
  writer: "native",
  artifactKind: "cognia-documents/document",
  pluginId: "cognia-documents",
  label: "document",
  create: {
    tool: "documents_create",
    args: ({ title, content }) => ({ title, markdown: content }),
  },
  read: {
    tool: "documents_read_markdown",
    args: (artifactId) => ({ artifactId }),
    text: (result) => ({ text: field(result, "markdown", isString), truncated: false }),
  },
  editTools: ["documents_apply_operations", "documents_read_markdown"],
}

export const NATIVE_DELIVERABLE_WRITERS: readonly NativeDeliverableWriter[] = [
  OFFICE_WORKBOOK_WRITER,
  DOCUMENTS_DOCX_WRITER,
]

const MARKDOWN: HostArtifactTarget = {
  writer: "artifact",
  type: "text",
  language: "markdown",
  previewable: false,
}
const HTML: HostArtifactTarget = {
  writer: "artifact",
  type: "html",
  language: "html",
  previewable: true,
}

const TARGETS: Record<WorkDeliverableFormat, DeliverableTarget> = {
  markdown: MARKDOWN,
  html: HTML,
  xlsx: OFFICE_WORKBOOK_WRITER,
  docx: DOCUMENTS_DOCX_WRITER,
}

/** The format a kind is written in (its default when omitted) and its writer. */
export function resolveDeliverable(
  kind: WorkDeliverableKind,
  format?: WorkDeliverableFormat
): { format: WorkDeliverableFormat; target: DeliverableTarget } {
  const formats = DELIVERABLE_FORMATS[kind]
  if (!formats) throw new Error(`unsupported deliverable kind: ${String(kind)}`)
  const chosen = format ?? formats[0]
  if (!formats.includes(chosen))
    throw new Error(
      `a ${kind} deliverable cannot be ${String(chosen)}; use ${formats.join(" or ")}`
    )
  return { format: chosen, target: TARGETS[chosen] }
}

/** The native writer that owns an artifact, if a dependency wrote it. */
export function nativeWriterFor(
  artifact: Pick<Artifact, "metadata">
): NativeDeliverableWriter | undefined {
  const kind = artifact.metadata?.plugin?.kind
  return kind
    ? NATIVE_DELIVERABLE_WRITERS.find((writer) => writer.artifactKind === kind)
    : undefined
}
