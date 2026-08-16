/** @jest-environment jsdom */

const mockInvoke = jest.fn()
const channels: Array<{ onmessage?: (message: unknown) => void }> = []

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {
    onmessage?: (message: unknown) => void
    constructor() {
      channels.push(this)
    }
  },
}))

import { SshTerminalSession } from "./ssh-session"
import type { SshConnectRequest } from "./ssh-profiles"

const request: SshConnectRequest = {
  host: "host.example",
  port: 22,
  username: "deploy",
  authMethod: "password",
  credentialRef: "ssh-1",
  rows: 24,
  cols: 80,
  profileId: "ssh-1",
  displayName: "Production",
}

beforeEach(() => {
  mockInvoke.mockReset()
  channels.length = 0
})

describe("SshTerminalSession", () => {
  it("connects through the native SSH command and exposes TOFU verification", async () => {
    mockInvoke.mockResolvedValue({
      session: {
        id: "remote-1",
        projectId: null,
        extensionId: null,
        origin: "remote",
        shell: "ssh deploy@host.example",
        alive: true,
      },
      hostKeyStatus: "learned",
      hostKeyFingerprint: "SHA256:abc",
    })

    const session = await SshTerminalSession.connect(request)

    expect(session.profileId).toBe("ssh-1")
    expect(session.hostKeyStatus).toBe("learned")
    expect(session.hostKeyFingerprint).toBe("SHA256:abc")
    expect(mockInvoke).toHaveBeenCalledWith(
      "ssh_terminal_spawn",
      expect.objectContaining({ req: request, onEvent: expect.any(Object) })
    )
  })

  it("dispatches data and exit envelopes and uses SSH-specific control commands", async () => {
    mockInvoke.mockResolvedValueOnce({
      session: {
        id: "remote-1",
        projectId: null,
        extensionId: null,
        origin: "remote",
        shell: "ssh deploy@host.example",
      },
      hostKeyStatus: "verified",
      hostKeyFingerprint: "SHA256:abc",
    })
    const session = await SshTerminalSession.connect(request)
    const data: number[][] = []
    session.onData((bytes) => data.push(Array.from(bytes)))

    channels[0]?.onmessage?.({ seq: 1, event: { kind: "data", bytes: [104, 105] } })
    expect(data).toEqual([[104, 105]])

    mockInvoke.mockResolvedValue(undefined)
    await session.write("ls")
    await session.write(new Uint8Array([13]))
    await session.resize(0, 100.2)
    await session.kill()
    expect(mockInvoke.mock.calls.slice(-4)).toEqual([
      ["ssh_terminal_write", { id: "remote-1", data: [108, 115] }],
      ["ssh_terminal_write", { id: "remote-1", data: [13] }],
      ["ssh_terminal_resize", { id: "remote-1", rows: 1, cols: 100 }],
      ["ssh_terminal_kill", { id: "remote-1" }],
    ])

    let exit: number | null | undefined
    session.onExit((code) => {
      exit = code
    })
    channels[0]?.onmessage?.({ seq: 2, event: { kind: "exit", code: null } })
    expect(exit).toBeNull()
    await session.kill()
    expect(mockInvoke).toHaveBeenCalledTimes(5)
  })

  it("dispatches integration envelopes and normalizes missing exit codes", async () => {
    mockInvoke.mockResolvedValueOnce({
      session: {
        id: "remote-2",
        projectId: null,
        extensionId: null,
        origin: "remote",
        shell: "ssh deploy@host.example",
      },
      hostKeyStatus: "verified",
      hostKeyFingerprint: "SHA256:def",
    })
    const session = await SshTerminalSession.connect(request)
    const integrations: unknown[] = []
    session.onIntegration((event) => integrations.push(event))
    channels[0]?.onmessage?.({
      seq: 1,
      event: { kind: "integration", event: { kind: "cwd", cwd: "/srv" } },
    })
    expect(integrations).toEqual([{ kind: "cwd", cwd: "/srv" }])

    let exit: number | null | undefined = 1
    session.onExit((code) => {
      exit = code
    })
    channels[0]?.onmessage?.({ seq: 2, event: { kind: "exit" } })
    expect(exit).toBeNull()
  })

  it("detaches and transitions local control ownership", async () => {
    mockInvoke.mockResolvedValueOnce({
      session: {
        id: "remote-3",
        projectId: null,
        extensionId: null,
        origin: "remote",
        shell: "ssh deploy@host.example",
      },
      hostKeyStatus: "verified",
      hostKeyFingerprint: "SHA256:ghi",
    })
    const session = await SshTerminalSession.connect(request)
    const controls: unknown[] = []
    session.onControlState((state) => controls.push(state))
    mockInvoke.mockResolvedValue(undefined)

    await session.detach()
    await session.takeControl()
    await session.releaseControl()

    expect(mockInvoke.mock.calls.slice(-3)).toEqual([
      ["terminal_detach", { id: "remote-3" }],
      ["terminal_take_control", { id: "remote-3" }],
      ["terminal_release_control", { id: "remote-3" }],
    ])
    expect(controls).toEqual([
      { role: "controller", controllerId: null },
      { role: "controller", controllerId: "local" },
      { role: "viewer", controllerId: null, reason: "released" },
    ])
  })

  describe("reattach", () => {
    const listed = {
      id: "remote-9",
      projectId: "project-1",
      extensionId: null,
      origin: "local" as const,
      shell: "ssh deploy@prod.example.com",
      kind: "ssh" as const,
      profileId: "ssh-1",
      sshHostKeyStatus: "verified" as const,
      sshHostKeyFingerprint: "SHA256:listed",
    }

    it("restores the host-key verdict the host reports", async () => {
      mockInvoke.mockResolvedValue({ ...listed, sshHostKeyFingerprint: "SHA256:fresh" })
      const session = await SshTerminalSession.reattach(listed)

      expect(mockInvoke).toHaveBeenCalledWith("terminal_reattach", {
        id: "remote-9",
        onEvent: expect.anything(),
        resumeFrom: 0,
      })
      // The host's answer wins over the listing that led us here.
      expect(session.hostKeyFingerprint).toBe("SHA256:fresh")
      expect(session.hostKeyStatus).toBe("verified")
      expect(session.profileId).toBe("ssh-1")
    })

    it("falls back to the listing when the host omits the key fields", async () => {
      // A host predating the field pair answers without them; the session is
      // still usable and keeps whatever the listing knew.
      mockInvoke.mockResolvedValue({
        id: "remote-9",
        projectId: "project-1",
        extensionId: null,
        origin: "local",
        shell: "ssh deploy@prod.example.com",
      })
      const session = await SshTerminalSession.reattach(listed)

      expect(session.hostKeyFingerprint).toBe("SHA256:listed")
      expect(session.hostKeyStatus).toBe("verified")
      expect(session.profileId).toBe("ssh-1")
    })

    it("stays usable when neither side knows the host key", async () => {
      // Both the host and the listing predate the field pair. Reattaching must
      // still produce a working handle rather than throwing — the fingerprint
      // is simply unknown until the next connect.
      const bare = {
        id: "remote-9",
        projectId: null,
        extensionId: null,
        origin: "local" as const,
        shell: "ssh deploy@prod.example.com",
        kind: "ssh" as const,
      }
      mockInvoke.mockResolvedValue(bare)
      const session = await SshTerminalSession.reattach(bare)

      expect(session.hostKeyStatus).toBe("learned")
      expect(session.hostKeyFingerprint).toBe("")
      expect(session.profileId).toBe("")
    })

    it("streams host events into the rebuilt handle", async () => {
      mockInvoke.mockResolvedValue(listed)
      const session = await SshTerminalSession.reattach(listed, 42)
      const chunks: Uint8Array[] = []
      session.onData((bytes) => chunks.push(bytes))

      channels[0]?.onmessage?.({ seq: 43, event: { kind: "data", bytes: [104, 105] } })

      expect(mockInvoke).toHaveBeenCalledWith(
        "terminal_reattach",
        expect.objectContaining({ resumeFrom: 42 })
      )
      expect(Array.from(chunks[0] ?? [])).toEqual([104, 105])
    })
  })
})
