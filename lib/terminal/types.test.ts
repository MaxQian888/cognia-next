import type { SessionInfo, SpawnRequest, TerminalEvent } from "./types"

describe("terminal IPC contracts", () => {
  it("represents local and remote spawn/session payloads", () => {
    const spawn: SpawnRequest = {
      shell: "/bin/zsh",
      profileId: "profile-1",
      args: ["-l"],
      rows: 24,
      cols: 80,
      origin: "remote",
      sandboxed: true,
      sandboxNetwork: false,
    }
    const session: SessionInfo = {
      id: "session-1",
      projectId: null,
      extensionId: null,
      origin: spawn.origin ?? "local",
      shell: spawn.shell,
      hostId: "host-1",
      kind: "localPty",
      profileId: spawn.profileId,
      currentController: "desktop",
      attachedClients: 2,
      integrationCapabilities: {
        osc633: true,
        commandStatus: true,
        cwdTracking: true,
        degradedReason: null,
      },
      replay: {
        firstSequence: 1,
        lastSequence: 4,
        retainedBytes: 128,
        truncated: false,
      },
    }

    expect(session).toMatchObject({ origin: "remote", shell: "/bin/zsh" })
  })

  it.each<TerminalEvent>([
    { kind: "data", bytes: [65] },
    { kind: "integration", event: { kind: "command_end", exit_code: 0 } },
    { kind: "exit", code: null },
    { kind: "replay_gap", requested_after: 1, first_available: 2, last_available: 4 },
    { kind: "controller_changed", controller: "desktop" },
  ])("preserves the $kind event payload", (event) => {
    expect(event.kind).toBeTruthy()
  })
})
