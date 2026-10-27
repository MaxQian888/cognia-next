let mockChain: string[] = ["tauri-channel"]
jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

import {
  ADHOC_PROFILE_ID,
  __resetTerminalHostProfileSyncForTests,
  buildSynchronizedSshProfiles,
  buildSynchronizedTerminalProfiles,
  ensureRemoteSpawnProfile,
  hasTransientTerminalProfile,
  registerTransientTerminalProfile,
  removeTransientTerminalProfile,
  syncTerminalHostProfiles,
} from "./host-profiles"

beforeEach(() => {
  mockChain = ["tauri-channel"]
  __resetTerminalHostProfileSyncForTests()
})

describe("transient user-launched terminal profiles", () => {
  const request = {
    profileId: "cognia-agent-terminal-freebuff",
    shell: "freebuff",
    args: [],
    cwd: "/workspace with spaces",
    rows: 24,
    cols: 80,
    enableShellIntegration: false,
    forceUtf8: false,
  }

  function deps() {
    return {
      call: jest.fn(async (_method: string, _payload: unknown) => undefined) as jest.Mock,
      readSettings: jest.fn(async () => ({
        terminal: { profiles: [{ id: "saved", name: "Saved", shell: "/bin/bash" }] },
      })),
      resolveTarget: jest.fn(async () => "original-host-and-account"),
    }
  }

  it("syncs the fixed executable/argv alongside saved profiles through the gated host API", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await expect(ensureRemoteSpawnProfile(request, sync)).resolves.toBe(request.profileId)
    expect(sync.call).toHaveBeenCalledWith("terminal_host_sync_profiles", {
      profiles: [
        expect.objectContaining({ profileId: "saved" }),
        { profileId: request.profileId, request },
      ],
    })
  })

  it("does not silently use a stale host profile if synchronization or capability checks fail", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    sync.call.mockRejectedValueOnce(new Error("terminal.open capability denied"))
    await expect(ensureRemoteSpawnProfile(request, sync)).rejects.toThrow(
      "terminal.open capability denied"
    )
    expect(hasTransientTerminalProfile(request.profileId)).toBe(true)
    await expect(ensureRemoteSpawnProfile(request, sync)).resolves.toBe(request.profileId)
  })

  it("synchronizes the policy-mutated workspace and sandbox request rather than its earlier draft", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await ensureRemoteSpawnProfile({ ...request, cwd: "/policy-approved", sandboxed: true }, sync)
    expect(sync.call).toHaveBeenCalledWith("terminal_host_sync_profiles", {
      profiles: [
        expect.anything(),
        {
          profileId: request.profileId,
          request: expect.objectContaining({
            cwd: "/policy-approved",
            sandboxed: true,
            enableShellIntegration: false,
          }),
        },
      ],
    })
  })

  it("serializes device-scoped profile replacements so concurrent agents preserve each other", async () => {
    mockChain = ["ws"]
    const sync = deps()
    let active = 0
    let maximum = 0
    sync.call.mockImplementation(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
    })
    const other = { ...request, profileId: "cognia-agent-terminal-zcode", shell: "zcode" }
    registerTransientTerminalProfile(request)
    registerTransientTerminalProfile(other)
    await Promise.all([
      ensureRemoteSpawnProfile(request, sync),
      ensureRemoteSpawnProfile(other, sync),
    ])
    expect(maximum).toBe(1)
    const last = sync.call.mock.calls.at(-1)![1] as { profiles: { profileId: string }[] }
    expect(last.profiles.map((profile) => profile.profileId)).toEqual([
      "saved",
      request.profileId,
      other.profileId,
    ])
  })

  it("removes only transient metadata and retains failed cleanup for retry", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await ensureRemoteSpawnProfile(request, sync)
    sync.call.mockRejectedValueOnce(new Error("host offline"))
    await expect(removeTransientTerminalProfile(request.profileId, sync)).rejects.toThrow(
      "host offline"
    )
    expect(hasTransientTerminalProfile(request.profileId)).toBe(true)
    await expect(ensureRemoteSpawnProfile(request, sync)).rejects.toThrow("cleanup is pending")
    await removeTransientTerminalProfile(request.profileId, sync)
    expect(hasTransientTerminalProfile(request.profileId)).toBe(false)
    expect(sync.call).toHaveBeenLastCalledWith("terminal_host_sync_profiles", {
      profiles: [expect.objectContaining({ profileId: "saved" })],
    })
  })

  it("refuses profile cleanup on a different host/account and succeeds after returning", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await ensureRemoteSpawnProfile(request, sync)
    sync.resolveTarget.mockResolvedValueOnce("different-host-or-account")
    await expect(removeTransientTerminalProfile(request.profileId, sync)).rejects.toThrow(
      "original terminal host"
    )
    expect(sync.call).toHaveBeenCalledTimes(1)
    expect(hasTransientTerminalProfile(request.profileId)).toBe(true)
    await removeTransientTerminalProfile(request.profileId, sync)
    expect(hasTransientTerminalProfile(request.profileId)).toBe(false)
  })

  it("rechecks the host after asynchronously loading settings before sending launch metadata", async () => {
    mockChain = ["ws"]
    const sync = deps()
    let target = "original-host-and-account"
    sync.resolveTarget.mockImplementation(async () => target)
    const saved = await sync.readSettings()
    sync.readSettings.mockImplementationOnce(async () => {
      target = "different-host-or-account"
      return saved
    })
    registerTransientTerminalProfile(request)
    await expect(ensureRemoteSpawnProfile(request, sync)).rejects.toThrow("original terminal host")
    expect(sync.call).not.toHaveBeenCalled()
  })

  it("does not override a saved profile or accept an ambiguous identity", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile({ ...request, profileId: "saved" })
    await expect(
      ensureRemoteSpawnProfile({ ...request, profileId: "saved" }, sync)
    ).rejects.toThrow("conflicts with a saved profile")
    expect(sync.call).not.toHaveBeenCalled()
    for (const profileId of [undefined, "default", ADHOC_PROFILE_ID]) {
      expect(() => registerTransientTerminalProfile({ ...request, profileId })).toThrow(
        "distinct identity"
      )
    }
  })

  it("cleans a local profile without contacting another host", async () => {
    const sync = deps()
    registerTransientTerminalProfile(request)
    await removeTransientTerminalProfile(request.profileId, sync)
    expect(sync.call).not.toHaveBeenCalled()
    expect(sync.resolveTarget).not.toHaveBeenCalled()
    expect(hasTransientTerminalProfile(request.profileId)).toBe(false)
  })
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
