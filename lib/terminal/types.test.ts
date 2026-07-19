import type { SessionInfo, SpawnRequest, TerminalEvent } from "./types"

describe("terminal IPC contracts", () => {
  it("represents local and remote spawn/session payloads", () => {
    const spawn: SpawnRequest = {
      shell: "/bin/zsh",
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
    }

    expect(session).toMatchObject({ origin: "remote", shell: "/bin/zsh" })
  })

  it.each<TerminalEvent>([
    { kind: "data", bytes: [65] },
    { kind: "integration", event: { kind: "command_end", exit_code: 0 } },
    { kind: "exit", code: null },
  ])("preserves the $kind event payload", (event) => {
    expect(event.kind).toBeTruthy()
  })
})
