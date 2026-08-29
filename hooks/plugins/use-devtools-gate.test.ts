/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

const useDeveloperModeMock = jest.fn(() => false)
jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  useDeveloperMode: () => useDeveloperModeMock(),
}))

import { useDevtoolsGate } from "./use-devtools-gate"

describe("useDevtoolsGate", () => {
  beforeEach(() => {
    useDeveloperModeMock.mockReset()
    useDeveloperModeMock.mockReturnValue(false)
  })

  it("uses the canonical persisted Developer Mode state", () => {
    const { result, rerender } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(false)

    useDeveloperModeMock.mockReturnValue(true)
    rerender()
    expect(result.current).toBe(true)
  })
})
