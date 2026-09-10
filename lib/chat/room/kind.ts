/**
 * Which room a session is, read off the columns each plane already writes.
 *
 * Kept as one function so the four consumers (roster projection, settings
 * defaults, the runner, the participants chip) cannot disagree about a
 * session that carries two bindings at once. Precedence: a shared session
 * binding wins, because its writes are server-authoritative and a local
 * runner must not orchestrate over it. Then a character team. Then an IM
 * binding.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { RoomKind } from "./types"

export type RoomKindSource = Pick<
  ChatSession,
  "kind" | "teamId" | "collaboration" | "platformBinding"
>

export function roomKindOf(session: RoomKindSource | null | undefined): RoomKind | null {
  if (!session) return null
  if (session.collaboration) return "shared"
  if (session.kind === "team" && session.teamId) return "team"
  if (session.platformBinding) return "im"
  return null
}

/** A room the local runner may drive. Shared rooms are the server's to run. */
export function isLocallyOrchestratedRoom(session: RoomKindSource | null | undefined): boolean {
  return roomKindOf(session) === "team"
}

/** Rooms where more than one human can be present. */
export function isMultiHumanRoom(kind: RoomKind | null): boolean {
  return kind === "shared" || kind === "im"
}
