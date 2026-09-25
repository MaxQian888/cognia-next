import type { PluginContext } from "@cognia/plugin-sdk"
import { normalizeExportName, summarizeSave } from "./export-file"
import {
  applyWorkbookOperations,
  createWorkbook,
  parseWorkbook,
  validateWorkbook,
  WORKBOOK_ARTIFACT_KIND,
  WORKBOOK_SCHEMA_VERSION,
  type WorkbookDocument,
  type WorkbookOperation,
} from "./model"
import { exportWorkbookXlsx, importDelimitedWorkbook, importWorkbookXlsx, XLSX_MIME } from "./xlsx"

export type OfficePluginContext = Pick<PluginContext, "artifact" | "files" | "skills" | "i18n">

/** A `.xlsx` filename `ctx.files.save` accepts, built from a title or model-supplied name. */
export function normalizeXlsxName(value: string | undefined): string {
  return normalizeExportName(value, "xlsx", "workbook")
}

export function createOfficeRuntime(ctx: OfficePluginContext) {
  function readArtifact(artifactId: string) {
    const artifact = ctx.artifact.getArtifact(artifactId)
    if (!artifact) throw new Error(`workbook artifact not found: ${artifactId}`)
    if (artifact.metadata?.plugin?.kind !== WORKBOOK_ARTIFACT_KIND) {
      throw new Error(`artifact is not a Cognia Office workbook: ${artifactId}`)
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
      const artifactId = await createArtifact(workbook, input)
      return { ok: true as const, artifactId, workbook }
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
      return { ok: true as const, artifactId, workbook, warnings: workbook.unsupportedFeatures }
    },

    inspect: (artifactId: string) => {
      const { artifact, workbook } = readArtifact(artifactId)
      return {
        ok: true as const,
        artifactId,
        version: artifact.version,
        title: workbook.title,
        sheets: workbook.sheets.map((sheet) => ({
          id: sheet.id,
          title: sheet.title,
          cellCount: Object.keys(sheet.cells).length,
          merges: sheet.merges.length,
        })),
        warnings: workbook.unsupportedFeatures,
      }
    },

    applyOperations: (input: {
      artifactId: string
      expectedVersion: number
      operations: WorkbookOperation[]
      changeDescription?: string
    }) => {
      const { workbook } = readArtifact(input.artifactId)
      const updated = applyWorkbookOperations(workbook, input.operations)
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
        workbook: updated,
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
    const match = /^([A-Z]+)(\d+)$/.exec(ref)
    // Skip non-canonical refs instead of collapsing them onto A1.
    if (!match) return []
    const column =
      match[1].split("").reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1
    const row = Number(match[2]) - 1
    maxRow = Math.max(maxRow, row)
    maxColumn = Math.max(maxColumn, column)
    return [{ row, column, cell }]
  })
  const values = Array.from({ length: maxRow + 1 }, () => Array<unknown>(maxColumn + 1).fill(null))
  for (const { row, column, cell } of decoded)
    values[row][column] = cell.formula ? `=${cell.formula}` : (cell.value ?? null)
  return values
}
