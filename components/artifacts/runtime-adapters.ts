/**
 * Runtime adapter table — describes how each artifact type is rendered
 * (iframe / inline renderer / jupyter), the iframe sandbox attribute it
 * needs, the export formats it supports, and which authoring affordances
 * apply (canvas / embedded designer / full designer).
 *
 * Ported from Cognia. cognia-next has no Designer subsystem, so the
 * embedded/full-designer flags are dead in practice — the table itself is
 * preserved verbatim so future Designer work doesn't reshape the schema.
 */

import type { Artifact, ArtifactExportFormat, ArtifactType } from "@/types"

export type ArtifactRuntimeTransport = "iframe" | "renderer" | "jupyter"

export interface ArtifactAuthoringCapabilities {
  canvas: boolean
  embeddedDesigner: boolean
  fullDesigner: boolean
}

export interface ArtifactRuntimeAdapter {
  type: ArtifactType
  transport: ArtifactRuntimeTransport
  rendererType?: "code" | "document" | "mermaid" | "chart" | "math"
  sandbox?: string
  exportFormats: ArtifactExportFormat[]
  authoring: ArtifactAuthoringCapabilities
}

export const ARTIFACT_RUNTIME_ADAPTERS: Record<ArtifactType, ArtifactRuntimeAdapter> = {
  code: {
    type: "code",
    transport: "renderer",
    rendererType: "code",
    exportFormats: ["raw"],
    authoring: { canvas: true, embeddedDesigner: false, fullDesigner: false },
  },
  document: {
    type: "document",
    transport: "renderer",
    rendererType: "document",
    exportFormats: ["raw"],
    authoring: { canvas: true, embeddedDesigner: false, fullDesigner: false },
  },
  svg: {
    type: "svg",
    transport: "iframe",
    sandbox: "allow-same-origin",
    exportFormats: ["raw", "svg"],
    authoring: { canvas: true, embeddedDesigner: true, fullDesigner: true },
  },
  html: {
    type: "html",
    transport: "iframe",
    sandbox: "allow-same-origin",
    exportFormats: ["raw", "html"],
    authoring: { canvas: true, embeddedDesigner: true, fullDesigner: true },
  },
  react: {
    type: "react",
    transport: "iframe",
    sandbox: "allow-scripts",
    exportFormats: ["raw"],
    authoring: { canvas: true, embeddedDesigner: true, fullDesigner: true },
  },
  mermaid: {
    type: "mermaid",
    transport: "renderer",
    rendererType: "mermaid",
    exportFormats: ["raw"],
    authoring: { canvas: true, embeddedDesigner: false, fullDesigner: false },
  },
  chart: {
    type: "chart",
    transport: "renderer",
    rendererType: "chart",
    exportFormats: ["raw"],
    authoring: { canvas: true, embeddedDesigner: false, fullDesigner: false },
  },
  math: {
    type: "math",
    transport: "renderer",
    rendererType: "math",
    exportFormats: ["raw"],
    authoring: { canvas: true, embeddedDesigner: false, fullDesigner: false },
  },
  jupyter: {
    type: "jupyter",
    transport: "jupyter",
    exportFormats: ["raw"],
    authoring: { canvas: true, embeddedDesigner: false, fullDesigner: false },
  },
}

export function getArtifactRuntimeAdapter(type: ArtifactType): ArtifactRuntimeAdapter {
  return ARTIFACT_RUNTIME_ADAPTERS[type]
}

export function getArtifactAuthoringCapabilities(
  type: ArtifactType
): ArtifactAuthoringCapabilities {
  return getArtifactRuntimeAdapter(type).authoring
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
