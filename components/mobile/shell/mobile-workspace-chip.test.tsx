/**
 * @jest-environment jsdom
 */
import { render, screen, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${vars.name}` : key,
}))
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: jest.fn(async () => []),
  loadActiveProjectId: jest.fn(async () => null),
  putProject: jest.fn(async () => undefined),
  deleteProjectRow: jest.fn(async () => undefined),
  persistActiveProjectId: jest.fn(async () => undefined),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchProjectSwitch: jest.fn() }),
}))

import { MobileWorkspaceChip } from "./mobile-workspace-chip"
import { useProjectStore } from "@/stores/project/project-store"

beforeEach(() => {
  act(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })
})

it("renders nothing when no workspace is active", () => {
  const { container } = render(<MobileWorkspaceChip />)
  expect(container).toBeEmptyDOMElement()
})

it("shows the active workspace name", () => {
  act(() => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Backend", roots: [] } as never],
      activeProjectId: "p1",
    })
  })
  render(<MobileWorkspaceChip />)
  expect(screen.getByTestId("mobile-workspace-chip")).toHaveTextContent("Backend")
})
