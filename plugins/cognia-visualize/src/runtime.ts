import type { FullPluginContext } from "@cognia/plugin-sdk/context"
import type { PluginArtifactAPI, PluginFilesAPI } from "@cognia/plugin-sdk"
import { exportVisualizationHtml, exportVisualizationSvg } from "./export"
import {
  createVisualization,
  parseVisualization,
  recommendProfile,
  validateVisualization,
  VISUALIZATION_ARTIFACT_KIND,
  VISUALIZATION_SCHEMA_VERSION,
  type VisualizationSpec,
} from "./model"

export type VisualizePluginContext = Pick<FullPluginContext, "pluginId"> & {
  artifact: PluginArtifactAPI
  files: PluginFilesAPI
}

export function createVisualizeRuntime(ctx: VisualizePluginContext) {
  const read = (artifactId: string) => {
    const artifact = ctx.artifact.getArtifact(artifactId)
    if (!artifact) throw new Error(`Visualization artifact not found: ${artifactId}`)
    if (artifact.metadata?.plugin?.kind !== VISUALIZATION_ARTIFACT_KIND)
      throw new Error(`Artifact is not a Cognia visualization: ${artifactId}`)
    return { artifact, spec: parseVisualization(artifact.content) }
  }
  return {
    recommend: (intent: string) => ({ ok: true as const, ...recommendProfile(intent) }),
    create: async (
      input: Parameters<typeof createVisualization>[0] & { sessionId?: string; messageId?: string }
    ) => {
      const spec = createVisualization(input)
      const artifactId = await ctx.artifact.createArtifact({
        title: spec.title,
        content: JSON.stringify(spec),
        type: "chart",
        language: "json",
        kind: VISUALIZATION_ARTIFACT_KIND,
        schemaVersion: VISUALIZATION_SCHEMA_VERSION,
        sessionId: input.sessionId,
        messageId: input.messageId,
        metadata: {
          sourceOrigin: "tool",
          userInitiated: true,
          previewable: true,
        },
      })
      ctx.artifact.openArtifact(artifactId)
      return { ok: true as const, artifactId, findings: validateVisualization(spec) }
    },
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
      const spec = createVisualization(input.spec)
      const artifact = ctx.artifact.updateArtifact(input.artifactId, {
        content: JSON.stringify(spec),
        expectedVersion: input.expectedVersion,
        changeDescription: input.changeDescription ?? "Update visualization",
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
        throw new Error("Visualization validation failed before export.")
      const bytes =
        input.format === "svg"
          ? exportVisualizationSvg(spec)
          : input.format === "html"
            ? exportVisualizationHtml(spec)
            : new TextEncoder().encode(JSON.stringify(spec, null, 2))
      const mimeType =
        input.format === "svg"
          ? "image/svg+xml"
          : input.format === "html"
            ? "text/html"
            : "application/json"
      const result = await ctx.files.save({
        suggestedName: input.suggestedName ?? `${safe(spec.title)}.${input.format}`,
        mimeType,
        bytes,
      })
      return { ok: result.saved, artifactId: input.artifactId, byteLength: bytes.byteLength }
    },
  }
}
function safe(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "visualization"
}
