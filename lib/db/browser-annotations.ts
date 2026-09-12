import type { BrowserSelection } from "@/lib/browser/protocol"
import type { ElementSelectionCore } from "@/types/element-selection"
import { getDb } from "./schema"

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

/**
 * Which annotations a reader wants. Required, not optional, and that is the
 * point: the two list functions used to filter on `sessionId` ALONE, so the
 * moment a second surface wrote into this table the browser pane's inspection
 * rail would have opened itself over artifact annotations — and then batch-sent
 * them to the model under a browser heading with a screenshot of the browser
 * attached. A reader must say what it is asking for.
 */
export type AnnotationScopeFilter = { kind: "web" } | { kind: "artifact"; artifactId: string }

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

export const BROWSER_ANNOTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function stripUrlSecrets(raw: string): string {
  try {
    const url = new URL(raw)
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return raw
  }
}

/**
 * Resolve what a row is about.
 *
 * A row written before this field existed, or by a plugin using the older
 * shape, is a web annotation — that is not a guess, it is the only thing this
 * table could hold at the time. Normalising here means every STORED row is
 * explicit even though the field is optional on the type.
 */
export function resolveAnnotationTarget(annotation: BrowserAnnotationRow): AnnotationTarget {
  return annotation.target ?? { kind: "web", baseUrl: annotation.baseUrl ?? "" }
}

/** Whether a row answers a reader's scope. */
export function annotationMatchesScope(
  annotation: BrowserAnnotationRow,
  scope: AnnotationScopeFilter
): boolean {
  const target = resolveAnnotationTarget(annotation)
  if (scope.kind !== target.kind) return false
  return target.kind === "artifact" ? target.artifactId === scope.artifactId : true
}

function sanitizeAnnotation(annotation: BrowserAnnotationRow): BrowserAnnotationRow {
  const selection = annotation.selection
  const target = resolveAnnotationTarget(annotation)
  return {
    ...annotation,
    target,
    selection: {
      ...selection,
      // Only a page selection HAS a URL. Reading it unconditionally used to put
      // the literal string "undefined" into the row — and from there into the
      // model's prompt as `Page: undefined`.
      ...("pageUrl" in selection && typeof selection.pageUrl === "string"
        ? { pageUrl: stripUrlSecrets(selection.pageUrl) }
        : {}),
      outerHTML: (selection.outerHTML ?? "").replace(
        /\s(?:value=("[^"]*"|'[^']*'|[^\s>]+)|checked(?:=("[^"]*"|'[^']*'|[^\s>]+))?|selected(?:=("[^"]*"|'[^']*'|[^\s>]+))?)/gi,
        ""
      ),
    },
  }
}

const STATUS_TRANSITIONS: Record<BrowserAnnotationStatus, readonly BrowserAnnotationStatus[]> = {
  pending: ["acknowledged", "resolved", "dismissed"],
  acknowledged: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
}

export async function saveBrowserAnnotation(annotation: BrowserAnnotationRow): Promise<void> {
  await getDb().browserAnnotations.put(sanitizeAnnotation(annotation))
}

/**
 * Pending annotations for one session, within one scope.
 *
 * `scope` is required. These two readers used to filter on `sessionId` alone,
 * which was harmless only while the browser was the sole writer; with a second
 * surface writing, an unscoped read hands one surface the other's rows.
 */
export async function listPendingAnnotations(
  sessionId: string,
  scope: AnnotationScopeFilter
): Promise<BrowserAnnotationRow[]> {
  const rows = await getDb().browserAnnotations.where("status").equals("pending").toArray()
  return rows
    .filter((row) => row.sessionId === sessionId && annotationMatchesScope(row, scope))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Pending + acknowledged — everything still awaiting an outcome. */
export async function listActionableAnnotations(
  sessionId: string,
  scope: AnnotationScopeFilter
): Promise<BrowserAnnotationRow[]> {
  const rows = await getDb().browserAnnotations.toArray()
  return rows
    .filter(
      (row) =>
        row.sessionId === sessionId &&
        (row.status === "pending" || row.status === "acknowledged") &&
        annotationMatchesScope(row, scope)
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** The embedded browser's own queue. Kept as a name because it reads better at
 * the call site than `listPendingAnnotations(id, { kind: "web" })`. */
export async function listPendingBrowserAnnotations(
  sessionId: string
): Promise<BrowserAnnotationRow[]> {
  return listPendingAnnotations(sessionId, { kind: "web" })
}

export async function listActionableBrowserAnnotations(
  sessionId: string
): Promise<BrowserAnnotationRow[]> {
  return listActionableAnnotations(sessionId, { kind: "web" })
}

export async function deleteExpiredBrowserAnnotations(now: number): Promise<number> {
  return getDb()
    .browserAnnotations.where("createdAt")
    .below(now - BROWSER_ANNOTATION_RETENTION_MS)
    .delete()
}

export async function getBrowserAnnotation(id: string): Promise<BrowserAnnotationRow | undefined> {
  return getDb().browserAnnotations.get(id)
}

export async function listBrowserAnnotations(
  baseUrl: string,
  status?: BrowserAnnotationStatus
): Promise<BrowserAnnotationRow[]> {
  const rows = status
    ? await getDb().browserAnnotations.where("[baseUrl+status]").equals([baseUrl, status]).toArray()
    : await getDb().browserAnnotations.where("baseUrl").equals(baseUrl).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function transitionBrowserAnnotation(
  id: string,
  status: BrowserAnnotationStatus,
  updatedAt: number,
  resolvedBy?: BrowserAnnotationResolvedBy
): Promise<boolean> {
  return getDb().transaction("rw", getDb().browserAnnotations, async () => {
    const annotation = await getDb().browserAnnotations.get(id)
    if (!annotation) return false
    if (annotation.status === status) return true
    if (!STATUS_TRANSITIONS[annotation.status].includes(status)) return false
    await getDb().browserAnnotations.update(id, {
      status,
      updatedAt,
      resolvedBy: status === "resolved" || status === "dismissed" ? resolvedBy : undefined,
      thread:
        (status === "resolved" || status === "dismissed") && resolvedBy
          ? [
              ...annotation.thread,
              {
                id: `${id}:${status}:${updatedAt}`,
                author: resolvedBy,
                content: `Annotation ${status} by ${resolvedBy}.`,
                createdAt: updatedAt,
              },
            ]
          : annotation.thread,
    })
    return true
  })
}

export async function appendBrowserAnnotationThreadMessage(
  id: string,
  message: BrowserAnnotationThreadMessage,
  updatedAt: number
): Promise<boolean> {
  return getDb().transaction("rw", getDb().browserAnnotations, async () => {
    const annotation = await getDb().browserAnnotations.get(id)
    if (!annotation) return false
    await getDb().browserAnnotations.update(id, {
      thread: [...annotation.thread, message],
      updatedAt,
    })
    return true
  })
}

export async function deleteBrowserAnnotation(id: string): Promise<void> {
  await getDb().browserAnnotations.delete(id)
}
