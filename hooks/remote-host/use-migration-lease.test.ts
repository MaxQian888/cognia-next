/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"

import { useMigrationLease } from "./use-migration-lease"

jest.mock("@/lib/remote-host/migration/service", () => ({
  requestMigrationLease: jest.fn(),
}))

const lease = (token: string, expiresAt: number) => ({ token, operations: [], expiresAt })

it("asks the host once and reuses the lease until it nears expiry", async () => {
  let now = 0
  const request = jest
    .fn()
    .mockResolvedValueOnce(lease("a", 120_000))
    .mockResolvedValueOnce(lease("b", 400_000))
  const { result } = renderHook(() => useMigrationLease("mini", { request, now: () => now }))
  await act(async () => expect(await result.current.acquire()).toBe("a"))
  await act(async () => expect(await result.current.acquire()).toBe("a"))
  now = 70_000
  await act(async () => expect(await result.current.acquire()).toBe("b"))
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenCalledWith("mini")
})

it("waits for a person at the host, then picks the lease up on the next try", async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(
      new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED (code K7Q2)", "K7Q2")
    )
    .mockResolvedValueOnce(lease("a", Date.now() + 600_000))
  const { result } = renderHook(() => useMigrationLease("mini", { request }))
  await act(async () => expect(await result.current.acquire()).toBeNull())
  expect(result.current.awaitingConsent).toEqual({ code: "K7Q2" })
  await act(async () => expect(await result.current.acquire()).toBe("a"))
  expect(result.current.awaitingConsent).toBeNull()
})

it("passes any other refusal on, and asks again after being told to forget", async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error("no route to host"))
    .mockResolvedValue(lease("a", Date.now() + 600_000))
  const { result } = renderHook(() => useMigrationLease("mini", { request }))
  await act(async () => {
    await expect(result.current.acquire()).rejects.toThrow("no route to host")
  })
  await act(async () => expect(await result.current.acquire()).toBe("a"))
  act(() => result.current.forget())
  await act(async () => expect(await result.current.acquire()).toBe("a"))
  expect(request).toHaveBeenCalledTimes(3)
})

it("refuses without a host", async () => {
  const request = jest.fn()
  const { result } = renderHook(() => useMigrationLease(null, { request }))
  await expect(result.current.acquire()).rejects.toThrow("no remote host")
  expect(request).not.toHaveBeenCalled()
})
