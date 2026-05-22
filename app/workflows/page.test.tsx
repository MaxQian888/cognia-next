/**
 * @jest-environment jsdom
 *
 * The page is a 6-line shell that delegates to either the desktop or mobile
 * workflow library based on platform. We mock both bodies + `usePlatform` so
 * the test stays at the route layer, verifying the wallpaper-scope marker
 * (`data-bg-target="canvas"`) on the desktop wrapper.
 */

jest.mock("@/components/workflow/library/workflow-library", () => ({
  WorkflowLibrary: () => <div data-testid="workflow-library-stub" />,
}))

jest.mock("@/components/mobile/workflow/workflow-list", () => ({
  WorkflowList: () => <div data-testid="workflow-list-mobile-stub" />,
}))

let mockPlatform: "mobile" | "desktop" = "desktop"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockPlatform,
}))

import { render, screen } from "@testing-library/react"
import WorkflowsLibraryPage from "./page"

describe("WorkflowsLibraryPage", () => {
  it("renders the desktop library inside a canvas-scoped wrapper", () => {
    mockPlatform = "desktop"
    const { container } = render(<WorkflowsLibraryPage />)
    expect(screen.getByTestId("workflow-library-stub")).toBeInTheDocument()
    const wrapper = container.querySelector("[data-bg-target='canvas']")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain("h-full")
  })

  it("renders the mobile list directly on mobile (no canvas wrapper)", () => {
    mockPlatform = "mobile"
    const { container } = render(<WorkflowsLibraryPage />)
    expect(screen.getByTestId("workflow-list-mobile-stub")).toBeInTheDocument()
    expect(container.querySelector("[data-bg-target='canvas']")).toBeNull()
  })
})
