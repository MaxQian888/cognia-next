/**
 * Bounded, prioritised context for a Bot's model call.
 *
 * Two budgets, because they fail differently:
 *
 *  - {@link FetchBudget} bounds what collection may READ (bytes, pages per
 *    kind, wall time), so a huge thread or diff costs a bounded amount of API
 *    quota and time whatever it contains;
 *  - {@link selectContext} bounds what is SENT: items go in priority order,
 *    required ones always (truncated to fit), each capped on its own, and
 *    everything left out is counted per kind so the Bot can say what it did
 *    not see instead of implying a complete review.
 *
 * Sizes are UTF-8 bytes. Token counts are an estimate that leans high for
 * non-Latin text (one token per non-ASCII character, four ASCII characters
 * per token), because under-estimating is the failure that overruns a window.
 */

export class ContextBudgetExceededError extends Error {
  readonly code = "context_budget_exceeded"
  constructor(
    readonly limit: "bytes" | "time" | "pages",
    readonly kind?: string
  ) {
    super(`Context collection exceeded its ${limit} budget${kind ? ` for ${kind}` : ""}`)
    this.name = "ContextBudgetExceededError"
  }
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii / 4) + other
}

/**
 * The longest prefix of `text` within `maxBytes`, never splitting a
 * character, with a visible marker when anything was cut.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean; omittedBytes: number } {
  const bytes = utf8Length(text)
  if (bytes <= maxBytes) return { text, truncated: false, omittedBytes: 0 }
  const marker = (omitted: number) => `\n…[truncated ${omitted} bytes]`
  // The marker is sized for the worst case; when even it does not fit, the
  // cut goes unmarked rather than past the limit.
  const markerBytes = utf8Length(marker(bytes))
  const marked = markerBytes <= maxBytes
  const budget = Math.max(0, marked ? maxBytes - markerBytes : maxBytes)
  let kept = ""
  let used = 0
  for (const char of text) {
    const size = utf8Length(char)
    if (used + size > budget) break
    kept += char
    used += size
  }
  const omitted = bytes - used
  return {
    text: marked ? `${kept}${marker(omitted)}` : kept,
    truncated: true,
    omittedBytes: omitted,
  }
}

export interface FetchBudgetLimits {
  maxBytes: number
  maxPagesPerKind: number
  /** Wall-clock allowance in ms, measured from creation. */
  maxDurationMs: number
}

export class FetchBudget {
  private bytes = 0
  private readonly pages = new Map<string, number>()
  private readonly deadline: number

  constructor(
    readonly limits: FetchBudgetLimits,
    private readonly now: () => number = Date.now
  ) {
    this.deadline = now() + limits.maxDurationMs
  }

  /** Charge a fetched page of `kind`; throws once any limit is crossed. */
  charge(kind: string, bytes: number): void {
    if (this.now() > this.deadline) throw new ContextBudgetExceededError("time", kind)
    const pages = (this.pages.get(kind) ?? 0) + 1
    if (pages > this.limits.maxPagesPerKind) throw new ContextBudgetExceededError("pages", kind)
    this.pages.set(kind, pages)
    this.bytes += bytes
    if (this.bytes > this.limits.maxBytes) throw new ContextBudgetExceededError("bytes", kind)
  }

  /** Pages of `kind` still allowed (for a bounded `pageWindow`). */
  pagesLeft(kind: string): number {
    return Math.max(0, this.limits.maxPagesPerKind - (this.pages.get(kind) ?? 0))
  }

  get fetchedBytes(): number {
    return this.bytes
  }
}

export interface ContextItem {
  id: string
  kind: string
  /** Where it came from (a URL or `path:line`), carried to the prompt as evidence. */
  source: string
  /** Lower is more important. Ties keep input order. */
  priority: number
  text: string
  /** Always included (truncated to fit); a required item that cannot fit fails selection. */
  required?: boolean
  /** Per-item cap tighter than the selection's. */
  maxBytes?: number
}

export interface SelectedContextItem {
  id: string
  kind: string
  source: string
  text: string
  bytes: number
  truncated: boolean
}

export interface ContextSelection {
  items: SelectedContextItem[]
  /** Items left out entirely, per kind. */
  omitted: Record<string, number>
  /** Items included but cut. */
  truncatedItems: number
  bytes: number
  estimatedTokens: number
}

export interface ContextSelectionLimits {
  maxBytes: number
  maxTokens: number
  maxItemBytes: number
  /** Below this many bytes of room, an optional item is omitted rather than cut. Default 512. */
  minUsefulBytes?: number
}

export function selectContext(
  items: readonly ContextItem[],
  limits: ContextSelectionLimits
): ContextSelection {
  const minUseful = limits.minUsefulBytes ?? 512
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Number(Boolean(b.item.required)) - Number(Boolean(a.item.required)) ||
        a.item.priority - b.item.priority ||
        a.index - b.index
    )
  const chosen: Array<SelectedContextItem & { index: number; priority: number }> = []
  const omitted: Record<string, number> = {}
  let bytes = 0
  let tokens = 0
  for (const { item, index } of ordered) {
    const cap = Math.min(item.maxBytes ?? limits.maxItemBytes, limits.maxItemBytes)
    const roomBytes = limits.maxBytes - bytes
    const roomTokens = limits.maxTokens - tokens
    const room = Math.min(cap, roomBytes, roomTokens)
    const whole = utf8Length(item.text)
    // "Useful" is judged against what the item could ever get, so a cap
    // below `minUseful` does not make an item unselectable.
    if (!item.required && (room < Math.min(whole, minUseful, cap) || room <= 0)) {
      omitted[item.kind] = (omitted[item.kind] ?? 0) + 1
      continue
    }
    if (item.required && room <= 0) throw new ContextBudgetExceededError("bytes", item.kind)
    // The estimate never exceeds the byte length, so a cut within `room`
    // bytes is also within the token room.
    const cut = truncateUtf8(item.text, room)
    const size = utf8Length(cut.text)
    bytes += size
    tokens += estimateTokens(cut.text)
    chosen.push({
      id: item.id,
      kind: item.kind,
      source: item.source,
      text: cut.text,
      bytes: size,
      truncated: cut.truncated,
      index,
      priority: item.priority,
    })
  }
  // Present in priority order, input order within a priority.
  chosen.sort((a, b) => a.priority - b.priority || a.index - b.index)
  return {
    items: chosen.map(({ index: _index, priority: _priority, ...rest }) => rest),
    omitted,
    truncatedItems: chosen.filter((item) => item.truncated).length,
    bytes,
    estimatedTokens: tokens,
  }
}
