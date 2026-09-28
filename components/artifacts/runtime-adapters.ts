/**
 * Runtime adapter table — describes how each artifact type is rendered
 * (iframe / inline renderer / jupyter), the iframe sandbox attribute it
 * needs, and the export formats it supports.
 *
 * `exportFormats` is a contract, not a wish list: every format named here must
 * have a renderer in `lib/artifacts/export/`, and
 * `runtime-adapters.test.ts` fails if one does not. `png` and `pdf` sat in
 * `ArtifactExportFormat` unclaimed by any adapter for a long time while the
 * resident routing prompt (ADR-0139) told the model chart artifacts were
 * "exportable" on every send.
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
    // No `png`: a screenshot of code is strictly worse than the code, and the
    // PDF path lays it out as selectable text rather than a picture.
    exportFormats: ["raw", "pdf"],
  },
  document: {
    type: "document",
    transport: "renderer",
    rendererType: "document",
    exportFormats: ["raw", "pdf"],
  },
  svg: {
    type: "svg",
    transport: "iframe",
    sandbox: "allow-same-origin",
    exportFormats: ["raw", "svg", "png", "pdf"],
  },
  html: {
    type: "html",
    transport: "iframe",
    sandbox: "allow-same-origin",
    exportFormats: ["raw", "html", "png", "pdf"],
  },
  react: {
    type: "react",
    transport: "iframe",
    sandbox: "allow-scripts",
    // `png` and `pdf` require a MOUNTED preview, unlike every other type here.
    // A React artifact's source is JSX that has not run, so re-rendering it
    // off-screen captures nothing; and its frame is opaque-origin, so neither
    // the parent nor the frame itself can rasterise it (html2canvas clones
    // into a child iframe, which an opaque-origin document cannot read). The
    // live frame is asked for a snapshot of what it drew instead, and the
    // exporter raises `ArtifactPreviewNotMountedError` when there is none.
    exportFormats: ["raw", "png", "pdf"],
  },
  mermaid: {
    type: "mermaid",
    transport: "renderer",
    rendererType: "mermaid",
    exportFormats: ["raw", "png", "pdf"],
  },
  chart: {
    type: "chart",
    transport: "renderer",
    rendererType: "chart",
    exportFormats: ["raw", "png", "pdf"],
  },
  math: {
    type: "math",
    transport: "renderer",
    rendererType: "math",
    exportFormats: ["raw", "png", "pdf"],
  },
  jupyter: {
    type: "jupyter",
    transport: "jupyter",
    // The jupyter transport has no raster path at all; `pdf` goes through the
    // text writer, which reads the notebook JSON as markdown.
    exportFormats: ["raw", "pdf"],
  },
}

export function getArtifactRuntimeAdapter(type: ArtifactType): ArtifactRuntimeAdapter {
  return ARTIFACT_RUNTIME_ADAPTERS[type]
}

/**
 * Whether an artifact's content is a plugin's structured model rather than
 * prose: a plugin-owned payload stored as JSON (a cognia-office workbook, a
 * cognia-documents document model). This reads the artifact itself, so it
 * holds while the owning plugin is disabled or still loading and for every
 * caller — the panel, the export workflow node, the preferred-format pick.
 */
export function isPluginModelArtifact(
  artifact: Pick<Artifact, "metadata"> & { language?: Artifact["language"] }
): boolean {
  return Boolean(artifact.metadata?.plugin) && artifact.language === "json"
}

/**
 * The formats the host can export an artifact as.
 *
 * Plugin-owned content — a plugin model (`isPluginModelArtifact`), or any
 * artifact a registered plugin renderer draws (`pluginOwnsContent`) — is not
 * prose, so the host's text-based exporters would print the model. Such an
 * artifact offers only the formats it declares, and `raw` when it declares
 * none; its native export is the plugin's own.
 */
export function getArtifactExportFormats(
  artifact: Pick<Artifact, "type" | "metadata"> & { language?: Artifact["language"] },
  options: { pluginOwnsContent?: boolean } = {}
): ArtifactExportFormat[] {
  const adapterFormats = getArtifactRuntimeAdapter(artifact.type).exportFormats
  const declaredFormats = artifact.metadata?.exportFormats
  const pluginOwned = options.pluginOwnsContent || isPluginModelArtifact(artifact)

  if (!declaredFormats?.length) {
    return pluginOwned ? ["raw"] : [...adapterFormats]
  }

  return declaredFormats.filter((format): format is ArtifactExportFormat =>
    adapterFormats.includes(format)
  )
}

export function getPreferredArtifactExportFormat(
  artifact: Pick<Artifact, "type" | "metadata"> & { language?: Artifact["language"] }
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
