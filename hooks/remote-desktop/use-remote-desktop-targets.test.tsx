import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import type { RemoteDesktopTarget } from "@/lib/remote-desktop/types"

import { useRemoteDesktopTargets } from "./use-remote-desktop-targets"

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
  it("does nothing off the desktop shell", () => {
    const list = jest.fn()
    const { result } = renderHook(() => useRemoteDesktopTargets(false, { list }))
    expect(result.current.loading).toBe(false)
    expect(list).not.toHaveBeenCalled()
  })

  it("loads targets and surfaces a Host refusal", async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_storage_corrupt"))
      .mockResolvedValueOnce([target("a")])
    const { result } = renderHook(() => useRemoteDesktopTargets(true, { list }))
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
      useRemoteDesktopTargets(true, { list, save, setCredential })
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
    expect(setCredential.mock.calls).toEqual([
      ["a", "a-b", "control", "secret"],
      ["a", "a-b", "view", null],
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
      useRemoteDesktopTargets(true, { list, save, setCredential, remove })
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
    expect(remove).toHaveBeenCalledWith("a")
  })
})
