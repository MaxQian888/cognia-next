/**
 * @jest-environment jsdom
 */

// The page is a route-layer shell: a width fork plus the `?id=` deep-link
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

// Width, not runtime. The desktop board is a multi-column grid, so a 375px
// browser needs the compact body just as much as a phone does.
let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compact }))

let search = new URLSearchParams()
jest.mock("next/navigation", () => ({ useSearchParams: () => search }))

import { render, screen } from "@testing-library/react"
import IssuesPage from "./page"

beforeEach(() => {
  consoleProps = null
  mobileProps = null
  compact = false
  search = new URLSearchParams()
})

describe("IssuesPage", () => {
  it("renders the desktop console inside a definite-height wrapper", () => {
    // `data-bg-target` is NOT asserted here any more: `FeaturePageShell` took
    // ownership of that attribute from its callers, and the console is stubbed
    // in this suite, so looking for it here tested nothing. What the page does
    // own is the full-height flex column the console's own `h-full` chain
    // resolves against.
    const { container } = render(<IssuesPage />)
    expect(screen.getByTestId("issue-console-stub")).toBeInTheDocument()
    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain("h-full")
    expect(wrapper?.className).toContain("min-h-0")
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

  it("renders the read-only compact body on a narrow viewport", () => {
    compact = true
    search = new URLSearchParams("id=iss_7")
    render(<IssuesPage />)
    expect(screen.getByTestId("issues-mobile-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("issue-console-stub")).not.toBeInTheDocument()
    expect(mobileProps).toMatchObject({ initialSelectedId: "iss_7" })
  })

  it("renders the desktop console on a wide viewport", () => {
    compact = false
    render(<IssuesPage />)
    expect(screen.getByTestId("issue-console-stub")).toBeInTheDocument()
  })

  it("forwards the ?project= deep link, which is what /projects links into", () => {
    search = new URLSearchParams("project=iprj_9")
    render(<IssuesPage />)
    expect(consoleProps).toMatchObject({ initialProjectId: "iprj_9" })
  })

  it("passes undefined when there is no container deep link", () => {
    render(<IssuesPage />)
    expect(consoleProps).toMatchObject({ initialProjectId: undefined })
  })
})
