/**
 * Export the workflow graph as a PNG.
 *
 * Uses the canonical React Flow recipe: compute the bounding box of all nodes
 * (`getNodesBounds`), derive the transform that fits them into the target image
 * (`getViewportForBounds`), then rasterise the `.react-flow__viewport` layer
 * with html2canvas — applying the fit transform on the *cloned* DOM via
 * `onclone` so the live canvas is never mutated. Capturing the viewport layer
 * (not the wrapper) naturally excludes the toolbars, minimap, and breadcrumb,
 * which are React Flow panels / sibling overlays.
 */

import html2canvas from "html2canvas"
import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react"

const MIN_DIMENSION = 512
const MAX_DIMENSION = 4096

export interface ExportWorkflowImageOptions {
  /** The React Flow wrapper element (contains `.react-flow__viewport`). */
  flowEl: HTMLElement
  nodes: Node[]
  fileName: string
  /** PNG background; `null` keeps it transparent. */
  backgroundColor?: string | null
  /** Fractional padding around the graph (0.12 = 12%). */
  padding?: number
}

function clampDimension(value: number): number {
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, value))
}

export async function exportWorkflowImage({
  flowEl,
  nodes,
  fileName,
  backgroundColor = null,
  padding = 0.12,
}: ExportWorkflowImageOptions): Promise<void> {
  if (nodes.length === 0) throw new Error("No nodes to export")
  const viewportEl = flowEl.querySelector<HTMLElement>(".react-flow__viewport")
  if (!viewportEl) throw new Error("React Flow viewport element not found")

  const bounds = getNodesBounds(nodes)
  const imageWidth = clampDimension(Math.round(bounds.width * (1 + padding * 2)))
  const imageHeight = clampDimension(Math.round(bounds.height * (1 + padding * 2)))
  const { x, y, zoom } = getViewportForBounds(bounds, imageWidth, imageHeight, 0.2, 2, padding)

  const canvas = await html2canvas(viewportEl, {
    backgroundColor,
    width: imageWidth,
    height: imageHeight,
    useCORS: true,
    logging: false,
    onclone: (doc: Document) => {
      const cloned = doc.querySelector<HTMLElement>(".react-flow__viewport")
      if (cloned) {
        cloned.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
      }
    },
  })

  const link = document.createElement("a")
  link.href = canvas.toDataURL("image/png")
  link.download = fileName.endsWith(".png") ? fileName : `${fileName}.png`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
