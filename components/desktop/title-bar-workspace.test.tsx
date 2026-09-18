/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { Project } from "@/types"

interface MockState {
  projects: Project[]
  activeProjectId: string | null
}
let mockState: MockState
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: MockState) => unknown) => selector(mockState),
}))

const switcherProps: { variant?: string; className?: string }[] = []
jest.mock("@/components/shell/workspace-switcher", () => ({
  WorkspaceSwitcher: (props: { variant?: string; className?: string }) => {
    switcherProps.push(props)
    return <div data-testid="workspace-switcher" data-variant={props.variant} />
  },
}))

let projectedStart = false
jest.mock("@/components/shell/title-bar-outlets", () => ({
  useTitleBarProjectionState: () => ({
    start: projectedStart,
    center: false,
    end: false,
    actions: false,
  }),
}))

import { TitleBarWorkspace } from "./title-bar-workspace"

function project(id: string, name: string): Project {
  return { id, name, roots: [] } as Project
}

beforeEach(() => {
  mockState = { projects: [], activeProjectId: null }
  switcherProps.length = 0
  projectedStart = false
})

describe("TitleBarWorkspace", () => {
  it("renders nothing when there is no active project", () => {
    const { container } = render(<TitleBarWorkspace />)
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing while the sidebar header already projects a switcher", () => {
    // On `/` the channel list's WorkspaceContextBar is portaled into the
    // bar's start zone — a second identical chip here was the duplication bug.
    projectedStart = true
    mockState = { projects: [project("p1", "Cognia")], activeProjectId: "p1" }
    const { container } = render(<TitleBarWorkspace />)
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when the active id points at a missing project", () => {
    mockState = { projects: [project("p1", "Cognia")], activeProjectId: "p-missing" }
    const { container } = render(<TitleBarWorkspace />)
    expect(container.firstChild).toBeNull()
  })

  it("mounts the wide workspace switcher for the active project", () => {
    mockState = { projects: [project("p1", "Cognia")], activeProjectId: "p1" }
    render(<TitleBarWorkspace />)
    // Clicking opens the project picker popover — covered by
    // workspace-switcher.test.tsx — instead of detouring through the palette.
    expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument()
    expect(switcherProps[0]?.variant).toBe("wide")
  })

  it("forwards the segment className onto the switcher", () => {
    mockState = { projects: [project("p1", "Cognia")], activeProjectId: "p1" }
    render(<TitleBarWorkspace className="shrink-0 min-w-24" />)
    expect(switcherProps[0]?.className).toBe("shrink-0 min-w-24")
  })
})
