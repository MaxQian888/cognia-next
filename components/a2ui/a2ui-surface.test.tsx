/**
 * Tests for A2UI Surface Components
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UISurface, A2UIInlineSurface, A2UIDialogSurface } from "./a2ui-surface"
import type { A2UISurfaceState } from "@/types/a2ui/schema"

// Mock components
const mockDeleteSurface = jest.fn()

const mockSurface: A2UISurfaceState = {
  id: "test-surface",
  type: "inline",
  ready: true,
  rootId: "root",
  components: {
    root: { id: "root", component: "Column", children: [] },
  },
  dataModel: {},
  catalogId: "default",
  createdAt: 0,
  updatedAt: 0,
}

const mockLoadingSurfaces = new Set<string>()
const mockErrors: Record<string, string> = {}
const mockRuntimeSettings = {
  a2uiDefaultCatalogId: "cognia-standard-v1",
  a2uiDefaultHostStrategy: "lazy-runtime" as const,
  a2uiDefaultTheme: "dark" as const,
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: jest.fn((selector) => {
    const state = {
      surfaces: { "test-surface": mockSurface },
      loadingSurfaces: Object.fromEntries([...mockLoadingSurfaces].map((k) => [k, true])),
      streamingSurfaces: {} as Record<string, boolean>,
      errors: mockErrors,
      deleteSurface: mockDeleteSurface,
    }
    return selector(state)
  }),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector) => selector({ settings: mockRuntimeSettings })),
}))

jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: {
    onAction: jest.fn(() => jest.fn()),
    onDataChange: jest.fn(() => jest.fn()),
  },
}))

jest.mock("./a2ui-context", () => ({
  A2UIProvider: ({ children, catalogId }: { children: React.ReactNode; catalogId: string }) => (
    <div data-testid="a2ui-provider" data-catalog-id={catalogId}>
      {children}
    </div>
  ),
}))

jest.mock("./a2ui-renderer", () => ({
  A2UIRenderer: ({ component }: { component: { id: string } }) => (
    <div data-testid={`renderer-${component.id}`}>Rendered: {component.id}</div>
  ),
}))

jest.mock("@/lib/utils", () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}))

describe("A2UISurface", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLoadingSurfaces.clear()
    Object.keys(mockErrors).forEach((key) => delete mockErrors[key])
    mockSurface.catalogId = "default"
    delete mockSurface.widget
    delete mockSurface.title
  })

  it("should render surface with root component", () => {
    render(<A2UISurface surfaceId="test-surface" />)

    expect(screen.getByTestId("a2ui-provider")).toBeInTheDocument()
    expect(screen.getByTestId("renderer-root")).toBeInTheDocument()
  })

  it("wraps widget-configured surfaces in the shared widget shell", () => {
    mockSurface.widget = {
      hostStrategy: "native",
      showChrome: true,
    }
    mockSurface.title = "Structured Widget"

    render(<A2UISurface surfaceId="test-surface" />)

    expect(screen.getByTestId("a2ui-widget-shell")).toBeInTheDocument()
    expect(screen.getByText("Structured Widget")).toBeInTheDocument()
    expect(screen.getByText("native")).toBeInTheDocument()

    delete mockSurface.widget
    delete mockSurface.title
  })

  it("applies runtime catalog and widget defaults only when surface fields are omitted", () => {
    delete mockSurface.catalogId
    mockSurface.widget = { minHeight: 180 }

    render(<A2UISurface surfaceId="test-surface" />)

    expect(screen.getByTestId("a2ui-provider")).toHaveAttribute(
      "data-catalog-id",
      "cognia-standard-v1"
    )
    expect(screen.getByTestId("a2ui-widget-shell")).toHaveAttribute(
      "data-host-strategy",
      "lazy-runtime"
    )
    expect(screen.getByTestId("a2ui-widget-shell")).toHaveAttribute("data-theme", "dark")
    expect(screen.getByTestId("a2ui-widget-shell")).toHaveStyle({ minHeight: "180px" })
  })

  it("preserves explicit surface catalog and widget fields", () => {
    mockSurface.catalogId = "late-plugin-catalog"
    mockSurface.widget = { hostStrategy: "native", theme: "light" }

    render(<A2UISurface surfaceId="test-surface" />)

    expect(screen.getByTestId("a2ui-provider")).toHaveAttribute(
      "data-catalog-id",
      "late-plugin-catalog"
    )
    expect(screen.getByTestId("a2ui-widget-shell")).toHaveAttribute("data-host-strategy", "native")
    expect(screen.getByTestId("a2ui-widget-shell")).toHaveAttribute("data-theme", "light")
  })

  it("should return null when surface not found", () => {
    const { useA2UIStore } = jest.requireMock("@/stores/a2ui")
    useA2UIStore.mockImplementationOnce((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        surfaces: {},
        loadingSurfaces: new Set(),
        errors: {},
      })
    )

    const { container } = render(<A2UISurface surfaceId="non-existent" />)
    expect(container.firstChild).toBeNull()
  })

  it("should show loading state when surface is loading", () => {
    mockLoadingSurfaces.add("test-surface")

    render(<A2UISurface surfaceId="test-surface" showLoading={true} />)

    expect(screen.getByText("Loading...")).toBeInTheDocument()
  })

  it("should show custom loading text", () => {
    mockLoadingSurfaces.add("test-surface")

    render(<A2UISurface surfaceId="test-surface" showLoading={true} loadingText="Please wait..." />)

    expect(screen.getByText("Please wait...")).toBeInTheDocument()
  })

  it("should not show loading when showLoading is false", () => {
    mockLoadingSurfaces.add("test-surface")

    const { container } = render(<A2UISurface surfaceId="test-surface" showLoading={false} />)

    expect(container.querySelector(".animate-spin")).toBeNull()
  })

  it("should show error state", () => {
    mockErrors["test-surface"] = "Something went wrong"

    render(<A2UISurface surfaceId="test-surface" />)

    expect(screen.getByText("Error loading surface")).toBeInTheDocument()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
  })

  it("should show loading spinner when not ready", () => {
    const { useA2UIStore } = jest.requireMock("@/stores/a2ui")
    useA2UIStore.mockImplementationOnce((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        surfaces: {
          "test-surface": { ...mockSurface, ready: false },
        },
        loadingSurfaces: new Set(),
        errors: {},
      })
    )

    const { container } = render(<A2UISurface surfaceId="test-surface" />)
    expect(container.querySelector(".animate-spin")).toBeInTheDocument()
  })

  it("should show no content message when no root component", () => {
    const { useA2UIStore } = jest.requireMock("@/stores/a2ui")
    useA2UIStore.mockImplementationOnce((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        surfaces: {
          "test-surface": { ...mockSurface, components: {} },
        },
        loadingSurfaces: new Set(),
        errors: {},
      })
    )

    render(<A2UISurface surfaceId="test-surface" />)
    expect(screen.getByText("No content to display")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const { container } = render(<A2UISurface surfaceId="test-surface" className="custom-class" />)

    expect(container.firstChild).toHaveClass("custom-class")
  })

  it("should subscribe to events when callbacks provided", () => {
    const onAction = jest.fn()
    const onDataChange = jest.fn()

    render(<A2UISurface surfaceId="test-surface" onAction={onAction} onDataChange={onDataChange} />)

    const { globalEventEmitter } = jest.requireMock("@/lib/a2ui/events")
    expect(globalEventEmitter.onAction).toHaveBeenCalled()
    expect(globalEventEmitter.onDataChange).toHaveBeenCalled()
  })
})

describe("A2UIInlineSurface", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLoadingSurfaces.clear()
    Object.keys(mockErrors).forEach((key) => delete mockErrors[key])
    mockSurface.catalogId = "default"
    delete mockSurface.widget
    delete mockSurface.title
  })

  it("should render with inline styles", () => {
    const { container } = render(<A2UIInlineSurface surfaceId="test-surface" />)

    expect(container.firstChild).toHaveClass("rounded-lg")
    expect(container.firstChild).toHaveClass("border")
    expect(container.firstChild).toHaveClass("bg-card")
  })

  it("should apply custom className", () => {
    const { container } = render(
      <A2UIInlineSurface surfaceId="test-surface" className="my-custom" />
    )

    expect(container.firstChild).toHaveClass("my-custom")
  })

  it("should disable loading by default", () => {
    mockLoadingSurfaces.add("test-surface")

    render(<A2UIInlineSurface surfaceId="test-surface" />)

    // Loading should not be shown (showLoading=false by default)
    expect(screen.queryByText("Loading...")).toBeNull()
  })
})

describe("A2UIDialogSurface", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLoadingSurfaces.clear()
    Object.keys(mockErrors).forEach((key) => delete mockErrors[key])
    mockSurface.catalogId = "default"
    delete mockSurface.widget
    delete mockSurface.title
  })

  it("should render with dialog styles", () => {
    const { container } = render(<A2UIDialogSurface surfaceId="test-surface" />)

    expect(container.firstChild).toHaveClass("fixed")
    expect(container.firstChild).toHaveClass("inset-0")
    expect(container.firstChild).toHaveClass("z-50")
  })

  it("uses the localized fallback dialog label when the surface has no title", () => {
    delete mockSurface.title

    render(<A2UIDialogSurface surfaceId="test-surface" />)

    expect(screen.getByRole("dialog", { name: "A2UI dialog" })).toBeInTheDocument()
  })

  it("should close dialog on backdrop click", () => {
    const { container } = render(<A2UIDialogSurface surfaceId="test-surface" />)

    const backdrop = container.firstChild as HTMLElement
    fireEvent.click(backdrop)

    expect(mockDeleteSurface).toHaveBeenCalledWith("test-surface")
  })

  it("should not close on content click", () => {
    render(<A2UIDialogSurface surfaceId="test-surface" />)

    const content = screen.getByTestId("a2ui-provider")
    fireEvent.click(content)

    expect(mockDeleteSurface).not.toHaveBeenCalled()
  })

  it("should apply custom className", () => {
    const { container } = render(
      <A2UIDialogSurface surfaceId="test-surface" className="custom-dialog" />
    )

    expect(container.firstChild).toHaveClass("custom-dialog")
  })
})
