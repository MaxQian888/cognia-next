/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import { InboxIcon } from "lucide-react"

import {
  CustomizerLists,
  type CustomizerItem,
  type CustomizerLabels,
  type CustomizerOverflowLabels,
} from "./customizer-list"
import { TooltipProvider } from "@/components/ui/tooltip"

// jsdom has no layout, so dnd-kit's collision detection never resolves an
// `over` target and a real drag ends as a no-op. Capture the `onDragEnd` the
// list installs so the reorder path can be driven with a synthetic drop — the
// same seam `bar-customizer.test.tsx` uses.
let lastDragEnd: ((event: unknown) => void) | undefined
jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual<typeof import("@dnd-kit/core")>("@dnd-kit/core")
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode
      onDragEnd: (event: unknown) => void
    }) => {
      lastDragEnd = onDragEnd
      return <>{children}</>
    },
  }
})

const item = (id: string, label: string, hint?: string): CustomizerItem => ({
  id,
  label,
  Icon: InboxIcon,
  hint,
})

const LABELS: CustomizerLabels = {
  restoreDefaults: "Restore defaults",
  pinned: "Pinned",
  dragHint: "Drag to reorder",
  pinnedEmpty: "Nothing pinned",
  hidden: "Hidden",
  hiddenEmpty: "Nothing hidden",
  hideItem: "Hide",
  showItem: "Show",
}

const OVERFLOW_LABELS: CustomizerOverflowLabels = {
  ...LABELS,
  more: "More",
  moreEmpty: "Nothing in More",
  moveToMore: "Move to More",
  pin: "Pin",
}

const handlers = {
  onReorderPinned: jest.fn(),
  onHide: jest.fn(),
  onShow: jest.fn(),
  onReset: jest.fn(),
  onPin: jest.fn(),
  onUnpin: jest.fn(),
}

const PREFIX = "cz"

/** Three-bucket editor: the nav rail / discover shape. */
function renderThreeBuckets(overrides: Partial<Parameters<typeof CustomizerLists>[0]> = {}) {
  return render(
    <TooltipProvider>
      <CustomizerLists
        testIdPrefix={PREFIX}
        isDefault={false}
        labels={OVERFLOW_LABELS}
        pinned={[item("inbox", "Inbox"), item("chat", "Chat")]}
        overflow={[item("term", "Terminal")]}
        hidden={[item("eval", "Eval")]}
        onReorderPinned={handlers.onReorderPinned}
        onHide={handlers.onHide}
        onShow={handlers.onShow}
        onReset={handlers.onReset}
        onPin={handlers.onPin}
        onUnpin={handlers.onUnpin}
        {...(overrides as object)}
      />
    </TooltipProvider>
  )
}

/** Two-bucket editor: the window-bar shape, with no overflow home. */
function renderTwoBuckets(overrides: Partial<Parameters<typeof CustomizerLists>[0]> = {}) {
  return render(
    <TooltipProvider>
      <CustomizerLists
        testIdPrefix={PREFIX}
        isDefault={false}
        labels={LABELS}
        pinned={[item("inbox", "Inbox", "Left")]}
        hidden={[item("eval", "Eval")]}
        onReorderPinned={handlers.onReorderPinned}
        onHide={handlers.onHide}
        onShow={handlers.onShow}
        onReset={handlers.onReset}
        {...(overrides as object)}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  lastDragEnd = undefined
  for (const fn of Object.values(handlers)) fn.mockClear()
})

describe("CustomizerLists — three buckets", () => {
  it("renders every bucket with its heading and drag hint", () => {
    renderThreeBuckets()
    expect(screen.getByTestId(PREFIX)).toBeInTheDocument()
    expect(screen.getByText("Pinned")).toBeInTheDocument()
    expect(screen.getByText("Drag to reorder")).toBeInTheDocument()
    expect(screen.getByText("More")).toBeInTheDocument()
    expect(screen.getByText("Hidden")).toBeInTheDocument()
    expect(screen.getByTestId(`${PREFIX}-pinned-inbox`)).toBeInTheDocument()
    expect(screen.getByTestId(`${PREFIX}-row-term`)).toBeInTheDocument()
    expect(screen.getByTestId(`${PREFIX}-row-eval`)).toBeInTheDocument()
  })

  it("moves a pinned item to More", () => {
    renderThreeBuckets()
    fireEvent.click(screen.getByTestId(`${PREFIX}-unpin-inbox`))
    expect(handlers.onUnpin).toHaveBeenCalledWith("inbox")
  })

  it("pins from More and from Hidden", () => {
    renderThreeBuckets()
    fireEvent.click(screen.getByTestId(`${PREFIX}-pin-term`))
    fireEvent.click(screen.getByTestId(`${PREFIX}-pin-eval`))
    expect(handlers.onPin).toHaveBeenNthCalledWith(1, "term")
    expect(handlers.onPin).toHaveBeenNthCalledWith(2, "eval")
  })

  it("hides from the pinned list and from More", () => {
    renderThreeBuckets()
    fireEvent.click(screen.getByTestId(`${PREFIX}-hide-inbox`))
    fireEvent.click(screen.getByTestId(`${PREFIX}-hide-term`))
    expect(handlers.onHide).toHaveBeenNthCalledWith(1, "inbox")
    expect(handlers.onHide).toHaveBeenNthCalledWith(2, "term")
  })

  it("unhides an item", () => {
    renderThreeBuckets()
    fireEvent.click(screen.getByTestId(`${PREFIX}-show-eval`))
    expect(handlers.onShow).toHaveBeenCalledWith("eval")
  })

  it("renders each bucket's empty state", () => {
    renderThreeBuckets({ pinned: [], overflow: [], hidden: [] })
    expect(screen.getByText("Nothing pinned")).toBeInTheDocument()
    expect(screen.getByText("Nothing in More")).toBeInTheDocument()
    expect(screen.getByText("Nothing hidden")).toBeInTheDocument()
  })

  it("labels the reset control and reports the click", () => {
    renderThreeBuckets()
    const reset = screen.getByTestId(`${PREFIX}-reset`)
    expect(reset).not.toBeDisabled()
    fireEvent.click(reset)
    expect(handlers.onReset).toHaveBeenCalledTimes(1)
  })

  it("disables reset at the shipped layout", () => {
    renderThreeBuckets({ isDefault: true })
    expect(screen.getByTestId(`${PREFIX}-reset`)).toBeDisabled()
  })
})

describe("CustomizerLists — two buckets", () => {
  it("drops the More section entirely", () => {
    renderTwoBuckets()
    expect(screen.queryByText("More")).toBeNull()
    expect(screen.queryByText("Nothing in More")).toBeNull()
  })

  // With no third home, "move to More" and "pin" have nowhere to go — unhiding
  // is the only way back into the bar.
  it("offers neither the per-row move-to-More nor pin actions", () => {
    renderTwoBuckets()
    expect(screen.queryByTestId(`${PREFIX}-unpin-inbox`)).toBeNull()
    expect(screen.queryByTestId(`${PREFIX}-pin-eval`)).toBeNull()
    expect(screen.getByTestId(`${PREFIX}-hide-inbox`)).toBeInTheDocument()
    expect(screen.getByTestId(`${PREFIX}-show-eval`)).toBeInTheDocument()
  })

  it("renders an item's trailing hint badge", () => {
    renderTwoBuckets()
    expect(screen.getByTestId("customizer-hint-inbox")).toHaveTextContent("Left")
  })

  it("omits the hint badge for an item without one", () => {
    renderTwoBuckets()
    expect(screen.queryByTestId("customizer-hint-eval")).toBeNull()
  })

  it("omits the section hint when the caller supplies none", () => {
    renderTwoBuckets()
    // Only the pinned section passes `dragHint`; Hidden has no hint line.
    expect(screen.getAllByText("Drag to reorder")).toHaveLength(1)
  })
})

describe("CustomizerLists — reordering", () => {
  it("persists a drop as the new pinned order", () => {
    renderThreeBuckets()
    act(() => {
      lastDragEnd?.({ active: { id: "chat" }, over: { id: "inbox" } })
    })
    expect(handlers.onReorderPinned).toHaveBeenCalledWith(["chat", "inbox"])
  })

  it("ignores a drop that lands on nothing", () => {
    renderThreeBuckets()
    act(() => {
      lastDragEnd?.({ active: { id: "chat" }, over: null })
    })
    expect(handlers.onReorderPinned).not.toHaveBeenCalled()
  })

  it("ignores a drop back onto the item's own slot", () => {
    renderThreeBuckets()
    act(() => {
      lastDragEnd?.({ active: { id: "chat" }, over: { id: "chat" } })
    })
    expect(handlers.onReorderPinned).not.toHaveBeenCalled()
  })

  it("starts a keyboard drag from the grip without throwing", () => {
    renderThreeBuckets()
    const handle = screen.getByTestId(`${PREFIX}-handle-inbox`)
    expect(handle).toHaveAttribute("aria-label", "drag Inbox")
    act(() => {
      fireEvent.keyDown(handle, { code: "Space" })
      fireEvent.keyDown(handle, { code: "ArrowDown" })
      fireEvent.keyDown(handle, { code: "Space" })
    })
    expect(screen.getByTestId(`${PREFIX}-pinned-inbox`)).toBeInTheDocument()
  })
})
