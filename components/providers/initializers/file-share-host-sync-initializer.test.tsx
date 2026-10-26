import { render } from "@testing-library/react"

const stop = jest.fn()
const sync = {
  activate: jest.fn(async () => null),
  pushPolicy: jest.fn(async () => {}),
  syncSessions: jest.fn(async () => {}),
  refresh: jest.fn(async () => {}),
  sessionsChanged: jest.fn(async (_ids: readonly string[]) => {}),
  start: jest.fn(() => stop),
}
const createFileShareHostSync = jest.fn(
  (_deps: import("@/lib/filespace/host-sync").FileShareHostSyncDeps) => sync
)
jest.mock("@/lib/filespace/host-sync", () => ({
  createFileShareHostSync: (deps: import("@/lib/filespace/host-sync").FileShareHostSyncDeps) =>
    createFileShareHostSync(deps),
  defaultLoadPolicy: jest.fn(),
}))
jest.mock("@/lib/filespace/mount-table", () => ({
  defaultMountTableDeps: { getSession: jest.fn(), loadSpace: jest.fn() },
}))

let unlockedAccountId: string | null = "acct-1"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId }),
}))

type Listener<S> = (state: S, prev: S) => void
function fakeStore<S>() {
  const listeners = new Set<Listener<S>>()
  return {
    subscribe: jest.fn((listener: Listener<S>) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit: (state: S, prev: S) => listeners.forEach((listener) => listener(state, prev)),
    size: () => listeners.size,
  }
}
type SettingsState = { settings?: { fileSharing?: object } }
type ProjectState = { projects: unknown[] }
const settingsStore = fakeStore<SettingsState>()
const projectStore = fakeStore<ProjectState>()
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { subscribe: (l: Listener<SettingsState>) => settingsStore.subscribe(l) },
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { subscribe: (l: Listener<ProjectState>) => projectStore.subscribe(l) },
}))

import { announceFileSpaceSessionsChanged } from "@/lib/filespace/lifecycle"

import { FileShareHostSyncInitializer } from "./file-share-host-sync-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  unlockedAccountId = "acct-1"
})

it("syncs this machine's host for the unlocked account", () => {
  render(<FileShareHostSyncInitializer />)
  expect(createFileShareHostSync).toHaveBeenCalledTimes(1)
  const deps = createFileShareHostSync.mock.calls[0]![0]
  expect(deps.target).toEqual({ hostId: "local" })
  expect(deps.localAccountId()).toBe("acct-1")
  expect(sync.start).toHaveBeenCalledTimes(1)
})

it("does nothing while locked: the Rust account session unbinds the host", () => {
  unlockedAccountId = null
  render(<FileShareHostSyncInitializer />)
  expect(createFileShareHostSync).not.toHaveBeenCalled()
  expect(sync.activate).not.toHaveBeenCalled()
  expect(settingsStore.size()).toBe(0)
})

it("pushes the policy when file-sharing settings change, and only then", () => {
  render(<FileShareHostSyncInitializer />)
  const before = { settings: { fileSharing: { a: 1 } } }
  settingsStore.emit({ settings: { fileSharing: before.settings.fileSharing } }, before)
  expect(sync.pushPolicy).not.toHaveBeenCalled()
  settingsStore.emit({ settings: { fileSharing: { a: 2 } } }, before)
  expect(sync.pushPolicy).toHaveBeenCalledTimes(1)
})

it("refreshes the mount tables when projects change", () => {
  render(<FileShareHostSyncInitializer />)
  const projects: unknown[] = []
  projectStore.emit({ projects }, { projects })
  expect(sync.refresh).not.toHaveBeenCalled()
  projectStore.emit({ projects: [] }, { projects })
  expect(sync.refresh).toHaveBeenCalledTimes(1)
})

it("pushes archives, restores and deletes to the host as they happen", async () => {
  const { unmount } = render(<FileShareHostSyncInitializer />)
  announceFileSpaceSessionsChanged(["s1"])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sync.sessionsChanged).toHaveBeenCalledWith(["s1"])
  unmount()
  announceFileSpaceSessionsChanged(["s2"])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sync.sessionsChanged).toHaveBeenCalledTimes(1)
})

it("stops and unsubscribes on unmount, and restarts for another account", () => {
  const { rerender, unmount } = render(<FileShareHostSyncInitializer />)
  unlockedAccountId = "acct-2"
  rerender(<FileShareHostSyncInitializer />)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(createFileShareHostSync).toHaveBeenCalledTimes(2)
  expect(createFileShareHostSync.mock.calls[1]![0].localAccountId()).toBe("acct-2")
  unmount()
  expect(stop).toHaveBeenCalledTimes(2)
  expect(settingsStore.size()).toBe(0)
  expect(projectStore.size()).toBe(0)
})
