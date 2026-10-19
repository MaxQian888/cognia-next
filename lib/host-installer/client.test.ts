import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

import {
  HOST_INSTALLER_STAGE_EVENT,
  closeSession,
  inspectMachine,
  installHost,
  installerSshRequest,
  onStage,
  openSsh,
  pairHost,
  toInstallerFailure,
  uninstallHost,
  type StageEventPayload,
} from "./client"

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock

beforeEach(() => {
  mockInvoke.mockReset()
  mockListen.mockReset()
})

const profile: SshHostProfile = {
  id: "ssh-1",
  name: "Build box",
  host: "box.example.com",
  port: 22,
  username: "max",
  authMethod: "agent",
  jumpHostId: "ssh-2",
  localForwards: [
    { id: "l1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80, enabled: true },
  ],
  remoteForwards: [],
}

const bastion: SshHostProfile = {
  id: "ssh-2",
  name: "Bastion",
  host: "bastion.example.com",
  port: 2222,
  username: "jump",
  authMethod: "agent",
}

describe("installerSshRequest", () => {
  it("resolves the jump chain and strips every forward at the source", () => {
    const built = installerSshRequest(profile, [profile, bastion])
    expect(built.kind).toBe("ok")
    if (built.kind !== "ok") return
    expect(built.request.host).toBe("box.example.com")
    expect(built.request.jumpChain?.map((hop) => hop.host)).toEqual(["bastion.example.com"])
    expect(built.request.localForwards ?? []).toEqual([])
    expect(built.request.remoteForwards ?? []).toEqual([])
  })

  it("reports a profile that cannot produce a request", () => {
    expect(installerSshRequest({ ...profile, host: "" }, [profile, bastion])).toEqual({
      kind: "invalid",
      reason: "host",
    })
    expect(installerSshRequest(profile, [profile])).toEqual({
      kind: "invalid",
      reason: "jumpChain",
    })
  })
})

describe("commands", () => {
  it("calls each command with the native argument names", async () => {
    mockInvoke.mockResolvedValue({ sessionId: "hi-1" })
    const built = installerSshRequest(profile, [profile, bastion])
    if (built.kind !== "ok") throw new Error("request")

    await openSsh(built.request)
    await inspectMachine("hi-1")
    await installHost({ sessionId: "hi-1", inspectionId: "inst-1", plan: "fresh", channel: "beta" })
    await pairHost({ sessionId: "hi-1", inspectionId: "inst-1", plan: "fresh", deviceName: "Mac" })
    await uninstallHost({
      sessionId: "hi-1",
      inspectionId: "inst-1",
      deleteDataConfirmation: "box",
    })
    await closeSession("hi-1")

    expect(mockInvoke.mock.calls).toEqual([
      ["host_installer_ssh_open", { request: built.request }],
      ["host_installer_inspect", { sessionId: "hi-1" }],
      [
        "host_installer_install",
        {
          args: {
            sessionId: "hi-1",
            inspectionId: "inst-1",
            plan: "fresh",
            choice: { channel: "beta", localAccountId: null },
          },
        },
      ],
      [
        "host_installer_pair",
        { sessionId: "hi-1", inspectionId: "inst-1", plan: "fresh", deviceName: "Mac" },
      ],
      [
        "host_installer_uninstall",
        { sessionId: "hi-1", inspectionId: "inst-1", deleteDataConfirmation: "box" },
      ],
      ["host_installer_close", { sessionId: "hi-1" }],
    ])
  })

  it("returns the value, or the native failure as data", async () => {
    mockInvoke.mockResolvedValueOnce({ inspectionId: "inst-1" })
    await expect(inspectMachine("hi-1")).resolves.toEqual({
      ok: true,
      value: { inspectionId: "inst-1" },
    })

    const unknown = { kind: "unknown", stage: "upload", message: "dropped" }
    mockInvoke.mockRejectedValueOnce(unknown)
    await expect(inspectMachine("hi-1")).resolves.toEqual({ ok: false, failure: unknown })

    mockInvoke.mockRejectedValueOnce(new Error("command not found"))
    await expect(inspectMachine("hi-1")).resolves.toEqual({
      ok: false,
      failure: { kind: "ipc", message: "command not found" },
    })
  })
})

describe("toInstallerFailure", () => {
  it("keeps a native failure and wraps anything else", () => {
    expect(toInstallerFailure({ kind: "busy" })).toEqual({ kind: "busy" })
    expect(toInstallerFailure({ kind: "made_up" })).toEqual({
      kind: "ipc",
      message: "[object Object]",
    })
    expect(toInstallerFailure("text")).toEqual({ kind: "ipc", message: "text" })
  })
})

describe("onStage", () => {
  it("delivers only its own session's stage events and unsubscribes", async () => {
    const unlisten = jest.fn()
    mockListen.mockResolvedValue(unlisten)
    const handler = jest.fn()

    const stop = await onStage("hi-1", handler)
    expect(mockListen).toHaveBeenCalledWith(HOST_INSTALLER_STAGE_EVENT, expect.any(Function))
    const deliver = mockListen.mock.calls[0][1] as (message: { payload: StageEventPayload }) => void
    const mine: StageEventPayload = {
      sessionId: "hi-1",
      operationId: "inst-1",
      stage: "upload",
      outcome: null,
    }
    deliver({ payload: mine })
    deliver({ payload: { ...mine, sessionId: "hi-2" } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(mine)

    stop()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
