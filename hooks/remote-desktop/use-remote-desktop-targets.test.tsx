import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
jest.mock("@/lib/remote-host/management-channel", () => ({ withManagementChannel: jest.fn() }))

import type { RemoteDesktopHostRef, RemoteDesktopTarget } from "@/lib/remote-desktop/types"

import { remoteDesktopHostKey, useRemoteDesktopTargets } from "./use-remote-desktop-targets"

const local: RemoteDesktopHostRef = { kind: "local" }

const target = (id: string): RemoteDesktopTarget => ({
  id,
  name: id,
  bindings: [
    {
      id: `${id}-b`,
      providerId: "p.vnc",
      adapter: "vnc",
      priority: 0,
      enabled: true,
      endpoint: {
        host: "h",
        port: 5900,
        pinnedIp: "192.168.1.2",
        class: "private",
        confirmedAt: 1,
      },
      viewOnly: true,
      config: null,
      hasControlCredential: false,
      hasViewCredential: false,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
})

describe("useRemoteDesktopTargets", () => {
  it("does nothing without a Host to ask", () => {
    const list = jest.fn()
    const { result } = renderHook(() => useRemoteDesktopTargets(null, { list }))
    expect(result.current.loading).toBe(false)
    expect(result.current.host).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it("keys a Host by its ref, not the object it arrives in", async () => {
    expect(remoteDesktopHostKey(null)).toBeNull()
    expect(remoteDesktopHostKey(local)).toBe("local")
    expect(remoteDesktopHostKey({ kind: "remote", hostRef: "companion:h" })).toBe(
      "remote:companion:h"
    )
    const list = jest.fn().mockResolvedValue([])
    const { result, rerender } = renderHook(
      ({ hostRef }: { hostRef: string }) =>
        useRemoteDesktopTargets({ kind: "remote", hostRef }, { list }),
      { initialProps: { hostRef: "companion:h" } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ hostRef: "companion:h" })
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith({ kind: "remote", hostRef: "companion:h" })
    rerender({ hostRef: "companion:other" })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(list).toHaveBeenLastCalledWith({ kind: "remote", hostRef: "companion:other" })
  })

  it("loads targets and surfaces a Host refusal", async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_storage_corrupt"))
      .mockResolvedValueOnce([target("a")])
    const { result } = renderHook(() => useRemoteDesktopTargets(local, { list }))
    await waitFor(() => expect(result.current.error?.code).toBe("remote_desktop_storage_corrupt"))
    await act(() => result.current.reload())
    expect(result.current.error).toBeNull()
    expect(result.current.targets.map((entry) => entry.id)).toEqual(["a"])
  })

  it("stores credentials after the target and reports one that failed", async () => {
    const saved = target("a")
    const save = jest.fn().mockResolvedValue(saved)
    const setCredential = jest
      .fn()
      .mockResolvedValueOnce({ ...saved, name: "after control" })
      .mockRejectedValueOnce(new Error("remote_desktop_credential_unavailable"))
    const list = jest.fn().mockResolvedValue([saved])
    const { result } = renderHook(() =>
      useRemoteDesktopTargets(local, { list, save, setCredential })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    let outcome: Awaited<ReturnType<typeof result.current.saveTarget>> | undefined
    await act(async () => {
      outcome = await result.current.saveTarget({
        draft: { name: "a", bindings: [] },
        bindingOf: (value) => value.bindings[0],
        control: "secret",
        view: null,
      })
    })
    expect(save).toHaveBeenCalledWith(local, { name: "a", bindings: [] })
    expect(setCredential.mock.calls).toEqual([
      [local, "a", "a-b", "control", "secret"],
      [local, "a", "a-b", "view", null],
    ])
    expect(outcome?.target.name).toBe("after control")
    expect(outcome?.credentialError?.code).toBe("remote_desktop_credential_unavailable")
  })

  it("keeps an untouched credential and deletes through the Host", async () => {
    const save = jest.fn().mockResolvedValue(target("a"))
    const setCredential = jest.fn()
    const remove = jest.fn().mockResolvedValue(undefined)
    const list = jest.fn().mockResolvedValue([])
    const { result } = renderHook(() =>
      useRemoteDesktopTargets(local, { list, save, setCredential, remove })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.saveTarget({
        draft: { name: "a", bindings: [] },
        bindingOf: () => undefined,
      })
      await result.current.deleteTarget("a")
    })
    expect(setCredential).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith(local, "a")
  })
})
