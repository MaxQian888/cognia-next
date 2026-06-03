import { initLspSettingsMigration } from "./migrate-settings-initializer"

describe("initLspSettingsMigration", () => {
  it("migrates immediately and saves when settings are already loaded", () => {
    const save = jest.fn(async (_patch: Record<string, unknown>) => {})
    const state = {
      settings: {
        developer: {
          userLspServers: [{ id: "eslint", name: "ESLint", languages: ["ts"], command: "eslint" }],
        },
      },
      save,
    }
    initLspSettingsMigration({ getState: () => state, subscribe: () => () => {} })
    expect(save).toHaveBeenCalledTimes(1)
    const patch = save.mock.calls[0][0] as {
      lsp: { servers: unknown[] }
      developer: Record<string, unknown>
    }
    expect(patch.lsp.servers).toHaveLength(1)
    expect(patch.developer.userLspServers).toBeUndefined()
  })

  it("does not save when there is nothing to migrate", () => {
    const save = jest.fn(async (_patch: Record<string, unknown>) => {})
    initLspSettingsMigration({
      getState: () => ({ settings: { developer: {} }, save }),
      subscribe: () => () => {},
    })
    expect(save).not.toHaveBeenCalled()
  })

  it("defers until settings load, then migrates on the first change", () => {
    const save = jest.fn(async (_patch: Record<string, unknown>) => {})
    let loaded = false
    const state = {
      get settings() {
        return loaded
          ? {
              developer: {
                userLspServers: [{ id: "x", name: "x", languages: ["x"], command: "x" }],
              },
            }
          : null
      },
      save,
    }
    let listener: (() => void) | null = null
    const unsubscribe = jest.fn()
    initLspSettingsMigration({
      getState: () => state,
      subscribe: (cb) => {
        listener = cb
        return unsubscribe
      },
    })
    expect(save).not.toHaveBeenCalled()

    // Settings load → store notifies.
    loaded = true
    listener!()
    expect(save).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("returns a no-op disposer when migration ran synchronously", () => {
    const dispose = initLspSettingsMigration({
      getState: () => ({ settings: { developer: {} }, save: jest.fn(async () => {}) }),
      subscribe: () => () => {},
    })
    expect(() => dispose()).not.toThrow()
  })
})
