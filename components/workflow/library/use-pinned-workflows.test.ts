/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { usePinnedWorkflows } from "./use-pinned-workflows"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async () => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    // Minimal slice — the hook only reads `settings.pinnedWorkflowIds` + `save`.
    settings: { pinnedWorkflowIds: [] } as never,
    save: saveMock as never,
  })
})

describe("usePinnedWorkflows", () => {
  it("reports pin state from settings", () => {
    useSettingsStore.setState({ settings: { pinnedWorkflowIds: ["wf_a"] } as never })
    const { result } = renderHook(() => usePinnedWorkflows())
    expect(result.current.isPinned("wf_a")).toBe(true)
    expect(result.current.isPinned("wf_b")).toBe(false)
  })

  it("pins an unpinned workflow", async () => {
    const { result } = renderHook(() => usePinnedWorkflows())
    await act(async () => {
      await result.current.togglePin("wf_a")
    })
    expect(saveMock).toHaveBeenCalledWith({ pinnedWorkflowIds: ["wf_a"] })
  })

  it("unpins an already-pinned workflow", async () => {
    useSettingsStore.setState({ settings: { pinnedWorkflowIds: ["wf_a", "wf_b"] } as never })
    const { result } = renderHook(() => usePinnedWorkflows())
    await act(async () => {
      await result.current.togglePin("wf_a")
    })
    expect(saveMock).toHaveBeenCalledWith({ pinnedWorkflowIds: ["wf_b"] })
  })
})
