/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

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

it("preserves the expanded sidebar when entering a conversation with an open dock", () => {
  setRowWidth(1100)
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
  expect(result.current).toMatchObject({ autoFold: false, overlay: true, groupPx: 840 })
})

it("preserves the sidebar when the dock opens after entering a conversation", () => {
  setRowWidth(1100)
  const { result, rerender } = renderHook(
    (props: ChatRowBudgetOptions) => useChatRowBudget(props),
    {
      initialProps: options({ dockOpen: false }),
    }
  )
  expect(result.current).toMatchObject({ overlay: false })
  rerender(options())
  expect(result.current).toMatchObject({ autoFold: false, overlay: true })
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
})

it("floats the dock as the row narrows and docks it again without folding the sidebar", () => {
  setRowWidth(1400)
  const { result, rerender } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ overlay: false })
  setRowWidth(1100)
  rerender()
  expect(result.current).toMatchObject({ autoFold: false, overlay: true, groupPx: 840 })
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
  setRowWidth(1400)
  rerender()
  expect(result.current).toMatchObject({ overlay: false, groupPx: 1140 })
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
})

it("releases a previous automatic fold even when the row is narrow", () => {
  useUIStore.setState({ sidebarCollapsed: true, sidebarAutoCollapsed: true })
  useShellColumnsStore.setState({ widths: { rail: 56, sidebar: 0, dock: 0 } })
  setRowWidth(1044)
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ autoFold: false, overlay: true })
  expect(useUIStore.getState()).toMatchObject({
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
  })
})

it("floats the dock when the sidebar is wider than its default", () => {
  useUIStore.setState({ sidebarWidth: 400 })
  setRowWidth(1100)
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ autoFold: false, needsFold: true, overlay: true })
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
  expect(result.current?.groupPx).toBe(700)
})

it("counts the icon rail beside a right-edge sidebar", () => {
  useSettingsStore.setState({ settings: { sidebarSide: "right" } as never })
  useShellColumnsStore.setState({ widths: { rail: 56, sidebar: 0, dock: 0 } })
  // 1160 + 56 rail = 1216 total; open, the sidebar and the rail take 316.
  setRowWidth(1160)
  const { result } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ autoFold: false, groupPx: 900 })
})

it("preserves a manually collapsed sidebar through navigation", () => {
  useUIStore.setState({ sidebarCollapsed: true })
  useShellColumnsStore.setState({ widths: { rail: 56, sidebar: 0, dock: 0 } })
  setRowWidth(1100)
  const { result, unmount } = renderHook(() => useChatRowBudget(options()))
  expect(result.current).toMatchObject({ autoFold: false, overlay: false, groupPx: 1100 })
  unmount()
  expect(useUIStore.getState()).toMatchObject({
    sidebarCollapsed: true,
    sidebarAutoCollapsed: false,
  })
})

it("stops floating the dock when it closes without changing the sidebar", () => {
  setRowWidth(1100)
  const { result, rerender } = renderHook(
    (props: ChatRowBudgetOptions) => useChatRowBudget(props),
    {
      initialProps: options(),
    }
  )
  expect(result.current?.overlay).toBe(true)
  rerender(options({ dockOpen: false }))
  expect(result.current).toMatchObject({ autoFold: false, overlay: false })
  expect(useUIStore.getState().sidebarCollapsed).toBe(false)
})
