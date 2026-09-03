/**
 * @jest-environment jsdom
 */

jest.mock("@/components/workspace/workspace-overview", () => ({
  WorkspaceOverview: () => <div data-testid="workspace-overview-stub" />,
  WORKSPACE_TABS: ["overview", "environments", "capabilities"] as const,
}))

const replaceMock = jest.fn()
let params = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: jest.fn() }),
  usePathname: () => "/workspace",
  useSearchParams: () => params,
}))

import { render, screen } from "@testing-library/react"
import WorkspacePage from "./page"

beforeEach(() => {
  params = new URLSearchParams()
  replaceMock.mockReset()
})

describe("WorkspacePage", () => {
  it("renders the overview inside the chat-background wrapper", () => {
    const { container } = render(<WorkspacePage />)
    expect(screen.getByTestId("workspace-overview-stub")).toBeInTheDocument()
    const wrapper = container.querySelector("[data-bg-target='chat']")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain("h-full")
  })

  /**
   * `?tab=source-control` used to mount the whole panel inside this page. It is
   * its own route now, and without the redirect an existing link would land on
   * Overview instead, which reads as the feature having been removed.
   */
  it("sends the retired source-control tab to its own route", () => {
    params = new URLSearchParams({ tab: "source-control" })
    render(<WorkspacePage />)
    expect(replaceMock).toHaveBeenCalledWith("/source-control")
  })

  it("leaves a tab it still owns alone", () => {
    params = new URLSearchParams({ tab: "environments" })
    render(<WorkspacePage />)
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
