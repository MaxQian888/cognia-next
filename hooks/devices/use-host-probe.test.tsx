/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import { useHostProbe } from "./use-host-probe"

function lease(environments: unknown, release = jest.fn()) {
  return {
    host: {} as never,
    release,
    transport: { call: jest.fn().mockResolvedValue(environments) } as never,
  }
}

it("stays idle until asked, so mounting the console dials nobody", () => {
  const acquire = jest.fn()
  renderHook(() => useHostProbe("h1", { acquire }))
  expect(acquire).not.toHaveBeenCalled()
})

it("reads the host's worktrees over its management channel", async () => {
  const release = jest.fn()
  const acquire = jest.fn().mockResolvedValue(lease([{ environmentId: "e1", path: "/w" }], release))
  const { result } = renderHook(() => useHostProbe("h1", { acquire }))

  act(() => result.current.probe())
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  expect(acquire).toHaveBeenCalledWith("h1")
  // A lease nobody gives back keeps the channel to that machine open for as
  // long as the console is mounted.
  expect(release).toHaveBeenCalled()
})

it("carries the failure verbatim rather than reporting an empty host", async () => {
  const acquire = jest.fn().mockRejectedValue(new Error("credential is unavailable"))
  const { result } = renderHook(() => useHostProbe("h1", { acquire }))

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
  const acquire = jest.fn().mockImplementation(async () => {
    await slow
    return lease([{ environmentId: "stale", path: "/stale" }])
  })

  const { result, rerender } = renderHook(({ host }) => useHostProbe(host, { acquire }), {
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
  const acquire = jest.fn()
  const { result } = renderHook(() => useHostProbe(null, { acquire }))
  act(() => result.current.probe())
  expect(acquire).not.toHaveBeenCalled()
})
