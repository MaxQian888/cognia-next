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
})
