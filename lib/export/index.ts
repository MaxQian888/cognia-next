/**
 * Top-level export barrel.
 *
 * The export subsystem is split across `single/` (per-session export
 * orchestrator, returns `{filename, content, mimeType}`), `text/` (rich
 * markdown / JSON / plain text writers), `html/` (beautiful + animated
 * HTML), and `batch/` (multi-session zips). Plugin authors importing
 * from `@/lib/export` get the orchestrator plus rich writers under
 * stable public names; reach into the sub-paths only when you need a
 * specific writer's options type.
 *
 * Naming convention: every exporter is `exportTo<Format>`. The two
 * HTML aliases (`exportToHTML`, `exportToAnimatedHTML`) preserve the
 * historical capitalisation plugin authors expect.
 */

export {
  renderSingleExport,
  type SingleExportFormat,
  type SingleExportOptions,
  type SingleExportResult,
} from "./single"

export {
  exportToRichMarkdown,
  exportToRichJSON,
  exportToPlainText,
  type RichExportData,
} from "./text/rich-markdown"

export { exportToBeautifulHtml, type BeautifulHtmlOptions } from "./html/beautiful-html"

export { exportToAnimatedHtml, type AnimatedHtmlOptions } from "./html/animated-html"

// Stable plugin-facing aliases.
export { exportToBeautifulHtml as exportToHTML } from "./html/beautiful-html"
export { exportToAnimatedHtml as exportToAnimatedHTML } from "./html/animated-html"

/**
 * Slugify a session title and append the right extension. Used by the
 * orchestrator and the plugin Export API when the caller wants a
 * stable filename without invoking `renderSingleExport`.
 */
export function generateFilename(title: string, extension: string): string {
  const slug = slugify(title) || "conversation"
  const ext = extension.startsWith(".") ? extension.slice(1) : extension
  return `${slug}.${ext}`
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}
