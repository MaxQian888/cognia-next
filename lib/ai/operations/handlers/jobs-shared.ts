/**
 * What the asynchronous job handlers (batches, fine-tuning, video jobs)
 * share: a wire context, the contract job status vocabulary, cursor query
 * strings and OpenAI-style page shapes. Pure.
 */

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

export interface WireContext {
  provider: ResolvedProvider
  deploymentRef: string | undefined
  signal: AbortSignal | undefined
}

export function contextOf(input: {
  provider: ResolvedProvider
  request: { deploymentRef?: string }
  signal?: AbortSignal
}): WireContext {
  return {
    provider: input.provider,
    deploymentRef: input.request.deploymentRef,
    signal: input.signal,
  }
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

/** A vendor status word to the contract's five. Unknown words are running. */
export function jobStatusOf(
  value: string | undefined,
  table: Record<string, JobStatus>
): JobStatus {
  if (!value) return "queued"
  return table[value] ?? table[value.toLowerCase()] ?? "running"
}

export function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined
  )
  return pairs.length
    ? `?${pairs.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join("&")}`
    : ""
}

export interface OpenAiPage<T> {
  data?: T[]
  has_more?: boolean
  last_id?: string
}

/** `nextCursor` of an OpenAI-style page: the last id when there is more. */
export function openAiCursor<T extends { id: string }>(page: OpenAiPage<T>): string | null {
  if (!page.has_more) return null
  return page.last_id ?? page.data?.at(-1)?.id ?? null
}

export function isoMs(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? undefined : parsed
}
