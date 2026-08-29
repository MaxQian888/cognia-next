"use client"

/**
 * Which DOM node is currently showing a given artifact's preview.
 *
 * Rasterising an artifact needs the pixels, and where those pixels live depends
 * on the artifact's transport (`components/artifacts/runtime-adapters.ts`):
 *
 * - `renderer` types (chart / mermaid / math / code / document) draw as live
 *   React inside the host tree, so the only way to capture them is to hand
 *   html2canvas the mounted node. That is the same trick
 *   `lib/workflow/editor/export-image.ts` uses on `.react-flow__viewport`.
 * - `iframe` types (html / svg / react) are sandboxed, so html2canvas cannot
 *   read into them at all. Those re-render into an off-screen same-origin
 *   iframe instead — see `lib/artifacts/export/raster.ts`.
 *
 * The registry exists only for the first group. It is deliberately a plain
 * module-level Map rather than a store: nothing renders off it, it is read
 * once per export, and a React context would force every preview to re-render
 * when an unrelated one mounted.
 */

const previewNodes = new Map<string, HTMLElement>()

/**
 * Record the node currently painting `artifactId`, returning a disposer.
 *
 * Re-registering the same id replaces the entry — a remount (the preview
 * iframe is keyed, and the dock can swap panels) must not leave the exporter
 * holding a detached node.
 */
export function registerArtifactPreviewNode(artifactId: string, node: HTMLElement): () => void {
  previewNodes.set(artifactId, node)
  return () => {
    if (previewNodes.get(artifactId) === node) previewNodes.delete(artifactId)
  }
}

/**
 * The live node for `artifactId`, or `null`.
 *
 * Returns `null` for a node that has been detached from the document: a stale
 * entry would rasterise to a blank image, which is worse than a typed failure
 * the caller can explain ("open the preview first").
 */
export function getArtifactPreviewNode(artifactId: string): HTMLElement | null {
  const node = previewNodes.get(artifactId)
  if (!node) return null
  if (typeof document !== "undefined" && !document.contains(node)) {
    previewNodes.delete(artifactId)
    return null
  }
  return node
}

/** Test seam — drops every registration. */
export function clearArtifactPreviewNodes(): void {
  previewNodes.clear()
}
