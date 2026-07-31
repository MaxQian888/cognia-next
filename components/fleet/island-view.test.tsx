/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { IslandView } from "./island-view"

jest.mock("./island-shell", () => ({
  IslandShell: () => <div data-testid="island-shell-stub" />,
}))

const cancelReveal = jest.fn()
const revealMock = jest.fn(() => cancelReveal)
jest.mock("@/lib/pet/reveal", () => ({
  schedulePetWindowReveal: () => revealMock(),
}))

describe("IslandView", () => {
  it("marks <html> transparent, schedules the reveal, and cleans both up", () => {
    const { unmount } = render(<IslandView />)
    expect(screen.getByTestId("island-shell-stub")).toBeInTheDocument()
    expect(document.documentElement.getAttribute("data-island-overlay")).toBe("true")
    expect(revealMock).toHaveBeenCalled()
    unmount()
    expect(document.documentElement.hasAttribute("data-island-overlay")).toBe(false)
    expect(cancelReveal).toHaveBeenCalled()
  })
})
