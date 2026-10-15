/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import {
  HostRuntimesUnavailableError,
  type HostRuntime,
  type HostRuntimes,
} from "@/lib/remote-host/host-runtimes"

import { useHostRuntimes } from "./use-host-runtimes"

const runtime = (overrides: Partial<HostRuntime> = {}): HostRuntime => ({
  name: "room-runner",
  state: "failed",
  error: "no backend",
  restartable: true,
  restarts: 0,
  ...overrides,
})

describe("useHostRuntimes", () => {
  it("reads the host's runtimes, and nothing without a host", async () => {
    const read = jest.fn(async (): Promise<HostRuntimes> => ({ runtimes: [runtime()] }))
    const { result, rerender } = renderHook(({ ref }) => useHostRuntimes(ref, { read }), {
      initialProps: { ref: "host-1" as string | null },
    })
    await waitFor(() => expect(result.current.runtimes).toEqual([runtime()]))
    expect(read).toHaveBeenCalledWith("host-1")
    rerender({ ref: null })
    await waitFor(() => expect(result.current.runtimes).toBeNull())
  })

  it("names why a host cannot report runtimes, and keeps other failures as messages", async () => {
    const desktop = async (): Promise<HostRuntimes> => {
      throw new HostRuntimesUnavailableError("not-headless")
    }
    const unavailable = renderHook(() => useHostRuntimes("desk", { read: desktop }))
    await waitFor(() => expect(unavailable.result.current.unavailable).toBe("not-headless"))
    const offline = async (): Promise<HostRuntimes> => {
      throw new Error("unreachable")
    }
    const failing = renderHook(() => useHostRuntimes("off", { read: offline }))
    await waitFor(() => expect(failing.result.current.error).toBe("unreachable"))
    expect(failing.result.current.unavailable).toBeNull()
  })

  it("restarts one runtime and shows the host's answer", async () => {
    const read = jest.fn(async (): Promise<HostRuntimes> => ({ runtimes: [runtime()] }))
    let release: (value: HostRuntimes) => void = () => undefined
    const restart = jest.fn(
      (_ref: string, _name: string) =>
        new Promise<HostRuntimes>((resolve) => {
          release = resolve
        })
    )
    const { result } = renderHook(() => useHostRuntimes("host-1", { read, restart }))
    await waitFor(() => expect(result.current.runtimes).not.toBeNull())

    let outcome: Promise<{ runtime?: HostRuntime; error?: string }> = Promise.resolve({})
    act(() => {
      outcome = result.current.restart("room-runner")
    })
    expect(result.current.restarting).toBe("room-runner")
    const after = runtime({ state: "running", error: undefined, restarts: 1 })
    await act(async () => {
      release({ runtime: after, runtimes: [after] })
      await outcome
    })
    await expect(outcome).resolves.toEqual({ runtime: after })
    expect(restart).toHaveBeenCalledWith("host-1", "room-runner")
    expect(result.current.restarting).toBeNull()
    expect(result.current.runtimes).toEqual([after])
  })

  it("returns a refused restart as a message and keeps the list", async () => {
    const read = async (): Promise<HostRuntimes> => ({ runtimes: [runtime()] })
    const restart = async (): Promise<HostRuntimes> => {
      throw new Error("no teardown")
    }
    const { result } = renderHook(() => useHostRuntimes("host-1", { read, restart }))
    await waitFor(() => expect(result.current.runtimes).not.toBeNull())
    let outcome: { error?: string } = {}
    await act(async () => {
      outcome = await result.current.restart("room-runner")
    })
    expect(outcome).toEqual({ error: "no teardown" })
    expect(result.current.runtimes).toEqual([runtime()])
  })

  it("reads again while a runtime is restarting", async () => {
    jest.useFakeTimers()
    try {
      const read = jest
        .fn<Promise<HostRuntimes>, [string]>()
        .mockResolvedValueOnce({ runtimes: [runtime({ state: "restarting", restartable: false })] })
        .mockResolvedValue({ runtimes: [runtime({ state: "running", error: undefined })] })
      const { result } = renderHook(() => useHostRuntimes("host-1", { read, pollMs: 1000 }))
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.runtimes?.[0].state).toBe("restarting")
      await act(async () => {
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(read).toHaveBeenCalledTimes(2)
      expect(result.current.runtimes?.[0].state).toBe("running")
    } finally {
      jest.useRealTimers()
    }
  })
})
