/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { AlwaysOnWork } from "@/lib/remote-host/migration/candidates"

import { useAlwaysOnWork } from "./use-always-on-work"

jest.mock("@/lib/remote-host/migration/candidates", () => ({ loadAlwaysOnWork: jest.fn() }))

const empty: AlwaysOnWork = { local: [], movedHere: [], unfinished: [] }
const withTask: AlwaysOnWork = {
  ...empty,
  local: [{ ref: { kind: "scheduled-task", id: "t1" }, label: "Digest" }],
}

it("reads on mount and again on reload", async () => {
  const load = jest.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(withTask)
  const { result } = renderHook(() => useAlwaysOnWork("mini", { load }))
  await waitFor(() => expect(result.current.work).toEqual(empty))
  await act(() => result.current.reload())
  expect(result.current.work).toEqual(withTask)
  expect(load).toHaveBeenCalledWith("mini")
})

it("reads again when the window regains focus", async () => {
  const load = jest.fn().mockResolvedValue(empty)
  renderHook(() => useAlwaysOnWork("mini", { load }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
  })
  expect(load).toHaveBeenCalledTimes(2)
})

it("keeps the newest host's answer when an older read lands late", async () => {
  let resolveSlow: (value: AlwaysOnWork) => void = () => undefined
  const load = jest.fn((hostId: string) =>
    hostId === "old"
      ? new Promise<AlwaysOnWork>((resolve) => (resolveSlow = resolve))
      : Promise.resolve(withTask)
  )
  const { result, rerender } = renderHook(({ host }) => useAlwaysOnWork(host, { load }), {
    initialProps: { host: "old" },
  })
  rerender({ host: "new" })
  await waitFor(() => expect(result.current.work).toEqual(withTask))
  await act(async () => resolveSlow(empty))
  expect(result.current.work).toEqual(withTask)
})

it("reports a failed read", async () => {
  const load = jest.fn().mockRejectedValue(new Error("db closed"))
  const { result } = renderHook(() => useAlwaysOnWork("mini", { load }))
  await waitFor(() => expect(result.current.error).toBe("db closed"))
})
