/**
 * Build workflow expression references from a structured accessor path.
 *
 * Used by the NDV Schema view (drag-to-map) and by autocomplete to insert a
 * reference to another node's output. The produced string is a single mustache
 * segment that round-trips through `lib/workflow/runtime/expression.ts`:
 *
 *     buildNodeRef("n_a", ["items", 0, "id"]) === "{{ $node['n_a'].items[0].id }}"
 *
 * IMPORTANT: there is NO `.out` wrapper. The runtime stores a node's raw
 * executor output at `upstream[id]`, so accessors address that object directly.
 * (A historical `.out.` convention in some seeds/tests resolves to `undefined`.)
 */

export type PathSegment = string | number

/** A path segment that needs no bracket-quoting in the expression grammar. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Render a segment list as the accessor suffix that follows a head token, e.g.
 * `.foo[0]['weird key']`. Mirrors the accessor grammar accepted by `tokenize`
 * in `expression.ts` (`.field` | `['key']` | `["key"]` | `[index]`).
 */
export function formatAccessors(segments: ReadonlyArray<PathSegment>): string {
  let out = ""
  for (const seg of segments) {
    if (typeof seg === "number") {
      out += `[${seg}]`
    } else if (IDENT_RE.test(seg)) {
      out += `.${seg}`
    } else if (!seg.includes("'")) {
      out += `['${seg}']`
    } else if (!seg.includes('"')) {
      // The tokenizer has no escape support, so when the key contains a single
      // quote we switch to double quotes rather than emitting an unparseable
      // escape sequence.
      out += `["${seg}"]`
    } else {
      // Contains both quote characters — unrepresentable in the tiny grammar.
      // Best effort: single-quote it; this will not resolve, but such keys are
      // exceptionally rare and the user can still hand-edit.
      out += `['${seg}']`
    }
  }
  return out
}

/** Human-readable display path for a SchemaRow (drops the leading dot). */
export function formatPath(segments: ReadonlyArray<PathSegment>): string {
  const acc = formatAccessors(segments)
  return acc.startsWith(".") ? acc.slice(1) : acc
}

/** Build the full `{{ $node['<id>']<accessors> }}` reference string. */
export function buildNodeRef(nodeId: string, segments: ReadonlyArray<PathSegment>): string {
  return `{{ $node['${nodeId}']${formatAccessors(segments)} }}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag-to-map payload — a data-view field chip → an ExpressionField drop target.
// The MIME constant + (de)serializers live here (pure) so both the drag source
// and the CodeMirror drop handler share one definition.
// ─────────────────────────────────────────────────────────────────────────────

export const EXPR_DRAG_MIME = "application/x-workflow-expr"

export interface ExprDragPayload {
  nodeId: string
  segments: PathSegment[]
}

/** Serialize a drag payload for `DataTransfer.setData(EXPR_DRAG_MIME, …)`. */
export function serializeExprDrag(nodeId: string, segments: ReadonlyArray<PathSegment>): string {
  return JSON.stringify({ nodeId, segments })
}

/** Parse a drag payload; returns null when the data isn't a valid payload. */
export function parseExprDrag(raw: string | null | undefined): ExprDragPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { nodeId?: unknown }).nodeId === "string" &&
      Array.isArray((parsed as { segments?: unknown }).segments)
    ) {
      const p = parsed as { nodeId: string; segments: unknown[] }
      const segments = p.segments.filter(
        (s): s is PathSegment => typeof s === "string" || typeof s === "number"
      )
      return { nodeId: p.nodeId, segments }
    }
    return null
  } catch {
    return null
  }
}
