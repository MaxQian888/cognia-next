/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react"

import { useMobileWorkflowView } from "./use-mobile-workflow-view"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async (_p?: { mobileWorkflowView?: "compact" | "comfortable" }) => {})

function setView(v?: "compact" | "comfortable") {
  useSettingsStore.setState({
    settings: (v ? { mobileWorkflowView: v } : {}) as never,
    save: saveMock as never,
  })
}

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.mobileWorkflowView

beforeEach(() => {
  saveMock.mockClear()
  setView(undefined)
})

describe("useMobileWorkflowView", () => {
  it("defaults to comfortable", () => {
    const { result } = renderHook(() => useMobileWorkflowView())
    expect(result.current.view).toBe("comfortable")
  })

  it("reads the persisted value", () => {
    setView("compact")
    const { result } = renderHook(() => useMobileWorkflowView())
    expect(result.current.view).toBe("compact")
  })

  it("toggles between densities", async () => {
    const { result } = renderHook(() => useMobileWorkflowView())
    await act(async () => {
      await result.current.toggle()
    })
    expect(lastSaved()).toBe("compact")

    setView("compact")
    const { result: r2 } = renderHook(() => useMobileWorkflowView())
    await act(async () => {
      await r2.current.toggle()
    })
    expect(lastSaved()).toBe("comfortable")
  })

  it("sets an explicit value", async () => {
    const { result } = renderHook(() => useMobileWorkflowView())
    await act(async () => {
      await result.current.setView("compact")
    })
    expect(lastSaved()).toBe("compact")
  })
})
