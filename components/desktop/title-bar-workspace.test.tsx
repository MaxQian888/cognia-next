/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { COMMAND_PALETTE_REQUEST_EVENT } from "@/lib/shell/command-palette-request"
import type { Project } from "@/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

interface MockState {
  projects: Project[]
  activeProjectId: string | null
}
let mockState: MockState
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: MockState) => unknown) => selector(mockState),
}))

import { TitleBarWorkspace } from "./title-bar-workspace"

function project(id: string, name: string, primaryPath?: string): Project {
  return {
    id,
    name,
    roots: primaryPath ? [{ path: primaryPath, isPrimary: true }] : [],
  } as Project
}

beforeEach(() => {
  mockState = { projects: [], activeProjectId: null }
})

describe("TitleBarWorkspace", () => {
  it("renders nothing when there is no active project", () => {
    const { container } = render(<TitleBarWorkspace />)
    expect(container.firstChild).toBeNull()
  })

  it("shows the active project's name", () => {
    mockState = { projects: [project("p1", "Cognia")], activeProjectId: "p1" }
    render(<TitleBarWorkspace />)
    expect(screen.getByTestId("title-bar-workspace")).toHaveTextContent("Cognia")
  })

  it("falls back to the primary root's folder name when the name is blank", () => {
    mockState = {
      projects: [project("p1", "   ", "/Users/me/dev/cognia-next")],
      activeProjectId: "p1",
    }
    render(<TitleBarWorkspace />)
    expect(screen.getByTestId("title-bar-workspace")).toHaveTextContent("cognia-next")
  })

  it("returns the raw path when it has no folder segment", () => {
    mockState = { projects: [project("p1", "", "/")], activeProjectId: "p1" }
    render(<TitleBarWorkspace />)
    expect(screen.getByTestId("title-bar-workspace")).toHaveTextContent("/")
  })

  it("uses the untitled label when there is neither a name nor a root", () => {
    mockState = { projects: [project("p1", "")], activeProjectId: "p1" }
    render(<TitleBarWorkspace />)
    expect(screen.getByTestId("title-bar-workspace")).toHaveTextContent("workspaceUntitled")
  })

  it("opens the command palette on click", () => {
    mockState = { projects: [project("p1", "Cognia")], activeProjectId: "p1" }
    // Through the palette's request seam, not a forged keystroke: the old
    // Ctrl+K dispatch never opened the ⌘K-listening palette on macOS.
    const seen: unknown[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
    try {
      render(<TitleBarWorkspace />)
      fireEvent.click(screen.getByTestId("title-bar-workspace"))
      expect(seen).toHaveLength(1)
    } finally {
      window.removeEventListener(COMMAND_PALETTE_REQUEST_EVENT, listener)
    }
  })
})
