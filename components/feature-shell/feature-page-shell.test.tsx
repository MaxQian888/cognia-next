/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars?.name ? `${key}:${vars.name}` : key,
}))

let isMobileValue = false
jest.mock("@/hooks/ui", () => ({
  useIsMobile: () => isMobileValue,
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
  isMobileValue = false
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
  isMobileValue = true
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
  isMobileValue = true
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
    isMobileValue = false
    render(
      <FeaturePageShell storageId="scoped">
        <div data-testid="scoped-center" />
      </FeaturePageShell>
    )
    expect(screen.getByTestId("feature-shell-scoped")).toHaveAttribute("data-bg-target", "chat")
  })

  test("mobile shell marks itself too", () => {
    isMobileValue = true
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
    isMobileValue = false
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
    isMobileValue = true
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
