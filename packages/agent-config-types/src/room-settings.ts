/**
 * Room settings carried on `ChatSession.roomSettings` (ADR-0177).
 *
 * Mirrors `lib/chat/room/types.ts`. The app-side module re-exports these so a
 * package consumer and the renderer read one shape.
 */

export type RoomReplyMode = "auto" | "mention_only" | "asleep"

export interface RoomSettings {
  /**
   * Stored from batch 1, read by the runner from batch 3. Until then the
   * setting is inert: the UI labels it so, and a test pins the label.
   */
  replyMode?: RoomReplyMode
  /** Injected into every member's system prompt as `## Room instructions`. */
  instructions?: string
  /** Mirrored onto `memoryUse` and `memoryLearn`, which the memory plane reads. */
  memory?: boolean
  /** Stored from batch 1, honoured by the router from batch 3. Inert until then. */
  mutedMemberIds?: string[]
}
