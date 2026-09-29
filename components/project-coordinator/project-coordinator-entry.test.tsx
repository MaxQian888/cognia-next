/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Project } from "@/types"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))
jest.mock("@/lib/project-coordinator/user-actions", () => ({
  enableProjectCoordination: jest.fn(async () => ({ id: "coord" })),
  disableProjectCoordination: jest.fn(),
}))
jest.mock("@/lib/project-coordinator/coordinator-session", () => ({
  ensureCoordinatorSession: jest.fn(async () => ({ id: "coord" })),
}))

import { useProjectStore } from "@/stores/project/project-store"
import {
  disableProjectCoordination,
  enableProjectCoordination,
} from "@/lib/project-coordinator/user-actions"
import { ensureCoordinatorSession } from "@/lib/project-coordinator/coordinator-session"
import { ProjectCoordinatorEntry } from "./project-coordinator-entry"

function setProject(coordinator?: Project["coordinator"]) {
  useProjectStore.setState({
    projects: [{ id: "p1", name: "W", coordinator } as Project],
  })
}

beforeEach(() => jest.clearAllMocks())

describe("ProjectCoordinatorEntry", () => {
  it("turns coordination on and opens the coordinator", async () => {
    setProject(undefined)
    render(<ProjectCoordinatorEntry workspaceId="p1" />)
    fireEvent.click(screen.getByTestId("project-coordination-enable"))
    await waitFor(() =>
      expect(enableProjectCoordination).toHaveBeenCalledWith("p1", "Project coordinator")
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringContaining("coord")))
  })

  it("shows the goal, opens the existing coordinator and can turn off", async () => {
    setProject({ enabled: true, goal: "Ship it", icon: "🚀" })
    render(<ProjectCoordinatorEntry workspaceId="p1" />)
    expect(screen.getByText("Ship it")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("project-coordination-open"))
    await waitFor(() =>
      expect(ensureCoordinatorSession).toHaveBeenCalledWith({
        projectId: "p1",
        title: "Project coordinator",
      })
    )
    fireEvent.click(screen.getByTestId("project-coordination-disable"))
    expect(disableProjectCoordination).toHaveBeenCalledWith("p1")
  })

  it("reports a failure to turn on", async () => {
    setProject(undefined)
    ;(enableProjectCoordination as jest.Mock).mockRejectedValueOnce(new Error("nope"))
    render(<ProjectCoordinatorEntry workspaceId="p1" />)
    fireEvent.click(screen.getByTestId("project-coordination-enable"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Coordination could not be turned on: nope")
    )
    expect(screen.getByText(/No goal set|splits work/)).toBeInTheDocument()
  })
})
