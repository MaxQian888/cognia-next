/**
 * The fleet DTOs are compile-time types; the only runtime surface is the two
 * constants below, which must stay in lockstep with the Rust side
 * (`src-tauri/src/fleet/mod.rs`) — assert their literal values so a drift is a
 * failing test, not a silent no-op event subscription.
 */

import {
  FLEET_ISLAND_GEOMETRY_EVENT,
  FLEET_ISLAND_HOVER_EVENT,
  FLEET_PERMISSION_WAIT_MS,
  FLEET_UPDATE_EVENT,
} from "./types"

describe("fleet runtime constants", () => {
  it("pins the update event topic to the Rust UPDATE_EVENT", () => {
    expect(FLEET_UPDATE_EVENT).toBe("fleet://update")
  })

  it("pins the island window event topics to their Rust constants", () => {
    expect(FLEET_ISLAND_GEOMETRY_EVENT).toBe("fleet://island-geometry")
    expect(FLEET_ISLAND_HOVER_EVENT).toBe("fleet://island-hover")
  })

  it("keeps the island answer window below the curl/hook timeout ladder", () => {
    // 20s island < 25s curl --max-time < 30s settings.json hook timeout.
    expect(FLEET_PERMISSION_WAIT_MS).toBe(20_000)
    expect(FLEET_PERMISSION_WAIT_MS).toBeLessThan(25_000)
  })
})

describe("fleet worker compatibility", () => {
  it("keeps worker hosts additive for old snapshots", () => {
    const oldSnapshot: import("./types").FleetSnapshot = { sessions: [], generatedAt: 1 }
    expect(oldSnapshot.hosts).toBeUndefined()
    const current: import("./types").FleetSnapshot = {
      ...oldSnapshot,
      hosts: [
        {
          hostRef: "device:a",
          online: true,
          maxActiveTurns: 2,
          usedSlots: 1,
          runtime: "cognia-agent",
          workspaceBindingReady: true,
          lastSeenAt: 1,
        },
      ],
    }
    expect(current.hosts?.[0]).toMatchObject({ hostRef: "device:a", usedSlots: 1 })
  })

  it("accepts canonical lifecycle metadata and runtime-proven capabilities", () => {
    const snapshot: import("./types").FleetSnapshot = {
      sessions: [
        {
          agent: "cognia",
          origin: "workflow",
          lifecycleConfidence: "native",
          sessionId: "session-1",
          status: "detached",
          cwd: null,
          projectName: null,
          lastPrompt: null,
          activity: null,
          permissionMode: null,
          model: null,
          terminal: null,
          transcriptPath: null,
          agentPid: null,
          pendingPermission: null,
          capabilities: {
            approvePermission: false,
            sendMessage: false,
            focusTerminal: false,
            openTranscript: false,
            interrupt: false,
          },
          startedAt: 1,
          lastEventAt: 2,
          toolUseCount: 0,
          turnCount: 0,
        },
      ],
      runtimeCapabilities: [
        {
          agent: "opencode",
          sendMessage: true,
          interrupt: true,
          answersQuestions: true,
          interruptMode: "native-sdk",
          questionMode: "native-sdk",
          observedAt: 2,
        },
      ],
      generatedAt: 2,
    }

    expect(snapshot.sessions[0]).toMatchObject({
      agent: "cognia",
      origin: "workflow",
      lifecycleConfidence: "native",
      status: "detached",
    })
    expect(snapshot.runtimeCapabilities?.[0]).toMatchObject({
      agent: "opencode",
      interrupt: true,
      answersQuestions: true,
    })
  })
})
