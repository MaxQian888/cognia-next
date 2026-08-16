import {
  buildSynchronizedSshProfiles,
  buildSynchronizedTerminalProfiles,
  syncTerminalHostProfiles,
} from "./host-profiles"

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

  it("never synchronizes a jump chain or a tunnel to the terminal host", () => {
    // A synchronized profile is what a phone or LAN client names to get a
    // shell. Carrying forwarding here would let a remote client make the
    // desktop open a listening port, which ADR-0082 §8 forbids — so the
    // stripping is pinned rather than left to `sshHostToConnectRequest`
    // happening not to copy the fields.
    const [synchronized] = buildSynchronizedSshProfiles([
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

    expect(synchronized.request).not.toHaveProperty("jumpChain")
    expect(synchronized.request).not.toHaveProperty("localForwards")
    expect(synchronized.request).not.toHaveProperty("remoteForwards")
  })

  it("replaces the host profile set, including clearing deleted profiles", async () => {
    const call = jest.fn(async () => undefined)
    await syncTerminalHostProfiles([], {}, call as never)
    expect(call).toHaveBeenCalledWith("terminal_host_service", {
      action: { kind: "syncProfiles", profiles: [], sshProfiles: [] },
    })
  })
})
