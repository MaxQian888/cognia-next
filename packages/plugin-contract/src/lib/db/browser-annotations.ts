/**
 * The plugin contract's share of `lib/db/browser-annotations.ts`, which re-exports these.
 */
import type { BrowserSelection } from "../browser/protocol"
import type { ElementSelectionCore } from "../../types/element-selection"

export type BrowserAnnotationIntent = "fix" | "change" | "question" | "approve"

export type BrowserAnnotationSeverity = "blocking" | "important" | "suggestion"

export type BrowserAnnotationStatus = "pending" | "acknowledged" | "resolved" | "dismissed"

export type BrowserAnnotationResolvedBy = "human" | "agent"

export interface BrowserAnnotationThreadMessage {
  id: string
  author: BrowserAnnotationResolvedBy
  content: string
  createdAt: number
}

/**
 * What an annotation is ABOUT.
 *
 * This table started life as the embedded browser's review queue, and its name
 * still says so — deliberately, because `BrowserAnnotationRow` and
 * `saveAnnotation` are published to plugin authors through
 * `packages/plugin-sdk/src/api/browser.ts` (ADR-0155/0156). Renaming the
 * published surface to tidy a noun would break every plugin that writes one,
 * which is a poor trade for a word. What the table actually holds is "an
 * element the user pointed at, plus what they want done about it", and the
 * artifact preview produces exactly that.
 */
export type AnnotationTarget =
  { kind: "web"; baseUrl: string } | { kind: "artifact"; artifactId: string; version?: string }

export interface BrowserAnnotationRow {
  id: string
  sessionId: string
  /**
   * The page a web annotation was taken on. Optional because an artifact
   * annotation was not taken on a page at all — absent is the honest answer,
   * and it keeps the existing `baseUrl` / `[baseUrl+status]` indexes meaning
   * exactly what they always meant.
   */
  baseUrl?: string
  /**
   * Normalised on write by {@link saveBrowserAnnotation}, so a stored row is
   * always explicit. Optional on the type only so that plugin authors writing
   * the older shape stay source-compatible.
   */
  target?: AnnotationTarget
  /**
   * `BrowserSelection` for a page, the surface-neutral core for anything else.
   * Readers must not assume `pageUrl` — an artifact element has no page.
   */
  selection: BrowserSelection | ElementSelectionCore
  comment: string
  intent: BrowserAnnotationIntent
  severity: BrowserAnnotationSeverity
  status: BrowserAnnotationStatus
  thread: BrowserAnnotationThreadMessage[]
  resolvedBy?: BrowserAnnotationResolvedBy
  createdAt: number
  updatedAt: number
}
