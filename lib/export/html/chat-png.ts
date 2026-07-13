// Rasterizes a "beautiful HTML" chat export to a PNG Blob. html2canvas cannot
// read into a sandboxed preview iframe and the export's stylesheet uses global
// selectors (body/pre/details) that would leak if injected into the app DOM, so
// we render the full self-contained document into an OFF-SCREEN, non-sandboxed,
// same-origin iframe and rasterize its body. Very long chats blow past canvas
// limits, so a height guard bails with a typed error the caller can surface.

import html2canvas from "html2canvas"
import { exportToBeautifulHtml, type BeautifulHtmlOptions } from "./beautiful-html"
import { THEMES } from "./syntax-themes"

/** Canvas rasterization gets unreliable past ~16k px; bail before that. */
export const MAX_PNG_HEIGHT_PX = 16000

/** Fixed capture width — matches the export container's readable measure. */
const CAPTURE_WIDTH_PX = 960

/** Thrown when a conversation is too tall to rasterize into one image. */
export class ChatPngTooLongError extends Error {
  constructor() {
    super("conversation too long to render as a single image")
    this.name = "ChatPngTooLongError"
  }
}

/** Resolve the page background used behind the export (custom theme wins). */
export function pngBackground(options: BeautifulHtmlOptions): string {
  return options.customTheme?.bg ?? THEMES[options.theme ?? "light"].bg
}

/**
 * Render a chat export to a PNG Blob. Throws {@link ChatPngTooLongError} when
 * the rendered height exceeds {@link MAX_PNG_HEIGHT_PX}.
 */
export async function renderChatToPng(options: BeautifulHtmlOptions): Promise<Blob> {
  const html = exportToBeautifulHtml(options)
  const iframe = document.createElement("iframe")
  iframe.setAttribute("aria-hidden", "true")
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${CAPTURE_WIDTH_PX}px;height:10px;border:0;visibility:hidden`
  document.body.appendChild(iframe)
  try {
    await new Promise<void>((resolve, reject) => {
      iframe.addEventListener("load", () => resolve(), { once: true })
      iframe.addEventListener("error", () => reject(new Error("iframe load failed")), {
        once: true,
      })
      iframe.srcdoc = html
    })
    const doc = iframe.contentDocument
    const body = doc?.body
    if (!doc || !body) throw new Error("capture document unavailable")
    const height = Math.max(body.scrollHeight, doc.documentElement?.scrollHeight ?? 0)
    if (height > MAX_PNG_HEIGHT_PX) throw new ChatPngTooLongError()
    iframe.style.height = `${height}px`
    const canvas = await html2canvas(body, {
      backgroundColor: pngBackground(options),
      scale: 2,
      width: CAPTURE_WIDTH_PX,
      windowWidth: CAPTURE_WIDTH_PX,
      logging: false,
    })
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
    })
  } finally {
    document.body.removeChild(iframe)
  }
}
