/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { ResponsiveDetailSheet } from "./responsive-detail-sheet"

const useIsMobileMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => useIsMobileMock(),
}))

beforeEach(() => {
  useIsMobileMock.mockReset().mockReturnValue(false)
})

describe("ResponsiveDetailSheet", () => {
  it("renders a right-side Sheet with title, description, and children on desktop", () => {
    render(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="My title" description="Summary">
        <p>body content</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByTestId("responsive-detail-sheet")).toBeInTheDocument()
    expect(screen.queryByTestId("responsive-detail-drawer")).toBeNull()
    expect(screen.getByText("My title")).toBeInTheDocument()
    expect(screen.getByText("Summary")).toBeInTheDocument()
    expect(screen.getByText("body content")).toBeInTheDocument()
  })

  it("renders a bottom Drawer on mobile with the same content", () => {
    useIsMobileMock.mockReturnValue(true)
    render(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="My title" description="Summary">
        <p>body content</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByTestId("responsive-detail-drawer")).toBeInTheDocument()
    expect(screen.queryByTestId("responsive-detail-sheet")).toBeNull()
    expect(screen.getByText("My title")).toBeInTheDocument()
    expect(screen.getByText("body content")).toBeInTheDocument()
  })

  it("omits the description line when not provided and renders headerExtra", () => {
    render(
      <ResponsiveDetailSheet
        open
        onOpenChange={() => {}}
        title="T"
        headerExtra={<button>extra action</button>}
      >
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByRole("button", { name: "extra action" })).toBeInTheDocument()
  })

  it("renders nothing while closed", () => {
    render(
      <ResponsiveDetailSheet open={false} onOpenChange={() => {}} title="Hidden">
        <p>hidden body</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.queryByText("hidden body")).toBeNull()
  })

  it("keeps the header for assistive tech only when headerVisuallyHidden", () => {
    const { rerender } = render(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="Goal · active" description="d">
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByText("Goal · active").parentElement).not.toHaveClass("sr-only")
    rerender(
      <ResponsiveDetailSheet
        open
        onOpenChange={() => {}}
        title="Goal · active"
        description="d"
        headerVisuallyHidden
      >
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    // Still named for screen readers, just not painted.
    expect(screen.getByRole("dialog", { name: "Goal · active" })).toBeInTheDocument()
    expect(screen.getByText("Goal · active").parentElement).toHaveClass("sr-only")
    expect(screen.getByText("d").parentElement).toHaveClass("sr-only")
  })

  it("hides the drawer header visually on mobile too", () => {
    useIsMobileMock.mockReturnValue(true)
    render(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="T" headerVisuallyHidden>
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByText("T").parentElement).toHaveClass("sr-only")
  })

  it("draws the corner close button by default and omits it with showCloseButton=false", () => {
    const { rerender } = render(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="T">
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument()
    rerender(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="T" showCloseButton={false}>
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
  })

  it("merges contentClassName into the sheet and drawer content", () => {
    const { unmount } = render(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="T" contentClassName="gap-0 p-0">
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByTestId("responsive-detail-sheet")).toHaveClass("gap-0", "p-0", "w-full")
    unmount()
    useIsMobileMock.mockReturnValue(true)
    render(
      <ResponsiveDetailSheet open onOpenChange={() => {}} title="T" contentClassName="p-0">
        <p>x</p>
      </ResponsiveDetailSheet>
    )
    expect(screen.getByTestId("responsive-detail-drawer")).toHaveClass("p-0", "max-h-[85vh]")
  })
})
