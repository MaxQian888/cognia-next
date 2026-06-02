/**
 * @jest-environment jsdom
 */
import { openFolderAsWorkspace } from "./open-folder"
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
