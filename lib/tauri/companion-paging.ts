/**
 * The page envelope and the long-running operation document (ADR-0175 B3).
 *
 * A paging command takes `pageSize` and `pageToken` and answers
 * `{items, nextPageToken}`. The token is opaque: it is whatever the Host
 * issued, handed back unchanged. A command the Host's durable ledger is still
 * running answers 202 with an `Operation`, and `GET /api/operations/{id}`
 * answers the same document until `done`.
 */

import type { Problem } from "./companion-problem"

export interface PageRequest {
  pageSize?: number
  /** Whatever the previous page's `nextPageToken` was. */
  pageToken?: string
}

export interface Page<T> {
  items: T[]
  /** Present exactly when another page exists. */
  nextPageToken?: string
}

export interface OperationMetadata {
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds. */
  updatedAt: number
  requestId?: string
}

export interface Operation<T = unknown> {
  id: string
  /** False while the Host's ledger may still change the outcome. */
  done: boolean
  /** The ledger's own state word. Branch on `done`, `error` and `result`. */
  status: string
  error?: Problem
  result?: T
  metadata: OperationMetadata
}

export function isPage(value: unknown): value is Page<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items) &&
    ("nextPageToken" in (value as object)
      ? typeof (value as { nextPageToken?: unknown }).nextPageToken === "string"
      : true)
  )
}

export function isOperation(value: unknown): value is Operation {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.done === "boolean" &&
    typeof candidate.status === "string" &&
    candidate.metadata !== null &&
    typeof candidate.metadata === "object"
  )
}

/**
 * Walk a paged command to its end. `fetchPage` receives the token of the page
 * to read (undefined for the first). `maxItems` bounds the walk so a caller
 * that only ever wanted "the first few hundred" cannot drain an unbounded
 * collection by accident.
 */
export async function collectPages<T>(
  fetchPage: (pageToken: string | undefined) => Promise<Page<T>>,
  options: { maxItems?: number; maxPages?: number } = {}
): Promise<T[]> {
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY
  const maxPages = options.maxPages ?? 100
  const items: T[] = []
  let token: string | undefined
  for (let pages = 0; pages < maxPages; pages += 1) {
    const page = await fetchPage(token)
    items.push(...page.items)
    if (items.length >= maxItems) return items.slice(0, maxItems)
    if (!page.nextPageToken) break
    token = page.nextPageToken
  }
  return items
}
