// Public surface for the subagent importer pipeline.

import { claudeCodeAdapter } from "./claude-code"
import { codexCliAdapter } from "./codex-cli"
import { opencodeAdapter } from "./opencode"
import { cursorAdapter } from "./cursor"
import { clineAdapter } from "./cline"
import { genericMdAdapter } from "./generic-md"
import type { ImportInput, SubagentSourceAdapter, SubagentSourceId } from "./types"

/** Ordered: priority for auto-detect. Generic stays last. */
export const SUBAGENT_SOURCE_ADAPTERS: SubagentSourceAdapter[] = [
  claudeCodeAdapter,
  codexCliAdapter,
  opencodeAdapter,
  cursorAdapter,
  clineAdapter,
  genericMdAdapter,
]

const ADAPTERS_BY_ID = new Map<SubagentSourceId, SubagentSourceAdapter>(
  SUBAGENT_SOURCE_ADAPTERS.map((a) => [a.id, a])
)

export function getSubagentAdapter(id: SubagentSourceId): SubagentSourceAdapter {
  const a = ADAPTERS_BY_ID.get(id)
  if (!a) throw new Error(`Unknown subagent source: ${id}`)
  return a
}

/**
 * Best-effort source detection. Uses each adapter's `detect()`; first "match"
 * wins, otherwise the first "maybe" — which means generic-md catches the
 * fallback. Only returns `null` if every adapter says "no", which only happens
 * when the input has zero accepted files.
 */
export function detectSource(input: ImportInput): SubagentSourceId | null {
  let firstMaybe: SubagentSourceId | null = null
  for (const adapter of SUBAGENT_SOURCE_ADAPTERS) {
    const verdict = adapter.detect(input)
    if (verdict === "match") return adapter.id
    if (verdict === "maybe" && firstMaybe === null) firstMaybe = adapter.id
  }
  return firstMaybe
}

export type {
  ImportFile,
  ImportInput,
  ParseFailure,
  ParseResult,
  SubagentImportDraft,
  SubagentSourceAdapter,
  SubagentSourceId,
  ImportTarget,
  ImportMergeStrategy,
  ApplyImportArgs,
  ApplyImportResult,
} from "./types"
