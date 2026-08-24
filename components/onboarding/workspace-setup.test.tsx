import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Project } from "@/types"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("@/components/workspace/new-workspace-dialog", () => ({
  NewWorkspaceDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-workspace-dialog" /> : null,
}))

import { useProjectStore } from "@/stores/project/project-store"
import { WorkspaceSetup } from "./workspace-setup"

function seed(root?: string) {
  const project = {
    id: "project-1",
    name: "App",
    roots: root ? [{ id: "r1", path: root, isPrimary: true }] : [],
  } as unknown as Project
  useProjectStore.setState({ projects: [project], activeProjectId: "project-1", loaded: true })
}

describe("WorkspaceSetup", () => {
  it("names the folder the agent will work in once there is one", () => {
    seed("/Users/x/Projects/App")
    render(<WorkspaceSetup hasNativePicker={() => true} openFolder={jest.fn()} />)
    expect(screen.getByTestId("onboarding-workspace-root")).toHaveTextContent(
      "/Users/x/Projects/App"
    )
  })

  it("says so when there is no folder yet", () => {
    // A fresh install lands on a rootless Default workspace, so the first file
    // the agent is asked to touch has nowhere to be.
    seed()
    render(<WorkspaceSetup hasNativePicker={() => true} openFolder={jest.fn()} />)
    expect(screen.getByTestId("onboarding-workspace-root")).toHaveTextContent("emptyDescription")
  })

  it("opens a folder through the shared workspace sink", async () => {
    seed()
    const openFolder = jest.fn(async () => undefined)
    render(<WorkspaceSetup hasNativePicker={() => true} openFolder={openFolder} />)
    fireEvent.click(screen.getByTestId("onboarding-workspace-open"))
    await waitFor(() => expect(openFolder).toHaveBeenCalled())
  })

  it("offers creation on every shell, and browsing only where a picker exists", () => {
    seed()
    const { unmount } = render(<WorkspaceSetup hasNativePicker={() => false} />)
    expect(screen.queryByTestId("onboarding-workspace-open")).not.toBeInTheDocument()
    expect(screen.getByTestId("onboarding-workspace-create")).toBeInTheDocument()
    unmount()

    render(<WorkspaceSetup hasNativePicker={() => true} />)
    expect(screen.getByTestId("onboarding-workspace-open")).toBeInTheDocument()
  })

  it("opens the create dialog", () => {
    seed()
    render(<WorkspaceSetup hasNativePicker={() => true} />)
    expect(screen.queryByTestId("new-workspace-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("onboarding-workspace-create"))
    expect(screen.getByTestId("new-workspace-dialog")).toBeInTheDocument()
  })
})
