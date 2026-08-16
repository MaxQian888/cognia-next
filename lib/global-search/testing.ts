/**
 * Test fixtures for global-search providers and the dialog. Kept in `lib/` so
 * every provider spec (and the dialog spec) builds the same context shape;
 * not used at runtime.
 */

import type {
  GlobalSearchContext,
  GlobalSearchProviderInput,
  ParsedGlobalSearchQuery,
} from "./types"
import { parseGlobalSearchQuery } from "./query-parser"

export const TEST_NOW = new Date(2026, 7, 16, 12, 0, 0).getTime()

/** Identity translator that renders ICU values inline for assertions. */
export function testTranslate(
  key: string,
  values?: Record<string, string | number | Date>
): string {
  if (!values || Object.keys(values).length === 0) return key
  return `${key}:${JSON.stringify(values)}`
}

export function makeTestContext(over: Partial<GlobalSearchContext> = {}): GlobalSearchContext {
  return {
    t: testTranslate,
    locale: "en",
    platform: "tauri",
    isTauri: true,
    now: TEST_NOW,
    activeProjectId: "p1",
    activeSessionId: null,
    sessions: [],
    workspaces: [],
    scope: "all",
    host: {
      reachableSettingsSections: new Set(),
      recorderAvailable: false,
      theme: "light",
      hasApiKey: false,
      pluginQuickActions: [],
      workbenchPanels: [],
    },
    ...over,
  }
}

export function makeProviderInput(
  raw: string,
  over: Partial<Omit<GlobalSearchProviderInput, "query">> & { query?: ParsedGlobalSearchQuery } = {}
): GlobalSearchProviderInput {
  return {
    query: over.query ?? parseGlobalSearchQuery(raw, { now: TEST_NOW }),
    ctx: over.ctx ?? makeTestContext(),
    limit: over.limit ?? 20,
    signal: over.signal ?? new AbortController().signal,
  }
}
