/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { render, screen } from "@testing-library/react"
import { TrackerTabs, TRACKER_DESTINATIONS } from "./tracker-tabs"

describe("TrackerTabs", () => {
  it("offers the three tracker destinations as links", () => {
    render(<TrackerTabs active="issues" />)
    expect(screen.getByTestId("tracker-nav-issues")).toHaveAttribute("href", "/issues")
    expect(screen.getByTestId("tracker-nav-projects")).toHaveAttribute("href", "/projects")
    expect(screen.getByTestId("tracker-nav-cycles")).toHaveAttribute("href", "/projects?tab=cycles")
    expect(TRACKER_DESTINATIONS.map((d) => d.id)).toEqual(["issues", "projects", "cycles"])
  })

  it("marks the current destination with aria-current, not a pressed state", () => {
    render(<TrackerTabs active="projects" />)
    expect(screen.getByTestId("tracker-nav-projects")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("tracker-nav-issues")).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("tracker-nav-cycles")).not.toHaveAttribute("aria-current")
  })

  it("stretches into equal segments when compact", () => {
    render(<TrackerTabs active="cycles" compact />)
    expect(screen.getByTestId("tracker-nav").className).toContain("w-full")
    expect(screen.getByTestId("tracker-nav-cycles").className).toContain("flex-1")
    expect(screen.getByTestId("tracker-nav-cycles")).toHaveAttribute("aria-current", "page")
  })
})
