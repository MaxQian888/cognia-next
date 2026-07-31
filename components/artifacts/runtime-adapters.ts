/**
 * Runtime adapter table — describes how each artifact type is rendered
 * (iframe / inline renderer / jupyter), the iframe sandbox attribute it
 * needs, and the export formats it supports.
 *
 * The `authoring` block this table used to carry is gone. It described a
 * Designer subsystem cognia-next never had: `fullDesigner` had no readers at
 * all, and `embeddedDesigner` had exactly one — a gate on whether to mount a
 * dialog that nothing could open. Visual authoring here is "Edit in Canvas"
 * (`useArtifactPanelState.handleOpenInCanvas`), and which types it suits is
 * `DESIGNABLE_TYPES` / `canDesign()` in `lib/artifacts/constants.ts`.
 */

import type { Artifact, ArtifactExportFormat, ArtifactType } from "@/types"

export type ArtifactRuntimeTransport = "iframe" | "renderer" | "jupyter"

export interface ArtifactRuntimeAdapter {
  type: ArtifactType
  transport: ArtifactRuntimeTransport
  rendererType?: "code" | "document" | "mermaid" | "chart" | "math"
  sandbox?: string
  exportFormats: ArtifactExportFormat[]
}

export const ARTIFACT_RUNTIME_ADAPTERS: Record<ArtifactType, ArtifactRuntimeAdapter> = {
  code: {
    type: "code",
    transport: "renderer",
    rendererType: "code",
    exportFormats: ["raw"],
  },
  document: {
    type: "document",
    transport: "renderer",
    rendererType: "document",
    exportFormats: ["raw"],
  },
  svg: {
    type: "svg",
    transport: "iframe",
    sandbox: "allow-same-origin",
    exportFormats: ["raw", "svg"],
  },
  html: {
    type: "html",
    transport: "iframe",
    sandbox: "allow-same-origin",
    exportFormats: ["raw", "html"],
  },
  react: {
    type: "react",
    transport: "iframe",
    sandbox: "allow-scripts",
    exportFormats: ["raw"],
  },
  mermaid: {
    type: "mermaid",
    transport: "renderer",
    rendererType: "mermaid",
    exportFormats: ["raw"],
  },
  chart: {
    type: "chart",
    transport: "renderer",
    rendererType: "chart",
    exportFormats: ["raw"],
  },
  math: {
    type: "math",
    transport: "renderer",
    rendererType: "math",
    exportFormats: ["raw"],
  },
  jupyter: {
    type: "jupyter",
    transport: "jupyter",
    exportFormats: ["raw"],
  },
}

export function getArtifactRuntimeAdapter(type: ArtifactType): ArtifactRuntimeAdapter {
  return ARTIFACT_RUNTIME_ADAPTERS[type]
}

export function getArtifactExportFormats(
  artifact: Pick<Artifact, "type" | "metadata">
): ArtifactExportFormat[] {
  const adapterFormats = getArtifactRuntimeAdapter(artifact.type).exportFormats
  const declaredFormats = artifact.metadata?.exportFormats

  if (!declaredFormats?.length) {
    return [...adapterFormats]
  }

  return declaredFormats.filter((format): format is ArtifactExportFormat =>
    adapterFormats.includes(format)
  )
}

export function getPreferredArtifactExportFormat(
  artifact: Pick<Artifact, "type" | "metadata">
): ArtifactExportFormat {
  const formats = getArtifactExportFormats(artifact)

  if (artifact.type === "html" && formats.includes("html")) {
    return "html"
  }

  if (artifact.type === "svg" && formats.includes("svg")) {
    return "svg"
  }

  return formats[0] || "raw"
}
