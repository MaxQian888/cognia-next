/**
 * Team rooms on the headless brain (ADR-0177, batch 1).
 *
 * The brain has no React tree, so before this it could not run a team room
 * at all: a phone paired to a cloud host got `claude_send` for one member and
 * nothing that orchestrated the round. This runtime is the same
 * process-wide `RoomRunner` the desktop renderer uses, over the same
 * store-backed sinks (zustand stores are plain modules here), with two
 * things the brain has to do itself because no hook does them:
 *
 * - **Feed it the sidecar.** The desktop hook subscribes `onClaudeMessage`
 *   on mount. The brain subscribes once at boot and forwards every frame,
 *   and the runner ignores the ones that are not member sub-sessions.
 * - **Publish member status.** The desktop reads `useUIStore.memberStatus`
 *   straight into the members panel. Nobody reads the brain's UI store, so
 *   each change goes out as a `room://member-status` host event, which is
 *   what a companion's members panel renders while the round runs on the
 *   host. The whole set is diffed, and a member dropped from the map (turn
 *   over) is published as `idle`, so a client never sticks on `thinking`.
 */

import { getHostRoomRunner } from "@/lib/chat/room/runner-host"
import { onClaudeMessage } from "@/lib/claude/ipc"
import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import { useUIStore, type MemberStatus } from "@/stores/ui"
import { registerHeadlessRuntime } from "../registry"

export const ROOM_MEMBER_STATUS_TOPIC = "room://member-status"

export interface RoomMemberStatusFrame {
  sessionId: string
  characterId: string
  status: MemberStatus
}

/**
 * The frames that turn `prev` into `next`. Keys are `<roomId>::<characterId>`
 * (`memberKey` in the UI store). The split is on the last separator so a
 * room id is never cut in half.
 */
export function diffMemberStatus(
  prev: Readonly<Record<string, MemberStatus>>,
  next: Readonly<Record<string, MemberStatus>>
): RoomMemberStatusFrame[] {
  const frames: RoomMemberStatusFrame[] = []
  const split = (key: string): [string, string] | null => {
    const at = key.lastIndexOf("::")
    if (at <= 0 || at + 2 >= key.length) return null
    return [key.slice(0, at), key.slice(at + 2)]
  }
  for (const [key, status] of Object.entries(next)) {
    if (prev[key] === status) continue
    const parts = split(key)
    if (parts) frames.push({ sessionId: parts[0], characterId: parts[1], status })
  }
  for (const key of Object.keys(prev)) {
    if (key in next) continue
    const parts = split(key)
    if (parts) frames.push({ sessionId: parts[0], characterId: parts[1], status: "idle" })
  }
  return frames
}

registerHeadlessRuntime({
  name: "room-runner",
  hosts: ["brain"],
  start: async (ctx) => {
    const runner = getHostRoomRunner()
    const unlisten = await onClaudeMessage((evt) => runner.handleEvent(evt))

    let previous = useUIStore.getState().memberStatus
    const unsubscribe = useUIStore.subscribe((state) => {
      if (state.memberStatus === previous) return
      const frames = diffMemberStatus(previous, state.memberStatus)
      previous = state.memberStatus
      for (const frame of frames) {
        void publishHostEvent(ROOM_MEMBER_STATUS_TOPIC, frame).catch((error) =>
          ctx.log(
            "warn",
            `room member status publish failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      }
    })

    return () => {
      unsubscribe()
      unlisten()
    }
  },
})
