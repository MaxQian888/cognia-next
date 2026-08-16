/**
 * @jest-environment jsdom
 */

jest.mock("@/components/workspace/workspace-overview", () => ({
  WorkspaceOverview: () => <div data-testid="workspace-overview-stub" />,
}))

import { render, screen } from "@testing-library/react"
import WorkspacePage from "./page"

describe("WorkspacePage", () => {
  it("renders the overview inside the chat-background wrapper", () => {
    const { container } = render(<WorkspacePage />)
    expect(screen.getByTestId("workspace-overview-stub")).toBeInTheDocument()
    const wrapper = container.querySelector("[data-bg-target='chat']")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain("h-full")
  })
})
