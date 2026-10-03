/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useChatRowBudget, type ChatRowBudgetOptions } from "./use-chat-row-budget"
import { useElementAxisSize } from "@/hooks/use-element-axis-size"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useUIStore } from "@/stores/ui/ui-store"

jest.mock("@/hooks/use-element-axis-size", () => ({ useElementAxisSize: jest.fn(() => 0) }))

const WORKSPACE_FLOOR = { minPx: 480, minPercent: 0 }
const row = document.createElement("div")

function options(overrides: Partial<ChatRowBudgetOptions> = {}): ChatRowBudgetOptions {
  return { row, dockOpen: true, dockFloor: WORKSPACE_FLOOR, chatMinPx: 420, ...overrides }
}

function setRowWidth(px: number) {
  jest.mocked(useElementAxisSize).mockReturnValue(px)
}

beforeEach(() => {
  setRowWidth(0)
  useUIStore.setState({
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
    sidebarAutoCollapseSuppressed: false,
    sidebarWidth: 260,
    guildRailCollapsed: false,
  })
  useShellColumnsStore.setState({ widths: { rail: 0, sidebar: 0, dock: 0 } })
  useSettingsStore.setState({ settings: { sidebarSide: "left" } as never })
})

it("holds the layout until the row is measured", () => {
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toBeNull()
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
})

it("folds the sidebar when the open sidebar leaves the chat too little room", () => {
  // Row = sidebar 260 + group; the group needs 900 → a 1100 row folds.
  setRowWidth(1100)
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ autoFold: true, overlay: false })
  expect(useUIStore.getState()).toMatchObject({
    sidebarCollapsed: true,
    sidebarAutoCollapsed: true,
  })
})

it("reads the total across the fold, so the fold's own reflow does not undo it", () => {
  setRowWidth(1100)
  const { result, rerender } = renderHook(() => useChatRowBudget(options()))
  expect(useUIStore.getState().sidebarAutoCollapsed).toBe(true)
  // Folded: the icon rail (56px) left the row, which is now 56px narrower.
  act(() => useShellColumnsStore.setState({ widths: { rail: 56, sidebar: 0, dock: 0 } }))
  setRowWidth(1044)
  rerender()
  expect(result.current).toMatchObject({ autoFold: true })
  expect(useUIStore.getState().sidebarAutoCollapsed).toBe(true)
})

it("unfolds once the window has room again", () => {
  useUIStore.setState({ sidebarCollapsed: true, sidebarAutoCollapsed: true })
  useShellColumnsStore.setState({ widths: { rail: 56, sidebar: 0, dock: 0 } })
  setRowWidth(1400)
  renderHook(() => useChatRowBudget(options()))
  expect(useUIStore.getState()).toMatchObject({
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
  })
})

it("floats the dock rather than re-folding a sidebar the user re-opened", () => {
  useUIStore.setState({ sidebarAutoCollapseSuppressed: true })
  setRowWidth(1100)
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ autoFold: false, needsFold: true, overlay: true })
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
  // Still squeezed: the refusal holds.
  expect(useUIStore.getState().sidebarAutoCollapseSuppressed).toBe(true)
})

it("counts the icon rail beside a right-edge sidebar", () => {
  useSettingsStore.setState({ settings: { sidebarSide: "right" } as never })
  useShellColumnsStore.setState({ widths: { rail: 56, sidebar: 0, dock: 0 } })
  // 1160 + 56 rail = 1216 total; open, the sidebar and the rail take 316.
  setRowWidth(1160)
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ autoFold: false, groupPx: 900 })
})

it("returns a borrowed fold when the dock host unmounts", () => {
  setRowWidth(1100)
  const { unmount } = renderHook(() => useChatRowBudget(options()))
  expect(useUIStore.getState().sidebarAutoCollapsed).toBe(true)
  unmount()
  expect(useUIStore.getState()).toMatchObject({
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
  })
})

it("releases the fold when the dock closes", () => {
  setRowWidth(1100)
  const { rerender } = renderHook((props: ChatRowBudgetOptions) => useChatRowBudget(props), {
    initialProps: options(),
  })
  expect(useUIStore.getState().sidebarAutoCollapsed).toBe(true)
  rerender(options({ dockOpen: false }))
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
})
