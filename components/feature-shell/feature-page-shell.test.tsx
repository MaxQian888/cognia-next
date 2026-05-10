/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

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

test("renders toolbar, left, center, and right panes on desktop", () => {
  render(
    <FeaturePageShell
      storageId="example"
      toolbar={<div data-testid="example-toolbar" />}
      leftPane={{ label: "Filters", content: <div data-testid="example-left" /> }}
      rightPane={{ label: "Preview", content: <div data-testid="example-right" /> }}
    >
      <div data-testid="example-center" />
    </FeaturePageShell>
  )
  expect(screen.getByTestId("feature-shell-example")).toBeInTheDocument()
  expect(screen.getByTestId("feature-shell-example-toolbar")).toBeInTheDocument()
  expect(screen.getByTestId("feature-shell-example-center")).toBeInTheDocument()
  expect(screen.getByTestId("example-toolbar")).toBeInTheDocument()
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
