/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  useWorkbenchRailLayout,
  useWorkbenchRailPersistent,
  workbenchRailLayoutOf,
} from "./use-workbench-rail-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { CONTEXT_ACTIVITY_RAIL_ORDER } from "@/types/context-workbench"
import {
  DEFAULT_WORKBENCH_RAIL_LAYOUT,
  type WorkbenchRailLayout,
} from "@/types/shell/workbench-rail"

const saveMock = jest.fn(async (_patch?: { workbenchRail?: WorkbenchRailLayout }) => {})

const setStored = (workbenchRail?: Partial<WorkbenchRailLayout>) =>
  useSettingsStore.setState({ settings: { workbenchRail } as never, save: saveMock as never })

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.workbenchRail as WorkbenchRailLayout

beforeEach(() => {
  saveMock.mockClear()
  setStored(undefined)
})

describe("workbenchRailLayoutOf", () => {
  it("falls back to the shipped default when nothing is stored", () => {
    expect(workbenchRailLayoutOf(undefined)).toEqual(DEFAULT_WORKBENCH_RAIL_LAYOUT)
  })

  it("fills in a half-written layout rather than dropping the rail", () => {
    expect(workbenchRailLayoutOf({ hidden: ["ai"] })).toEqual({
      order: DEFAULT_WORKBENCH_RAIL_LAYOUT.order,
      hidden: ["ai"],
      groups: DEFAULT_WORKBENCH_RAIL_LAYOUT.groups,
    })
  })
})

describe("useWorkbenchRailPersistent", () => {
  it("collapses the rail away when the user has expressed no preference", () => {
    // Defaults OFF: a persistent rail beside a closed panel is a second icon
    // column boxing the conversation in from the right, opposite the left nav
    // rail. Four hosts read this to decide their collapsed width, so a wrong
    // default is four surfaces wrong at once.
    setStored(undefined)
    const { result } = renderHook(() => useWorkbenchRailPersistent())
    expect(result.current).toBe(false)
  })

  it("honours an explicit opt-in", () => {
    useSettingsStore.setState({
      settings: { workbenchRailPersistent: true } as never,
      save: saveMock as never,
    })
    const { result } = renderHook(() => useWorkbenchRailPersistent())
    expect(result.current).toBe(true)
  })

  it("honours an explicit opt-out", () => {
    useSettingsStore.setState({
      settings: { workbenchRailPersistent: false } as never,
      save: saveMock as never,
    })
    const { result } = renderHook(() => useWorkbenchRailPersistent())
    expect(result.current).toBe(false)
  })

  it("does not re-render when an unrelated rail edit lands", () => {
    // A one-field selector on purpose: the hosts that read this want only the
    // boolean and must not re-render on every reorder of the rail.
    useSettingsStore.setState({
      settings: { workbenchRailPersistent: true, workbenchRail: { hidden: [] } } as never,
      save: saveMock as never,
    })
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useWorkbenchRailPersistent()
    })
    const before = renders
    act(() => {
      useSettingsStore.setState({
        settings: {
          workbenchRailPersistent: true,
          workbenchRail: { hidden: ["ai"] },
        } as never,
        save: saveMock as never,
      })
    })
    expect(result.current).toBe(true)
    expect(renders).toBe(before)
  })
})

describe("useWorkbenchRailLayout", () => {
  it("resolves the default rail when unset", () => {
    const { result } = renderHook(() => useWorkbenchRailLayout())
    expect(result.current.resolved.visible.map((i) => i.id)).toEqual([
      ...CONTEXT_ACTIVITY_RAIL_ORDER,
    ])
    expect(result.current.isDefault).toBe(true)
  })

  it("hides an activity, keeping its slot in the order", async () => {
    setStored({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: [] })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    await act(async () => {
      await result.current.hide("review")
    })
    expect(lastSaved().hidden).toEqual(["review"])
    expect(lastSaved().order).toEqual([...CONTEXT_ACTIVITY_RAIL_ORDER])
  })

  /**
   * `groups` is dormant — nothing reads or writes it — but `hide` used to
   * rebuild `{ order, hidden }` from scratch while `show` spread the layout, so
   * hiding one activity silently deleted it. Harmless only while the field is
   * always empty; the day it is not, that is a user's panel groups gone. Kept
   * pinned so the dormancy stays a deferral rather than a data-loss bug.
   */
  it("preserves the dormant groups field when hiding an activity", async () => {
    const groups = [{ id: "group:a", label: "A", icon: "Rows3", panelIds: ["comments"] }]
    setStored({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: [], groups })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    await act(async () => {
      await result.current.hide("review")
    })
    expect(lastSaved().groups).toEqual(groups)
  })

  it("shows a hidden activity", async () => {
    setStored({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: ["review", "ai"] })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    await act(async () => {
      await result.current.show("review")
    })
    expect(lastSaved().hidden).toEqual(["ai"])
  })

  it("reorders, preserving ids the catalog does not know about", async () => {
    // A plugin activity that is live on the rail but absent from the canonical
    // catalog must keep its stored slot — the customizer never showed it, so it
    // cannot be in the incoming id list.
    setStored({ order: ["ai", "acme:custom", "workspace"], hidden: [] })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    await act(async () => {
      await result.current.reorder(["workspace", "ai"])
    })
    expect(lastSaved().order).toEqual(["workspace", "ai", "acme:custom"])
  })

  it("drops ids that are not in the catalog from the incoming order", async () => {
    setStored({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: [] })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    await act(async () => {
      await result.current.reorder(["ai", "ghost", "workspace"])
    })
    expect(lastSaved().order.slice(0, 2)).toEqual(["ai", "workspace"])
    expect(lastSaved().order).not.toContain("ghost")
  })

  it("resets to the shipped layout", async () => {
    setStored({ order: ["workspace"], hidden: ["ai"] })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    expect(result.current.isDefault).toBe(false)
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_WORKBENCH_RAIL_LAYOUT)
  })

  it("does not recompute when an unrelated setting changes", () => {
    setStored({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: [] })
    const { result, rerender } = renderHook(() => useWorkbenchRailLayout())
    const firstLayout = result.current.layout
    const firstHide = result.current.hide
    act(() => {
      useSettingsStore.setState({
        settings: {
          ...useSettingsStore.getState().settings,
          apiKey: "changed",
        } as never,
      })
    })
    rerender()
    // Keyed on `settings.workbenchRail`, so an unrelated write must not churn
    // the callbacks and re-render the workbench in four hosts.
    expect(result.current.layout).toBe(firstLayout)
    expect(result.current.hide).toBe(firstHide)
  })
})

describe("useWorkbenchRailLayout — partial and repeat writes", () => {
  it("fills in a missing hidden set", () => {
    expect(workbenchRailLayoutOf({ order: ["ai"] })).toEqual({
      order: ["ai"],
      hidden: DEFAULT_WORKBENCH_RAIL_LAYOUT.hidden,
      groups: DEFAULT_WORKBENCH_RAIL_LAYOUT.groups,
    })
  })

  it("appends an activity the stored order never mentioned when hiding it", async () => {
    // A plugin activity is live on the rail without being in the stored order.
    // Hiding it has to give it a slot, or unhiding would drop it to the end.
    setStored({ order: ["ai"], hidden: [] })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    await act(async () => {
      await result.current.hide("acme:custom")
    })
    expect(lastSaved().order).toEqual(["ai", "acme:custom"])
    expect(lastSaved().hidden).toEqual(["acme:custom"])
  })

  it("hiding an already-hidden activity is idempotent", async () => {
    setStored({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: ["ai"] })
    const { result } = renderHook(() => useWorkbenchRailLayout())
    await act(async () => {
      await result.current.hide("ai")
    })
    expect(lastSaved().hidden).toEqual(["ai"])
    expect(lastSaved().order).toEqual([...CONTEXT_ACTIVITY_RAIL_ORDER])
  })
})
