import { usePluginDevSessionStore } from "./plugin-dev-session-store"

beforeEach(() => {
  usePluginDevSessionStore.getState().clear()
})

describe("usePluginDevSessionStore", () => {
  it("merges out-of-order events into one idempotent attempt timeline", () => {
    const store = usePluginDevSessionStore.getState()
    store.ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 2,
      event: "build_started",
      occurredAt: "2026-08-29T10:00:02Z",
    })
    store.ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 0,
      event: "session_started",
      projectName: "Demo Project",
      occurredAt: "2026-08-29T10:00:00Z",
    })
    store.ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 2,
      event: "build_started",
      occurredAt: "2026-08-29T10:00:03Z",
    })
    store.ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 2,
      event: "change_detected",
      occurredAt: "2026-08-29T10:00:01Z",
    })

    const session = usePluginDevSessionStore.getState().sessions[0]
    expect(session.state).toBe("watching")
    expect(session.projectName).toBe("Demo Project")
    expect(session.attempts).toHaveLength(1)
    expect(session.attempts[0].attempt).toBe(2)
    expect(session.attempts[0].stages).toEqual(["detected", "building"])
  })

  it("records a generation-backed runtime result on the matching attempt", () => {
    usePluginDevSessionStore.getState().recordReloadResult({
      schemaVersion: 1,
      ok: true,
      outcome: "activated",
      stage: "verify",
      sessionId: "session-a",
      attempt: 1,
      pluginId: "demo.plugin",
      pluginType: "python",
      activationProof: {
        previousGeneration: 3,
        generation: 4,
        actualState: "active",
        packageVersion: "1.0.0",
        artifactRevision: "sha256:abc",
        reloadMode: "hot",
      },
    })

    const session = usePluginDevSessionStore.getState().sessions[0]
    expect(session.pluginId).toBe("demo.plugin")
    expect(session.pluginType).toBe("python")
    expect(session.attempts[0].state).toBe("active")
    expect(session.attempts[0].stages).toEqual([
      "discovering",
      "quiescing",
      "activating",
      "verifying",
      "active",
    ])
    expect(session.attempts[0].activationProof?.generation).toBe(4)
  })

  it("marks a live session stale after the heartbeat deadline", () => {
    usePluginDevSessionStore.getState().ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 0,
      event: "session_started",
      occurredAt: "2026-08-29T10:00:00Z",
    })

    usePluginDevSessionStore.getState().markStale(Date.parse("2026-08-29T10:00:16Z"))

    expect(usePluginDevSessionStore.getState().sessions[0].state).toBe("stale")
  })

  it("creates a starting session when the App attaches a terminal before CLI events arrive", () => {
    usePluginDevSessionStore.getState().attachTerminal("session-app", "terminal-1")

    expect(usePluginDevSessionStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        id: "session-app",
        state: "starting",
        terminalSessionId: "terminal-1",
        attempts: [],
      })
    )
  })

  it("preserves a stopped session and its history when late events arrive", () => {
    const store = usePluginDevSessionStore.getState()
    store.ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 1,
      event: "build_failed",
      occurredAt: "2026-08-29T10:00:01Z",
      summary: "compiler failed",
      durationMs: 45,
    })
    store.ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 1,
      event: "session_stopped",
      occurredAt: "2026-08-29T10:00:02Z",
    })
    store.ingest({
      schemaVersion: 1,
      sessionId: "session-a",
      attempt: 2,
      event: "heartbeat",
      occurredAt: "2026-08-29T10:00:03Z",
    })

    const session = usePluginDevSessionStore.getState().sessions[0]
    expect(session.state).toBe("stopped")
    expect(session.attempts[0]).toEqual(
      expect.objectContaining({
        state: "build_failed",
        durationMs: 45,
        diagnostics: ["compiler failed"],
      })
    )
  })

  it.each([
    ["install", ["installing"]],
    ["discover", ["discovering"]],
    ["quiesce", ["discovering", "quiescing"]],
    ["activate", ["discovering", "quiescing", "activating"]],
    ["verify", ["discovering", "quiescing", "activating", "verifying"]],
  ] as const)("maps a %s reload failure to its completed stages", (stage, stages) => {
    usePluginDevSessionStore.getState().recordReloadResult({
      schemaVersion: 1,
      ok: false,
      outcome: stage === "quiesce" ? "restart_required" : "failed",
      stage,
      sessionId: `session-${stage}`,
      attempt: 1,
      pluginId: "demo.plugin",
      error: {
        code: "runtime_failure",
        message: `${stage} failed`,
        action: "Retry",
        retriable: true,
      },
    })

    expect(usePluginDevSessionStore.getState().sessions[0].attempts[0]).toEqual(
      expect.objectContaining({
        state: stage === "quiesce" ? "restart_required" : "reload_failed",
        stages,
        diagnostics: [`${stage} failed`],
      })
    )
  })

  it("bounds diagnostics and updates an existing session terminal", () => {
    const store = usePluginDevSessionStore.getState()
    for (let index = 0; index < 55; index += 1) {
      store.ingest({
        schemaVersion: 1,
        sessionId: "session-a",
        attempt: 1,
        event: "build_failed",
        occurredAt: new Date(1_000 + index).toISOString(),
        summary: `failure-${index}`,
      })
    }
    store.attachTerminal("session-a", "terminal-2")

    const session = usePluginDevSessionStore.getState().sessions[0]
    expect(session.terminalSessionId).toBe("terminal-2")
    expect(session.attempts[0].diagnostics).toHaveLength(50)
    expect(session.attempts[0].diagnostics[0]).toBe("failure-5")
  })

  it("bounds retained sessions and attempts", () => {
    const store = usePluginDevSessionStore.getState()
    for (let session = 0; session < 12; session += 1) {
      for (let attempt = 1; attempt <= 55; attempt += 1) {
        store.ingest({
          schemaVersion: 1,
          sessionId: `session-${session}`,
          attempt,
          event: "build_started",
          occurredAt: new Date(1_000 + session * 100 + attempt).toISOString(),
        })
      }
    }

    const state = usePluginDevSessionStore.getState()
    expect(state.sessions).toHaveLength(10)
    expect(state.sessions.every((session) => session.attempts.length <= 50)).toBe(true)
  })
})
