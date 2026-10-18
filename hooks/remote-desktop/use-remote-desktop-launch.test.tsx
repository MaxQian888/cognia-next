import { act, renderHook } from "@testing-library/react"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
jest.mock("@/lib/remote-host/management-channel", () => ({ withManagementChannel: jest.fn() }))

import type { RemoteDesktopBinding, RemoteDesktopTarget } from "@/lib/remote-desktop/types"

import { canLaunch, isLaunchable, useRemoteDesktopLaunch } from "./use-remote-desktop-launch"

function binding(overrides: Partial<RemoteDesktopBinding>): RemoteDesktopBinding {
  return {
    id: "b",
    providerId: "p",
    adapter: "none",
    priority: 0,
    enabled: true,
    endpoint: null,
    viewOnly: false,
    config: null,
    hasControlCredential: false,
    hasViewCredential: false,
    ...overrides,
  }
}

const consoleBinding = binding({
  access: "web-console",
  console: { url: "https://gw.lan/#/client/x", profile: "guacamole" },
})
const appBinding = binding({
  access: "external-app",
  launch: { launcher: "rustdesk", peerId: "123456789" },
})
const target: RemoteDesktopTarget = {
  id: "t",
  name: "Office",
  bindings: [consoleBinding, appBinding],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => push.mockReset())

describe("useRemoteDesktopLaunch", () => {
  it("knows which bindings open outside a session and when the list withheld how", () => {
    expect(isLaunchable(consoleBinding)).toBe(true)
    expect(isLaunchable(binding({ access: "bridge" }))).toBe(false)
    expect(isLaunchable(binding({}))).toBe(false)
    expect(canLaunch(consoleBinding)).toBe(true)
    expect(canLaunch(appBinding)).toBe(true)
    expect(canLaunch(binding({ access: "web-console", console: { profile: "generic" } }))).toBe(
      false
    )
    expect(canLaunch(binding({ access: "external-app", launch: { launcher: "rustdesk" } }))).toBe(
      false
    )
  })

  it("sends a desktop console to the viewer page without asking the Host yet", async () => {
    const launch = jest.fn()
    const { result } = renderHook(() =>
      useRemoteDesktopLaunch(
        { kind: "remote", hostRef: "companion:h" },
        { kind: "desktop", launch }
      )
    )
    await act(async () => {
      expect(await result.current.open(target, consoleBinding)).toBe("viewer")
    })
    expect(push).toHaveBeenCalledWith(
      "/devices/remote-desktop?target=t&binding=b&mode=control&host=companion%3Ah"
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it("asks the Host and opens the app or console elsewhere, tracking the pending binding", async () => {
    let resolve: (value: unknown) => void = () => undefined
    const launch = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const navigate = jest.fn()
    const { result } = renderHook(() =>
      useRemoteDesktopLaunch({ kind: "local" }, { kind: "web", launch: launch as never, navigate })
    )
    let outcome: Promise<string> = Promise.resolve("")
    act(() => {
      outcome = result.current.open(target, appBinding)
    })
    expect(result.current.pending).toBe("b")
    await act(async () => {
      resolve({
        kind: "external-app",
        launcher: "rustdesk",
        uri: "rustdesk://connection/new/123456789",
      })
      await outcome
    })
    await expect(outcome).resolves.toBe("app")
    expect(result.current.pending).toBeNull()
    expect(launch).toHaveBeenCalledWith({ kind: "local" }, { targetId: "t", bindingId: "b" })
  })

  it("passes a Host refusal to the caller", async () => {
    const launch = jest.fn().mockRejectedValue(new Error("remote_desktop_forbidden"))
    const { result } = renderHook(() =>
      useRemoteDesktopLaunch({ kind: "local" }, { kind: "phone", launch })
    )
    await act(async () => {
      await expect(result.current.open(target, consoleBinding)).rejects.toThrow(
        "remote_desktop_forbidden"
      )
    })
    expect(result.current.pending).toBeNull()
  })
})
