/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

let developerMode = false
jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  useDeveloperMode: () => developerMode,
}))

import { useVisiblePluginSection } from "./plugin-visible-section"

describe("useVisiblePluginSection", () => {
  beforeEach(() => {
    developerMode = false
  })

  it("passes every ordinary section through", () => {
    for (const section of ["library", "discover", "agent-packages", "governance"] as const) {
      const { result } = renderHook(() => useVisiblePluginSection(section))
      expect(result.current).toBe(section)
    }
  })

  it("falls back to the Library when Devtools is selected but developer mode is off", () => {
    const { result } = renderHook(() => useVisiblePluginSection("devtools"))
    expect(result.current).toBe("library")
  })

  it("shows Devtools when developer mode is on", () => {
    developerMode = true
    const { result } = renderHook(() => useVisiblePluginSection("devtools"))
    expect(result.current).toBe("devtools")
  })
})
