/**
 * @jest-environment jsdom
 */
import { openFolderAsWorkspace, openPathAsWorkspace } from "./open-folder"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import * as tauri from "@/lib/tauri"
import { open as openDialog } from "@tauri-apps/plugin-dialog"

jest.mock("@/lib/tauri")
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn() }))
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: jest.fn(async () => []),
  loadActiveProjectId: jest.fn(async () => null),
  putProject: jest.fn(async () => undefined),
  deleteProjectRow: jest.fn(async () => undefined),
  persistActiveProjectId: jest.fn(async () => undefined),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchProjectCreate: jest.fn(async () => undefined),
    dispatchProjectSwitch: jest.fn(),
  }),
}))

const pickMock = openDialog as jest.Mock

beforeEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  ;(tauri.isTauri as jest.Mock).mockReturnValue(true)
  pickMock.mockReset()
})

it("returns null on Web", async () => {
  ;(tauri.isTauri as jest.Mock).mockReturnValue(false)
  expect(await openFolderAsWorkspace()).toBeNull()
})

it("returns null when the picker is cancelled", async () => {
  pickMock.mockResolvedValue(null)
  expect(await openFolderAsWorkspace()).toBeNull()
})

it("creates + activates a workspace from the picked folder", async () => {
  pickMock.mockResolvedValue("/Users/me/proj")
  const created = await openFolderAsWorkspace()
  expect(created).not.toBeNull()
  expect(primaryRootOf(created!)?.path).toBe("/Users/me/proj")
  expect(created!.name).toBe("proj")
  expect(useProjectStore.getState().activeProjectId).toBe(created!.id)
})

describe("openPathAsWorkspace", () => {
  it("returns null for a blank path", () => {
    expect(openPathAsWorkspace("   ")).toBeNull()
    expect(useProjectStore.getState().projects).toHaveLength(0)
  })

  it("creates + activates a workspace for a given path", () => {
    const created = openPathAsWorkspace("/Users/me/proj")
    expect(created).not.toBeNull()
    expect(primaryRootOf(created!)?.path).toBe("/Users/me/proj")
    expect(useProjectStore.getState().activeProjectId).toBe(created!.id)
    expect(useProjectStore.getState().projects).toHaveLength(1)
  })

  it("re-activates an existing workspace instead of duplicating it", () => {
    const first = openPathAsWorkspace("/Users/me/proj")
    useProjectStore.setState({ activeProjectId: null })
    const again = openPathAsWorkspace("/Users/me/proj")
    expect(again!.id).toBe(first!.id)
    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(useProjectStore.getState().activeProjectId).toBe(first!.id)
  })

  it("dedupes the picker flow too", async () => {
    pickMock.mockResolvedValue("/Users/me/proj")
    const first = await openFolderAsWorkspace()
    const again = await openFolderAsWorkspace()
    expect(again!.id).toBe(first!.id)
    expect(useProjectStore.getState().projects).toHaveLength(1)
  })

  it("skips archived workspaces when deduping", () => {
    const first = openPathAsWorkspace("/Users/me/proj")
    useProjectStore.setState((s) => ({
      projects: s.projects.map((p) => ({ ...p, isArchived: true })),
    }))
    const again = openPathAsWorkspace("/Users/me/proj")
    expect(again!.id).not.toBe(first!.id)
    expect(useProjectStore.getState().projects).toHaveLength(2)
  })
})
