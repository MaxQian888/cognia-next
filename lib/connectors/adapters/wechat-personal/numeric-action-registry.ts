/**
 * Per-conversation LRU mapping `numeric reply → binding action id`.
 *
 * iLink has no native callback channel — A2UI surfaces project to a
 * plaintext mirror with "回复 1 同意 / 2 取消" hints. Users reply with a
 * digit; the outbound mapper (`a2ui-mapper.ts:buildIlinkA2UISurface`)
 * records the mapping and the inbound parser
 * (`parse.ts:tryParseNumericCallback`) consumes it via
 * `consumeNumericAction`, emitting a `ConnectorCallbackEvent` against the
 * corresponding binding.
 *
 * Why a per-conversation map: numbers reset when the assistant emits a
 * fresh surface. Carrying the registry across conversations would
 * cross-route a "1" in chat A to chat B's surface. Capacity per
 * conversation is bounded to 9 — the numeric menu only ever assigns the
 * single ASCII digits 1–9 (see `MAX_NUMERIC` in the mapper and the
 * `[1-9]` reply regex in the parser) — so a runaway loop can't blow
 * memory.
 */

const TTL_MS = 90_000
const CAPACITY_PER_CONVERSATION = 9

interface Entry {
  numeric: number
  actionId: string
  expiresAt: number
}

const byConversation = new Map<string, Entry[]>()

function evictExpired(entries: Entry[], nowMs: number): Entry[] {
  const live = entries.filter((e) => e.expiresAt > nowMs)
  return live
}

function trim(entries: Entry[]): Entry[] {
  if (entries.length <= CAPACITY_PER_CONVERSATION) return entries
  return entries.slice(entries.length - CAPACITY_PER_CONVERSATION)
}

/**
 * Record `numeric → actionId` for a conversation. Overwrites a prior
 * binding for the same numeric (the freshest surface wins). Returns the
 * stored entry count after insert so callers can assert capacity in
 * tests.
 */
export function setNumericAction(
  conversationKey: string,
  numeric: number,
  actionId: string,
  nowMs: number = Date.now()
): number {
  const existing = evictExpired(byConversation.get(conversationKey) ?? [], nowMs)
  const without = existing.filter((e) => e.numeric !== numeric)
  const next = trim([...without, { numeric, actionId, expiresAt: nowMs + TTL_MS }])
  byConversation.set(conversationKey, next)
  return next.length
}

/**
 * Look up a numeric reply without consuming it. The parser consumes via
 * `consumeNumericAction` once it routes the callback so a double-tap
 * doesn't fire twice.
 */
export function peekNumericAction(
  conversationKey: string,
  numeric: number,
  nowMs: number = Date.now()
): string | undefined {
  const entries = byConversation.get(conversationKey)
  if (!entries || entries.length === 0) return undefined
  const live = evictExpired(entries, nowMs)
  if (live.length !== entries.length) byConversation.set(conversationKey, live)
  return live.find((e) => e.numeric === numeric)?.actionId
}

/**
 * Consume a numeric binding (lookup + delete). `tryParseNumericCallback`
 * uses this to route exactly once. Returns undefined when no live binding
 * matches.
 */
export function consumeNumericAction(
  conversationKey: string,
  numeric: number,
  nowMs: number = Date.now()
): string | undefined {
  const entries = byConversation.get(conversationKey)
  if (!entries || entries.length === 0) return undefined
  const live = evictExpired(entries, nowMs)
  const idx = live.findIndex((e) => e.numeric === numeric)
  if (idx === -1) {
    if (live.length !== entries.length) byConversation.set(conversationKey, live)
    return undefined
  }
  const hit = live[idx]
  const next = live.filter((_, i) => i !== idx)
  if (next.length === 0) byConversation.delete(conversationKey)
  else byConversation.set(conversationKey, next)
  return hit.actionId
}

/** Test seam — clear every conversation's bindings. */
export function __resetNumericActionRegistryForTesting(): void {
  byConversation.clear()
}

/** Test seam — expose internal entry count for a conversation. */
export function __countNumericActionsForTesting(conversationKey: string): number {
  return byConversation.get(conversationKey)?.length ?? 0
}
