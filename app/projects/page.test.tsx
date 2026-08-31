/**
 * @jest-environment jsdom
 */

let consoleProps: Record<string, unknown> | null = null
jest.mock("@/components/issues/projects/project-console", () => ({
  ProjectConsole: (props: Record<string, unknown>) => {
    consoleProps = props
    return <div data-testid="project-console-stub" />
  },
}))
let mobileProps: Record<string, unknown> | null = null
jest.mock("@/components/mobile/issues/projects-mobile-body", () => ({
  ProjectsMobileBody: (props: Record<string, unknown>) => {
    mobileProps = props
    return <div data-testid="projects-mobile-stub" />
  },
}))

// Width, not runtime: the desktop table is a seven-column grid.
let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compact }))

let search = new URLSearchParams()
jest.mock("next/navigation", () => ({ useSearchParams: () => search }))

import { render, screen } from "@testing-library/react"
import ProjectsPage from "./page"

beforeEach(() => {
  consoleProps = null
  mobileProps = null
  compact = false
  search = new URLSearchParams()
})

describe("ProjectsPage", () => {
  it("renders the project console inside a definite-height wrapper", () => {
    // Same correction as `/issues`: `data-bg-target` belongs to
    // `FeaturePageShell` now, and the console is stubbed here, so asserting it
    // at this layer could never pass. The wrapper's height chain is what this
    // page actually owns.
    const { container } = render(<ProjectsPage />)
    expect(screen.getByTestId("project-console-stub")).toBeInTheDocument()
    expect(container.firstElementChild?.className).toContain("h-full")
  })

  it("forwards the ?id= deep link", () => {
    search = new URLSearchParams("id=iprj_9")
    render(<ProjectsPage />)
    expect(consoleProps).toMatchObject({ initialSelectedId: "iprj_9" })
  })

  it("passes undefined rather than null when there is no deep link", () => {
    render(<ProjectsPage />)
    expect(consoleProps).toMatchObject({ initialSelectedId: undefined })
  })

  describe("narrow viewport", () => {
    it("renders the read-only body instead of the desktop table", () => {
      compact = true
      render(<ProjectsPage />)
      expect(screen.getByTestId("projects-mobile-stub")).toBeInTheDocument()
      expect(screen.queryByTestId("project-console-stub")).not.toBeInTheDocument()
    })

    it("forwards the deep link there too", () => {
      compact = true
      search = new URLSearchParams("id=iprj_9")
      render(<ProjectsPage />)
      expect(mobileProps).toMatchObject({ initialSelectedId: "iprj_9" })
    })
  })
})
