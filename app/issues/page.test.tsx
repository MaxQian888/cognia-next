/**
 * @jest-environment jsdom
 */

// The page is a route-layer shell: a platform fork plus the `?id=` deep-link
// read. Mock both bodies so the test stays at that layer.
let consoleProps: Record<string, unknown> | null = null
let mobileProps: Record<string, unknown> | null = null
jest.mock("@/components/issues/issue-console", () => ({
  IssueConsole: (props: Record<string, unknown>) => {
    consoleProps = props
    return <div data-testid="issue-console-stub" />
  },
}))
jest.mock("@/components/mobile/issues/issues-mobile-body", () => ({
  IssuesMobileBody: (props: Record<string, unknown>) => {
    mobileProps = props
    return <div data-testid="issues-mobile-stub" />
  },
}))

let platform = "tauri"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }))

let search = new URLSearchParams()
jest.mock("next/navigation", () => ({ useSearchParams: () => search }))

import { render, screen } from "@testing-library/react"
import IssuesPage from "./page"

beforeEach(() => {
  consoleProps = null
  mobileProps = null
  platform = "tauri"
  search = new URLSearchParams()
})

describe("IssuesPage", () => {
  it("renders the desktop console inside the chat-background wrapper", () => {
    const { container } = render(<IssuesPage />)
    expect(screen.getByTestId("issue-console-stub")).toBeInTheDocument()
    const wrapper = container.querySelector("[data-bg-target='chat']")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain("h-full")
  })

  it("forwards the ?id= deep link, since a static export has no [id] route", () => {
    search = new URLSearchParams("id=iss_42")
    render(<IssuesPage />)
    expect(consoleProps).toMatchObject({ initialSelectedId: "iss_42" })
  })

  it("passes undefined rather than null when there is no deep link", () => {
    render(<IssuesPage />)
    expect(consoleProps).toMatchObject({ initialSelectedId: undefined })
  })

  it("renders the read-only mobile body on the Capacitor shell", () => {
    platform = "mobile"
    search = new URLSearchParams("id=iss_7")
    render(<IssuesPage />)
    expect(screen.getByTestId("issues-mobile-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("issue-console-stub")).not.toBeInTheDocument()
    expect(mobileProps).toMatchObject({ initialSelectedId: "iss_7" })
  })

  it("renders the desktop console on web", () => {
    platform = "web"
    render(<IssuesPage />)
    expect(screen.getByTestId("issue-console-stub")).toBeInTheDocument()
  })
})
