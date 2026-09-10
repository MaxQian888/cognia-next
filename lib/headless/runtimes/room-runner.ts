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
 *   The activity string (`Read · foo.ts`, ADR-0177 batch 2) rides the same
 *   frame, so a change of tool with no change of status is published too.
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
  /** The tool the member is on, or `null` when it is between tools or done. */
  activity: string | null
}

/** The two per-member maps the UI store keeps, read together. */
export interface MemberStatusSnapshot {
  status: Readonly<Record<string, MemberStatus>>
  activity: Readonly<Record<string, string>>
}

/**
 * The frames that turn `prev` into `next`. Keys are `<roomId>::<characterId>`
 * (`memberKey` in the UI store). The split is on the last separator so a
 * room id is never cut in half. A member present in neither map of `next`
 * is published as idle with no activity, once.
 */
export function diffMemberStatus(
  prev: MemberStatusSnapshot,
  next: MemberStatusSnapshot
): RoomMemberStatusFrame[] {
  const frames: RoomMemberStatusFrame[] = []
  const split = (key: string): [string, string] | null => {
    const at = key.lastIndexOf("::")
    if (at <= 0 || at + 2 >= key.length) return null
    return [key.slice(0, at), key.slice(at + 2)]
  }
  const keys = new Set([
    ...Object.keys(prev.status),
    ...Object.keys(prev.activity),
    ...Object.keys(next.status),
    ...Object.keys(next.activity),
  ])
  for (const key of keys) {
    const before = { status: prev.status[key] ?? "idle", activity: prev.activity[key] ?? null }
    const after = { status: next.status[key] ?? "idle", activity: next.activity[key] ?? null }
    if (before.status === after.status && before.activity === after.activity) continue
    const parts = split(key)
    if (parts) frames.push({ sessionId: parts[0], characterId: parts[1], ...after })
  }
  return frames
}

registerHeadlessRuntime({
  name: "room-runner",
  hosts: ["brain"],
  start: async (ctx) => {
    const runner = getHostRoomRunner()
    const unlisten = await onClaudeMessage((evt) => runner.handleEvent(evt))

    const snapshot = (state: {
      memberStatus: Record<string, MemberStatus>
      memberActivity: Record<string, string>
    }): MemberStatusSnapshot => ({ status: state.memberStatus, activity: state.memberActivity })
    let previous = snapshot(useUIStore.getState())
    const unsubscribe = useUIStore.subscribe((state) => {
      if (state.memberStatus === previous.status && state.memberActivity === previous.activity) {
        return
      }
      const current = snapshot(state)
      const frames = diffMemberStatus(previous, current)
      previous = current
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
