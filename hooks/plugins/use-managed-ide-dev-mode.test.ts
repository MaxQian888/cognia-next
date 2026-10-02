/**
 * @jest-environment jsdom
 */

const mockReadStatus = jest.fn(async () => ({ enabled: true, devPaths: [] }))
jest.mock("@/lib/plugin/ide/dev-mode", () => {
  const actual = jest.requireActual("@/lib/plugin/ide/dev-mode")
  return { ...actual, readDevModeStatus: () => mockReadStatus() }
})

import { act, renderHook } from "@testing-library/react"

import { resetDevModeForTests } from "@/lib/plugin/ide/dev-mode"

import { useManagedIdeDevMode } from "./use-managed-ide-dev-mode"

beforeEach(() => resetDevModeForTests())

it("reads the host switch on mount and re-renders on every change", async () => {
  const { result } = renderHook(() => useManagedIdeDevMode())
  expect(mockReadStatus).toHaveBeenCalledTimes(1)
  expect(result.current.status.enabled).toBe(false)
  expect(result.current.simulations).toEqual([])
  act(() => resetDevModeForTests())
  expect(result.current.folders).toEqual([])
})

it("treats an unreachable host as off", async () => {
  mockReadStatus.mockRejectedValueOnce(new Error("no host"))
  const { result } = renderHook(() => useManagedIdeDevMode())
  await act(async () => undefined)
  expect(result.current.status.enabled).toBe(false)
})
