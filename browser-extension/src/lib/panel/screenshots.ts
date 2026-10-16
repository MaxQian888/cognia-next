/**
 * Screenshots and files the panel attaches to a submission (ADR-0228 §3).
 *
 * A visible-area shot is one `captureVisibleTab`; a region is a crop of one,
 * chosen by dragging over its preview; a full page scrolls the tab and
 * stitches the captures, at Chrome's pace of two captures a second, and puts
 * the scroll back where the person left it.
 */
import type { BrowserAttachmentKind } from "@cognia/companion-client"

import { MAX_CANVAS_SIDE } from "../agent/image-ops"
import { base64ToBytes } from "../attachment-upload"
import type { BrowserApi, TabRef } from "../browser-api"

export interface PendingAttachment {
  id: string
  name: string
  mediaType: string
  kind: BrowserAttachmentKind
  bytes: Uint8Array
  /** A data URL for an image's thumbnail; absent for a PDF. */
  previewUrl?: string
}

type ShotApi = Pick<
  BrowserApi,
  "captureVisible" | "activateTab" | "scrollMetrics" | "scrollTo" | "cropImage" | "stitchImages"
>

/** Chrome refuses more than two visible-tab captures a second. */
export const CAPTURE_SPACING_MS = 550
export const MAX_SEGMENTS = 20

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

export function screenshotAttachment(
  id: string,
  base64Png: string,
  now: number,
  label: "visible" | "region" | "full-page"
): PendingAttachment {
  return {
    id,
    name: `screenshot-${label}-${stamp(now)}.png`,
    mediaType: "image/png",
    kind: "screenshot",
    bytes: base64ToBytes(base64Png),
    previewUrl: `data:image/png;base64,${base64Png}`,
  }
}

function windowOf(tab: TabRef): number {
  if (tab.windowId === undefined) throw new Error("the tab's window is unknown")
  return tab.windowId
}

/** The visible area of the tab, as a data URL. The tab is brought to front first. */
export async function captureVisible(
  api: ShotApi,
  tab: TabRef,
  sleep: (ms: number) => Promise<void>
) {
  await api.activateTab(tab.id)
  await sleep(150)
  return api.captureVisible(windowOf(tab))
}

/** A dragged rectangle on a preview of `preview` size, in the image's own pixels. */
export function regionInImagePixels(
  rect: { x: number; y: number; width: number; height: number },
  preview: { width: number; height: number },
  image: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const scaleX = image.width / Math.max(1, preview.width)
  const scaleY = image.height / Math.max(1, preview.height)
  const left = Math.min(rect.x, rect.x + rect.width)
  const top = Math.min(rect.y, rect.y + rect.height)
  const x = Math.max(0, Math.round(left * scaleX))
  const y = Math.max(0, Math.round(top * scaleY))
  return {
    x,
    y,
    width: Math.max(1, Math.min(image.width - x, Math.round(Math.abs(rect.width) * scaleX))),
    height: Math.max(1, Math.min(image.height - y, Math.round(Math.abs(rect.height) * scaleY))),
  }
}

/**
 * The whole page, stitched. Answers base64 PNG and whether it was cut short
 * (more segments than {@link MAX_SEGMENTS}, or taller than a canvas draws).
 */
export async function captureFullPage(
  api: ShotApi,
  tab: TabRef,
  sleep: (ms: number) => Promise<void>
): Promise<{ base64: string; width: number; height: number; truncated: boolean }> {
  const windowId = windowOf(tab)
  await api.activateTab(tab.id)
  const metrics = await api.scrollMetrics(tab.id)
  const steps = Math.min(
    MAX_SEGMENTS,
    Math.max(1, Math.ceil(metrics.scrollHeight / metrics.viewportHeight))
  )
  const shots: string[] = []
  const heights: number[] = []
  try {
    for (let step = 0; step < steps; step++) {
      const landed = await api.scrollTo(tab.id, step * metrics.viewportHeight)
      await sleep(step === 0 ? 150 : CAPTURE_SPACING_MS)
      shots.push(await api.captureVisible(windowId))
      // A last segment that could not scroll a full viewport overlaps the one
      // before it; only the rows below the previous bottom are new.
      const previousBottom = step * metrics.viewportHeight
      const fresh =
        step === 0 ? metrics.viewportHeight : landed + metrics.viewportHeight - previousBottom
      heights.push(Math.round(Math.max(0, Math.min(metrics.viewportHeight, fresh)) * metrics.dpr))
    }
  } finally {
    await api.scrollTo(tab.id, metrics.scrollY).catch(() => undefined)
  }
  const width = Math.min(MAX_CANVAS_SIDE, Math.round(metrics.viewportWidth * metrics.dpr))
  const rows = heights.reduce((sum, value) => sum + value, 0)
  return {
    base64: await api.stitchImages(shots, width, heights),
    width,
    height: Math.min(MAX_CANVAS_SIDE, rows),
    truncated:
      rows > MAX_CANVAS_SIDE ||
      (steps === MAX_SEGMENTS && metrics.scrollHeight > steps * metrics.viewportHeight),
  }
}

/** A file's name from its URL, or a fallback with the right extension. */
export function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop()
    const decoded = last ? decodeURIComponent(last) : ""
    return decoded && decoded.length <= 120 ? decoded : fallback
  } catch {
    return fallback
  }
}

/** The media type of fetched bytes: the server's word, else the file's magic. */
export function sniffMediaType(bytes: Uint8Array, declared: string): string {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
    return "application/pdf"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return declared
}
