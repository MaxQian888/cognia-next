/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Project } from "@/types"

// next-intl is globally mocked against en.json in jest.setup.ts.

jest.mock("@/lib/project-coordinator/pause", () => ({
  pauseProject: jest.fn(async () => undefined),
  resumeProject: jest.fn(async () => undefined),
}))

import { useProjectStore } from "@/stores/project/project-store"
import { resumeProject } from "@/lib/project-coordinator/pause"
import { ProjectPausedBanner } from "./project-paused-banner"

function setProject(coordinator?: Project["coordinator"]) {
  useProjectStore.setState({ projects: [{ id: "p1", name: "W", coordinator } as Project] })
}

beforeEach(() => jest.clearAllMocks())

describe("ProjectPausedBanner", () => {
  it("renders nothing while the project runs", () => {
    setProject({ enabled: true })
    const { container } = render(<ProjectPausedBanner projectId="p1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says the project is paused, why, and resumes it", async () => {
    setProject({ enabled: true, paused: { at: Date.now() - 60_000, reason: "over budget" } })
    render(<ProjectPausedBanner projectId="p1" />)
    const banner = screen.getByTestId("project-paused-banner")
    expect(banner).toHaveTextContent("Project paused")
    expect(banner).toHaveTextContent("Reason: over budget")
    fireEvent.click(screen.getByTestId("project-resume"))
    await waitFor(() => expect(resumeProject).toHaveBeenCalledWith("p1"))
  })
})
