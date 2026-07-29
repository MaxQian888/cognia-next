import type {
  MarketplaceSourceItem,
  MarketplaceSourcePreview,
  SourcePreviewEntry,
  SourceSyncState,
} from "./types"

/**
 * These view-model types are the seam between the source components and every
 * driver of them (Storybook, the dialog, the tests). There is no runtime here
 * to exercise, so the test's job is to pin the contract: the fixtures below are
 * `satisfies`-checked, which fails the build if a field is renamed or a
 * required one is dropped, and the exhaustive switch fails if a sync state is
 * added without every consumer being told.
 */
describe("marketplace source view models", () => {
  it("describes a preview without needing Dexie or the GitHub API", () => {
    const entry = {
      id: "acme/tools#clipboard",
      name: "Clipboard",
      version: "",
    } satisfies SourcePreviewEntry

    const preview = {
      id: "acme/tools@v2",
      name: "Acme Tools",
      owner: "Acme",
      catalogPath: "plugins/catalog.json",
      repoUrl: "https://github.com/acme/tools/tree/v2",
      entries: [entry],
      alreadyAdded: false,
    } satisfies MarketplaceSourcePreview

    // `version: ""` is the documented stand-in for a catalog that omits it, so
    // it must stay expressible rather than becoming `undefined`.
    expect(preview.entries[0].version).toBe("")
    expect(preview.owner).toBe("Acme")
  })

  it("keeps `never` distinguishable from a synced-but-empty source", () => {
    const never = { kind: "never" } satisfies SourceSyncState
    const empty = {
      kind: "ok",
      pluginCount: 0,
      lastSyncedAt: 1,
    } satisfies SourceSyncState

    // The whole reason `never` exists: a source added offline has produced no
    // catalog, and rendering it as "0 plugins" would be a lie.
    expect(never.kind).not.toBe(empty.kind)
  })

  it("covers every sync state exhaustively", () => {
    const label = (sync: SourceSyncState): string => {
      switch (sync.kind) {
        case "never":
          return "never"
        case "syncing":
          return "syncing"
        case "ok":
          return `ok:${sync.pluginCount}`
        case "error":
          return `error:${sync.message}`
        default: {
          // Adding a state without handling it here stops compiling.
          const unreachable: never = sync
          return unreachable
        }
      }
    }

    const item = {
      id: "acme/tools",
      name: "Acme Tools",
      repoRef: "acme/tools",
      repoUrl: "https://github.com/acme/tools",
      sync: { kind: "error", message: "404", lastSyncedAt: 2 },
    } satisfies MarketplaceSourceItem

    expect(label(item.sync)).toBe("error:404")
    expect(label({ kind: "never" })).toBe("never")
    expect(label({ kind: "syncing" })).toBe("syncing")
    expect(label({ kind: "ok", pluginCount: 3, lastSyncedAt: 1 })).toBe("ok:3")
  })
})
