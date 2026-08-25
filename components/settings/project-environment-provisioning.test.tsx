/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Project } from "@/types"

let mockProjects: Array<Partial<Project>> = []

// `mock`-prefixed so the hoisted `jest.mock` factory may close over it.
const mockUpdateProject = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ projects: mockProjects }),
    { getState: () => ({ projects: mockProjects, updateProject: mockUpdateProject }) }
  ),
}))

import { ProjectEnvironmentProvisioning } from "./project-environment-provisioning"

const ALL = [
  { name: "package.json", isDir: false },
  { name: "pnpm-lock.yaml", isDir: false },
  { name: "Cargo.toml", isDir: false },
  { name: "node_modules", isDir: true },
  { name: ".env", isDir: false },
]
const VISIBLE = ALL.filter((entry) => !["node_modules", ".env"].includes(entry.name))

function deps(over: Record<string, unknown> = {}) {
  return {
    listRoot: jest.fn(async (_root: string, includeIgnored: boolean) =>
      includeIgnored ? ALL : VISIBLE
    ),
    probePnpm: jest.fn(async () => "unsupported" as const),
    applyToWorkspace: mockUpdateProject,
    ...over,
  }
}

function renderCard(over: Record<string, unknown> = {}) {
  return render(
    <ProjectEnvironmentProvisioning
      projectId="p1"
      executionRoot="/repos/app"
      deps={deps(over) as never}
    />
  )
}

beforeEach(() => {
  mockProjects = [{ id: "p1" }]
  mockUpdateProject.mockClear()
})

describe("ProjectEnvironmentProvisioning", () => {
  it("states the cost of each suggestion next to the suggestion", async () => {
    // "Approve" next to a directory name is not a decision anyone can make.
    // The consequence — your own checkout changes — has to be on the row.
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("project-environment-provisioning")).toHaveAttribute(
        "data-state",
        "offered"
      )
    )
    const link = screen.getByTestId("provisioning-candidate-cacheLink:node_modules")
    expect(link).toHaveTextContent("Link node_modules from this checkout")
    expect(link).toHaveTextContent("changes what you are working in")
    expect(link).toHaveTextContent("pnpm-lock.yaml")

    const target = screen.getByTestId("provisioning-candidate-cacheLink:target")
    expect(target).toHaveTextContent("rebuild over each other")
    expect(screen.getByTestId("provisioning-candidate-include:.env")).toHaveTextContent(
      "holds credentials"
    )
  })

  it("applies nothing until a person accepts", async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId("provisioning-accept-all")).toBeInTheDocument())
    expect(mockUpdateProject).not.toHaveBeenCalled()

    await userEvent.click(screen.getAllByRole("button", { name: "Use it" })[0])
    expect(mockUpdateProject).toHaveBeenCalledWith("p1", {
      workspaceProvisioning: {
        accepted: ["cacheLink:node_modules"],
        reviewed: ["cacheLink:node_modules"],
      },
    })
  })

  it("keeps a declined suggestion reachable instead of hiding it forever", async () => {
    mockProjects = [
      { id: "p1", workspaceProvisioning: { accepted: [], reviewed: ["include:.env"] } },
    ]
    renderCard()
    await waitFor(() => expect(screen.getByTestId("provisioning-declined")).toBeInTheDocument())
    // Not re-offered in the pending list...
    expect(screen.getByTestId("provisioning-declined")).toHaveTextContent(".env")
    // ...but one click away from being turned back on.
    const declined = screen.getByTestId("provisioning-declined")
    await userEvent.click(within(declined).getByRole("button", { name: "Use it" }))
    expect(mockUpdateProject).toHaveBeenCalledWith("p1", {
      workspaceProvisioning: { accepted: ["include:.env"], reviewed: ["include:.env"] },
    })
  })

  it("shows what is already in use with a way to stop", async () => {
    mockProjects = [
      {
        id: "p1",
        workspaceProvisioning: {
          accepted: ["cacheLink:node_modules"],
          reviewed: ["cacheLink:node_modules"],
        },
      },
    ]
    renderCard()
    await waitFor(() => expect(screen.getByText("In use for new worktrees")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "Stop using" }))
    expect(mockUpdateProject).toHaveBeenCalledWith("p1", {
      workspaceProvisioning: { accepted: [], reviewed: ["cacheLink:node_modules"] },
    })
  })

  it("offers pnpm's global store instead of the share, and does not run it", async () => {
    // The command edits a machine-wide config affecting every project on this
    // computer. Showing it is help; running it from a settings panel is not.
    renderCard({ probePnpm: async () => "available" })
    await waitFor(() => expect(screen.getByTestId("provisioning-pnpm")).toBeInTheDocument())
    expect(screen.getByTestId("provisioning-pnpm")).toHaveTextContent(
      "pnpm config set --global virtualStoreType global"
    )
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument()
  })

  it("stops proposing the node_modules share once the global store is on", async () => {
    renderCard({ probePnpm: async () => "enabled" })
    await waitFor(() => expect(screen.getByTestId("provisioning-pnpm")).toBeInTheDocument())
    expect(
      screen.queryByTestId("provisioning-candidate-cacheLink:node_modules")
    ).not.toBeInTheDocument()
    expect(screen.getByTestId("provisioning-candidate-cacheLink:target")).toBeInTheDocument()
  })

  it("says the boring thing when there is nothing to suggest", async () => {
    renderCard({ listRoot: async () => [{ name: "README.md", isDir: false }] })
    await waitFor(() => expect(screen.getByTestId("provisioning-empty")).toBeInTheDocument())
  })
})
