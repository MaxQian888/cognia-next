"use client"

/**
 * Rasterise an artifact to a PNG Blob.
 *
 * `png` has been a member of `ArtifactExportFormat` since the type landed and
 * no adapter ever offered it, while ADR-0139's resident routing prompt told the
 * model chart artifacts were "exportable" on every single send. This is the
 * other half of that promise.
 *
 * Three capture strategies, picked by transport — the split is forced, not a
 * preference:
 *
 * - **svg**: parsed straight into an `<img>` and drawn to a canvas. No DOM
 *   walk needed, and it is the only path that survives an artifact whose
 *   preview is not on screen.
 * - **html / react**: re-rendered into an off-screen, *same-origin* iframe.
 *   html2canvas walks the DOM, and it cannot walk into the sandboxed preview
 *   frame (`components/artifacts/artifact-preview.tsx` gives that one
 *   `sandbox="allow-scripts"` with no `allow-same-origin`). This indirection is
 *   the same recipe `lib/export/html/chat-png.ts` uses.
 * - **renderer types** (chart / mermaid / math): captured from the mounted
 *   node via `lib/artifacts/preview-registry.ts`. Recharts and Mermaid draw
 *   live React/SVG; there is no serialisable source to re-render off-screen.
 */

import html2canvas from "html2canvas-pro"
import { sanitizeHTML } from "@/lib/artifacts/preview-utils"
import { getArtifactPreviewNode } from "@/lib/artifacts/preview-registry"
import { getArtifactRuntimeAdapter } from "@/components/artifacts/runtime-adapters"
import type { Artifact } from "@/types"

/** Capture width for the off-screen html/react path. Matches the chat exporter. */
export const CAPTURE_WIDTH_PX = 900

/**
 * Same ceiling `lib/export/html/chat-png.ts` uses. Canvas element height is
 * capped by the browser (~32k in Chrome, lower in Safari); past this the
 * capture silently produces a blank or truncated image, so fail loudly.
 */
export const MAX_PNG_HEIGHT_PX = 16000

/** The artifact's preview is not mounted, and its pixels only exist there. */
export class ArtifactPreviewNotMountedError extends Error {
  constructor(artifactId: string) {
    super(`artifact ${artifactId} must be previewed before it can be rasterised`)
    this.name = "ArtifactPreviewNotMountedError"
  }
}

/** The rendered artifact is taller than a canvas can hold. */
export class ArtifactTooLargeToRasteriseError extends Error {
  constructor(height: number) {
    super(`rendered artifact is ${height}px tall, over the ${MAX_PNG_HEIGHT_PX}px capture limit`)
    this.name = "ArtifactTooLargeToRasteriseError"
  }
}

/** This artifact type has no visual form to capture. */
export class ArtifactNotRasterisableError extends Error {
  constructor(type: string) {
    super(`artifact type ${type} has no rendered form to rasterise`)
    this.name = "ArtifactNotRasterisableError"
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("canvas.toBlob returned null"))
    }, "image/png")
  })
}

/**
 * SVG → PNG without html2canvas. The source is sanitised first: an artifact is
 * model output, and a `<script>` inside an `<img src="data:image/svg+xml,…">`
 * does not execute, but an external `<image href>` would still phone home.
 */
async function rasteriseSvg(content: string): Promise<Blob> {
  const sanitized = sanitizeHTML(content, { wholeDocument: false })
  const url = URL.createObjectURL(new Blob([sanitized], { type: "image/svg+xml" }))
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error("svg failed to decode"))
      img.src = url
    })
    // `naturalWidth` is 0 for an SVG with no intrinsic size; fall back to the
    // capture width rather than producing a 0×0 canvas.
    const width = image.naturalWidth || CAPTURE_WIDTH_PX
    const height = image.naturalHeight || CAPTURE_WIDTH_PX
    if (height > MAX_PNG_HEIGHT_PX) throw new ArtifactTooLargeToRasteriseError(height)
    const canvas = document.createElement("canvas")
    canvas.width = width * 2
    canvas.height = height * 2
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("2d canvas context unavailable")
    ctx.scale(2, 2)
    ctx.drawImage(image, 0, 0, width, height)
    return await canvasToPng(canvas)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** html / react → PNG through an off-screen same-origin iframe. */
async function rasteriseHtml(content: string, background: string): Promise<Blob> {
  const iframe = document.createElement("iframe")
  iframe.setAttribute("aria-hidden", "true")
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${CAPTURE_WIDTH_PX}px;height:10px;border:0;visibility:hidden`
  document.body.appendChild(iframe)
  try {
    await new Promise<void>((resolve, reject) => {
      iframe.addEventListener("load", () => resolve(), { once: true })
      iframe.addEventListener("error", () => reject(new Error("capture iframe failed")), {
        once: true,
      })
      // Sanitised, and deliberately NOT sandboxed: html2canvas has to read this
      // document. Scripts are stripped by `sanitizeHTML`, which is what makes
      // that safe.
      iframe.srcdoc = sanitizeHTML(content, { wholeDocument: true })
    })
    const doc = iframe.contentDocument
    const body = doc?.body
    if (!doc || !body) throw new Error("capture document unavailable")
    const height = Math.max(body.scrollHeight, doc.documentElement?.scrollHeight ?? 0, 1)
    if (height > MAX_PNG_HEIGHT_PX) throw new ArtifactTooLargeToRasteriseError(height)
    iframe.style.height = `${height}px`
    const canvas = await html2canvas(body, {
      backgroundColor: background,
      scale: 2,
      width: CAPTURE_WIDTH_PX,
      windowWidth: CAPTURE_WIDTH_PX,
      logging: false,
    })
    return await canvasToPng(canvas)
  } finally {
    iframe.remove()
  }
}

/** A live renderer node → PNG. */
async function rasteriseMountedNode(node: HTMLElement, background: string): Promise<Blob> {
  const height = Math.max(node.scrollHeight, 1)
  if (height > MAX_PNG_HEIGHT_PX) throw new ArtifactTooLargeToRasteriseError(height)
  const canvas = await html2canvas(node, {
    backgroundColor: background,
    scale: 2,
    logging: false,
  })
  return canvasToPng(canvas)
}

export interface RasteriseOptions {
  /**
   * Canvas background. `null` keeps transparency. Defaults to white because a
   * transparent PNG of dark-themed text is unreadable everywhere it is pasted.
   */
  background?: string | null
}

/**
 * Render `artifact` to a PNG Blob.
 *
 * Throws a *typed* error the caller can turn into a specific message —
 * "preview it first", "too large", "nothing to draw" are three different user
 * problems and collapsing them into one toast makes all three unactionable.
 */
export async function renderArtifactToPngBlob(
  artifact: Pick<Artifact, "id" | "type" | "content">,
  options: RasteriseOptions = {}
): Promise<Blob> {
  const background = options.background === undefined ? "#ffffff" : options.background
  const adapter = getArtifactRuntimeAdapter(artifact.type)

  if (artifact.type === "svg") return rasteriseSvg(artifact.content)
  if (adapter.transport === "iframe") {
    return rasteriseHtml(artifact.content, background ?? "#ffffff")
  }
  if (adapter.transport === "renderer") {
    const node = getArtifactPreviewNode(artifact.id)
    if (!node) throw new ArtifactPreviewNotMountedError(artifact.id)
    return rasteriseMountedNode(node, background ?? "#ffffff")
  }
  throw new ArtifactNotRasterisableError(artifact.type)
}
