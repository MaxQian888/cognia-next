/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, act } from "@testing-library/react"

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
// The list and its dialogs are covered by their own suite. Stubbed here so this
// one stays about the chip becoming a real trigger.
const pickerRender = jest.fn()
jest.mock("@/components/workspace/workspace-picker-list", () => ({
  useWorkspacePickerDialogs: () => ({
    actions: {
      openFolder: jest.fn(),
      newWorkspace: jest.fn(),
      adopt: jest.fn(),
      manage: jest.fn(),
      canOpenFolder: true,
      adoptableCount: 0,
    },
    element: <div data-testid="picker-dialogs" />,
  }),
  WorkspacePickerList: (props: { density?: string; onSwitched?: () => void }) => {
    pickerRender(props)
    return (
      <button type="button" data-testid="picker-list" onClick={() => props.onSwitched?.()}>
        list
      </button>
    )
  },
}))

import { MobileWorkspaceChip } from "./mobile-workspace-chip"
import { useProjectStore } from "@/stores/project/project-store"

beforeEach(() => {
  pickerRender.mockClear()
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

function activateWorkspace() {
  act(() => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Backend", roots: [] } as never],
      activeProjectId: "p1",
    })
  })
}

it("opens the same picker the desktop popover uses, at touch density", () => {
  // The chip used to be an inert span whose comment said remote switching was
  // deferred, while the real switcher sat two layers deep in the nav Sheet as a
  // 40px icon. The name in the header is the switcher now.
  activateWorkspace()
  render(<MobileWorkspaceChip />)

  fireEvent.click(screen.getByTestId("mobile-workspace-chip"))

  expect(screen.getByTestId("picker-list")).toBeInTheDocument()
  expect(pickerRender).toHaveBeenCalledWith(
    expect.objectContaining({ density: "comfortable" })
  )
})

it("closes the drawer once a workspace is chosen", () => {
  activateWorkspace()
  render(<MobileWorkspaceChip />)
  fireEvent.click(screen.getByTestId("mobile-workspace-chip"))

  fireEvent.click(screen.getByTestId("picker-list"))

  expect(screen.queryByTestId("picker-list")).not.toBeInTheDocument()
})

it("mounts the dialogs outside the drawer, which unmounts its children", () => {
  // A dialog owned by the drawer content would be torn down by the same close
  // that asked to open it, so nothing would appear.
  activateWorkspace()
  render(<MobileWorkspaceChip />)

  expect(screen.getByTestId("picker-dialogs")).toBeInTheDocument()
  expect(screen.queryByTestId("picker-list")).not.toBeInTheDocument()
})
