/**
 * Reverse-lookup helper for the Drafts → Accept flow (M2).
 *
 * Distill output is built from the **PII-redacted** chunks (placeholders
 * like `<EMAIL_001>` in place of real values), so a synthesised Character
 * / Skill draft may contain those placeholders. Before writing a real
 * Character / Skill row, we want the option to swap them back to their
 * original PII — the user is acting on their own data on their own
 * machine, so the placeholder versions are usually a worse experience
 * than restoring the originals.
 *
 * `previewUnredact` walks every `twinSources.redactionMapEnc` for a twin,
 * decrypts them, and produces a `UnredactPreview` the UI can render with
 * per-placeholder keep/restore toggles. `applyUnredactSelection` then
 * rewrites the draft payload in place.
 *
 * Defensive: never throws. A decryption failure for one source is logged
 * and the remaining sources continue contributing. Placeholders without a
 * known original stay verbatim in the output.
 */

import { decryptRedactionMap } from "@/lib/twin/ingest/redaction-key"
import type { RedactionRecord } from "@/lib/twin/ingest/redact"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import type { TwinDraft } from "@/types/twin"

export interface UnredactPlaceholder {
  /** The `<KIND_NNN>` token as it appears in the draft. */
  placeholder: string
  /** Decoded PII original from the source row. */
  original: string
  /** Bucket from `redact.ts:PiiKind`. */
  kind: string
  /** Default: true (restore). User can flip individually in the dialog. */
  keep: boolean
}

export interface UnredactPreview {
  /** Snapshot of the draft payload as JSON (pre-restore). */
  redactedJson: string
  /** Placeholders found in the snapshot — deduped. */
  placeholders: UnredactPlaceholder[]
}

const PLACEHOLDER_RE =
  /<(EMAIL|PHONE|CN_ID|BANK_CARD|NAME|IP_ADDR|API_KEY|PASSPORT|DRIVER_LICENSE)_\d{3}>/g

/**
 * Read every `redactionMapEnc` blob for a twin and merge them into one
 * placeholder → record lookup. If the same placeholder shows up in two
 * sources (counter resets per source, so collisions are real), the first
 * source wins — the UI can break ties later if it ever matters.
 */
export async function loadTwinUnredactMap(
  twinId: string
): Promise<Record<string, RedactionRecord>> {
  const sources = await listTwinSourcesByTwin(twinId)
  const merged: Record<string, RedactionRecord> = {}
  for (const source of sources) {
    if (!source.redactionMapEnc) continue
    try {
      const map = await decryptRedactionMap(source.redactionMapEnc)
      for (const [key, record] of Object.entries(map)) {
        if (!merged[key]) merged[key] = record
      }
    } catch (err) {
      console.warn("loadTwinUnredactMap: decrypt failed for source", {
        sourceId: source.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return merged
}

/** Scan a JSON string for `<KIND_NNN>` placeholders (deduped, ordered). */
export function findPlaceholders(serialized: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let match: RegExpExecArray | null
  PLACEHOLDER_RE.lastIndex = 0
  while ((match = PLACEHOLDER_RE.exec(serialized)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0])
      out.push(match[0])
    }
  }
  return out
}

/**
 * Build the preview the UnredactDialog renders. Placeholders with no
 * decrypted original are filtered out — the dialog shows "no PII to
 * restore" in that case.
 */
export async function previewUnredact(draft: TwinDraft, twinId: string): Promise<UnredactPreview> {
  const redactedJson = JSON.stringify(draft.payload, null, 2)
  const placeholdersInDraft = findPlaceholders(redactedJson)
  if (placeholdersInDraft.length === 0) {
    return { redactedJson, placeholders: [] }
  }
  const map = await loadTwinUnredactMap(twinId)
  const placeholders: UnredactPlaceholder[] = []
  for (const token of placeholdersInDraft) {
    const record = map[token]
    if (!record) continue
    placeholders.push({
      placeholder: token,
      original: record.original,
      kind: record.kind,
      keep: true,
    })
  }
  return { redactedJson, placeholders }
}

/**
 * Apply a user's unredact selection to a draft payload. Returns a fresh
 * object — the caller (drafts tab accept handler) writes this into the
 * `characters` / `skills` table.
 */
export function applyUnredactSelection(
  payload: TwinDraft["payload"],
  selection: ReadonlyArray<Pick<UnredactPlaceholder, "placeholder" | "original" | "keep">>
): TwinDraft["payload"] {
  if (selection.length === 0) return payload
  const restored = selection.filter((p) => p.keep)
  if (restored.length === 0) return payload
  const json = JSON.stringify(payload)
  let next = json
  for (const { placeholder, original } of restored) {
    next = next.split(placeholder).join(escapeForJson(original))
  }
  return JSON.parse(next) as TwinDraft["payload"]
}

/**
 * The placeholder lives inside a JSON string — when we splice the
 * original PII back in, that value also has to be JSON-safe so the
 * subsequent `JSON.parse(next)` round-trips cleanly. `JSON.stringify`
 * gives us escaped quotes / backslashes / control chars; we strip the
 * surrounding quotes since the placeholder itself was un-quoted in the
 * stringified payload.
 */
function escapeForJson(value: string): string {
  const quoted = JSON.stringify(value)
  return quoted.slice(1, quoted.length - 1)
}
