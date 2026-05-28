/**
 * A2UI surface → iLink plaintext bridge with numeric callback wiring.
 *
 * iLink carries no native interactive surface — every outbound channels
 * through `sendmessage` as text. To preserve A2UI interactivity we:
 *
 *   1. Walk the surface and pick out every interactive component
 *      (`Button`, `Select`, `RadioGroup`, `Checkbox`).
 *   2. Assign numerics `1..9` so the user can reply with a single ASCII
 *      digit and we never juggle multi-character input.
 *   3. Record the binding the bus will need to route the inbound digit
 *      reply through `dispatchConnectorCallback`:
 *        - When `node.raw.value` is already namespaced (`wfapp:` /
 *          `wfcan:`) the row already exists in
 *          `connectorCallbackBindings` from whichever upstream tool
 *          emitted the surface (see `plugins/workflow-ai`). We DO NOT
 *          write a second row — that would split the dispatch into two
 *          rows for the same component and let one expire while the
 *          other survives. We simply point the numeric registry at the
 *          existing wireActionId.
 *        - Otherwise (plain A2UI Button etc.) we write a fresh
 *          `callback_query` binding under `buildActionId(surfaceId,
 *          componentId, action)`. This is the same format every native
 *          adapter uses, so the bus's binding lookup + the generic
 *          digest-turn handler handle the click identically to a
 *          Telegram tap.
 *   4. Cache `numeric → wireActionId` in the per-conversation
 *      `numeric-action-registry` LRU (90 s TTL, capacity 9) so the
 *      parser doesn't need a Dexie roundtrip on the hot path.
 *   5. Append a "回复数字触发按钮：1) … 2) …" footer to the mirror so
 *      the user knows what to type.
 *
 * Inbound matching lives in `parse.ts:tryParseNumericCallback`; the
 * `index.ts:handleMessage` hook routes hits through
 * `getBus().dispatchConnectorCallback` instead of the regular
 * `ctx.emit`.
 */

import {
  buildActionId,
  generatePlainTextMirror,
  recordCallbackBinding,
  walkA2UISurface,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import type { A2UIMessageSegment } from "@/types/connectors/segment"
import { setNumericAction } from "./numeric-action-registry"

interface NumberedInteractive {
  componentId: string
  numeric: number
  label: string
  /**
   * The wire action id we'll route inbound digits to. Either:
   *   - a pre-existing `wfapp:` / `wfcan:` id (workflow approval surface)
   *   - a freshly-built `a2ui:<surfaceId>:<componentId>:<action>` id
   */
  wireActionId: string
  /** True when a fresh `callback_query` binding row must be written. */
  needsBindingWrite: boolean
}

const INTERACTIVE_KINDS = new Set(["Button", "Select", "RadioGroup", "Checkbox"])

const MAX_NUMERIC = 9
const FOOTER_PREFIX = "回复数字触发按钮："

const PRESERVED_PREFIXES = ["wfapp:", "wfcan:"] as const

function preserveExistingWireActionId(value: string): boolean {
  return PRESERVED_PREFIXES.some((p) => value.startsWith(p))
}

/**
 * Walk the surface and assemble the numbered list. Pure — exported for
 * unit coverage; callers go through `buildIlinkA2UISurface` which also
 * persists bindings.
 */
export function collectNumberedInteractives(segment: A2UIMessageSegment): NumberedInteractive[] {
  const out: NumberedInteractive[] = []
  walkA2UISurface(segment.content, (node) => {
    if (!INTERACTIVE_KINDS.has(node.component as string)) return
    if (out.length >= MAX_NUMERIC) return
    const raw = node.raw
    const action = stringValue(raw.action) || node.id
    const value = stringValue(raw.value)
    const label = stringValue(raw.text) || stringValue(raw.label) || action || node.id

    if (value && preserveExistingWireActionId(value)) {
      // Workflow approve/cancel button — upstream tool already wrote the
      // binding row, just point the numeric at it.
      out.push({
        componentId: node.id,
        numeric: out.length + 1,
        label,
        wireActionId: value,
        needsBindingWrite: false,
      })
      return
    }

    const wireActionId = buildActionId(segment.surfaceId, node.id, action)
    out.push({
      componentId: node.id,
      numeric: out.length + 1,
      label,
      wireActionId,
      needsBindingWrite: true,
    })
  })
  return out
}

export interface BuildIlinkA2UIInput {
  adapterId: string
  conversationKey: string
  segment: A2UIMessageSegment
}

export interface BuildIlinkA2UIOutput {
  /** Mirror text — what the caller appends to the outbound chunk pipeline. */
  textMirror: string
  /** How many interactive components got a numeric binding. */
  numberedCount: number
}

/**
 * Build the mirror text and record callback bindings for an A2UI segment.
 * Persists `callback_query` bindings for plain interactive components +
 * caches numeric → wireActionId for every numbered row. Existing
 * `wfapp:` / `wfcan:` bindings are reused rather than duplicated.
 */
export async function buildIlinkA2UISurface(
  input: BuildIlinkA2UIInput
): Promise<BuildIlinkA2UIOutput> {
  const { segment, adapterId, conversationKey } = input
  const baseMirror =
    segment.plainTextMirror.trim().length > 0
      ? segment.plainTextMirror
      : generatePlainTextMirror(segment.content)

  const numbered = collectNumberedInteractives(segment)
  if (numbered.length === 0) {
    return { textMirror: baseMirror, numberedCount: 0 }
  }

  await Promise.all(
    numbered.map(async (entry) => {
      if (entry.needsBindingWrite) {
        await recordCallbackBinding({
          adapterId,
          actionId: entry.wireActionId,
          kind: "callback_query",
          surfaceId: segment.surfaceId,
          componentId: entry.componentId,
          conversationKey,
        })
      }
      setNumericAction(conversationKey, entry.numeric, entry.wireActionId)
    })
  )

  const footer = FOOTER_PREFIX + numbered.map((e) => `${e.numeric}) ${e.label}`).join("  ")
  return {
    textMirror: `${baseMirror}\n\n${footer}`.trim(),
    numberedCount: numbered.length,
  }
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}
