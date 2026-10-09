/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/goal/verification", () => ({ listGoalVerifierWorkflowOptions: jest.fn() }))
// Run the live query's querier once and hand its answer back, as Dexie would.
jest.mock("dexie-react-hooks", () => {
  const { useEffect, useState } = jest.requireActual<typeof import("react")>("react")
  return {
    useLiveQuery: <T>(querier: () => T | Promise<T>, deps: unknown[], initial: T) => {
      const [value, setValue] = useState<T>(initial)
      useEffect(() => {
        let live = true
        void Promise.resolve(querier()).then((next) => live && setValue(next))
        return () => {
          live = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})

import { usePlatform } from "@/hooks/use-platform"
import { listGoalVerifierWorkflowOptions } from "@/lib/goal/verification"
import { transport } from "@/lib/tauri/transport-instance"
import { useGoalVerifierOptions } from "./use-goal-verifier-options"

const usePlatformMock = usePlatform as jest.Mock
const callMock = transport.call as jest.Mock
const listMock = listGoalVerifierWorkflowOptions as jest.Mock

const OPTION = {
  name: "Release checks",
  binding: { workflowId: "wf", versionId: "v1", deploymentId: "d1", deploymentRevision: 1 },
}

beforeEach(() => {
  usePlatformMock.mockReturnValue("tauri")
  callMock.mockReset()
  listMock.mockReset().mockResolvedValue([OPTION])
})

it("reads this host's own catalog off the phone", async () => {
  const { result } = renderHook(() => useGoalVerifierOptions())
  await waitFor(() => expect(result.current.options).toEqual([OPTION]))
  expect(result.current.failed).toBe(false)
  expect(callMock).not.toHaveBeenCalled()
})

it("asks the paired desktop for its catalog on a phone", async () => {
  usePlatformMock.mockReturnValue("mobile")
  callMock.mockResolvedValueOnce({ options: [OPTION] })
  const { result } = renderHook(() => useGoalVerifierOptions())
  expect(result.current.options).toEqual([])
  await waitFor(() => expect(result.current.options).toEqual([OPTION]))
  expect(callMock).toHaveBeenCalledWith("goal_verification_options", {})
  expect(listMock).not.toHaveBeenCalled()
  expect(result.current.failed).toBe(false)
})

it("treats a missing options field as an empty catalog", async () => {
  usePlatformMock.mockReturnValue("mobile")
  callMock.mockResolvedValueOnce(undefined)
  const { result } = renderHook(() => useGoalVerifierOptions())
  await waitFor(() => expect(callMock).toHaveBeenCalled())
  await waitFor(() => expect(result.current.failed).toBe(false))
  expect(result.current.options).toEqual([])
})

it("says the desktop's catalog could not be read", async () => {
  usePlatformMock.mockReturnValue("mobile")
  callMock.mockRejectedValueOnce(new Error("offline"))
  const { result } = renderHook(() => useGoalVerifierOptions())
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.options).toEqual([])
})
