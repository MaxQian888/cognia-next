/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { useRegisterPairedHost } from "./use-register-paired-host"

const mockRequestSwitch = jest.fn()
jest.mock("@/hooks/devices/use-execution-host-switch", () => ({
  useExecutionHostSwitch: () => ({ requestSwitch: mockRequestSwitch, dialog: null }),
}))

const config: CompanionConfig = {
  baseUrl: "https://box.example:27890",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-key" },
  deviceKeyThumbprint: "device-thumbprint",
  deviceId: "device-1",
  serverVersion: "1.2.3",
  serverFingerprint: "sha256:paired-spki",
}

const filed = { id: "h1", label: "Build box" } as RemoteHost
const initial = useRemoteHostStore.getState()
const addHost = jest.fn(() => filed)

beforeEach(() => {
  addHost.mockClear()
  mockRequestSwitch.mockReset()
  useRemoteHostStore.setState({ ...initial, addHost }, true)
})

afterAll(() => useRemoteHostStore.setState(initial, true))

describe("useRegisterPairedHost", () => {
  it("files the Host with its label and switches to it, reporting once settled", async () => {
    let settle: (() => void) | undefined
    mockRequestSwitch.mockImplementation((_id: string, options: { onSettled: () => void }) => {
      settle = options.onSettled
      return Promise.resolve("confirming")
    })
    const onRegistered = jest.fn()
    const { result } = renderHook(() => useRegisterPairedHost())

    let returned: RemoteHost | undefined
    act(() => {
      returned = result.current.register(
        config,
        { label: "  Build box ", alwaysOn: false, connectAfter: true },
        onRegistered
      )
    })
    expect(returned).toBe(filed)
    expect(addHost).toHaveBeenCalledWith({ label: "Build box", config })
    expect(mockRequestSwitch).toHaveBeenCalledWith("h1", { onSettled: expect.any(Function) })
    // Filed, but the switch is still being answered.
    expect(onRegistered).not.toHaveBeenCalled()

    act(() => settle?.())
    expect(onRegistered).toHaveBeenCalledWith(filed)
  })

  it("never switches to an always-on Host and records where it was installed", () => {
    const onRegistered = jest.fn()
    const { result } = renderHook(() => useRegisterPairedHost())
    const installBinding = { kind: "ssh" as const, profileId: "ssh-1", installedAt: 5 }

    act(() => {
      result.current.register(
        config,
        { label: "", alwaysOn: true, connectAfter: true, installBinding },
        onRegistered
      )
    })
    expect(addHost).toHaveBeenCalledWith({
      label: undefined,
      config,
      alwaysOn: true,
      installBinding,
    })
    expect(mockRequestSwitch).not.toHaveBeenCalled()
    expect(onRegistered).toHaveBeenCalledWith(filed)
  })

  it("only files the Host when the window should not switch", () => {
    const onRegistered = jest.fn()
    const { result } = renderHook(() => useRegisterPairedHost())
    act(() => {
      result.current.register(
        config,
        { label: "Box", alwaysOn: false, connectAfter: false },
        onRegistered
      )
    })
    expect(mockRequestSwitch).not.toHaveBeenCalled()
    expect(onRegistered).toHaveBeenCalledWith(filed)
  })
})
