/**
 * @jest-environment jsdom
 *
 * The page is a 6-line shell that delegates to either the desktop or mobile
 * workflow library based on viewport. We mock both bodies + `useIsMobile` so
 * the test stays at the route layer, verifying the wallpaper-scope marker
 * (`data-bg-target="canvas"`) on the desktop wrapper.
 */

jest.mock("@/components/workflow/library/workflow-library", () => ({
  WorkflowLibrary: () => <div data-testid="workflow-library-stub" />,
}))

jest.mock("@/components/mobile/workflow/workflow-list", () => ({
  WorkflowList: () => <div data-testid="workflow-list-mobile-stub" />,
}))

let mockIsMobile = false
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}))

import { render, screen } from "@testing-library/react"
import WorkflowsLibraryPage from "./page"

describe("WorkflowsLibraryPage", () => {
  it("renders the desktop library inside a canvas-scoped wrapper", () => {
    mockIsMobile = false
    const { container } = render(<WorkflowsLibraryPage />)
    expect(screen.getByTestId("workflow-library-stub")).toBeInTheDocument()
    const wrapper = container.querySelector("[data-bg-target='canvas']")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain("h-full")
  })

  it("renders the mobile list directly on mobile (no canvas wrapper)", () => {
    mockIsMobile = true
    const { container } = render(<WorkflowsLibraryPage />)
    expect(screen.getByTestId("workflow-list-mobile-stub")).toBeInTheDocument()
    expect(container.querySelector("[data-bg-target='canvas']")).toBeNull()
  })
})
