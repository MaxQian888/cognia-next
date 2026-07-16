import type { BrowserSelection } from "@/lib/browser/protocol"
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

export interface BrowserAnnotationRow {
  id: string
  sessionId: string
  baseUrl: string
  selection: BrowserSelection
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

function sanitizeAnnotation(annotation: BrowserAnnotationRow): BrowserAnnotationRow {
  return {
    ...annotation,
    selection: {
      ...annotation.selection,
      pageUrl: stripUrlSecrets(annotation.selection.pageUrl),
      outerHTML: annotation.selection.outerHTML.replace(
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

export async function listPendingBrowserAnnotations(
  sessionId: string
): Promise<BrowserAnnotationRow[]> {
  const rows = await getDb().browserAnnotations.where("status").equals("pending").toArray()
  return rows.filter((row) => row.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt)
}

export async function listActionableBrowserAnnotations(
  sessionId: string
): Promise<BrowserAnnotationRow[]> {
  const rows = await getDb().browserAnnotations.toArray()
  return rows
    .filter(
      (row) =>
        row.sessionId === sessionId &&
        (row.status === "pending" || row.status === "acknowledged")
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteExpiredBrowserAnnotations(now: number): Promise<number> {
  return getDb().browserAnnotations
    .where("createdAt")
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
