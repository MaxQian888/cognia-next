/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import type {
  InspectionView,
  InstallerResult,
  OpenedView,
  PairView,
  StageEventPayload,
} from "@/lib/host-installer/client"
import { encodePairPayload } from "@/lib/qr/pair-payload"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

import { useHostInstall, type HostInstallDeps, type RunChoice } from "./use-host-install"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))
jest.mock("@/components/connectivity/pair/pair-api", () => ({ registerPairPayload: jest.fn() }))
const mockRecordRecentServer = jest.fn()
jest.mock("@/lib/connectivity/recent-servers", () => ({
  recordRecentServer: (...args: unknown[]) => mockRecordRecentServer(...args),
}))
const mockFileHost = jest.fn()
jest.mock("@/hooks/devices/use-register-paired-host", () => ({
  useRegisterPairedHost: () => ({ register: mockFileHost, dialog: null }),
}))

const profile: SshHostProfile = {
  id: "ssh-1",
  name: "Build box",
  host: "box.example.com",
  port: 22,
  username: "max",
  authMethod: "agent",
}

const opened: OpenedView = {
  sessionId: "hi-1",
  hostKeyStatus: "verified",
  hostKeyFingerprint: "SHA256:abc",
}

function inspection(id: string, offers: InspectionView["offers"]): InspectionView {
  return {
    inspectionId: id,
    os: "linux",
    arch: "x64",
    target: "linux-x64",
    hostname: "box",
    user: "max",
    dataDir: "/home/max/.local/share/cognia",
    serviceManager: "systemd",
    linger: true,
    glibc: "2.35",
    freeBytes: 10_000_000_000,
    existing: null,
    offers,
    notices: [],
  }
}

const SECRET = "one-time-secret"
const pairView: PairView = {
  invitation: encodePairPayload({
    baseUrl: "https://box.example:27890",
    mode: "owner-invitation",
    invitation: SECRET,
    hostId: "host-a",
    tenantId: "tenant-a",
    expiresAt: Date.now() + 600_000,
    serverVersion: "1.2.3",
    fingerprint: "deadbeef",
  }),
  hasRelay: false,
  expiresAtMs: Date.now() + 600_000,
}

const config = {
  baseUrl: "https://box.example:27890",
  deviceId: "device-1",
  serverVersion: "1.2.3",
  serverFingerprint: "deadbeef",
}
const filed = { id: "host-1", label: "Build box" } as RemoteHost

const ok = <T,>(value: T): InstallerResult<T> => ({ ok: true, value })

let stageHandler: ((event: StageEventPayload) => void) | null
function makeClient() {
  stageHandler = null
  const unlisten = jest.fn()
  return {
    unlisten,
    installerSshRequest: jest.fn(() => ({
      kind: "ok" as const,
      request: { host: "box" } as never,
    })),
    openSsh: jest.fn(async () => ok(opened)),
    inspectMachine: jest.fn(async () => ok(inspection("inst-1", ["fresh"]))),
    installHost: jest.fn(async () => ok({ version: "1.2.3", dataDir: "/d" })),
    pairHost: jest.fn(async () => ok(pairView)),
    uninstallHost: jest.fn(async () => ok(null)),
    closeSession: jest.fn(async () => undefined),
    onStage: jest.fn(async (_id: string, handler: (event: StageEventPayload) => void) => {
      stageHandler = handler
      return unlisten
    }),
  }
}

const choice = (overrides: Partial<RunChoice> = {}): RunChoice => ({
  plan: "fresh",
  channel: "stable",
  label: "Build box",
  alwaysOn: true,
  connectAfter: false,
  ...overrides,
})

function setup(client = makeClient(), extra: Partial<HostInstallDeps> = {}) {
  const register = jest.fn(async () => ({ kind: "ok" as const, config, path: "direct" }))
  const deps: HostInstallDeps = {
    client,
    registerPairPayload: register as unknown as HostInstallDeps["registerPairPayload"],
    credentialStoreReady: () => true,
    deviceName: async () => "Mac",
    now: () => 42,
    ...extra,
  }
  const hook = renderHook(() => useHostInstall(profile, [profile], deps))
  return { client, register, hook }
}

beforeEach(() => {
  mockFileHost.mockReset()
  mockFileHost.mockReturnValue(filed)
  mockRecordRecentServer.mockReset()
})

describe("useHostInstall", () => {
  it("dials, inspects, installs, pairs and files the Host bound to the profile", async () => {
    const { client, register, hook } = setup()
    await act(() => hook.result.current.connect())
    expect(client.openSsh).toHaveBeenCalledWith({ host: "box" })
    expect(hook.result.current.phase).toMatchObject({ kind: "ready", opened })

    let landInstall: (() => void) | undefined
    client.installHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landInstall = () => resolve(ok({ version: "1.2.3", dataDir: "/d" }))
        })
    )
    let running: Promise<void> | undefined
    act(() => {
      running = hook.result.current.run(choice({ channel: "beta" }))
    })
    await act(async () => undefined)
    act(() =>
      stageHandler?.({ sessionId: "hi-1", operationId: "inst-1", stage: "fetch", outcome: null })
    )
    // Another session's events never reach this hook (the client filters them),
    // and a stage the plan does not show changes nothing.
    act(() =>
      stageHandler?.({ sessionId: "hi-1", operationId: "inst-1", stage: "probe", outcome: "ok" })
    )
    expect(hook.result.current.phase).toMatchObject({
      kind: "running",
      plan: "fresh",
      progress: [
        { stage: "fetch", status: "running" },
        { stage: "upload", status: "pending" },
        { stage: "stage", status: "pending" },
        { stage: "service", status: "pending" },
        { stage: "pair", status: "pending" },
      ],
    })
    await act(async () => {
      landInstall?.()
      await running
    })

    expect(client.installHost).toHaveBeenCalledWith({
      sessionId: "hi-1",
      inspectionId: "inst-1",
      plan: "fresh",
      channel: "beta",
    })
    expect(client.pairHost).toHaveBeenCalledWith({
      sessionId: "hi-1",
      inspectionId: "inst-1",
      plan: "fresh",
      deviceName: "Mac",
    })
    expect(register).toHaveBeenCalledWith(pairView.invitation)
    expect(mockFileHost).toHaveBeenCalledWith(config, {
      label: "Build box",
      alwaysOn: true,
      connectAfter: false,
      installBinding: { kind: "ssh", profileId: "ssh-1", installedAt: 42 },
    })
    const phase = hook.result.current.phase
    expect(phase.kind).toBe("paired")
    if (phase.kind !== "paired") return
    expect(phase.host).toBe(filed)
    expect(phase.progress.every((entry) => entry.status === "done")).toBe(true)
    // The owner invitation never reaches render state.
    expect(JSON.stringify(phase)).not.toContain(SECRET)
    expect(JSON.stringify(phase)).not.toContain(pairView.invitation)
  })

  it("reports a profile that cannot be dialled without opening anything", async () => {
    const client = makeClient()
    client.installerSshRequest.mockReturnValueOnce({
      kind: "invalid",
      reason: "jumpChain",
    } as never)
    const { hook } = setup(client)
    await act(() => hook.result.current.connect())
    expect(hook.result.current.phase).toEqual({ kind: "invalid_profile", reason: "jumpChain" })
    expect(client.openSsh).not.toHaveBeenCalled()
  })

  it("asks to reconnect when the host key changed", async () => {
    const client = makeClient()
    client.openSsh.mockResolvedValueOnce({
      ok: false,
      failure: {
        kind: "host_key_changed",
        change: {
          host: "box",
          port: 22,
          knownFingerprint: "SHA256:old",
          presentedFingerprint: "SHA256:new",
        },
      },
    })
    const { hook } = setup(client)
    await act(() => hook.result.current.connect())
    expect(hook.result.current.phase).toMatchObject({
      kind: "failed",
      next: "reconnect",
      opened: null,
    })
  })

  it("never repeats a step whose outcome is unknown; it inspects again", async () => {
    const client = makeClient()
    client.installHost.mockResolvedValueOnce({
      ok: false,
      failure: { kind: "unknown", stage: "upload", message: "dropped" },
    })
    const { hook } = setup(client)
    await act(() => hook.result.current.connect())
    await act(() => hook.result.current.run(choice()))
    expect(hook.result.current.phase).toMatchObject({ kind: "failed", next: "reinspect" })

    // A retry has nothing to repeat once the plan must be chosen again.
    client.inspectMachine.mockResolvedValueOnce(ok(inspection("inst-2", ["repair", "uninstall"])))
    await act(() => hook.result.current.reinspect())
    await act(() => hook.result.current.retry())
    expect(client.installHost).toHaveBeenCalledTimes(1)
    expect(hook.result.current.phase).toMatchObject({
      kind: "ready",
      inspection: { inspectionId: "inst-2", offers: ["repair", "uninstall"] },
    })
  })

  it("retries only the pairing when the install already landed", async () => {
    const client = makeClient()
    client.pairHost.mockResolvedValueOnce({
      ok: false,
      failure: { kind: "fault", stage: "pair", message: "channel closed" },
    })
    const { hook } = setup(client)
    await act(() => hook.result.current.connect())
    await act(() => hook.result.current.run(choice()))
    const failed = hook.result.current.phase
    expect(failed).toMatchObject({ kind: "failed", next: "retry" })
    if (failed.kind === "failed") {
      expect(failed.progress.map((entry) => entry.status)).toEqual([
        "done",
        "done",
        "done",
        "done",
        "failed",
      ])
    }

    await act(() => hook.result.current.retry())
    expect(client.installHost).toHaveBeenCalledTimes(1)
    expect(client.pairHost).toHaveBeenCalledTimes(2)
    expect(hook.result.current.phase.kind).toBe("paired")
  })

  it("sends a registration failure back to inspection, since the invitation may be spent", async () => {
    const { client, register, hook } = setup()
    register.mockResolvedValueOnce({
      kind: "registration_error",
      message: "403",
      error: new Error("invitation already used"),
      baseUrl: config.baseUrl,
    } as never)
    await act(() => hook.result.current.connect())
    await act(() => hook.result.current.run(choice()))
    const phase = hook.result.current.phase
    expect(phase).toMatchObject({ kind: "failed", next: "reinspect", failure: { source: "pair" } })
    if (phase.kind === "failed")
      expect(phase.progress.at(-1)).toEqual({ stage: "pair", status: "failed" })
    expect(mockFileHost).not.toHaveBeenCalled()
    expect(client.pairHost).toHaveBeenCalledTimes(1)
  })

  it("refuses to redeem the invitation into a store that cannot keep the key", async () => {
    const { register, hook } = setup(makeClient(), { credentialStoreReady: () => false })
    await act(() => hook.result.current.connect())
    await act(() => hook.result.current.run(choice()))
    expect(hook.result.current.phase).toMatchObject({
      kind: "failed",
      failure: { source: "pair", failure: { kind: "vault_locked" } },
    })
    expect(register).not.toHaveBeenCalled()
  })

  it("re-pairs without installing", async () => {
    const client = makeClient()
    client.inspectMachine.mockResolvedValueOnce(ok(inspection("inst-1", ["re_pair"])))
    const { hook } = setup(client)
    await act(() => hook.result.current.connect())
    await act(() => hook.result.current.run(choice({ plan: "re_pair" })))
    expect(client.installHost).not.toHaveBeenCalled()
    expect(client.pairHost).toHaveBeenCalledWith(expect.objectContaining({ plan: "re_pair" }))
    expect(hook.result.current.phase).toMatchObject({
      kind: "paired",
      progress: [{ stage: "pair", status: "done" }],
    })
  })

  it("uninstalls, deleting data only with the typed machine name", async () => {
    const client = makeClient()
    client.inspectMachine.mockResolvedValue(ok(inspection("inst-1", ["uninstall"])))
    const { hook } = setup(client)
    await act(() => hook.result.current.connect())
    await act(() =>
      hook.result.current.run(choice({ plan: "uninstall", deleteDataConfirmation: "box" }))
    )
    expect(client.uninstallHost).toHaveBeenCalledWith({
      sessionId: "hi-1",
      inspectionId: "inst-1",
      deleteDataConfirmation: "box",
    })
    expect(hook.result.current.phase).toMatchObject({ kind: "uninstalled", dataDeleted: true })
    expect(client.pairHost).not.toHaveBeenCalled()
  })

  it("closes the session and stops listening on unmount", async () => {
    const { client, hook } = setup()
    await act(() => hook.result.current.connect())
    hook.unmount()
    expect(client.unlisten).toHaveBeenCalledTimes(1)
    expect(client.closeSession).toHaveBeenCalledWith("hi-1")
  })

  it("closes the previous session before dialling again", async () => {
    const { client, hook } = setup()
    await act(() => hook.result.current.connect())
    await act(() => hook.result.current.connect())
    expect(client.closeSession).toHaveBeenCalledWith("hi-1")
    expect(client.openSsh).toHaveBeenCalledTimes(2)
  })
})
