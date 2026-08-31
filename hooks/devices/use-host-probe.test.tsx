/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import { useHostProbe } from "./use-host-probe"

function target(environments: unknown, close = jest.fn()) {
  return {
    host: {} as never,
    close,
    transport: { call: jest.fn().mockResolvedValue(environments) } as never,
  }
}

it("stays idle until asked, so mounting the console dials nobody", () => {
  const openTarget = jest.fn()
  renderHook(() => useHostProbe("h1", { openTarget }))
  expect(openTarget).not.toHaveBeenCalled()
})

it("reads the host's worktrees over its own transport", async () => {
  const close = jest.fn()
  const openTarget = jest
    .fn()
    .mockResolvedValue(target([{ environmentId: "e1", path: "/w" }], close))
  const { result } = renderHook(() => useHostProbe("h1", { openTarget }))

  act(() => result.current.probe())
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  expect(openTarget).toHaveBeenCalledWith("h1")
  // The transport is per-probe, so leaving it open would hold a live
  // connection to a remote machine for as long as the console is mounted.
  expect(close).toHaveBeenCalled()
})

it("carries the failure verbatim rather than reporting an empty host", async () => {
  const openTarget = jest.fn().mockRejectedValue(new Error("credential is unavailable"))
  const { result } = renderHook(() => useHostProbe("h1", { openTarget }))

  act(() => result.current.probe())
  await waitFor(() => expect(result.current.state.status).toBe("error"))
  expect(result.current.state).toMatchObject({ message: "credential is unavailable" })
})

/**
 * Probing A, switching to B and probing again would otherwise land A's
 * worktrees under B's name whenever A answered second.
 */
it("drops a result whose host is no longer selected", async () => {
  let release: (value: unknown) => void = () => {}
  const slow = new Promise((resolve) => {
    release = resolve
  })
  const openTarget = jest.fn().mockImplementation(async () => {
    await slow
    return target([{ environmentId: "stale", path: "/stale" }])
  })

  const { result, rerender } = renderHook(({ host }) => useHostProbe(host, { openTarget }), {
    initialProps: { host: "h1" as string | null },
  })
  act(() => result.current.probe())
  rerender({ host: "h2" })
  await act(async () => {
    release(undefined)
    await Promise.resolve()
  })

  expect(result.current.state.status).toBe("idle")
})

it("does nothing when there is no host to probe", () => {
  const openTarget = jest.fn()
  const { result } = renderHook(() => useHostProbe(null, { openTarget }))
  act(() => result.current.probe())
  expect(openTarget).not.toHaveBeenCalled()
})
