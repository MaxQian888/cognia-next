/** @jest-environment jsdom */
let tauriValue = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => tauriValue,
}))
const settingsState: { current: unknown } = { current: {} }
jest.mock("@/lib/db/settings", () => ({ getSettings: async () => settingsState.current }))
const writeTextFileMock = jest.fn(async () => undefined)
const readDirMock = jest.fn(async () => [{ name: "a.enc.cbk" }, { name: "b.txt" }])
const removeMock = jest.fn(async () => undefined)
const mkdirMock = jest.fn(async () => undefined)
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    writeTextFile: (...a: unknown[]) => writeTextFileMock(...(a as [])),
    readDir: (...a: unknown[]) => readDirMock(...(a as [])),
    remove: (...a: unknown[]) => removeMock(...(a as [])),
    mkdir: (...a: unknown[]) => mkdirMock(...(a as [])),
  }),
  { virtual: true }
)
jest.mock(
  "@tauri-apps/api/path",
  () => ({
    appDataDir: async () => "/app-data",
    join: async (...parts: string[]) => parts.join("/"),
  }),
  { virtual: true }
)

import {
  createInjectedBackupHost,
  resolveBackupHostFilesystem,
  setBackupHostFilesystem,
} from "./backup-host-filesystem"

afterEach(() => {
  setBackupHostFilesystem(null)
  tauriValue = false
  settingsState.current = {}
  jest.clearAllMocks()
})

describe("resolveBackupHostFilesystem", () => {
  it("returns null on hosts without a filesystem", async () => {
    expect(await resolveBackupHostFilesystem()).toBeNull()
  })

  it("prefers an injected host and removes it through the disposer", async () => {
    const fs = {
      writeTextFile: jest.fn(),
      readDirNames: jest.fn(async () => []),
      remove: jest.fn(),
    }
    const dispose = setBackupHostFilesystem(createInjectedBackupHost(fs))
    const host = await resolveBackupHostFilesystem()
    expect(host?.kind).toBe("injected")
    expect(await host!.resolveBackupDir()).toBeNull()
    settingsState.current = { backupAutoSchedule: { dirPath: " /srv/backups/ " } }
    expect(await host!.resolveBackupDir()).toBe("/srv/backups/")
    expect(host!.join("/srv/backups/", "x")).toBe("/srv/backups/x")
    expect(host!.join("C:\\b\\", "x")).toBe("C:\\b\\x")
    settingsState.current = null
    expect(await host!.resolveBackupDir()).toBeNull()
    dispose()
    expect(await resolveBackupHostFilesystem()).toBeNull()
  })

  it("builds the Tauri adapter on the desktop", async () => {
    tauriValue = true
    const host = await resolveBackupHostFilesystem()
    expect(host?.kind).toBe("tauri")
    expect(await host!.resolveBackupDir()).toBe("/app-data/backups")
    expect(mkdirMock).toHaveBeenCalledWith("/app-data/backups", { recursive: true })
    await host!.filesystem.writeTextFile("/p", "c")
    expect(writeTextFileMock).toHaveBeenCalledWith("/p", "c")
    expect(await host!.filesystem.readDirNames("/d")).toEqual(["a.enc.cbk", "b.txt"])
    await host!.filesystem.remove("/p")
    expect(removeMock).toHaveBeenCalledWith("/p")
    mkdirMock.mockRejectedValueOnce(new Error("exists"))
    expect(await host!.resolveBackupDir()).toBe("/app-data/backups")
  })
})
