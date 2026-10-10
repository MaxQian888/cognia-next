/**
 * The query parameters a conversation files link adds (ADR-0222 §2), in one
 * dependency-free module: the `cognia://` parser
 * (`lib/navigation/cognia-deeplink.ts`) reads them, and the link builders
 * (`./links.ts`) write them, so neither has to import the other.
 */

import type { FileSpacePath } from "@/types/filespace"

import { normalizeFileSpacePath } from "./paths"

export const FILES_VIEW_PARAM = "view"
export const FILES_VIEW_VALUE = "files"
export const FILES_PATH_PARAM = "path"
export const FILES_LINE_PARAM = "line"

/** Every parameter a files link may add, for consumers that strip a spent link. */
export const FILES_LINK_PARAMS = [FILES_VIEW_PARAM, FILES_PATH_PARAM, FILES_LINE_PARAM] as const

/** Largest line number a link may carry; beyond it the parameter is ignored. */
export const MAX_FILES_LINK_LINE = 10_000_000

/** Anything with `URLSearchParams.get`. */
export interface FilesViewParamsSource {
  get(name: string): string | null
}

export interface ParsedFilesView {
  path?: FileSpacePath
  line?: number
}

/**
 * The files-view parameters for a target, in their fixed order: `view`, then
 * `path`, then `line` (only with a path).
 */
export function filesViewParams(view: ParsedFilesView): URLSearchParams {
  const params = new URLSearchParams()
  params.set(FILES_VIEW_PARAM, FILES_VIEW_VALUE)
  if (view.path) {
    params.set(FILES_PATH_PARAM, view.path)
    const line = sanitizeFilesLinkLine(view.line)
    if (line !== undefined) params.set(FILES_LINE_PARAM, String(line))
  }
  return params
}

/**
 * The files view a link's parameters ask for, or `null` when they do not ask
 * for one. An unknown `view` is not an error — the link still opens its
 * conversation — and a malformed `path` drops the path, not the view, so a
 * mangled link lands on the Files panel instead of nowhere.
 */
export function parseFilesViewParams(params: FilesViewParamsSource | null): ParsedFilesView | null {
  if (!params || params.get(FILES_VIEW_PARAM) !== FILES_VIEW_VALUE) return null
  const rawPath = params.get(FILES_PATH_PARAM)
  const path = rawPath ? (normalizeFileSpacePath(rawPath) ?? undefined) : undefined
  if (!path || path === "/") return {}
  const raw = params.get(FILES_LINE_PARAM)
  const line = raw && /^\d+$/.test(raw) ? sanitizeFilesLinkLine(Number(raw)) : undefined
  return line === undefined ? { path } : { path, line }
}

/** A 1-based line within bounds, or `undefined`. */
export function sanitizeFilesLinkLine(line: number | undefined): number | undefined {
  if (line === undefined || !Number.isInteger(line)) return undefined
  return line >= 1 && line <= MAX_FILES_LINK_LINE ? line : undefined
}
