const registerLiveSession = jest.fn()
const wireSessionToStore = jest.fn()
const lifecycle = jest.fn()

jest.mock("./session-registry", () => ({
  registerLiveSession: (...args: unknown[]) => registerLiveSession(...args),
}))
jest.mock("./spawn-orchestrator", () => ({
  wireSessionToStore: (...args: unknown[]) => wireSessionToStore(...args),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchTerminalLifecycle: lifecycle }),
}))

import { connectSshFromDock } from "./ssh-connect"
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
      rows: 30,
      cols: 100,
      projectId: "project-1",
      store: terminalStore,
      connect: jest.fn(async () => session as never),
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
      rows: 24,
      cols: 80,
      store: store(),
      connect,
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
      rows: 24,
      cols: 80,
      store: terminalStore,
      connect: jest.fn(async () => {
        throw error
      }),
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
        rows: 24,
        cols: 80,
        store: store(),
      })
    ).resolves.toEqual({ kind: "error", message: "native unavailable" })
    expect(connect).toHaveBeenCalled()
  })
})
