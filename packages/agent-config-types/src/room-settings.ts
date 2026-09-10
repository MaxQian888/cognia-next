/**
 * Room settings carried on `ChatSession.roomSettings` (ADR-0177).
 *
 * Mirrors `lib/chat/room/types.ts`. The app-side module re-exports these so a
 * package consumer and the renderer read one shape.
 */

export type RoomReplyMode = "auto" | "mention_only" | "asleep"

export interface RoomSettings {
  /**
   * When the room's agents may speak on their own. Read by the team runner
   * (`lib/chat/room/runner.ts`) and by IM admission
   * (`lib/connectors/conversation-admission.ts`) since batch 3.
   */
  replyMode?: RoomReplyMode
  /** Injected into every member's system prompt as `## Room instructions`. */
  instructions?: string
  /** Mirrored onto `memoryUse` and `memoryLearn`, which the memory plane reads. */
  memory?: boolean
  /**
   * Members the router never picks on its own. An explicit `@` or a pick in
   * the composer still reaches a muted member: the user asked, so mute, which
   * is about the room's own initiative, does not apply.
   */
  mutedMemberIds?: string[]
}
