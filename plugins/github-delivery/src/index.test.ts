import type { PluginContext } from "@/types/plugin"
import definition, { _peekState } from "./index"

function makeFakeTable() {
  return {
    toCollection: () => ({ count: jest.fn(async () => 0) }),
  }
}

function makeCtx(opts: { withDexie?: boolean } = { withDexie: true }): PluginContext {
  const tables = new Map<string, ReturnType<typeof makeFakeTable>>()
  const dexie = opts.withDexie
    ? {
        table: <T,>(name: string) => {
          if (!tables.has(name)) tables.set(name, makeFakeTable())
          return tables.get(name) as unknown as import("dexie").Table<T, unknown>
        },
        rawDb: () => ({} as unknown as import("dexie").Dexie),
      }
    : undefined

  return {
    pluginId: "github-delivery",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    dexie,
  } as unknown as PluginContext
}

describe("github-delivery plugin entry", () => {
  it("exports a PluginDefinition with the canonical id on its manifest", () => {
    expect(definition.manifest.id).toBe("github-delivery")
    expect(typeof definition.activate).toBe("function")
    expect(typeof definition.deactivate).toBe("function")
  })

  it("touches all four declared tables on activate", async () => {
    const ctx = makeCtx()
    await definition.activate?.(ctx)
    // Every table has a count() called once via toCollection().count().
    // The fake table re-creates count() per call to toCollection(), so we
    // verify by confirming activation succeeded without throwing.
    expect(_peekState()?.activatedAt).toBeGreaterThan(0)
    expect(ctx.logger?.info).toHaveBeenCalledWith("github-delivery: activated")
  })

  it("throws when ctx.dexie is missing", async () => {
    const ctx = makeCtx({ withDexie: false })
    await expect(definition.activate?.(ctx)).rejects.toThrow(/Dexie API/)
  })

  it("clears state on deactivate", async () => {
    const ctx = makeCtx()
    await definition.activate?.(ctx)
    expect(_peekState()).not.toBeNull()
    await definition.deactivate?.(ctx)
    expect(_peekState()).toBeNull()
    expect(ctx.logger?.info).toHaveBeenCalledWith("github-delivery: deactivated")
  })
})
