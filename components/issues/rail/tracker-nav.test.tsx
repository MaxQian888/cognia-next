/**
 * @jest-environment jsdom
 */

/**
 * The switcher that makes `/issues` and `/projects` read as one subsystem
 * rather than as two unrelated pages in two navigation groups.
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}))

import { render, screen } from "@testing-library/react"

import { TrackerNav } from "./tracker-nav"

describe("TrackerNav", () => {
  it("offers both tracker destinations", () => {
    render(<TrackerNav active="issues" />)

    expect(screen.getByTestId("tracker-nav-issues")).toHaveAttribute("href", "/issues")
    expect(screen.getByTestId("tracker-nav-projects")).toHaveAttribute("href", "/projects")
  })

  it("marks the current route with aria-current, not a pressed state", () => {
    // These are links. The active one is where you already are, which is
    // `aria-current="page"`, not a toggle that happens to be down.
    render(<TrackerNav active="projects" />)

    expect(screen.getByTestId("tracker-nav-projects")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("tracker-nav-issues")).not.toHaveAttribute("aria-current")
  })

  it("moves the marker with the active route", () => {
    const { rerender } = render(<TrackerNav active="issues" />)
    expect(screen.getByTestId("tracker-nav-issues")).toHaveAttribute("aria-current", "page")

    rerender(<TrackerNav active="projects" />)
    expect(screen.getByTestId("tracker-nav-issues")).not.toHaveAttribute("aria-current")
  })

  it("is a landmark, so the rail's filter sections stay a separate region", () => {
    render(<TrackerNav active="issues" />)
    expect(screen.getByRole("navigation")).toBeInTheDocument()
  })
})
