/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { SystemDetails } from "@/lib/perf/backend/types"

import { useHostSystem } from "./use-host-system"

const details = (os: string) => ({ os, osVersion: null, cpuCount: 2 }) as unknown as SystemDetails

it("reads the Host's details, and again when asked", async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(details("Ubuntu"))
    .mockResolvedValueOnce(details("Debian"))
  const { result } = renderHook(() => useHostSystem("host-1", load))
  await waitFor(() => expect(result.current.details?.os).toBe("Ubuntu"))
  expect(load).toHaveBeenCalledWith("host-1")
  expect(result.current.loading).toBe(false)

  await act(() => result.current.reload())
  expect(result.current.details?.os).toBe("Debian")
})

it("keeps the last details and reports a failed read", async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(details("Ubuntu"))
    .mockRejectedValueOnce(new Error("forbidden"))
  const { result } = renderHook(() => useHostSystem("host-1", load))
  await waitFor(() => expect(result.current.details).not.toBeNull())
  await act(() => result.current.reload())
  expect(result.current.error).toBe("forbidden")
  expect(result.current.details?.os).toBe("Ubuntu")
})

it("reads nothing without a Host, and drops a read for a Host it left", async () => {
  let finish: (value: SystemDetails) => void = () => undefined
  const load = jest.fn(() => new Promise<SystemDetails>((resolve) => (finish = resolve)))
  const { result, rerender } = renderHook(({ ref }) => useHostSystem(ref, load), {
    initialProps: { ref: "host-1" as string | null },
  })
  rerender({ ref: null })
  await act(async () => finish(details("Ubuntu")))
  expect(result.current.details).toBeNull()
  expect(load).toHaveBeenCalledTimes(1)
})
