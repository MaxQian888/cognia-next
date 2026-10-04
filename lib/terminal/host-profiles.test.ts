let mockChain: string[] = ["tauri-channel"]
jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

import {
  ADHOC_PROFILE_ID,
  buildSynchronizedSshProfiles,
  buildSynchronizedTerminalProfiles,
  syncTerminalHostProfiles,
} from "./host-profiles"

beforeEach(() => {
  mockChain = ["tauri-channel"]
})

describe("terminal host profile synchronization", () => {
  it("sends only complete named profiles and preserves sandbox policy", () => {
    expect(
      buildSynchronizedTerminalProfiles(
        [
          { id: "blank", name: "Blank", shell: "" },
          {
            id: "build",
            name: "Build",
            shell: "/bin/zsh",
            args: ["-l"],
            cwd: "/workspace",
            env: { TERM_FEATURE: "1" },
          },
        ],
        { sandboxed: true, forceUtf8: false }
      )
    ).toEqual([
      {
        profileId: "build",
        request: expect.objectContaining({
          shell: "/bin/zsh",
          args: ["-l"],
          cwd: "/workspace",
          env: { TERM_FEATURE: "1" },
          rows: 24,
          cols: 80,
          sandboxed: true,
          forceUtf8: false,
        }),
      },
    ])
  })

  it("synchronizes secret-free SSH profiles by stable identifier", () => {
    expect(
      buildSynchronizedSshProfiles([
        {
          id: "invalid",
          name: "Invalid",
          host: "bad host",
          port: 22,
          username: "deploy",
          authMethod: "password",
        },
        {
          id: "production",
          name: "Production",
          host: "server.example.com",
          port: 2222,
          username: "deploy",
          authMethod: "privateKey",
          privateKeyPath: "~/.ssh/id_ed25519",
          credentialRef: "production",
        },
      ])
    ).toEqual([
      {
        profileId: "production",
        request: expect.objectContaining({
          profileId: "production",
          host: "server.example.com",
          port: 2222,
          rows: 24,
          cols: 80,
          credentialRef: "production",
        }),
      },
    ])
  })

  it("synchronizes the jump chain but never a forwarding rule", () => {
    // A synchronized profile is what a phone, a LAN client, or SFTP names to
    // reach a machine. Forwarding here would let a remote client make the
    // desktop open a listening port, which ADR-0082 §9 forbids, so stripping it
    // is pinned rather than left to happenstance. The jump chain is the
    // opposite case: it opens nothing, and without it a bastion-backed host is
    // dialed direct, which reaches a different machine or none.
    const bastion = {
      id: "bastion",
      name: "Bastion",
      host: "jump.example.com",
      port: 2200,
      username: "jumper",
      authMethod: "password" as const,
      credentialRef: "bastion",
    }
    const synchronized = buildSynchronizedSshProfiles([
      bastion,
      {
        id: "production",
        name: "Production",
        host: "server.example.com",
        port: 22,
        username: "deploy",
        authMethod: "agent",
        jumpHostId: "bastion",
        localForwards: [
          {
            id: "lfwd-1",
            localPort: 8080,
            remoteHost: "db.internal",
            remotePort: 5432,
            enabled: true,
          },
        ],
        remoteForwards: [
          {
            id: "rfwd-1",
            remotePort: 9000,
            localHost: "localhost",
            localPort: 3000,
            enabled: true,
          },
        ],
      },
    ])
    const production = synchronized.find((entry) => entry.profileId === "production")!

    expect(production.request.jumpChain).toEqual([
      {
        host: "jump.example.com",
        port: 2200,
        username: "jumper",
        authMethod: "password",
        credentialRef: "bastion",
        privateKeyPath: undefined,
      },
    ])
    expect(production.request).not.toHaveProperty("localForwards")
    expect(production.request).not.toHaveProperty("remoteForwards")
    // A direct host carries no empty chain field at all.
    expect(synchronized.find((entry) => entry.profileId === "bastion")!.request).not.toHaveProperty(
      "jumpChain"
    )
  })

  it("leaves out a profile whose chain cannot be walked rather than syncing it direct", () => {
    const synchronized = buildSynchronizedSshProfiles([
      {
        id: "orphan",
        name: "Orphan",
        host: "server.example.com",
        port: 22,
        username: "deploy",
        authMethod: "agent",
        jumpHostId: "deleted-bastion",
      },
    ])
    expect(synchronized).toEqual([])
  })

  it("replaces the host profile set, including clearing deleted profiles", async () => {
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles([], {}, call as never)
    expect(call).toHaveBeenCalledWith("terminal_host_service", {
      action: { kind: "syncProfiles", profiles: [], sshProfiles: [] },
    })
  })

  // Two commands, two authorities: the local one also owns `provision` and the
  // login-service registration and stays local; the remote one is gated on
  // `terminal.open` and scoped to the calling device.
  it("uses the capability-gated RPC against a remote host", async () => {
    mockChain = ["ws", "webrtc"]
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles(
      [{ id: "build", name: "Build", shell: "/bin/bash" }],
      {},
      call as never
    )
    const [command, payload] = call.mock.calls[0] as unknown as [
      string,
      { profiles: { profileId: string }[] },
    ]
    expect(command).toBe("terminal_host_sync_profiles")
    expect(payload.profiles.map((entry) => entry.profileId)).toEqual(["build"])
  })

  // An SSH profile names a destination and a credential. Installing one from a
  // paired device would let it drive outbound connections from the host, so the
  // Rust arm refuses them and the client must not send them either.
  it("never sends SSH profiles to a remote host", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles(
      [],
      {
        sshProfiles: [
          {
            id: "prod",
            name: "prod",
            host: "example.com",
            username: "root",
            auth: "agent",
          } as never,
        ],
      },
      call as never
    )
    expect(call.mock.calls[0][1]).toEqual({ profiles: [] })
  })

  // A remote spawn frame carries a profile id and nothing else, so a shell the
  // user picked has to arrive as a profile or it is silently replaced by the
  // host's bootstrap default.
  it("carries an ad-hoc spawn alongside the saved profiles, never instead of them", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles(
      [{ id: "build", name: "Build", shell: "/bin/bash" }],
      { adHoc: { shell: "/bin/zsh", rows: 24, cols: 80 } },
      call as never
    )
    const payload = call.mock.calls[0][1] as unknown as {
      profiles: { profileId: string; request: { shell: string } }[]
    }
    expect(payload.profiles.map((entry) => entry.profileId)).toEqual(["build", ADHOC_PROFILE_ID])
    expect(payload.profiles.at(-1)?.request.shell).toBe("/bin/zsh")
  })
})
