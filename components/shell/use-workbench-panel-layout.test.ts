/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useWorkbenchPanelLayout } from "./use-workbench-panel-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_WORKBENCH_PANEL_LAYOUT,
  type WorkbenchPanelLayout,
} from "@/types/shell/workbench-panels"

const saveMock = jest.fn(async (_patch?: { workbenchPanels?: WorkbenchPanelLayout }) => {})

function setStored(workbenchPanels?: Partial<WorkbenchPanelLayout>) {
  useSettingsStore.setState({
    settings: { workbenchPanels } as never,
    save: saveMock as never,
  })
}

function lastSaved(): WorkbenchPanelLayout {
  return saveMock.mock.calls.at(-1)![0]!.workbenchPanels!
}

beforeEach(() => {
  saveMock.mockClear()
  setStored(undefined)
})

describe("useWorkbenchPanelLayout", () => {
  it("resolves the shipped panel set when nothing is stored", () => {
    const { result } = renderHook(() => useWorkbenchPanelLayout())
    expect(result.current.isDefault).toBe(true)
    expect(result.current.resolved.visible.map((item) => item.id)).toContain("preview")
    expect(result.current.resolved.hidden).toEqual([])
  })

  it("hides a panel's tab, keeping its slot in the order", async () => {
    const { result } = renderHook(() => useWorkbenchPanelLayout())
    await act(async () => {
      await result.current.hide("memory")
    })
    expect(lastSaved().hidden).toEqual(["memory"])
    // Appended to `order` rather than left out: unhiding has to restore it in
    // place, not drop it at the end of the strip.
    expect(lastSaved().order).toEqual(["memory"])
  })

  it("shows a hidden panel again", async () => {
    setStored({ order: ["memory"], hidden: ["memory", "logs"] })
    const { result } = renderHook(() => useWorkbenchPanelLayout())
    await act(async () => {
      await result.current.show("memory")
    })
    expect(lastSaved().hidden).toEqual(["logs"])
  })

  it("keeps ids the catalog does not know when reordering", async () => {
    // A plugin panel whose extension is disabled this session is absent from
    // the catalog, so the customizer never showed it and it cannot be in the
    // incoming list. It must keep its stored slot regardless.
    setStored({ order: ["memory", "acme:panel", "logs"], hidden: [] })
    const { result } = renderHook(() => useWorkbenchPanelLayout())
    await act(async () => {
      await result.current.reorder(["logs", "memory"])
    })
    expect(lastSaved().order).toEqual(["logs", "memory", "acme:panel"])
  })

  it("drops ids that are not in the catalog from the incoming order", async () => {
    const { result } = renderHook(() => useWorkbenchPanelLayout())
    await act(async () => {
      await result.current.reorder(["memory", "not-a-panel"])
    })
    expect(lastSaved().order).toEqual(["memory"])
  })

  it("resets to the shipped default", async () => {
    setStored({ order: ["memory"], hidden: ["logs"] })
    const { result } = renderHook(() => useWorkbenchPanelLayout())
    expect(result.current.isDefault).toBe(false)
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_WORKBENCH_PANEL_LAYOUT)
  })

  it("writes only its own settings key", async () => {
    const { result } = renderHook(() => useWorkbenchPanelLayout())
    await act(async () => {
      await result.current.hide("memory")
    })
    const patch = saveMock.mock.calls.at(-1)![0]!
    // The rail layout is a separate key and a separate editor; a panel edit
    // must not carry it along and overwrite a concurrent rail change.
    expect(Object.keys(patch)).toEqual(["workbenchPanels"])
  })
})
