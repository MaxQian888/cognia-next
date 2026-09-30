import type { PluginContext } from "@cognia/plugin-sdk"
import { decodeCell } from "./a1"
import { normalizeExportName, summarizeSave } from "./export-file"
import { loadFormulaFunctions, recalculateWorkbook } from "./formula-eval"
import {
  applyWorkbookOperations,
  createWorkbook,
  parseWorkbook,
  summarizeWorkbook,
  validateWorkbook,
  WORKBOOK_ARTIFACT_KIND,
  WORKBOOK_SCHEMA_VERSION,
  type WorkbookDocument,
  type WorkbookOperation,
} from "./model"
import { formatWorkbookRead, readWorkbook, type ReadWorkbookOptions } from "./read-range"
import {
  exportWorkbookXlsx,
  importDelimitedWorkbook,
  importWorkbookXlsx,
  validateXlsxPackage,
  XLSX_MIME,
} from "./xlsx"

export type OfficePluginContext = Pick<
  PluginContext,
  "pluginId" | "artifact" | "files" | "skills" | "i18n"
>

export type OfficeRuntime = ReturnType<typeof createOfficeRuntime>

/** A `.xlsx` filename `ctx.files.save` accepts, built from a title or model-supplied name. */
export function normalizeXlsxName(value: string | undefined): string {
  return normalizeExportName(value, "xlsx", "workbook")
}

export function createOfficeRuntime(ctx: OfficePluginContext) {
  /**
   * Derive every formula's value from its formula, in place, before a commit
   * — the stored value is never an agent's assertion. Import skips this and
   * keeps the source file's cached values.
   */
  async function recalculate(workbook: WorkbookDocument) {
    return recalculateWorkbook(workbook, await loadFormulaFunctions())
  }

  function readArtifact(artifactId: string) {
    const artifact = ctx.artifact.getArtifact(artifactId)
    if (!artifact) throw new Error(`workbook artifact not found: ${artifactId}`)
    if (artifact.metadata?.plugin?.kind !== WORKBOOK_ARTIFACT_KIND) {
      throw new Error(`artifact is not a Cognia Office workbook: ${artifactId}`)
    }
    // The host lets any plugin read any artifact; only this plugin's own
    // workbooks are ones it can vouch for (and update).
    if (artifact.metadata.plugin.ownerPluginId !== ctx.pluginId) {
      throw new Error(`workbook artifact is not owned by ${ctx.pluginId}: ${artifactId}`)
    }
    return { artifact, workbook: parseWorkbook(artifact.content) }
  }

  async function createArtifact(
    workbook: WorkbookDocument,
    options: { sessionId?: string; messageId?: string }
  ) {
    const artifactId = await ctx.artifact.createArtifact({
      title: workbook.title,
      content: JSON.stringify(workbook),
      type: "code",
      language: "json",
      kind: WORKBOOK_ARTIFACT_KIND,
      schemaVersion: WORKBOOK_SCHEMA_VERSION,
      sessionId: options.sessionId,
      messageId: options.messageId,
      metadata: {
        sourceOrigin: "tool",
        // Every artifact this runtime creates comes from an agent tool call.
        userInitiated: false,
        previewable: true,
        exportFormats: ["raw"],
      },
    })
    ctx.artifact.openArtifact(artifactId)
    return artifactId
  }

  return {
    create: async (input: {
      title: string
      sheetTitle?: string
      operations?: WorkbookOperation[]
      content?: string
      sessionId?: string
      messageId?: string
    }) => {
      const workbook = applyWorkbookOperations(
        input.content?.trim()
          ? await importDelimitedWorkbook(input.content, input.title, ctx.i18n.t("import.untitled"))
          : createWorkbook(input.title, input.sheetTitle),
        input.operations ?? []
      )
      const recalculation = await recalculate(workbook)
      const artifactId = await createArtifact(workbook, input)
      return {
        ok: true as const,
        artifactId,
        version: 1,
        summary: summarizeWorkbook(workbook),
        findings: validateWorkbook(workbook),
        recalculation,
      }
    },

    importXlsx: async (input: {
      handle?: string
      title?: string
      sessionId?: string
      messageId?: string
    }) => {
      const file = input.handle
        ? await ctx.files.readAttachment(input.handle)
        : (await ctx.files.open({ accept: [".xlsx", XLSX_MIME], maxBytes: 50 * 1024 * 1024 }))[0]
      if (!file) return { ok: false as const, cancelled: true as const }
      const workbook = await importWorkbookXlsx(
        file.bytes,
        input.title ?? "",
        file.name,
        ctx.i18n.t("import.untitled")
      )
      const artifactId = await createArtifact(workbook, input)
      return {
        ok: true as const,
        artifactId,
        version: 1,
        summary: summarizeWorkbook(workbook),
        findings: validateWorkbook(workbook),
        warnings: workbook.unsupportedFeatures,
      }
    },

    inspect: (artifactId: string) => {
      const { artifact, workbook } = readArtifact(artifactId)
      const summary = summarizeWorkbook(workbook)
      return {
        ok: true as const,
        artifactId,
        version: artifact.version,
        title: workbook.title,
        sheets: summary.sheets,
        summary,
        warnings: workbook.unsupportedFeatures,
      }
    },

    readRange: (
      artifactId: string,
      options: ReadWorkbookOptions & { format?: "grid" | "text" } = {}
    ) => {
      const { artifact, workbook } = readArtifact(artifactId)
      const { format = "grid", ...readOptions } = options
      if (format !== "grid" && format !== "text") throw new Error(`invalid format: ${format}`)
      const read = readWorkbook(workbook, readOptions)
      return {
        ok: true as const,
        artifactId,
        version: artifact.version,
        title: workbook.title,
        truncated: read.truncated,
        cellsReturned: read.cellsReturned,
        ...(format === "text"
          ? {
              text: formatWorkbookRead(read),
              sheets: read.sheets.map(({ rows: _rows, formulas: _formulas, ...sheet }) => sheet),
            }
          : { sheets: read.sheets }),
      }
    },

    applyOperations: async (input: {
      artifactId: string
      expectedVersion: number
      operations: WorkbookOperation[]
      changeDescription?: string
    }) => {
      const { workbook } = readArtifact(input.artifactId)
      const updated = applyWorkbookOperations(workbook, input.operations)
      const recalculation = await recalculate(updated)
      // `expectedVersion` still guards the write: an edit that landed while the
      // function library loaded makes this one fail instead of overwriting it.
      const artifact = ctx.artifact.updateArtifact(input.artifactId, {
        content: JSON.stringify(updated),
        title: updated.title,
        expectedVersion: input.expectedVersion,
        changeDescription: input.changeDescription,
      })
      ctx.artifact.openArtifact(input.artifactId)
      return {
        ok: true as const,
        artifactId: input.artifactId,
        version: artifact.version,
        summary: summarizeWorkbook(updated),
        findings: validateWorkbook(updated),
        recalculation,
      }
    },

    listVersions: (artifactId: string) => {
      const { artifact } = readArtifact(artifactId)
      return {
        ok: true as const,
        artifactId,
        currentVersion: artifact.version,
        versions: ctx.artifact.listVersions(artifactId).map((version) => ({
          versionId: version.id,
          version: version.version,
          title: version.title,
          createdAt: version.createdAt,
          changeDescription: version.changeDescription,
        })),
      }
    },

    restoreVersion: (input: { artifactId: string; versionId: string; expectedVersion: number }) => {
      readArtifact(input.artifactId)
      const target = ctx.artifact
        .listVersions(input.artifactId)
        .find((version) => version.id === input.versionId)
      if (!target) throw new Error(`workbook version not found: ${input.versionId}`)
      // Refuse a snapshot this schema cannot open before it becomes current.
      const restoredWorkbook = parseWorkbook(target.content)
      const artifact = ctx.artifact.restoreVersion(
        input.artifactId,
        input.versionId,
        input.expectedVersion
      )
      ctx.artifact.openArtifact(input.artifactId)
      return {
        ok: true as const,
        artifactId: input.artifactId,
        version: artifact.version,
        summary: summarizeWorkbook(restoredWorkbook),
        findings: validateWorkbook(restoredWorkbook),
      }
    },

    validate: (artifactId: string) => {
      const { workbook } = readArtifact(artifactId)
      const findings = validateWorkbook(workbook)
      return {
        ok: !findings.some((finding) => finding.severity === "error"),
        artifactId,
        findings,
      }
    },

    exportXlsx: async (
      artifactId: string,
      suggestedName?: string,
      allowUnsupportedFeatureLoss = false
    ) => {
      const { workbook } = readArtifact(artifactId)
      const findings = validateWorkbook(workbook)
      if (findings.some((finding) => finding.severity === "error")) {
        return {
          ok: false as const,
          artifactId,
          findings,
          error: "The workbook has validation errors; fix them before exporting.",
        }
      }
      if (workbook.unsupportedFeatures.length > 0 && !allowUnsupportedFeatureLoss) {
        return {
          ok: false as const,
          artifactId,
          requiresConfirmation: true as const,
          unsupportedFeatures: workbook.unsupportedFeatures,
          error:
            "The workbook contains unsupported features that the export would drop. Ask the " +
            "user to confirm, then retry with allowUnsupportedFeatureLoss: true.",
        }
      }
      const bytes = await exportWorkbookXlsx(workbook)
      if (!(await validateXlsxPackage(bytes)))
        return {
          ok: false as const,
          artifactId,
          reason: "invalid-package" as const,
          error: "The generated XLSX did not reopen cleanly, so nothing was saved.",
        }
      const filename = normalizeXlsxName(suggestedName ?? workbook.title)
      const outcome = await ctx.files.save({ suggestedName: filename, mimeType: XLSX_MIME, bytes })
      return {
        ...summarizeSave(outcome, filename),
        artifactId,
        byteLength: bytes.byteLength,
        findings,
      }
    },

    syncLark: async (
      artifactId: string,
      sessionId: string,
      options: { folderToken?: string; signal?: AbortSignal } = {}
    ) => {
      const { workbook } = readArtifact(artifactId)
      const result = await ctx.skills.invokeBuiltIn(
        "lark.sheets.create",
        {
          title: workbook.title,
          ...(options.folderToken ? { folderToken: options.folderToken } : {}),
          sheets: workbook.sheets.map((sheet) => ({
            title: sheet.title,
            values: sheetToValues(sheet),
          })),
        },
        { sessionId, signal: options.signal }
      )
      if (result.status !== "ok") return { ok: false as const, artifactId, result }
      return { ok: true as const, artifactId, result: result.data }
    },
  }
}

function sheetToValues(sheet: WorkbookDocument["sheets"][number]): unknown[][] {
  let maxRow = -1
  let maxColumn = -1
  const decoded = Object.entries(sheet.cells).flatMap(([ref, cell]) => {
    // Skip non-canonical refs instead of collapsing them onto A1.
    if (!/^[A-Z]+\d+$/.test(ref)) return []
    const { r: row, c: column } = decodeCell(ref)
    maxRow = Math.max(maxRow, row)
    maxColumn = Math.max(maxColumn, column)
    return [{ row, column, cell }]
  })
  const values = Array.from({ length: maxRow + 1 }, () => Array<unknown>(maxColumn + 1).fill(null))
  for (const { row, column, cell } of decoded)
    values[row][column] = cell.formula ? `=${cell.formula}` : (cell.value ?? null)
  return values
}
