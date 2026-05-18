/**
 * Tests for `syncUserLspServers`. Mocks the registry surface so we
 * only verify the diff logic (add / remove / skip).
 */

const registerMock = jest.fn(async () => ({ state: "running" }))
const unregisterMock = jest.fn(async () => undefined)
let listResult: Array<{ ownerId: string; serverId: string }> = []

jest.mock("./lsp-registry", () => ({
  registerLspServer: (input: unknown) => registerMock(input),
  unregisterLspServer: (owner: string, id: string) => unregisterMock(owner, id),
  listLspServers: () => listResult,
}))

import { syncUserLspServers, USER_LSP_PLUGIN_PATH } from "./lsp-user-servers"

beforeEach(() => {
  registerMock.mockClear()
  unregisterMock.mockClear()
  listResult = []
})

describe("syncUserLspServers", () => {
  it("adds every entry on first sync", async () => {
    const result = await syncUserLspServers([
      {
        id: "eslint",
        name: "ESLint",
        languages: ["typescript"],
        command: "/usr/local/bin/eslint-server",
      },
      {
        id: "pyright",
        name: "Pyright",
        languages: ["python"],
        command: "/usr/local/bin/pyright-langserver",
      },
    ])
    expect(result).toEqual({ added: 2, removed: 0, skipped: 0 })
    expect(registerMock).toHaveBeenCalledTimes(2)
    const eslintCall = registerMock.mock.calls.find(
      (c) => (c[0] as { config: { id: string } }).config.id === "eslint"
    )
    expect(eslintCall?.[0]).toMatchObject({
      ownerId: "user",
      pluginPath: USER_LSP_PLUGIN_PATH,
      confirmedConsent: true,
    })
  })

  it("skips entries already registered (idempotent re-sync)", async () => {
    listResult = [{ ownerId: "user", serverId: "eslint" }]
    const result = await syncUserLspServers([
      {
        id: "eslint",
        name: "ESLint",
        languages: ["typescript"],
        command: "/eslint-server",
      },
    ])
    expect(result).toEqual({ added: 0, removed: 0, skipped: 1 })
    expect(registerMock).not.toHaveBeenCalled()
  })

  it("removes entries no longer present in settings", async () => {
    listResult = [
      { ownerId: "user", serverId: "eslint" },
      { ownerId: "user", serverId: "pyright" },
    ]
    const result = await syncUserLspServers([
      { id: "pyright", name: "Pyright", languages: ["python"], command: "/p" },
    ])
    expect(result.removed).toBe(1)
    expect(unregisterMock).toHaveBeenCalledWith("user", "eslint")
    expect(registerMock).not.toHaveBeenCalled()
  })

  it("treats `enabled: false` as removal", async () => {
    listResult = [{ ownerId: "user", serverId: "eslint" }]
    await syncUserLspServers([
      {
        id: "eslint",
        name: "ESLint",
        languages: ["typescript"],
        command: "/eslint",
        enabled: false,
      },
    ])
    expect(unregisterMock).toHaveBeenCalledWith("user", "eslint")
  })

  it("does not touch records owned by plugins (only `user` ownerId is in scope)", async () => {
    listResult = [
      { ownerId: "user", serverId: "eslint" },
      { ownerId: "publisher.x", serverId: "rust" }, // plugin-contributed; should be ignored
    ]
    await syncUserLspServers([])
    expect(unregisterMock).toHaveBeenCalledTimes(1)
    expect(unregisterMock).toHaveBeenCalledWith("user", "eslint")
  })

  it("handles an undefined settings list as 'remove all user entries'", async () => {
    listResult = [{ ownerId: "user", serverId: "eslint" }]
    await syncUserLspServers(undefined)
    expect(unregisterMock).toHaveBeenCalledWith("user", "eslint")
  })
})
