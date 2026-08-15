import type { FileViewerContribution } from "./types"

/**
 * Extensions that get a rich (non-text) preview.
 *
 * Exactly the list `isProjectFilePreviewable` has always used. Widening it is a
 * product change, not a refactor: the project workbench grants its `preview`
 * capability from this answer, so an extra entry makes a Preview tab appear on
 * a file kind that never had one.
 */
export const RICH_PREVIEW_EXTENSIONS = ["md", "markdown", "html", "htm", "json"] as const

/**
 * The host's own viewers.
 *
 * Ordering is by `priority` and nothing else, so a future contribution can win
 * a file kind by declaring a higher number. That is deliberately unlike
 * `lib/artifacts/renderer-registry.ts`, which declares a `priority` it never
 * reads and lets the last registration for a kind silently win.
 */
export const BUILTIN_FILE_VIEWERS: readonly FileViewerContribution[] = [
  {
    id: "builtin.markdown",
    priority: 100,
    matches: (probe) => probe.extension === "md" || probe.extension === "markdown",
    load: () => import("@/components/file-viewer/markdown-viewer"),
  },
  {
    id: "builtin.html",
    priority: 100,
    matches: (probe) => probe.extension === "html" || probe.extension === "htm",
    load: () => import("@/components/file-viewer/html-viewer"),
  },
  {
    id: "builtin.json",
    priority: 100,
    matches: (probe) => probe.extension === "json",
    load: () => import("@/components/file-viewer/json-viewer"),
  },
  {
    id: "builtin.text",
    priority: -100,
    /**
     * Terminal links only, whatever the extension.
     *
     * Scoping by source rather than by file kind is what keeps
     * `isProjectFilePreviewable` answering exactly what it answered before: for
     * `project-preview` nothing matches a `.py`, so no Preview tab appears. It
     * also avoids the real misfeature — a read-only Monaco of `draftContent`
     * mounted in the workbench next to the editable Monaco showing the same
     * buffer.
     */
    matches: (probe) => probe.source === "terminal",
    load: () => import("@/components/file-viewer/monaco-viewer"),
  },
]
