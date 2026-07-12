/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { SubPageShell } from "./sub-page-shell"

const backMock = jest.fn()
const replaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ back: backMock, replace: replaceMock, push: jest.fn() }),
}))

describe("<SubPageShell />", () => {
  beforeEach(() => {
    backMock.mockReset()
    replaceMock.mockReset()
  })

  it("renders the title, back link, and children", () => {
    render(
      <SubPageShell title="同步状态" backAria="Back to Me" testid="shell-sync">
        <div data-testid="body">body content</div>
      </SubPageShell>
    )
    expect(screen.getByText("同步状态")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
    const back = screen.getByTestId("mobile-sub-page-back")
    expect(back).toHaveAttribute("aria-label", "Back to Me")
  })

  it("back pops history when there is an entry to pop", () => {
    // jsdom starts with history.length ≥ 1; push one entry so length > 1.
    window.history.pushState(null, "", "/me/backup")
    render(
      <SubPageShell title="备份" backAria="Back">
        body
      </SubPageShell>
    )
    fireEvent.click(screen.getByTestId("mobile-sub-page-back"))
    // Popping (not pushing `/me`) keeps hardware-back from returning the
    // user to the subpage they just left.
    expect(backMock).toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("falls back to replace(backHref) when history has nothing to pop", () => {
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)
    try {
      render(
        <SubPageShell title="离线" backAria="Back" backHref="/">
          body
        </SubPageShell>
      )
      fireEvent.click(screen.getByTestId("mobile-sub-page-back"))
      expect(replaceMock).toHaveBeenCalledWith("/")
      expect(backMock).not.toHaveBeenCalled()
    } finally {
      lengthSpy.mockRestore()
    }
  })

  it("renders the headerAccessory slot when provided", () => {
    render(
      <SubPageShell
        title="Connectors"
        backAria="Back"
        headerAccessory={<div data-testid="accessory">badge</div>}
      >
        body
      </SubPageShell>
    )
    expect(screen.getByTestId("accessory")).toBeInTheDocument()
  })

  it("respects bodyClassName override", () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back" bodyClassName="px-2 py-2">
        body
      </SubPageShell>
    )
    expect(container.querySelector("section")?.className).toMatch(/px-2/)
  })

  it("centers content within a max width on large screens", () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back">
        body
      </SubPageShell>
    )
    // Body section + header inner row both clamp to a centered max width so
    // the page reads correctly on tablets / landscape, not edge-to-edge.
    expect(container.querySelector("section")?.className).toMatch(/max-w-2xl/)
    expect(container.querySelector("header > div")?.className).toMatch(/max-w-2xl/)
  })

  it("keeps the default width without the lg relaxation", () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back">
        body
      </SubPageShell>
    )
    expect(container.querySelector("section")?.className).not.toMatch(/lg:max-w-4xl/)
    expect(container.querySelector("header > div")?.className).not.toMatch(/lg:max-w-4xl/)
  })

  it('relaxes the clamp to lg:max-w-4xl when width="wide"', () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back" width="wide">
        body
      </SubPageShell>
    )
    // Both the body and the sticky header widen together so the back button
    // stays aligned with the content edge on large tablets.
    expect(container.querySelector("section")?.className).toMatch(/max-w-2xl/)
    expect(container.querySelector("section")?.className).toMatch(/lg:max-w-4xl/)
    expect(container.querySelector("header > div")?.className).toMatch(/lg:max-w-4xl/)
  })
})
