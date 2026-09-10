/**
 * One runner per process (ADR-0177, batch 1).
 *
 * # Host
 *
 * The desktop renderer's `useTeamChat` and the `room_send` RPC arm must share
 * one `RoomRunner`: a phone's turn and a local turn on the same room have to
 * hit the same steer queue, the same interrupt set and the same stream
 * registry, or the second would orchestrate over the first. The headless
 * brain constructs the same singleton from its runtime.
 *
 * # Companion
 *
 * A paired phone or web companion does not orchestrate. It sends through
 * `room_send` and only *projects* the member sub-session events it already
 * receives on the mirrored event channel into its store, so streaming text
 * still renders. That projector is the same `RoomRunner` with persistence
 * stubbed to no-ops: the host writes every durable row, and the sync mirror
 * brings them over. Session status on the companion is derived from the
 * member events themselves (first event opens, last `session_ended` closes
 * after a short grace for the next member to start).
 */

import type { ClaudeEvent } from "@cognia/agent-config-types"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { RoomRunner } from "./runner"
import { createProductionRoomDeps } from "./production-deps"
import { createStoreRoomSinks } from "./store-sinks"
import type { RoomRunnerDeps, RoomRunnerSinks } from "./runner-deps"

let hostRunner: RoomRunner | null = null
let companionProjector: CompanionRoomProjector | null = null

/** The host's runner: desktop renderer, headless brain, and the RPC arm share it. */
export function getHostRoomRunner(): RoomRunner {
  if (!hostRunner) hostRunner = new RoomRunner(createProductionRoomDeps(), createStoreRoomSinks())
  return hostRunner
}

/** Members finished, wait this long for the next one before calling the room idle. */
export const COMPANION_IDLE_GRACE_MS = 1_500

/**
 * A `RoomRunner` whose persistence is inert. `send` is never called on it
 * (the hook routes sends to the host), so `execution` and most of `ai` are
 * unreachable, but `respondToApproval` and the event handler are live.
 */
export function createCompanionProjectionDeps(base: RoomRunnerDeps): RoomRunnerDeps {
  return {
    ...base,
    db: {
      ...base.db,
      persistMessages: async () => undefined,
      bumpUnread: async () => undefined,
      recordResultUsage: async () => undefined,
    },
    ai: {
      ...base.ai,
      applySdkSubagentBridge: () => undefined,
    },
  }
}

export class CompanionRoomProjector {
  private readonly active = new Map<string, Set<string>>()
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    readonly runner: RoomRunner,
    private readonly sinks: Pick<RoomRunnerSinks, "status">,
    private readonly graceMs: number = COMPANION_IDLE_GRACE_MS
  ) {}

  handleEvent(evt: ClaudeEvent): void {
    const sessionId = (evt as { sessionId?: unknown }).sessionId
    if (typeof sessionId === "string") {
      const decoded = decodeSubSession(sessionId)
      if (decoded) {
        const roomId = decoded.teamSessionId
        if (evt.type === "event" || evt.type === "permission_request") this.open(roomId, sessionId)
        else if (evt.type === "session_ended") this.close(roomId, sessionId)
      }
    }
    this.runner.handleEvent(evt)
  }

  /** The host accepted a send, so the room is busy until its members finish. */
  markSending(roomId: string): void {
    const timer = this.idleTimers.get(roomId)
    if (timer) clearTimeout(timer)
    this.idleTimers.delete(roomId)
    if (this.sinks.status.get(roomId) !== "streaming") this.sinks.status.set(roomId, "streaming")
  }

  private open(roomId: string, sub: string): void {
    const subs = this.active.get(roomId) ?? new Set<string>()
    subs.add(sub)
    this.active.set(roomId, subs)
    this.markSending(roomId)
  }

  private close(roomId: string, sub: string): void {
    const subs = this.active.get(roomId)
    subs?.delete(sub)
    if (subs && subs.size > 0) return
    const timer = this.idleTimers.get(roomId)
    if (timer) clearTimeout(timer)
    this.idleTimers.set(
      roomId,
      setTimeout(() => {
        this.idleTimers.delete(roomId)
        if ((this.active.get(roomId)?.size ?? 0) > 0) return
        this.active.delete(roomId)
        if (this.sinks.status.get(roomId) === "streaming") this.sinks.status.set(roomId, "idle")
      }, this.graceMs)
    )
  }

  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    this.active.clear()
    this.runner.dispose()
  }
}

export function getCompanionRoomProjector(): CompanionRoomProjector {
  if (!companionProjector) {
    const sinks = createStoreRoomSinks()
    companionProjector = new CompanionRoomProjector(
      new RoomRunner(createCompanionProjectionDeps(createProductionRoomDeps()), sinks),
      sinks
    )
  }
  return companionProjector
}

export function __resetRoomRunnersForTests(): void {
  hostRunner?.dispose()
  hostRunner = null
  companionProjector?.dispose()
  companionProjector = null
}
