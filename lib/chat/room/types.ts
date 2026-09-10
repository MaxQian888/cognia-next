/**
 * The room vocabulary (ADR-0177).
 *
 * A "room" is one conversation shape with three memberships: a character team
 * (several personas, one local user), a shared session (several people, one
 * assistant, server-authoritative), and an IM group (a platform channel
 * talking to one bot). Each keeps its membership somewhere different. These
 * types are what lets one runner, one roster projection and one settings
 * sheet serve all three without asking which plane they are on.
 *
 * Pure: no Dexie, no React, no store.
 */

/** Which membership source a room reads. `null` is a plain one-to-one chat. */
export type RoomKind = "team" | "shared" | "im"

import type { RoomReplyMode } from "@cognia/agent-config-types"

/**
 * `RoomReplyMode` and `RoomSettings` are declared in
 * `@cognia/agent-config-types/room-settings` because the session row carries
 * them. `RoomReplyMode` says when the room's agents may speak on their own.
 *
 * - `auto`: the room decides (auto rounds in a team, the activation policy in
 *   an IM group, the silence verdict in a shared room).
 * - `mention_only`: an explicit `@` is the only thing that gets a reply.
 * - `asleep`: nothing replies until the mode is changed.
 *
 * Batch 1 (ADR-0177) stores and renders the value. The team runner and the
 * IM admission mapping honour it in batch 3, so until then it is labelled
 * inert in the settings sheet and pinned by `settings.test.ts`.
 */
export type { RoomReplyMode, RoomSettings } from "@cognia/agent-config-types"

/** How complete a roster is, so the UI never claims a list it does not have. */
export type RoomRosterCompleteness = "full" | "partial" | "observed"

/** The settings a room actually runs with once defaults are applied. */
export interface ResolvedRoomSettings {
  kind: RoomKind | null
  replyMode: RoomReplyMode
  instructions: string
  memory: boolean
  mutedMemberIds: readonly string[]
  /** True when `memory` came from the kind's default rather than the row. */
  memoryDefaulted: boolean
}
