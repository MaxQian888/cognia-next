/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/plugin/lifecycle/backup", () => ({
  getPluginBackupManager: jest.fn(),
}))

import { getPluginBackupManager } from "@/lib/plugin/lifecycle/backup"
import { isTauri } from "@/lib/tauri"

import {
  __resetPluginBackupIndexForTests,
  ensurePluginBackupIndexLoaded,
  notifyPluginBackupsChanged,
  usePluginRollbackAvailable,
} from "./use-plugin-rollback-availability"

/** Render, then let the one-shot index load settle inside act(). */
async function renderAvailable(id: string, version: string) {
  const hook = renderHook(() => usePluginRollbackAvailable(id, version))
  await act(async () => {
    await ensurePluginBackupIndexLoaded()
  })
  return hook
}

let backups: Record<string, Array<{ version: string }>> = {}
const initialize = jest.fn(async () => {})

beforeEach(() => {
  jest.clearAllMocks()
  __resetPluginBackupIndexForTests()
  backups = {}
  ;(isTauri as jest.Mock).mockReturnValue(true)
  ;(getPluginBackupManager as jest.Mock).mockReturnValue({
    initialize,
    getBackups: (id: string) => backups[id] ?? [],
  })
})

describe("usePluginRollbackAvailable", () => {
  it("loads the persisted backup index once", async () => {
    await renderAvailable("a", "2.0.0")
    await renderAvailable("b", "1.0.0")
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1))
  })

  it("is available only when a backup of another version exists", async () => {
    backups = { a: [{ version: "1.0.0" }], b: [{ version: "1.0.0" }] }
    expect((await renderAvailable("a", "2.0.0")).result.current).toBe(true)
    // The only snapshot is of the installed version — nothing to go back to.
    expect((await renderAvailable("b", "1.0.0")).result.current).toBe(false)
    expect((await renderAvailable("c", "1.0.0")).result.current).toBe(false)
  })

  it("is never available off the desktop shell", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    backups = { a: [{ version: "1.0.0" }] }
    expect((await renderAvailable("a", "2.0.0")).result.current).toBe(false)
  })

  it("re-checks when a backup is written", async () => {
    const { result } = await renderAvailable("a", "2.0.0")
    expect(result.current).toBe(false)
    backups = { a: [{ version: "1.0.0" }] }
    act(() => notifyPluginBackupsChanged())
    expect(result.current).toBe(true)
  })
})
