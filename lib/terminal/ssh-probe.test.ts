import { probeSshHost } from "./ssh-probe"
import type { SshHostProfile } from "./ssh-profiles"
import type { SshTerminalSession } from "./ssh-session"

const TARGET: SshHostProfile = {
  id: "s1",
  name: "prod-web-01",
  host: "10.0.4.21",
  port: 22,
  username: "deploy",
  authMethod: "agent",
}

function fakeSession(overrides: Partial<SshTerminalSession> = {}) {
  return {
    hostKeyStatus: "verified" as const,
    hostKeyFingerprint: "SHA256:abc",
    kill: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SshTerminalSession
}

describe("probeSshHost", () => {
  it("reports the host key verdict a connection actually returned", async () => {
    const connect = jest.fn().mockResolvedValue(fakeSession())
    await expect(
      probeSshHost({ profile: TARGET, allProfiles: [TARGET], connect })
    ).resolves.toEqual({
      kind: "reachable",
      hostKeyStatus: "verified",
      hostKeyFingerprint: "SHA256:abc",
    })
  })

  /**
   * A test that opens a tunnel has changed the machine it was only supposed to
   * ask about, so the rules are dropped before the request is built rather
   * than filtered somewhere downstream.
   */
  it("never binds a port, even for a host whose forwards are all enabled", async () => {
    const connect = jest.fn().mockResolvedValue(fakeSession())
    await probeSshHost({
      profile: {
        ...TARGET,
        localForwards: [
          { id: "l1", localPort: 8080, remoteHost: "db.internal", remotePort: 5432, enabled: true },
        ],
        remoteForwards: [
          { id: "r1", remotePort: 9000, localHost: "localhost", localPort: 3000, enabled: true },
        ],
      },
      allProfiles: [TARGET],
      connect,
    })
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ localForwards: [], remoteForwards: [] })
    )
  })

  /**
   * A bastion-backed host that only answers direct is not reachable, so
   * probing the target alone would report a success the user cannot use.
   */
  it("dials the whole jump chain rather than the target alone", async () => {
    const bastion: SshHostProfile = {
      ...TARGET,
      id: "s0",
      name: "bastion",
      host: "edge.example",
      username: "jump",
    }
    const connect = jest.fn().mockResolvedValue(fakeSession())
    await probeSshHost({
      profile: { ...TARGET, jumpHostId: "s0" },
      allProfiles: [bastion, TARGET],
      connect,
    })
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        jumpChain: [expect.objectContaining({ host: "edge.example", username: "jump" })],
      })
    )
  })

  it("kills the session it opened, so a passing test leaves no shell behind", async () => {
    const kill = jest.fn().mockResolvedValue(undefined)
    const connect = jest.fn().mockResolvedValue(fakeSession({ kill }))
    await probeSshHost({ profile: TARGET, allProfiles: [TARGET], connect })
    expect(kill).toHaveBeenCalledTimes(1)
  })

  /** The answer is already in hand, so cleanup failing must not lose it. */
  it("still reports reachable when the cleanup kill fails", async () => {
    const connect = jest
      .fn()
      .mockResolvedValue(fakeSession({ kill: jest.fn().mockRejectedValue(new Error("gone")) }))
    await expect(
      probeSshHost({ profile: TARGET, allProfiles: [TARGET], connect })
    ).resolves.toMatchObject({ kind: "reachable" })
  })

  it("carries the native failure verbatim, because the message is the diagnosis", async () => {
    const connect = jest.fn().mockRejectedValue(new Error("connection refused"))
    await expect(
      probeSshHost({ profile: TARGET, allProfiles: [TARGET], connect })
    ).resolves.toEqual({ kind: "unreachable", message: "connection refused" })
  })

  /**
   * A profile that cannot produce a request is not an unreachable machine. The
   * host may be perfectly healthy, and the remedy is in Settings rather than
   * on the box, so the two answers stay apart.
   */
  it("separates an unbuildable profile from an unreachable host", async () => {
    const connect = jest.fn()
    await expect(
      probeSshHost({ profile: { ...TARGET, host: "" }, allProfiles: [TARGET], connect })
    ).resolves.toMatchObject({ kind: "invalid" })
    expect(connect).not.toHaveBeenCalled()
  })

  it("refuses a jump chain it cannot walk instead of probing direct", async () => {
    const connect = jest.fn()
    await expect(
      probeSshHost({
        profile: { ...TARGET, jumpHostId: "gone" },
        allProfiles: [TARGET],
        connect,
      })
    ).resolves.toEqual({ kind: "invalid", reason: "jumpChain" })
    expect(connect).not.toHaveBeenCalled()
  })
})
