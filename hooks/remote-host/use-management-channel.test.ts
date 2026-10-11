/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import { useManagementChannel } from "./use-management-channel"

function lease(call: jest.Mock, release = jest.fn()) {
  return { host: {} as never, release, transport: { call, subscribe: jest.fn() } as never }
}

it("calls the host over its channel and gives the lease back", async () => {
  const call = jest.fn().mockResolvedValue({ ok: true })
  const release = jest.fn()
  const acquire = jest.fn().mockResolvedValue(lease(call, release))
  const { result } = renderHook(() => useManagementChannel("h1", { acquire }))
  await expect(result.current.call("host_capabilities", { a: 1 })).resolves.toEqual({ ok: true })
  expect(acquire).toHaveBeenCalledWith("h1")
  expect(call).toHaveBeenCalledWith("host_capabilities", { a: 1 })
  expect(release).toHaveBeenCalledTimes(1)
})

it("gives the lease back when the host refuses", async () => {
  const release = jest.fn()
  const acquire = jest
    .fn()
    .mockResolvedValue(lease(jest.fn().mockRejectedValue(new Error("refused")), release))
  const { result } = renderHook(() => useManagementChannel("h1", { acquire }))
  await expect(result.current.call("x")).rejects.toThrow("refused")
  expect(release).toHaveBeenCalledTimes(1)
})

it("refuses without dialling anything when no host is selected", async () => {
  const acquire = jest.fn()
  const { result } = renderHook(() => useManagementChannel(null, { acquire }))
  await expect(result.current.call("x")).rejects.toThrow("no remote host")
  expect(acquire).not.toHaveBeenCalled()
})
