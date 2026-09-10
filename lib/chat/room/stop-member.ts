/**
 * Stop one member of a room without stopping the room (ADR-0177, batch 3).
 *
 * The message header's stop button calls this from every shell. On a host
 * it reaches the process-wide runner directly. On a companion the runner is
 * a projector that runs nothing, so the stop goes to the host as
 * `room_stop { sessionId, characterId }`, the same arm that stops the whole
 * room when no member is named.
 */

import { getHostRoomRunner } from "./runner-host"
import { isCompanionShell } from "./shell"
import { stopRoomTurn } from "@/lib/companion/room-send-client"

export interface StopRoomMemberDeps {
  companion?: () => boolean
  host?: () => Pick<ReturnType<typeof getHostRoomRunner>, "stopMember">
  remote?: typeof stopRoomTurn
}

export async function stopRoomMember(
  sessionId: string,
  characterId: string,
  deps: StopRoomMemberDeps = {}
): Promise<void> {
  const companion = (deps.companion ?? isCompanionShell)()
  if (companion) {
    await (deps.remote ?? stopRoomTurn)(sessionId, characterId)
    return
  }
  await (deps.host ?? getHostRoomRunner)().stopMember(sessionId, characterId)
}
