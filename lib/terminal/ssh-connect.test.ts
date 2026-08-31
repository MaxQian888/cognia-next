const registerLiveSession = jest.fn()
const wireSessionToStore = jest.fn()
const lifecycle = jest.fn()

jest.mock("./session-registry", () => ({
  registerLiveSession: (...args: unknown[]) => registerLiveSession(...args),
}))
const spawnFromDock = jest.fn()
jest.mock("./spawn-orchestrator", () => ({
  wireSessionToStore: (...args: unknown[]) => wireSessionToStore(...args),
  spawnFromDock: (...args: unknown[]) => spawnFromDock(...args),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchTerminalLifecycle: lifecycle }),
}))

import {
  connectSshFromDock,
  isUnknownHostProfileError,
  resolveSshHostLaunch,
  SSH_PROFILE_NOT_ON_HOST,
} from "./ssh-connect"
import type { SshHostProfile } from "./ssh-profiles"
import { SshTerminalSession } from "./ssh-session"

const profile: SshHostProfile = {
  id: "ssh-1",
  name: "Production",
  host: "prod.example.com",
  port: 22,
  username: "deploy",
  authMethod: "password",
  credentialRef: "ssh-1",
}

/**
 * The desktop chain, which is what every test below meant before the module
 * learned there was another one. Written out rather than left to the real
 * detector: under Node there is no Tauri marker, so the live chain is empty and
 * these would all short-circuit on "no terminal host".
 */
const LOCAL = () => ["tauri-channel" as const]
const REMOTE = () => ["ws" as const]

function store() {
  return {
    sessions: {},
    registerSession: jest.fn(),
    removeSession: jest.fn(),
    setSessionStatus: jest.fn(),
    setSessionExit: jest.fn(),
    setSessionCwd: jest.fn(),
    pushPrompt: jest.fn(),
    closePrompt: jest.fn(),
    pushCommand: jest.fn(),
  }
}

describe("connectSshFromDock", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("registers a connected SSH session with the existing terminal lifecycle", async () => {
    const terminalStore = store()
    const session = {
      id: "remote-1",
      info: {
        id: "remote-1",
        projectId: "project-1",
        extensionId: null,
        origin: "remote" as const,
        shell: "ssh deploy@prod.example.com",
      },
      profileId: "ssh-1",
      hostKeyStatus: "learned" as const,
      hostKeyFingerprint: "SHA256:abc",
    }
    const result = await connectSshFromDock({
      profile,
      allProfiles: [profile],
      rows: 30,
      cols: 100,
      projectId: "project-1",
      store: terminalStore,
      connect: jest.fn(async () => session as never),
      transportChain: LOCAL,
    })

    expect(result).toEqual({
      kind: "connected",
      sessionId: "remote-1",
      hostKeyStatus: "learned",
      hostKeyFingerprint: "SHA256:abc",
    })
    expect(registerLiveSession).toHaveBeenCalledWith(session)
    expect(terminalStore.registerSession).toHaveBeenCalledWith(session.info, {
      title: "Production",
    })
    expect(wireSessionToStore).toHaveBeenCalledWith(
      session,
      terminalStore,
      expect.objectContaining({ dispatchTerminalLifecycle: lifecycle })
    )
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "spawned", sessionId: "remote-1" })
    )
  })

  it("returns a validation error without opening a connection", async () => {
    const connect = jest.fn()
    const result = await connectSshFromDock({
      profile: { ...profile, host: "" },
      allProfiles: [profile],
      rows: 24,
      cols: 80,
      store: store(),
      connect,
      transportChain: LOCAL,
    })
    expect(result).toEqual({ kind: "error", message: "invalid SSH host profile: host" })
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([
    [new Error("network down"), "network down"],
    ["network down", "network down"],
  ])("returns connection failures without registering a session", async (error, message) => {
    const terminalStore = store()
    const result = await connectSshFromDock({
      profile,
      allProfiles: [profile],
      rows: 24,
      cols: 80,
      store: terminalStore,
      connect: jest.fn(async () => {
        throw error
      }),
      transportChain: LOCAL,
    })
    expect(result).toEqual({ kind: "error", message })
    expect(terminalStore.registerSession).not.toHaveBeenCalled()
  })

  it("uses the native session connector when no test connector is supplied", async () => {
    const connect = jest
      .spyOn(SshTerminalSession, "connect")
      .mockRejectedValueOnce(new Error("native unavailable"))
    await expect(
      connectSshFromDock({
        profile,
        allProfiles: [profile],
        rows: 24,
        cols: 80,
        store: store(),
        transportChain: LOCAL,
      })
    ).resolves.toEqual({ kind: "error", message: "native unavailable" })
    expect(connect).toHaveBeenCalled()
  })
})

/**
 * The path that was dormant. `TerminalHost::spawn_synchronized_profile` has
 * always accepted a non-local identity: a remote client names a profile id and
 * the host connects out of the `ssh_profiles` map its own desktop synced, which
 * is what ADR-0082 describes. Three UI gates are what made SSH look
 * desktop-only.
 */
describe("connectSshFromDock, through the host", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("sends the profile id and nothing else about the host", async () => {
    spawnFromDock.mockResolvedValue({ kind: "ok", sessionId: "remote-9" })
    const terminalStore = store()
    await connectSshFromDock({
      profile: { ...profile, jumpHostId: "bastion" },
      allProfiles: [profile],
      rows: 30,
      cols: 100,
      projectId: "project-1",
      store: terminalStore,
      transportChain: REMOTE,
    })

    const [call] = spawnFromDock.mock.calls
    expect(call[0].req).toEqual({
      profileId: "ssh-1",
      shell: "",
      rows: 30,
      cols: 100,
      projectId: "project-1",
    })
    // Not the address, not the port, not the jump chain, and above all not the
    // credential: the host resolves every one of them itself.
    expect(JSON.stringify(call[0].req)).not.toContain("prod.example.com")
    expect(JSON.stringify(call[0].req)).not.toContain("bastion")
  })

  it("labels the tab with the saved host rather than the host's shell", async () => {
    spawnFromDock.mockResolvedValue({ kind: "ok", sessionId: "remote-9" })
    await connectSshFromDock({
      profile,
      allProfiles: [profile],
      rows: 24,
      cols: 80,
      store: store(),
      transportChain: REMOTE,
    })
    expect(spawnFromDock).toHaveBeenCalledWith(expect.objectContaining({ title: "Production" }))
  })

  /**
   * The `/ws/terminal` frames carry no host-key fields. The host records the
   * verdict on its own session row and it never crosses the wire, so reporting
   * `learned` here would invent a trust decision nobody observed.
   */
  it("reports no host-key verdict, because the wire carries none", async () => {
    spawnFromDock.mockResolvedValue({ kind: "ok", sessionId: "remote-9" })
    await expect(
      connectSshFromDock({
        profile,
        allProfiles: [profile],
        rows: 24,
        cols: 80,
        store: store(),
        transportChain: REMOTE,
      })
    ).resolves.toEqual({
      kind: "connected",
      sessionId: "remote-9",
      hostKeyStatus: null,
      hostKeyFingerprint: null,
    })
  })

  /**
   * A host only knows the SSH profiles its own desktop renderer synced, and a
   * headless `cognia-server` has no renderer, so it has none. The bare native
   * string does not say whose list is being consulted.
   */
  it("rewords a profile the host does not hold, naming it", async () => {
    spawnFromDock.mockResolvedValue({ kind: "error", message: "unknown terminal profile: ssh-1" })
    await expect(
      connectSshFromDock({
        profile,
        allProfiles: [profile],
        rows: 24,
        cols: 80,
        store: store(),
        transportChain: REMOTE,
      })
    ).resolves.toEqual({
      kind: "error",
      message: `${SSH_PROFILE_NOT_ON_HOST}:Production`,
    })
  })

  it("passes every other host failure through untouched", async () => {
    spawnFromDock.mockResolvedValue({ kind: "error", message: "connection refused" })
    await expect(
      connectSshFromDock({
        profile,
        allProfiles: [profile],
        rows: 24,
        cols: 80,
        store: store(),
        transportChain: REMOTE,
      })
    ).resolves.toEqual({ kind: "error", message: "connection refused" })
  })

  it("reports a plugin veto as a refusal rather than a silent no-op", async () => {
    spawnFromDock.mockResolvedValue({ kind: "denied" })
    await expect(
      connectSshFromDock({
        profile,
        allProfiles: [profile],
        rows: 24,
        cols: 80,
        store: store(),
        transportChain: REMOTE,
      })
    ).resolves.toMatchObject({ kind: "error" })
  })

  /** SSH runs on a machine. With nothing paired there is no machine to run it. */
  it("refuses when no host can answer at all", async () => {
    await expect(
      connectSshFromDock({
        profile,
        allProfiles: [profile],
        rows: 24,
        cols: 80,
        store: store(),
        transportChain: () => [],
      })
    ).resolves.toMatchObject({ kind: "error" })
    expect(spawnFromDock).not.toHaveBeenCalled()
  })
})

describe("isUnknownHostProfileError", () => {
  it("matches the native wording regardless of case or surrounding text", () => {
    expect(isUnknownHostProfileError("unknown terminal profile: ssh-1")).toBe(true)
    expect(isUnknownHostProfileError("Error: Unknown Terminal Profile")).toBe(true)
  })

  it("does not claim every failure", () => {
    expect(isUnknownHostProfileError("connection refused")).toBe(false)
    expect(isUnknownHostProfileError("")).toBe(false)
  })
})

describe("resolveSshHostLaunch", () => {
  it("returns the saved host for a known id", () => {
    expect(resolveSshHostLaunch("ssh-1", [profile])).toEqual({ kind: "ready", profile })
  })

  it("reports an unknown id without inventing a profile", () => {
    expect(resolveSshHostLaunch("ssh-9", [profile])).toEqual({ kind: "unknownHost" })
    expect(resolveSshHostLaunch("ssh-1", undefined)).toEqual({ kind: "unknownHost" })
    expect(resolveSshHostLaunch("ssh-1", [])).toEqual({ kind: "unknownHost" })
  })

  it("refuses a password host that has never stored a credential", () => {
    // Callers reached by id have no secret field, so this would otherwise fail
    // deep in native code with an opaque keyring miss.
    expect(resolveSshHostLaunch("ssh-1", [{ ...profile, credentialRef: undefined }])).toEqual({
      kind: "credentialRequired",
      name: "Production",
    })
  })

  it("launches key and agent hosts that hold no credential", () => {
    const key: SshHostProfile = {
      ...profile,
      authMethod: "privateKey",
      privateKeyPath: "~/.ssh/id_ed25519",
      credentialRef: undefined,
    }
    const agent: SshHostProfile = {
      ...profile,
      authMethod: "agent",
      credentialRef: undefined,
    }
    expect(resolveSshHostLaunch("ssh-1", [key])).toEqual({ kind: "ready", profile: key })
    expect(resolveSshHostLaunch("ssh-1", [agent])).toEqual({ kind: "ready", profile: agent })
  })
})
