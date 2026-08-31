/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { useDirectoryPicker } from "./use-directory-picker"

describe("useDirectoryPicker", () => {
  it("reports a picker where one exists, and returns what it picked", async () => {
    const pick = jest.fn(async () => "/picked")
    const { result } = renderHook(() => useDirectoryPicker({ pick, hasPicker: () => true }))

    expect(result.current.available).toBe(true)
    await act(async () => {
      await expect(result.current.browse()).resolves.toBe("/picked")
    })
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it("reports no picker, and never calls one, where none exists", async () => {
    // This is the whole point: a caller that renders its affordance on
    // `available` cannot produce a present-and-inert button, and a caller that
    // calls `browse()` anyway gets null rather than an unhandled rejection
    // from a native dialog that is not there.
    const pick = jest.fn(async () => "/picked")
    const { result } = renderHook(() => useDirectoryPicker({ pick, hasPicker: () => false }))

    expect(result.current.available).toBe(false)
    await act(async () => {
      await expect(result.current.browse()).resolves.toBeNull()
    })
    expect(pick).not.toHaveBeenCalled()
  })

  it("passes a dialog title through when the caller has one", async () => {
    const pick = jest.fn(async () => null)
    const { result } = renderHook(() =>
      useDirectoryPicker({ pick, hasPicker: () => true, title: "Pick a project" })
    )

    await act(async () => {
      await result.current.browse()
    })
    expect(pick).toHaveBeenCalledWith("Pick a project")
  })

  it("clears busy after the picker rejects, so the trigger is not stuck", async () => {
    const boom = new Error("platform failure")
    const pick = jest.fn(async () => {
      throw boom
    })
    const { result } = renderHook(() => useDirectoryPicker({ pick, hasPicker: () => true }))

    await act(async () => {
      await expect(result.current.browse()).rejects.toBe(boom)
    })
    expect(result.current.busy).toBe(false)
  })

  it("resolves null on a cancelled pick rather than treating it as a value", async () => {
    const { result } = renderHook(() =>
      useDirectoryPicker({ pick: async () => null, hasPicker: () => true })
    )

    await act(async () => {
      await expect(result.current.browse()).resolves.toBeNull()
    })
  })
})
