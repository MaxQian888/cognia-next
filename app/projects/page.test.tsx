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

let platform = "desktop"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }))

let search = new URLSearchParams()
jest.mock("next/navigation", () => ({ useSearchParams: () => search }))

import { render, screen } from "@testing-library/react"
import ProjectsPage from "./page"

beforeEach(() => {
  consoleProps = null
  mobileProps = null
  platform = "desktop"
  search = new URLSearchParams()
})

describe("ProjectsPage", () => {
  it("renders the project console inside the chat-background wrapper", () => {
    const { container } = render(<ProjectsPage />)
    expect(screen.getByTestId("project-console-stub")).toBeInTheDocument()
    expect(container.querySelector("[data-bg-target='chat']")).not.toBeNull()
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

  describe("mobile", () => {
    it("renders the read-only body instead of the desktop table", () => {
      platform = "mobile"
      render(<ProjectsPage />)
      expect(screen.getByTestId("projects-mobile-stub")).toBeInTheDocument()
      expect(screen.queryByTestId("project-console-stub")).not.toBeInTheDocument()
    })

    it("forwards the deep link there too", () => {
      platform = "mobile"
      search = new URLSearchParams("id=iprj_9")
      render(<ProjectsPage />)
      expect(mobileProps).toMatchObject({ initialSelectedId: "iprj_9" })
    })
  })
})
