import type { ComponentType } from "react"

/**
 * Which entry point asked for a file.
 *
 * Carried all the way into `matches` because it changes what a viewer should
 * do, not just where the request came from: HTML authored by the user in the
 * project editor may run its own scripts, the same markup arriving from a
 * terminal link may not, and the read-only Monaco fallback is meaningful for a
 * terminal link but would be a second, confusing copy of a buffer already open
 * in the editor beside it.
 */
export type FileViewerSource = "terminal" | "project-preview"

/**
 * Every way opening a file can fail, as data.
 *
 * A list rather than a bare union because three things have to agree on it: the
 * surface's state machine, the `fileViewer.error.*` message keys, and the
 * diagnostics that report a code. A union alone lets one of the three drift
 * without anything noticing.
 */
export const FILE_VIEWER_ERROR_CODES = [
  "too-large",
  "not-found",
  "outside-workspace",
  "is-directory",
  "no-backend",
  "no-root",
  "read-failed",
  "unsupported",
] as const

export type FileViewerErrorCode = (typeof FILE_VIEWER_ERROR_CODES)[number]

export function isFileViewerErrorCode(value: unknown): value is FileViewerErrorCode {
  return typeof value === "string" && (FILE_VIEWER_ERROR_CODES as readonly string[]).includes(value)
}

/** The message key a code maps to, so the surface never hand-builds one. */
export function fileViewerErrorMessageKey(code: FileViewerErrorCode): string {
  // kebab-case code -> camelCase key, matching `i18n/messages/*/fileViewer.json`.
  return `error.${code.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`
}

/** One open. Built by the caller; the surface never mutates it. */
export interface FileViewerRequest {
  /**
   * Per-open token. Every async result is discarded unless it still matches the
   * request on screen, so a slow read for a file the user has already navigated
   * away from cannot paint over a fast one.
   */
  requestId: string
  source: FileViewerSource
  /**
   * The absolute workspace root the read is confined to. Required unless
   * `providedText` is set; a request with neither is a programming error and
   * fails closed rather than reading anything.
   */
  root?: string
  /** POSIX-separated, relative to `root`, no leading slash and no `..` segment. */
  relPath: string
  /** Chrome label only. Never logged, never passed to a filesystem API. */
  displayName: string
  /**
   * Text the host already holds, which short-circuits the read entirely.
   *
   * `undefined` and `""` are different answers: `""` is an empty file, while
   * `undefined` means "go and read it". The project preview passes the live
   * editor draft here so an unsaved buffer previews as the user sees it.
   */
  providedText?: string
  line?: number | null
  column?: number | null
}

/** Everything a contribution is allowed to see when deciding whether it claims a file. */
export interface FileViewerProbe {
  /** Lower-cased, without the dot. `""` when the name has no extension. */
  extension: string
  /** Reserved. Nothing derives this yet and no built-in reads it. */
  mimeType?: string
  /**
   * Byte size, when known — absent during the capability pre-flight, which runs
   * in render with no `stat` in hand. A contribution that needs a size must
   * treat `undefined` as "may match" rather than as zero.
   */
  size?: number
  source: FileViewerSource
}

/**
 * What a contribution renders with.
 *
 * Deliberately carries no root and no filesystem handle: a viewer that can see
 * a path it could resolve is one refactor away from reading it itself, and the
 * host owning every read is the invariant that makes the confinement worth
 * anything.
 */
export interface FileViewerRenderProps {
  /** UTF-8 text the host has already read, confined, and size-checked. */
  text: string
  displayName: string
  relPath: string
  line: number | null
  column: number | null
  source: FileViewerSource
}

export interface FileViewerContribution {
  id: string
  /**
   * Resolution order: priority descending, ties broken by id ascending so the
   * result is stable across platforms and test runs. Built-in rich viewers sit
   * at 100, the text fallback at -100, and 1–99 is left for future host
   * contributions.
   */
  priority: number
  matches: (probe: FileViewerProbe) => boolean
  /**
   * Lazy module loader rather than a component reference.
   *
   * `isProjectFilePreviewable` consults this registry from
   * `lib/context-workbench/capabilities.ts`, which four unrelated client trees
   * import (the artifact dock, the canvas side panels, the workflow sidebar and
   * the project workbench). An eager component here would drag Monaco,
   * `MarkdownRenderer` and DOMPurify into every one of those bundles just to
   * answer a question about a file extension.
   */
  load: () => Promise<{ default: ComponentType<FileViewerRenderProps> }>
}
