/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

import {
  PluginSectionToolbar,
  visibleSegments,
  type PluginToolbarSegment,
} from "./plugin-section-toolbar"

const SEGMENTS: PluginToolbarSegment[] = [
  { value: "all", label: "All", count: 40 },
  { value: "enabled", label: "Enabled", count: 0 },
  { value: "updates", label: "Updates", count: 0 },
  { value: "configurable", label: "Configurable", count: 3 },
  { value: "errored", label: "Errored", count: 0 },
]

describe("visibleSegments", () => {
  it("drops zero-count segments so no filter leads to a guaranteed empty state", () => {
    expect(visibleSegments(SEGMENTS, "all").map((s) => s.value)).toEqual(["all", "configurable"])
  })

  it("keeps the active segment even after its count drops to zero", () => {
    // Selecting "Errored", then the last error clearing, must not make the
    // control lose the segment the user is currently standing on.
    expect(visibleSegments(SEGMENTS, "errored").map((s) => s.value)).toEqual([
      "all",
      "configurable",
      "errored",
    ])
  })

  it("treats an absent count as 'not countable' rather than zero", () => {
    const views: PluginToolbarSegment[] = [
      { value: "permissions", label: "Permissions" },
      { value: "audit", label: "Audit" },
    ]
    expect(visibleSegments(views, "permissions")).toHaveLength(2)
  })

  it("returns an empty list when given no segments", () => {
    expect(visibleSegments([], "all")).toEqual([])
  })
})

describe("PluginSectionToolbar", () => {
  it("renders the search box and reports every keystroke", () => {
    const onChange = jest.fn()
    render(
      <PluginSectionToolbar
        search={{ value: "clip", onChange, placeholder: "Search installed", testId: "search" }}
      />
    )
    const input = screen.getByTestId("search")
    expect(input).toHaveValue("clip")
    fireEvent.change(input, { target: { value: "clipb" } })
    expect(onChange).toHaveBeenCalledWith("clipb")
  })

  it("renders only the surviving segments, with their counts", () => {
    render(
      <PluginSectionToolbar
        segments={{
          ariaLabel: "Status",
          items: SEGMENTS,
          value: "all",
          onSelect: jest.fn(),
          testId: "seg",
        }}
      />
    )
    expect(screen.getByText("All")).toBeInTheDocument()
    expect(screen.getByText("40")).toBeInTheDocument()
    expect(screen.getByText("Configurable")).toBeInTheDocument()
    expect(screen.queryByText("Enabled")).not.toBeInTheDocument()
    expect(screen.queryByText("Errored")).not.toBeInTheDocument()
  })

  it("reports the picked segment", () => {
    const onSelect = jest.fn()
    render(
      <PluginSectionToolbar
        segments={{
          ariaLabel: "Status",
          items: SEGMENTS,
          value: "all",
          onSelect,
          testId: "seg",
        }}
      />
    )
    fireEvent.click(screen.getByTestId("seg-configurable"))
    expect(onSelect).toHaveBeenCalledWith("configurable")
  })

  it("swallows Radix's deselect when the active segment is re-clicked", () => {
    const onSelect = jest.fn()
    render(
      <PluginSectionToolbar
        segments={{
          ariaLabel: "Status",
          items: SEGMENTS,
          value: "all",
          onSelect,
          testId: "seg",
        }}
      />
    )
    fireEvent.click(screen.getByTestId("seg-all"))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("omits the segment control entirely when nothing survives filtering", () => {
    render(
      <PluginSectionToolbar
        segments={{
          ariaLabel: "Status",
          items: [{ value: "enabled", label: "Enabled", count: 0 }],
          value: "all",
          onSelect: jest.fn(),
          testId: "seg",
        }}
      />
    )
    expect(screen.queryByTestId("seg")).not.toBeInTheDocument()
  })

  // `testId` is optional on the segments config, so a section may opt out of
  // per-item hooks. The items still have to render — leaving the attribute
  // off must not cost the caller the control.
  it("renders the segments without per-item test ids when the section omits testId", () => {
    render(
      <PluginSectionToolbar
        segments={{
          ariaLabel: "Status",
          items: [{ value: "all", label: "All", count: 40 }],
          value: "all",
          onSelect: jest.fn(),
        }}
      />
    )
    const item = screen.getByRole("radio", { name: /All/ })
    expect(item).toBeInTheDocument()
    expect(item).not.toHaveAttribute("data-testid")
  })

  it("renders section tools and the status line when supplied", () => {
    render(
      <PluginSectionToolbar tools={<button type="button">Sort</button>} status={<p>3 of 40</p>} />
    )
    expect(screen.getByRole("button", { name: "Sort" })).toBeInTheDocument()
    expect(screen.getByText("3 of 40")).toBeInTheDocument()
  })

  it("renders nothing but its own container when given no slots", () => {
    render(<PluginSectionToolbar />)
    const root = screen.getByTestId("plugin-section-toolbar")
    expect(root).toBeInTheDocument()
    expect(root).not.toHaveTextContent(/\S/)
  })
})

describe("stacked layout", () => {
  // A mobile body has no `FeaturePageHeader` controls slot scrolling on its
  // behalf, and at 375px the one-row form squeezes the search input to a few
  // characters. Stacked gives search its own line and scrolls the rest.
  it("puts the search on its own line and scrolls segments + tools", () => {
    render(
      <PluginSectionToolbar
        layout="stacked"
        search={{ value: "", onChange: () => {}, placeholder: "Search" }}
        segments={{
          ariaLabel: "Status",
          items: [{ value: "all", label: "All", count: 2 }],
          value: "all",
          onSelect: () => {},
        }}
        tools={<button type="button">Filter</button>}
      />
    )
    const controls = screen.getByTestId("plugin-section-toolbar-controls")
    expect(controls.className).toContain("overflow-x-auto")
    expect(controls).toContainElement(screen.getByRole("button", { name: "Filter" }))
    // The search sits outside that scroller, so it keeps its full width.
    expect(controls).not.toContainElement(screen.getByPlaceholderText("Search"))
  })

  it("defaults to the single-row shape", () => {
    render(
      <PluginSectionToolbar
        search={{ value: "", onChange: () => {}, placeholder: "Search" }}
        tools={<button type="button">Filter</button>}
      />
    )
    expect(screen.getByTestId("plugin-section-toolbar")).toHaveAttribute("data-layout", "row")
    expect(screen.queryByTestId("plugin-section-toolbar-controls")).toBeNull()
  })
})
