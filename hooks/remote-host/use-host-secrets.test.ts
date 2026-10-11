/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { HostSecretEntry } from "@/lib/remote-host/host-secrets"

import { useHostSecrets } from "./use-host-secrets"

jest.mock("@/lib/remote-host/host-secrets", () => ({ listHostSecrets: jest.fn() }))

const one: HostSecretEntry[] = [{ kind: "provider", name: "deepseek" }]

it("reads on mount and again on reload", async () => {
  const load = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(one)
  const { result } = renderHook(() => useHostSecrets("mini", { load }))
  await waitFor(() => expect(result.current.entries).toEqual([]))
  await act(() => result.current.reload())
  expect(result.current.entries).toEqual(one)
  expect(load).toHaveBeenCalledWith("mini")
})

it("reads nothing from a host that cannot answer", async () => {
  const load = jest.fn()
  const { result } = renderHook(() => useHostSecrets("mini", { load, enabled: false }))
  await act(async () => undefined)
  expect(load).not.toHaveBeenCalled()
  expect(result.current.entries).toBeNull()
})

it("says why a read failed and keeps the newest host's answer", async () => {
  let resolveSlow: (value: HostSecretEntry[]) => void = () => undefined
  const load = jest.fn((hostId: string) =>
    hostId === "old"
      ? new Promise<HostSecretEntry[]>((resolve) => (resolveSlow = resolve))
      : hostId === "broken"
        ? Promise.reject(new Error("no route"))
        : Promise.resolve(one)
  )
  const { result, rerender } = renderHook(({ id }) => useHostSecrets(id, { load }), {
    initialProps: { id: "old" },
  })
  rerender({ id: "new" })
  await waitFor(() => expect(result.current.entries).toEqual(one))
  await act(async () => resolveSlow([]))
  expect(result.current.entries).toEqual(one)
  rerender({ id: "broken" })
  await waitFor(() => expect(result.current.error).toBe("no route"))
})
