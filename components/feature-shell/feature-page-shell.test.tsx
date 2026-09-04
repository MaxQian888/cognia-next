/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars?.name ? `${key}:${vars.name}` : key,
}))

// The shell overlays its side panes below `lg`, not below `md`, so what these
// tests toggle is the breakpoint tier. `"tablet"` is the case the rename was
// for: a narrow desktop window that used to get three starved columns.
let breakpointValue: "mobile" | "tablet" | "desktop" = "desktop"
jest.mock("@/hooks/ui", () => ({
  useBreakpoint: () => breakpointValue,
}))

// react-resizable-panels reads window.matchMedia and ResizeObserver — stub
// them to avoid jsdom blowups.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = jest.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia
  }
  if (typeof window.ResizeObserver === "undefined") {
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
})

import { FeaturePageShell } from "./feature-page-shell"

beforeEach(() => {
  breakpointValue = "desktop"
})

test("renders the direct header, left, center, and right panes on desktop", () => {
  render(
    <FeaturePageShell
      storageId="example"
      header={<header data-testid="example-header" />}
      leftPane={{ label: "Filters", content: <div data-testid="example-left" /> }}
      rightPane={{ label: "Preview", content: <div data-testid="example-right" /> }}
    >
      <div data-testid="example-center" />
    </FeaturePageShell>
  )
  expect(screen.getByTestId("feature-shell-example")).toBeInTheDocument()
  expect(screen.getByTestId("feature-shell-example-header")).toBeInTheDocument()
  expect(screen.getByTestId("feature-shell-example-center")).toBeInTheDocument()
  expect(screen.getByTestId("example-header")).toBeInTheDocument()
  expect(screen.getByTestId("example-left")).toBeInTheDocument()
  expect(screen.getByTestId("example-center")).toBeInTheDocument()
  expect(screen.getByTestId("example-right")).toBeInTheDocument()
  expect(screen.getByLabelText("Filters")).toBeInTheDocument()
  expect(screen.getByLabelText("Preview")).toBeInTheDocument()
})

test("renders only the center pane when no leftPane / rightPane is provided", () => {
  render(
    <FeaturePageShell storageId="solo">
      <div data-testid="solo-center" />
    </FeaturePageShell>
  )
  expect(screen.getByTestId("solo-center")).toBeInTheDocument()
  expect(screen.queryByLabelText("Filters")).toBeNull()
  expect(screen.queryByLabelText("Preview")).toBeNull()
})

test("on mobile, renders sheet triggers for left and right panes", () => {
  breakpointValue = "mobile"
  render(
    <FeaturePageShell
      storageId="example"
      leftPane={{ label: "Filters", content: <div data-testid="example-left" /> }}
      rightPane={{ label: "Preview", content: <div data-testid="example-right" /> }}
    >
      <div data-testid="example-center" />
    </FeaturePageShell>
  )
  // Mobile renders Sheet TRIGGERS for the left/right pane labels.
  expect(screen.getByLabelText("openLeft:Filters")).toBeInTheDocument()
  expect(screen.getByLabelText("openRight:Preview")).toBeInTheDocument()
  // Center always visible.
  expect(screen.getByTestId("example-center")).toBeInTheDocument()
})

test("on mobile with no panes, no sheet triggers render", () => {
  breakpointValue = "mobile"
  render(
    <FeaturePageShell storageId="solo">
      <div data-testid="solo-center" />
    </FeaturePageShell>
  )
  expect(screen.queryByLabelText(/^openLeft/)).toBeNull()
  expect(screen.queryByLabelText(/^openRight/)).toBeNull()
  expect(screen.getByTestId("solo-center")).toBeInTheDocument()
})

/**
 * The wallpaper only paints inside a `[data-bg-target]` subtree. Hand-marking
 * it left seven routes with no marker at all, so enabling a wallpaper produced
 * a blank page on them (ADR-0148; same shape as ADR-0007's E1 defect, where the
 * scope selector existed in CSS but nothing ever applied the attribute). The
 * shell owns the marker now, on both the desktop and the mobile branch.
 */
describe("wallpaper scope marker", () => {
  test("desktop shell marks itself as a background target", () => {
    breakpointValue = "desktop"
    render(
      <FeaturePageShell storageId="scoped">
        <div data-testid="scoped-center" />
      </FeaturePageShell>
    )
    expect(screen.getByTestId("feature-shell-scoped")).toHaveAttribute("data-bg-target", "chat")
  })

  test("mobile shell marks itself too", () => {
    breakpointValue = "mobile"
    render(
      <FeaturePageShell storageId="scoped-mobile">
        <div data-testid="scoped-mobile-center" />
      </FeaturePageShell>
    )
    expect(screen.getByTestId("feature-shell-scoped-mobile")).toHaveAttribute(
      "data-bg-target",
      "chat"
    )
  })

  test("does not nest a second target inside itself", () => {
    breakpointValue = "desktop"
    const { container } = render(
      <FeaturePageShell storageId="nesting">
        <div data-testid="nesting-center" />
      </FeaturePageShell>
    )
    // Nested targets each paint their own ::before layer, which doubles the
    // wallpaper's effective opacity — the reason the nine page wrappers that
    // used to carry this attribute had to give it up when the shell took over.
    expect(container.querySelectorAll("[data-bg-target]")).toHaveLength(1)
  })
})

/**
 * The mobile Sheets were uncontrolled, which is a dead end for any route whose
 * center pane SELECTS what the right pane shows: the tap wrote a store the
 * Sheet was not watching, so nothing happened and the user had to find a 16px
 * panel icon. `open` / `onOpenChange` on the pane config is what lets a route
 * drive its own detail. Omitting them must keep the old behaviour exactly.
 */
describe("controlled mobile panes", () => {
  beforeEach(() => {
    breakpointValue = "mobile"
  })

  test("an uncontrolled right pane still opens from its own trigger", () => {
    render(
      <FeaturePageShell
        storageId="uncontrolled"
        rightPane={{ label: "Detail", content: <div data-testid="uncontrolled-detail" /> }}
      >
        <div data-testid="uncontrolled-center" />
      </FeaturePageShell>
    )
    expect(screen.queryByTestId("uncontrolled-detail")).toBeNull()
    fireEvent.click(screen.getByLabelText("openRight:Detail"))
    expect(screen.getByTestId("uncontrolled-detail")).toBeInTheDocument()
  })

  test("a controlled right pane renders open without anyone touching the trigger", () => {
    render(
      <FeaturePageShell
        storageId="controlled"
        rightPane={{
          label: "Detail",
          content: <div data-testid="controlled-detail" />,
          open: true,
          onOpenChange: jest.fn(),
        }}
      >
        <div data-testid="controlled-center" />
      </FeaturePageShell>
    )
    expect(screen.getByTestId("controlled-detail")).toBeInTheDocument()
  })

  test("a controlled right pane stays shut while its owner says so", () => {
    const onOpenChange = jest.fn()
    render(
      <FeaturePageShell
        storageId="controlled-shut"
        rightPane={{
          label: "Detail",
          content: <div data-testid="shut-detail" />,
          open: false,
          onOpenChange,
        }}
      >
        <div data-testid="shut-center" />
      </FeaturePageShell>
    )
    expect(screen.queryByTestId("shut-detail")).toBeNull()
    // The trigger reports intent rather than opening itself, so the owner
    // stays the single source of truth for what is selected.
    fireEvent.click(screen.getByLabelText("openRight:Detail"))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId("shut-detail")).toBeNull()
  })

  test("the left pane takes the same controls", () => {
    const onOpenChange = jest.fn()
    render(
      <FeaturePageShell
        storageId="controlled-left"
        leftPane={{
          label: "Sections",
          content: <div data-testid="controlled-sections" />,
          open: true,
          onOpenChange,
        }}
      >
        <div data-testid="controlled-left-center" />
      </FeaturePageShell>
    )
    expect(screen.getByTestId("controlled-sections")).toBeInTheDocument()
  })
})

/**
 * The tablet tier is why this shell stopped asking `useIsMobile`.
 *
 * Between `md` and `lg` the three percentages still resolved, so a ~900px
 * window rendered three columns in ~750px: the right pane landed near 165px
 * and clipped its own property values mid-word, and a six-column board lost
 * two columns off the edge. Nothing about that window is a phone, so the fix
 * is the tier, not the mobile flag.
 */
describe("narrow desktop windows", () => {
  function renderWithPanes(storageId: string) {
    return render(
      <FeaturePageShell
        storageId={storageId}
        leftPane={{ label: "Rail", content: <div data-testid={`${storageId}-left`} /> }}
        rightPane={{ label: "Details", content: <div data-testid={`${storageId}-right`} /> }}
      >
        <div data-testid={`${storageId}-center`} />
      </FeaturePageShell>
    )
  }

  test("a tablet-width window overlays its side panes instead of columning them", () => {
    breakpointValue = "tablet"
    renderWithPanes("tablet-shell")

    // The pane-control strip is the overlay branch's signature.
    expect(screen.getByTestId("feature-shell-tablet-shell-pane-controls")).toBeInTheDocument()
    expect(screen.getByTestId("tablet-shell-center")).toBeInTheDocument()
    // Side content lives behind a trigger, so it is not painted inline.
    expect(screen.queryByTestId("tablet-shell-right")).not.toBeInTheDocument()
  })

  test("a full-width window still columns all three", () => {
    breakpointValue = "desktop"
    renderWithPanes("wide-shell")

    expect(screen.queryByTestId("feature-shell-wide-shell-pane-controls")).not.toBeInTheDocument()
    expect(screen.getByTestId("wide-shell-right")).toBeInTheDocument()
  })

  test("the overlaid pane is still reachable from its trigger", () => {
    breakpointValue = "tablet"
    renderWithPanes("tablet-open")

    fireEvent.click(screen.getByLabelText("openRight:Details"))
    expect(screen.getByTestId("tablet-open-right")).toBeInTheDocument()
  })
})
