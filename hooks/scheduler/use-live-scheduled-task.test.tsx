/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"

// A stand-in for Dexie's live query: run the querier once per dependency change.
// The real one needs an IndexedDB behind the table; what is under test here is
// what the querier asks for and what it answers.
jest.mock("dexie-react-hooks", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    useLiveQuery: <T,>(querier: () => Promise<T>, deps: unknown[], initial: T) => {
      const [value, setValue] = React.useState<T>(initial)
      React.useEffect(() => {
        let alive = true
        void querier().then((result) => {
          if (alive) setValue(result)
        })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getTask: jest.fn() },
}))

import { schedulerDb } from "@/lib/scheduler/scheduler-db"

import { useLiveScheduledTask } from "./use-live-scheduled-task"

const getTask = schedulerDb.getTask as jest.Mock

beforeEach(() => {
  getTask.mockReset()
})

describe("useLiveScheduledTask", () => {
  it("reads the task from the local schedule", async () => {
    getTask.mockResolvedValue({ id: "t1", name: "Nightly build" })
    const { result } = renderHook(() => useLiveScheduledTask("t1"))
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toEqual({ id: "t1", name: "Nightly build" }))
    expect(getTask).toHaveBeenCalledWith("t1")
  })

  it("answers null for an id that names nothing, so callers can say it is gone", async () => {
    getTask.mockResolvedValue(null)
    const { result } = renderHook(() => useLiveScheduledTask("gone"))
    await waitFor(() => expect(result.current).toBeNull())
  })

  it("does not read at all without an id", async () => {
    const { result } = renderHook(() => useLiveScheduledTask(undefined))
    await waitFor(() => expect(result.current).toBeNull())
    expect(getTask).not.toHaveBeenCalled()
  })
})
