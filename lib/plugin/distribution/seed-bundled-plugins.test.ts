/**
 * @jest-environment jsdom
 */

import {
  bundledPluginCatalog,
  readSeedMarker,
  seedBundledPlugins,
  SEED_MARKER_KEY,
  STAGED_PLUGIN_ROOT,
  writeSeedMarker,
  type SeedBundledPluginsDeps,
} from "./seed-bundled-plugins"

jest.mock("@cognia/logging", () => ({
  loggers: { manager: { child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn() }) } },
}))

const CATALOG = {
  entries: {
    repowiki: { id: "cognia-repowiki", version: "0.1.0", files: [] },
  },
}

function deps(over: Partial<SeedBundledPluginsDeps> = {}) {
  const marker: Record<string, string> = {}
  const installed: string[] = []
  const base: SeedBundledPluginsDeps = {
    catalog: CATALOG,
    resolveResource: async (relative) => `/Bundle/${relative}`,
    installFromDirectory: async (dir) => {
      installed.push(dir)
    },
    readMarker: () => ({ ...marker }),
    writeMarker: (next) => {
      Object.assign(marker, next)
    },
    ...over,
  }
  return { base, marker, installed }
}

describe("seedBundledPlugins", () => {
  it("installs a staged plugin from the resource tree and records its version", async () => {
    const { base, marker, installed } = deps()
    const outcome = await seedBundledPlugins(base)

    expect(installed).toEqual([`/Bundle/${STAGED_PLUGIN_ROOT}/repowiki`])
    expect(outcome.seeded).toEqual(["repowiki"])
    expect(marker).toEqual({ repowiki: "0.1.0" })
  })

  it("does nothing on the next launch when the version is unchanged", async () => {
    const { base, installed } = deps({ readMarker: () => ({ repowiki: "0.1.0" }) })
    const outcome = await seedBundledPlugins(base)

    expect(installed).toEqual([])
    expect(outcome.upToDate).toEqual(["repowiki"])
    expect(outcome.seeded).toEqual([])
  })

  it("re-seeds when the bundled version moves ahead of the marker", async () => {
    const { base, installed } = deps({ readMarker: () => ({ repowiki: "0.0.9" }) })
    const outcome = await seedBundledPlugins(base)

    expect(installed).toHaveLength(1)
    expect(outcome.seeded).toEqual(["repowiki"])
  })

  it("does not re-seed a plugin the user deleted, which is what the marker is for", async () => {
    // The marker names the version, not the presence of the directory. Putting
    // back what somebody deliberately removed, on every launch, is the worse
    // of the two failures.
    const { base, installed } = deps({ readMarker: () => ({ repowiki: "0.1.0" }) })
    await seedBundledPlugins(base)
    expect(installed).toEqual([])
  })

  it("records nothing when the install throws, so the next launch retries", async () => {
    const { base, marker } = deps({
      installFromDirectory: async () => {
        throw new Error("EACCES")
      },
    })
    const outcome = await seedBundledPlugins(base)

    expect(outcome.seeded).toEqual([])
    expect(outcome.failed).toEqual({ repowiki: "EACCES" })
    expect(marker).toEqual({})
  })

  it("records a failure rather than throwing when the resource cannot be resolved", async () => {
    // A dev build that never ran the staging step. The plugin runtime still
    // has to start.
    const { base, marker } = deps({
      resolveResource: async () => {
        throw new Error("resource not found")
      },
    })
    const outcome = await seedBundledPlugins(base)
    expect(outcome.seeded).toEqual([])
    expect(outcome.failed.repowiki).toMatch(/resource not found/u)
    expect(marker).toEqual({})
  })

  it("asks for the directory the staging script writes into the bundle", async () => {
    const asked: string[] = []
    const { base } = deps({
      resolveResource: async (relative) => {
        asked.push(relative)
        return `/Bundle/${relative}`
      },
    })
    await seedBundledPlugins(base)
    expect(asked).toEqual([`${STAGED_PLUGIN_ROOT}/repowiki`])
  })

  it("keeps one plugin's failure from blocking another", async () => {
    const twoEntries = {
      entries: {
        alpha: { id: "a", version: "1.0.0", files: [] },
        beta: { id: "b", version: "1.0.0", files: [] },
      },
    }
    const { base, marker } = deps({
      catalog: twoEntries,
      installFromDirectory: async (dir) => {
        if (dir.endsWith("alpha")) throw new Error("boom")
      },
    })
    const outcome = await seedBundledPlugins(base)

    expect(outcome.failed).toEqual({ alpha: "boom" })
    expect(outcome.seeded).toEqual(["beta"])
    expect(marker).toEqual({ beta: "1.0.0" })
  })
})

describe("the seed marker", () => {
  beforeEach(() => window.localStorage.clear())

  it("round-trips through localStorage", () => {
    writeSeedMarker({ repowiki: "0.1.0" })
    expect(readSeedMarker()).toEqual({ repowiki: "0.1.0" })
    expect(window.localStorage.getItem(SEED_MARKER_KEY)).toContain("0.1.0")
  })

  it("treats unreadable or malformed storage as unseeded rather than throwing", () => {
    window.localStorage.setItem(SEED_MARKER_KEY, "{not json")
    expect(readSeedMarker()).toEqual({})

    window.localStorage.setItem(SEED_MARKER_KEY, JSON.stringify(["repowiki"]))
    expect(readSeedMarker()).toEqual({})

    window.localStorage.setItem(SEED_MARKER_KEY, JSON.stringify({ repowiki: 3 }))
    expect(readSeedMarker()).toEqual({})
  })

  it("swallows a storage that refuses to write", () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded")
      },
    } as unknown as Storage
    expect(() => writeSeedMarker({ repowiki: "0.1.0" }, refusing)).not.toThrow()
  })
})

describe("the generated catalog", () => {
  it("is the one the production path reads, and it carries RepoWiki", () => {
    // The seeder imports this rather than reading it back out of the resource
    // directory, so a stale or missing catalog is a build failure here rather
    // than a plugin that quietly never appears on a user's machine.
    const catalog = bundledPluginCatalog()
    expect(catalog.entries.repowiki?.id).toBe("cognia-repowiki")
    expect(catalog.entries.repowiki.files.length).toBeGreaterThan(20)
    expect(catalog.entries.repowiki.files.map((f) => f.path)).toContain("plugin.json")
  })
})
