import { invoke as invokeRaw } from "@tauri-apps/api/core"
import { isTauri as isTauriRaw } from "@/lib/tauri"
import { listTrustedWorkspaces as listTrustedWorkspacesRaw } from "@/lib/db/trusted-workspaces"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/db/trusted-workspaces", () => ({ listTrustedWorkspaces: jest.fn() }))
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

const invoke = invokeRaw as jest.Mock
const isTauri = isTauriRaw as jest.Mock
const listTrustedWorkspaces = listTrustedWorkspacesRaw as jest.Mock

import { syncTrustedWorkspacesToRust } from "./hook-trust-sync"

beforeEach(() => {
  invoke.mockReset()
  isTauri.mockReset()
  listTrustedWorkspaces.mockReset()
})

it("no-ops on web and never reads the ledger or invokes", async () => {
  isTauri.mockReturnValue(false)
  await syncTrustedWorkspacesToRust()
  expect(listTrustedWorkspaces).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})

it("pushes the trusted paths into the Rust gate", async () => {
  isTauri.mockReturnValue(true)
  listTrustedWorkspaces.mockResolvedValue([
    { path: "/repo/a", trustedAt: 2 },
    { path: "/repo/b", trustedAt: 1 },
  ])
  invoke.mockResolvedValue(undefined)
  await syncTrustedWorkspacesToRust()
  expect(invoke).toHaveBeenCalledWith("set_trusted_workspaces", {
    paths: ["/repo/a", "/repo/b"],
  })
})

it("swallows errors so a failed sync never throws", async () => {
  isTauri.mockReturnValue(true)
  listTrustedWorkspaces.mockRejectedValue(new Error("dexie closed"))
  await expect(syncTrustedWorkspacesToRust()).resolves.toBeUndefined()
  expect(invoke).not.toHaveBeenCalled()
})
