import type { PluginContext } from "@cognia/plugin-sdk"
import { VISUALIZATION_COLUMNS } from "./chart"
import {
  exportVisualizationHtml,
  exportVisualizationSvg,
  type VisualizationExportLabels,
} from "./export"
import { normalizeExportName, summarizeSave } from "./export-file"
import {
  createVisualization,
  parseVisualization,
  recommendProfile,
  validateVisualization,
  VISUALIZATION_ARTIFACT_KIND,
  VISUALIZATION_SCHEMA_VERSION,
  type VisualizationSpec,
} from "./model"

export type VisualizePluginContext = Pick<PluginContext, "artifact" | "files" | "export" | "i18n">

/** The custom exporter id `ctx.export.exportSession` resolves for this plugin. */
export const VISUALIZATION_REPORT_FORMAT = "visualization-report"

const EXPORT_MIME = {
  svg: "image/svg+xml",
  html: "text/html",
  json: "application/json",
} as const

type SpecInput = Parameters<typeof createVisualization>[0]

export function createVisualizeRuntime(ctx: VisualizePluginContext) {
  const t = (key: string, params?: Record<string, string | number>) => ctx.i18n.t(key, params)
  const read = (artifactId: string) => {
    const artifact = ctx.artifact.getArtifact(artifactId)
    if (!artifact) throw new Error(`Visualization artifact not found: ${artifactId}`)
    if (artifact.metadata?.plugin?.kind !== VISUALIZATION_ARTIFACT_KIND)
      throw new Error(`Artifact is not a Cognia visualization: ${artifactId}`)
    return { artifact, spec: parseVisualization(artifact.content) }
  }
  /** Build a spec, defaulting the screen-reader summary in the user's language. */
  const buildSpec = (input: SpecInput) =>
    createVisualization(
      input,
      t("summary.default", { title: input.title.trim(), count: input.data.length })
    )
  const exportLabels = (): VisualizationExportLabels => ({
    columns: Object.fromEntries(VISUALIZATION_COLUMNS.map((key) => [key, t(`preview.col.${key}`)])),
    dataHeading: t("preview.data"),
    emptyReport: t("report.empty"),
  })
  const listSpecs = (sessionId?: string) =>
    ctx.artifact
      .listArtifacts(sessionId ? { sessionId } : undefined)
      .filter((artifact) => artifact.metadata?.plugin?.kind === VISUALIZATION_ARTIFACT_KIND)

  return {
    exportLabels,
    recommend: (intent: string) => ({ ok: true as const, ...recommendProfile(intent) }),
    create: async (input: SpecInput & { sessionId?: string; messageId?: string }) => {
      const { sessionId, messageId, ...specInput } = input
      const spec = buildSpec(specInput)
      const artifactId = await ctx.artifact.createArtifact({
        title: spec.title,
        content: JSON.stringify(spec),
        type: "chart",
        language: "json",
        kind: VISUALIZATION_ARTIFACT_KIND,
        schemaVersion: VISUALIZATION_SCHEMA_VERSION,
        sessionId,
        messageId,
        metadata: {
          sourceOrigin: "tool",
          // Every artifact this runtime creates comes from an agent tool call.
          userInitiated: false,
          previewable: true,
        },
      })
      ctx.artifact.openArtifact(artifactId)
      return { ok: true as const, artifactId, findings: validateVisualization(spec) }
    },
    /** `sessionId` scopes the listing; without one every visualization is listed. */
    list: (input: { sessionId?: string }) => ({
      ok: true as const,
      artifacts: listSpecs(input.sessionId).map((artifact) => ({
        artifactId: artifact.id,
        title: artifact.title,
        version: artifact.version,
        updatedAt: artifact.updatedAt,
        sessionId: artifact.sessionId,
      })),
    }),
    inspect: (artifactId: string) => {
      const { artifact, spec } = read(artifactId)
      return {
        ok: true as const,
        artifactId,
        version: artifact.version,
        spec,
        findings: validateVisualization(spec),
      }
    },
    update: (input: {
      artifactId: string
      expectedVersion: number
      spec: VisualizationSpec
      changeDescription?: string
    }) => {
      read(input.artifactId)
      const spec = buildSpec(input.spec)
      const artifact = ctx.artifact.updateArtifact(input.artifactId, {
        title: spec.title,
        content: JSON.stringify(spec),
        expectedVersion: input.expectedVersion,
        changeDescription: input.changeDescription ?? t("history.update"),
      })
      ctx.artifact.openArtifact(input.artifactId)
      return {
        ok: true as const,
        artifactId: input.artifactId,
        version: artifact.version,
        findings: validateVisualization(spec),
      }
    },
    validate: (artifactId: string) => {
      const { spec } = read(artifactId)
      const findings = validateVisualization(spec)
      return { ok: !findings.some((finding) => finding.severity === "error"), artifactId, findings }
    },
    preview: (artifactId: string) => {
      read(artifactId)
      ctx.artifact.openArtifact(artifactId)
      return { ok: true as const, artifactId }
    },
    export: async (input: {
      artifactId: string
      format: "svg" | "html" | "json"
      suggestedName?: string
    }) => {
      const { spec } = read(input.artifactId)
      const findings = validateVisualization(spec)
      if (findings.some((finding) => finding.severity === "error"))
        return {
          ok: false as const,
          artifactId: input.artifactId,
          findings,
          error: "The visualization has validation errors; fix them before exporting.",
        }
      const bytes =
        input.format === "svg"
          ? exportVisualizationSvg(spec)
          : input.format === "html"
            ? exportVisualizationHtml(
                spec,
                exportLabels(),
                ctx.i18n.getCurrentLocale() === "zh-CN" ? "zh-CN" : "en"
              )
            : new TextEncoder().encode(JSON.stringify(spec, null, 2))
      const filename = normalizeExportName(
        input.suggestedName ?? spec.title,
        input.format,
        "visualization"
      )
      const outcome = await ctx.files.save({
        suggestedName: filename,
        mimeType: EXPORT_MIME[input.format],
        bytes,
      })
      return {
        ...summarizeSave(outcome, filename),
        artifactId: input.artifactId,
        byteLength: bytes.byteLength,
      }
    },
    /**
     * Render every visualization in a session into one HTML report through
     * the host export pipeline (`exportSession` → this plugin's
     * `visualization-report` exporter), then save it like any other export.
     * Going through the pipeline keeps the export hooks and the Digital Twin
     * provenance disclosure a session export must carry.
     */
    exportReport: async (input: { sessionId: string; suggestedName?: string }) => {
      if (listSpecs(input.sessionId).length === 0)
        return {
          ok: false as const,
          sessionId: input.sessionId,
          error:
            "This session has no visualizations yet; create one with visualize_create before exporting a report.",
        }
      const result = await ctx.export.exportSession(input.sessionId, {
        // Our own registered exporter id; the host resolves it for this plugin.
        format: VISUALIZATION_REPORT_FORMAT,
      })
      if (!result.success || !result.blob)
        return {
          ok: false as const,
          sessionId: input.sessionId,
          error: result.error ?? "The visualization report could not be generated.",
        }
      const bytes = new Uint8Array(await result.blob.arrayBuffer())
      const filename = normalizeExportName(
        input.suggestedName ?? result.filename,
        "html",
        "visualization-report"
      )
      const outcome = await ctx.files.save({
        suggestedName: filename,
        mimeType: "text/html",
        bytes,
      })
      return {
        ...summarizeSave(outcome, filename),
        sessionId: input.sessionId,
        byteLength: bytes.byteLength,
      }
    },
  }
}
