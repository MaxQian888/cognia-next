/** @jest-environment node */
import { isCliHost } from "@/lib/platform/detect"

import { markCliHostProcess } from "./cli-host-marker"

describe("markCliHostProcess", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__COGNIA_CLI__
  })

  it("sets the marker the platform leaf reads", () => {
    expect(isCliHost()).toBe(false)
    markCliHostProcess()
    expect(isCliHost()).toBe(true)
  })

  it("writes the exact key `isCliHost` checks, on the target it is given", () => {
    const target: Record<string, unknown> = {}
    markCliHostProcess(target)
    expect(target).toEqual({ __COGNIA_CLI__: true })
    // The global stays untouched when a target is supplied, so a test that
    // marks a fake object cannot leak the verdict into the rest of the suite.
    expect(isCliHost()).toBe(false)
  })
})
