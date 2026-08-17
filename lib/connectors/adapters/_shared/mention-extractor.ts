/**
 * Shared mention-detection plumbing.
 *
 * Each platform parser walks its own native message shape (Telegram entities,
 * Discord `mentions[]`, Slack `<@USERID>` regex + rich_text blocks, Lark
 * `mentions[]`) and produces a stream of candidate user ids. The shape of
 * that walk differs platform-to-platform — but the post-walk reduction
 * (dedup + self-detection + canonical return type) is identical, and is
 * what this module owns.
 *
 * Usage from a parser:
 *
 *   const acc = new MentionAccumulator(selfId)
 *   for (const id of myPlatformMentionIds(msg)) acc.add(id)
 *   const { selfMentioned, users } = acc.finalize()
 *
 * Why a class rather than a free function: parsers emit candidates from
 * several call sites (entities scan, blocks scan, reply-to inference). A
 * stateful accumulator avoids passing temporary arrays around.
 */

import type { MentionDescriptor } from "@/types/connectors/event"

export class MentionAccumulator {
  private readonly users: string[] = []
  private readonly seen = new Set<string>()
  private selfMentioned = false

  constructor(private readonly selfId: string) {}

  /**
   * Record a candidate mention. No-op when the id is empty/undefined or
   * has already been observed for this message. Marks `selfMentioned`
   * automatically when the id matches `selfId`.
   */
  add(id: string | null | undefined): void {
    if (!id) return
    if (this.seen.has(id)) {
      // Still flip selfMentioned even on duplicate adds — a self-mention
      // that appears multiple times (e.g., reply-to AND inline @) should
      // not be missed because the first add hit the dedup short-circuit.
      if (id === this.selfId) this.selfMentioned = true
      return
    }
    this.seen.add(id)
    this.users.push(id)
    if (id === this.selfId) this.selfMentioned = true
  }

  /**
   * Mark the message as a self-mention regardless of the id list (e.g.,
   * Telegram treats "user replied to a message authored by the bot" as a
   * self-mention even though no @-entity exists). Idempotent.
   */
  markSelfMentioned(): void {
    this.selfMentioned = true
  }

  /**
   * Returns the canonical `MentionDescriptor` consumed by the bus —
   * `{selfMentioned, users}` — matching what NormalizedInboundEvent
   * declares. Safe to call once at the end of parsing; do not mutate
   * the accumulator afterwards.
   */
  finalize(): MentionDescriptor {
    return { selfMentioned: this.selfMentioned, users: [...this.users] }
  }
}
