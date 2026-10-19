/**
 * What each prompt slot last resolved to, in this context (ADR-0236).
 *
 * The Prompt Center shows published configuration and actual use as separate
 * facts: "published revision X" is a database statement, "the last title
 * request used revision X" is this log. It is memory-only and holds ids, never
 * prompt text or task data, so nothing private is persisted or exported.
 */

import type { PromptResolutionContext, PromptSource } from "./types"

export interface PromptResolutionRecord {
  promptId: string
  source: PromptSource
  context: PromptResolutionContext
  at: number
}

const MAX_RECENT = 200
const latest = new Map<string, PromptResolutionRecord>()
const recent: PromptResolutionRecord[] = []
const listeners = new Set<() => void>()

export function recordPromptResolution(record: PromptResolutionRecord): void {
  latest.set(record.promptId, record)
  recent.push(record)
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT)
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A UI subscriber must never break a model call.
    }
  }
}

/** The latest resolution of one prompt in this context, if any. */
export function lastPromptResolution(promptId: string): PromptResolutionRecord | undefined {
  return latest.get(promptId)
}

/** Recent resolutions, newest first. */
export function recentPromptResolutions(): PromptResolutionRecord[] {
  return [...recent].reverse()
}

export function subscribePromptResolutions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam. */
export function __resetPromptResolutionsForTests(): void {
  latest.clear()
  recent.length = 0
}
