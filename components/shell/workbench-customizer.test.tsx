/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

import { WorkbenchCustomizer } from "./workbench-customizer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { CONTEXT_ACTIVITY_RAIL_ORDER } from "@/types/context-workbench"
import {
  DEFAULT_WORKBENCH_RAIL_LAYOUT,
  type WorkbenchRailLayout,
} from "@/types/shell/workbench-rail"

jest.mock("next-intl", () => ({
  // Return the key as passed, so assertions target stable strings. This
  // component scopes to `contextWorkbench.customize` and `…​.activities`, so a
  // label reads as its bare leaf (`hint`) and an activity as its own id.
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(
  async (_patch?: { workbenchRail?: WorkbenchRailLayout; workbenchRailPersistent?: boolean }) => {}
)

function setLayout(layout?: Partial<WorkbenchRailLayout>, persistent?: boolean) {
  useSettingsStore.setState({
    settings: { workbenchRail: layout, workbenchRailPersistent: persistent } as never,
    save: saveMock as never,
  })
}

beforeEach(() => {
  saveMock.mockClear()
  setLayout(undefined)
})

const renderCustomizer = () =>
  render(
    <TooltipProvider>
      <WorkbenchCustomizer />
    </TooltipProvider>
  )

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.workbenchRail as WorkbenchRailLayout

describe("WorkbenchCustomizer", () => {
  it("lists every canonical activity on the rail by default", () => {
    renderCustomizer()
    for (const activity of CONTEXT_ACTIVITY_RAIL_ORDER) {
      expect(screen.getByTestId(`workbench-customizer-list-pinned-${activity}`)).toBeInTheDocument()
    }
    expect(screen.getByText("hiddenEmpty")).toBeInTheDocument()
  })

  it("hides an activity", () => {
    renderCustomizer()
    fireEvent.click(screen.getByTestId("workbench-customizer-list-hide-review"))
    expect(lastSaved().hidden).toEqual(["review"])
    // The slot survives, so unhiding puts it back where the user left it.
    expect(lastSaved().order).toEqual([...CONTEXT_ACTIVITY_RAIL_ORDER])
  })

  it("shows a hidden activity", () => {
    setLayout({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: ["ai"] })
    renderCustomizer()
    expect(screen.getByTestId("workbench-customizer-list-row-ai")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workbench-customizer-list-show-ai"))
    expect(lastSaved().hidden).toEqual([])
  })

  it("restore defaults is disabled at the shipped layout and enabled otherwise", () => {
    const { rerender } = renderCustomizer()
    expect(screen.getByTestId("workbench-customizer-list-reset")).toBeDisabled()

    act(() => setLayout({ order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: ["ai"] }))
    rerender(
      <TooltipProvider>
        <WorkbenchCustomizer />
      </TooltipProvider>
    )
    expect(screen.getByTestId("workbench-customizer-list-reset")).not.toBeDisabled()
  })

  it("restores defaults on click", () => {
    setLayout({ order: ["workspace"], hidden: ["ai"] })
    renderCustomizer()
    fireEvent.click(screen.getByTestId("workbench-customizer-list-reset"))
    expect(lastSaved()).toEqual(DEFAULT_WORKBENCH_RAIL_LAYOUT)
  })

  it("starts a keyboard drag from the grip handle without throwing", () => {
    renderCustomizer()
    const handle = screen.getByTestId("workbench-customizer-list-handle-ai")
    // Exercises the dnd-kit keyboard sensor → handleDragEnd wiring. jsdom has
    // no layout, so this resolves to a no-op reorder, but the handler runs.
    act(() => {
      fireEvent.keyDown(handle, { code: "Space" })
      fireEvent.keyDown(handle, { code: "ArrowDown" })
      fireEvent.keyDown(handle, { code: "Space" })
    })
    expect(screen.getByTestId("workbench-customizer-list-pinned-ai")).toBeInTheDocument()
  })

  it("explains that hiding does not strand the panel", () => {
    renderCustomizer()
    expect(screen.getByText("hint")).toBeInTheDocument()
  })

  describe("persistent rail switch", () => {
    it("is on when the user has never touched it", () => {
      // The rail is what makes the right-hand panels discoverable at all, so
      // the pre-minibar behaviour is the opt-out rather than the default.
      renderCustomizer()
      expect(screen.getByTestId("workbench-persistent-rail")).toBeChecked()
    })

    it("reflects an explicit opt-out", () => {
      setLayout(undefined, false)
      renderCustomizer()
      expect(screen.getByTestId("workbench-persistent-rail")).not.toBeChecked()
    })

    it("writes only its own settings key, leaving the rail order untouched", () => {
      renderCustomizer()
      fireEvent.click(screen.getByTestId("workbench-persistent-rail"))
      const patch = saveMock.mock.calls.at(-1)?.[0]
      expect(patch).toEqual({ workbenchRailPersistent: false })
      // Kept out of `workbenchRail` on purpose: that type's mutators rebuild
      // their object, and its "restore defaults" means "put my activity order
      // back" — which must not also switch the rail off.
      expect(patch).not.toHaveProperty("workbenchRail")
    })
  })
})
