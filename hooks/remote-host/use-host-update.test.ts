/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { HostUpdateUnsupportedError, type HostUpdateStatus } from "@/lib/remote-host/host-update"

import { useHostUpdate } from "./use-host-update"

const status = (overrides: Partial<HostUpdateStatus> = {}): HostUpdateStatus => ({
  install: "native",
  currentVersion: "1.4.0",
  channel: "stable",
  autoUpdate: true,
  phase: "available",
  available: { version: "1.5.0", criticality: "routine" },
  installRequested: false,
  ...overrides,
})

describe("useHostUpdate", () => {
  it("reads the host's status, and nothing without a host", async () => {
    const read = jest.fn(async () => status())
    const { result, rerender } = renderHook(({ id }) => useHostUpdate(id, { read }), {
      initialProps: { id: "mini" as string | null },
    })
    await waitFor(() => expect(result.current.status?.available?.version).toBe("1.5.0"))
    expect(read).toHaveBeenCalledWith("mini")
    rerender({ id: null })
    await waitFor(() => expect(result.current.status).toBeNull())
  })

  it("marks a host from before self-update, and keeps other failures as messages", async () => {
    const tooOld = async (): Promise<HostUpdateStatus> => {
      throw new HostUpdateUnsupportedError()
    }
    const unsupported = renderHook(() => useHostUpdate("old", { read: tooOld }))
    await waitFor(() => expect(unsupported.result.current.unsupported).toBe(true))
    const unreachable = async (): Promise<HostUpdateStatus> => {
      throw new Error("unreachable")
    }
    const offline = renderHook(() => useHostUpdate("off", { read: unreachable }))
    await waitFor(() => expect(offline.result.current.error).toBe("unreachable"))
  })

  it("reads again while the host is moving, and stops once it settles", async () => {
    jest.useFakeTimers()
    try {
      const answers = [
        status({ phase: "downloading" }),
        status({ phase: "installing" }),
        status({ phase: "idle", available: undefined, currentVersion: "1.5.0" }),
      ]
      const read = jest.fn(async () => answers.shift() ?? status({ phase: "idle" }))
      const { result } = renderHook(() => useHostUpdate("mini", { read, pollMs: 1000 }))
      await act(async () => {})
      expect(result.current.status?.phase).toBe("downloading")
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })
      expect(result.current.status?.currentVersion).toBe("1.5.0")
      const reads = read.mock.calls.length
      await act(async () => {
        jest.advanceTimersByTime(5000)
      })
      expect(read.mock.calls.length).toBe(reads)
    } finally {
      jest.useRealTimers()
    }
  })

  it("takes each action's answer as the new status and reports a refusal", async () => {
    const install = jest.fn(async () =>
      status({ installRequested: true, phase: "waiting-for-idle" })
    )
    const configure = jest.fn(async () => status({ channel: "beta" }))
    const refresh = jest.fn(async () => {
      throw new Error("no catalog is published for the beta channel")
    })
    // Stable deps, as callers pass them: a new function per render re-reads.
    const read = async () => status()
    const { result } = renderHook(() =>
      useHostUpdate("mini", { read, install, configure, refresh })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    await act(async () => {
      expect(await result.current.install()).toBeNull()
    })
    expect(result.current.status?.phase).toBe("waiting-for-idle")
    await act(async () => {
      expect(await result.current.configure({ channel: "beta" })).toBeNull()
    })
    expect(configure).toHaveBeenCalledWith("mini", { channel: "beta" })
    expect(result.current.status?.channel).toBe("beta")
    await act(async () => {
      expect(await result.current.refresh()).toMatch(/no catalog/)
    })
    expect(result.current.pending).toBeNull()
  })
})
