/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

const redetectWranglerBinary = jest.fn(async () => ({
  path: "/new/wrangler",
  version: "4",
  ready: true,
}))
jest.mock("@/lib/sites/wrangler-detect", () => ({
  detectWranglerBinary: jest.fn(),
  ensureWranglerApproved: jest.fn(),
  redetectWranglerBinary: (...args: unknown[]) => redetectWranglerBinary(...args),
}))

import { useWranglerDetection } from "./use-wrangler-detection"

const FOUND = { path: "/bin/wrangler", version: "3", ready: true }

function deps(overrides: Record<string, unknown> = {}) {
  return {
    detect: jest.fn(async () => FOUND),
    approve: jest.fn(async () => FOUND),
    ...overrides,
  } as never
}

beforeEach(() => jest.clearAllMocks())

it("probes nothing while disabled", async () => {
  const d = deps()
  const { result } = renderHook(() => useWranglerDetection(false, d))
  await waitFor(() => expect(result.current.detection).toBeNull())
  expect((d as unknown as { detect: jest.Mock }).detect).not.toHaveBeenCalled()
})

it("runs only the cheap probe on mount, never the hash", async () => {
  // `ensureWranglerApproved` SHA-256s a multi-megabyte binary. The console used
  // to do that on every mount, with no Site selected and no intent to upload.
  const d = deps()
  const { result } = renderHook(() => useWranglerDetection(true, d))
  await waitFor(() => expect(result.current.detection).toEqual(FOUND))
  expect((d as unknown as { detect: jest.Mock }).detect).toHaveBeenCalledTimes(1)
  expect((d as unknown as { approve: jest.Mock }).approve).not.toHaveBeenCalled()
})

it("reports not-found when the probe throws rather than hanging on null", async () => {
  const d = deps({ detect: jest.fn(async () => Promise.reject(new Error("no ipc"))) })
  const { result } = renderHook(() => useWranglerDetection(true, d))
  await waitFor(() =>
    expect(result.current.detection).toEqual({ path: null, version: null, ready: false })
  )
})

it("hashes once per resolved path, however many uploads run", async () => {
  const d = deps()
  const { result } = renderHook(() => useWranglerDetection(true, d))
  await waitFor(() => expect(result.current.detection).toEqual(FOUND))

  await act(async () => {
    await result.current.ensureApproved()
  })
  await act(async () => {
    await result.current.ensureApproved()
  })
  expect((d as unknown as { approve: jest.Mock }).approve).toHaveBeenCalledTimes(1)
})

it("re-approves after a redetect resolves a different binary", async () => {
  const d = deps()
  const { result } = renderHook(() => useWranglerDetection(true, d))
  await waitFor(() => expect(result.current.detection).toEqual(FOUND))
  await act(async () => {
    await result.current.ensureApproved()
  })

  await act(async () => {
    await result.current.redetect()
  })
  expect(result.current.detection?.path).toBe("/new/wrangler")

  await act(async () => {
    await result.current.ensureApproved()
  })
  // `redetectWranglerBinary` approves the binary it resolves, so the new path
  // is already in the ledger — a following upload must not hash it again.
  expect((d as unknown as { approve: jest.Mock }).approve).toHaveBeenCalledTimes(1)
})
