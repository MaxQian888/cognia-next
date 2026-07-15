/**
 * Guards for the two-phase Open VSX graph install.
 *
 * The properties under test are the ones a user would never see failing until
 * it was too late: that a half-installed graph is impossible, that consent
 * covers everything a click installs, and that the double `getPlugin` call
 * does not silently download every extension twice.
 *
 * `runMarketplaceInstall` is driven for real here — the whole point of
 * implementing its `{ getPlugin, installPlugin }` seam is that the consent
 * chain is the same code path the cognia registry uses, so testing against a
 * stand-in would prove nothing.
 */

jest.mock("@/lib/db/plugins", () => ({
  // `install-flow.ts` reaches for these during conflict / dependency detection.
  listPlugins: jest.fn(async () => []),
  getPlugin: jest.fn(async () => null),
  setPluginConfig: jest.fn(async () => undefined),
  deletePlugin: jest.fn(async () => undefined),
  upsertPlugin: jest.fn(async (draft: unknown) => draft),
}))
jest.mock("@/lib/file/file-operations", () => ({
  readBinaryFile: jest.fn(async () => new Uint8Array()),
  removeFile: jest.fn(async () => undefined),
}))
jest.mock("@/lib/native/utils", () => ({ canUseTauriInvoke: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } },
}))

import JSZip from "jszip"
import { runMarketplaceInstall } from "@/lib/plugin/marketplace/install-flow"
import { prepareVscodeExtension } from "./install-vscode-extension"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginManifest, PluginPermission } from "@/types/plugin"
import type { PreparedVscodeExtension } from "./install-vscode-extension"
import {
  commitGraph,
  createOpenVsxInstallClient,
  stageGraph,
  type OpenVsxInstallFlowDeps,
} from "./openvsx-install-flow"
import type { OpenVsxInstallPlan, ResolvedExtensionNode } from "./openvsx-dep-resolver"
import type { OpenVsxQueryEntry } from "./openvsx-client"

// =============================================================================
// Fixtures
// =============================================================================

function queryEntry(id: string): OpenVsxQueryEntry {
  const [namespace, name] = id.split(".")
  return {
    namespace,
    name,
    version: "1.0.0",
    targetPlatform: "darwin-arm64",
    files: {
      download: `https://open-vsx.org/api/${namespace}/${name}/1.0.0/file/${id}.vsix`,
      sha256: `https://open-vsx.org/api/${namespace}/${name}/1.0.0/file/${id}.sha256`,
    },
  }
}

function node(id: string, isRoot = false): ResolvedExtensionNode {
  const [namespace, name] = id.split(".")
  return {
    extensionId: id,
    namespace,
    name,
    version: "1.0.0",
    targetPlatform: "darwin-arm64",
    entry: queryEntry(id),
    depth: isRoot ? 0 : 1,
    dependencies: [],
    isRoot,
  }
}

/** `ids` in install order; the LAST one is the root. */
function plan(ids: string[]): OpenVsxInstallPlan {
  const rootId = ids[ids.length - 1]
  return {
    rootId,
    host: "darwin-arm64",
    nodes: ids.map((id) => node(id, id === rootId)),
    bundled: [],
    cycles: [],
  }
}

/** A `prepareVscodeExtension` result, minus the JSZip work. */
function prepared(id: string, permissions: PluginPermission[] = []): PreparedVscodeExtension {
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    type: "vscode-extension",
    capabilities: ["vscode-extension"],
    permissions,
  } as unknown as PluginManifest
  return {
    bytes: new Uint8Array([1, 2, 3]),
    vsix: { sha256: `sha-${id}` } as PreparedVscodeExtension["vsix"],
    adapted: { manifest, warnings: [] } as unknown as PreparedVscodeExtension["adapted"],
  }
}

function row(id: string): PluginRow {
  return { id, path: `/ext/${id}` } as PluginRow
}

/** An externally-resolvable promise — lets a test park code at an exact point. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * Deps wired to an in-memory world: every download hands back a temp path,
 * every prepare hands back a manifest with `permissions`.
 */
function makeDeps(
  ids: string[],
  overrides: Partial<OpenVsxInstallFlowDeps> = {}
): OpenVsxInstallFlowDeps & {
  download: jest.Mock
  commit: jest.Mock
  uninstall: jest.Mock
} {
  const download = jest.fn(async (entry: OpenVsxQueryEntry) => ({
    tempPath: `/tmp/${entry.namespace}.${entry.name}.vsix`,
    sha256Hex: `sha-${entry.namespace}.${entry.name}`,
    sizeBytes: 3,
  }))
  const commit = jest.fn(async (p: PreparedVscodeExtension) => row(p.adapted.manifest.id))
  const uninstall = jest.fn(async () => undefined)

  return {
    resolveHost: async () => "darwin-arm64",
    resolveGraph: jest.fn(async () => plan(ids)),
    download,
    readBytes: jest.fn(async (path: string) => new Uint8Array([path.length])),
    prepare: jest.fn(async (_bytes: Uint8Array) => prepared("placeholder")),
    commit,
    uninstall,
    ...overrides,
  } as OpenVsxInstallFlowDeps & { download: jest.Mock; commit: jest.Mock; uninstall: jest.Mock }
}

/**
 * The full wiring: `download` reports a temp path derived from the entry, and
 * `readBytes` / `prepare` thread the id through it so each node stages as
 * itself. `permissions` assigns each node the permissions its bundle implies.
 */
function stagingDeps(
  ids: string[],
  permissions: Record<string, PluginPermission[]> = {},
  overrides: Partial<OpenVsxInstallFlowDeps> = {}
): OpenVsxInstallFlowDeps & { download: jest.Mock; commit: jest.Mock; uninstall: jest.Mock } {
  const base = makeDeps(ids, overrides)
  return {
    ...base,
    readBytes: jest.fn(async (path: string) => {
      // `/tmp/<id>.vsix` -> `<id>`
      const id = path.slice("/tmp/".length, -".vsix".length)
      return new TextEncoder().encode(id)
    }),
    prepare: jest.fn(async (bytes: Uint8Array) => {
      const id = new TextDecoder().decode(bytes)
      return prepared(id, permissions[id] ?? [])
    }),
    ...overrides,
  } as OpenVsxInstallFlowDeps & { download: jest.Mock; commit: jest.Mock; uninstall: jest.Mock }
}

/** A consent chain that approves everything, recording what it was shown. */
function approvingChain(client: ReturnType<typeof createOpenVsxInstallClient>, pluginId: string) {
  const permissionPayloads: Array<{ declared: PluginPermission[] }> = []
  const result = runMarketplaceInstall({
    pluginId,
    client,
    requestConflictReview: async () => "continue",
    requestPermissionReview: async (payload) => {
      permissionPayloads.push({ declared: payload.declared })
      return "approve"
    },
    requestConfig: async () => ({ result: "save", value: {} }),
    rollback: null,
  })
  return { result, permissionPayloads }
}

beforeEach(() => {
  jest.clearAllMocks()
})

// =============================================================================
// Staging
// =============================================================================

describe("stageGraph", () => {
  it("downloads and parses every node before anything is committed", async () => {
    const deps = stagingDeps(["b.dep", "a.root"])

    const graph = await stageGraph(plan(["b.dep", "a.root"]), deps)

    expect(graph.staged.map((s) => s.node.extensionId)).toEqual(["b.dep", "a.root"])
    expect(deps.download).toHaveBeenCalledTimes(2)
    expect(deps.commit).not.toHaveBeenCalled()
    // The commit installs from the file Rust verified, not from a base64
    // round trip of the same bytes.
    expect(graph.staged[0].prepared.stagedPath).toBe("/tmp/b.dep.vsix")
  })

  it("rejects a node whose bytes disagree with the checksum Rust verified", async () => {
    // Rust hashed the file it wrote; `installVsix` hashed the bytes the
    // renderer actually parsed. They are only the same file if nothing
    // rewrote it in between.
    const deps = stagingDeps(
      ["a.root"],
      {},
      {
        download: jest.fn(async () => ({
          tempPath: "/tmp/a.root.vsix",
          sha256Hex: "a-completely-different-digest",
          sizeBytes: 3,
        })),
      }
    )

    await expect(stageGraph(plan(["a.root"]), deps)).rejects.toThrow(/Checksum disagreement/)
    expect(deps.commit).not.toHaveBeenCalled()
  })

  it("rejects a .vsix whose manifest impersonates a different extension", async () => {
    // The registry listed one id; the archive's own package.json declares
    // another. Installing under the registry's id would let a namespace serve
    // an extension pretending to be someone else's.
    const deps = stagingDeps(
      ["a.root"],
      {},
      {
        prepare: jest.fn(async () => prepared("someone.else")),
        download: jest.fn(async () => ({
          tempPath: "/tmp/a.root.vsix",
          sha256Hex: "sha-someone.else",
          sizeBytes: 3,
        })),
      }
    )

    await expect(stageGraph(plan(["a.root"]), deps)).rejects.toThrow(
      /lists "a\.root" but the \.vsix declares "someone\.else"/
    )
  })

  it("cleans up already-staged temp files when a later node fails", async () => {
    const { removeFile } = jest.requireMock("@/lib/file/file-operations")
    let call = 0
    const deps = stagingDeps(
      ["b.dep", "a.root"],
      {},
      {
        download: jest.fn(async (entry: OpenVsxQueryEntry) => {
          if (++call === 2) throw new Error("registry went away")
          return {
            tempPath: `/tmp/${entry.namespace}.${entry.name}.vsix`,
            sha256Hex: `sha-${entry.namespace}.${entry.name}`,
            sizeBytes: 3,
          }
        }),
      }
    )

    await expect(stageGraph(plan(["b.dep", "a.root"]), deps)).rejects.toThrow("registry went away")
    // The first node's 80 MB download must not be orphaned in app data.
    expect(removeFile).toHaveBeenCalledWith("/tmp/b.dep.vsix")
  })
})

// =============================================================================
// Consent
// =============================================================================

describe("consent", () => {
  it("consent_covers_full_transitive_set", async () => {
    // The root itself needs nothing. Its transitive dependency spawns
    // processes. If that permission is not in the one prompt the user sees,
    // the consent is a lie: they approve two things and get eight.
    const deps = stagingDeps(["c.deep", "b.mid", "a.root"], {
      "c.deep": ["process:spawn"],
      "b.mid": ["network:fetch"],
      "a.root": [],
    })
    const client = createOpenVsxInstallClient(deps)

    const { result, permissionPayloads } = approvingChain(client, "a.root")
    await result

    expect(permissionPayloads).toHaveLength(1)
    expect(permissionPayloads[0].declared).toEqual(
      expect.arrayContaining(["process:spawn", "network:fetch"])
    )
  })

  it("installs nothing when the user declines the one prompt", async () => {
    const deps = stagingDeps(["b.dep", "a.root"], { "b.dep": ["process:spawn"] })
    const client = createOpenVsxInstallClient(deps)

    const result = await runMarketplaceInstall({
      pluginId: "a.root",
      client,
      requestConflictReview: async () => "continue",
      requestPermissionReview: async () => "cancel",
      requestConfig: async () => ({ result: "save", value: {} }),
      rollback: null,
    })

    expect(result).toEqual({ status: "cancelled", stage: "permission" })
    expect(deps.commit).not.toHaveBeenCalled()
  })

  it("does not stall the chain on the dependencies step", async () => {
    // A trap worth naming: `manifest.dependencies` is cognia's plugin-dependency
    // mechanism, and `runMarketplaceInstall` cancels when an id in it isn't
    // installed. Our dependencies are staged and about to be installed by us,
    // so putting them there would make every multi-node install cancel itself.
    const deps = stagingDeps(["b.dep", "a.root"])
    const client = createOpenVsxInstallClient(deps)

    const result = await runMarketplaceInstall({
      pluginId: "a.root",
      client,
      requestConflictReview: async () => "continue",
      requestPermissionReview: async () => "approve",
      requestConfig: async () => ({ result: "save", value: {} }),
      rollback: null,
      // Deliberately absent: `requestDependencyReview`. Its absence is what
      // turns an unmet dependency into `cancelled/dependencies`.
    })

    expect(result).toEqual({ status: "installed", pluginId: "a.root" })
  })
})

// =============================================================================
// The double-getPlugin trap
// =============================================================================

describe("getPlugin memoisation", () => {
  it("two_getPlugin_calls_download_once", async () => {
    // `use-plugin-pre-install.ts` calls getPlugin to compute totalSteps, then
    // `install-flow.ts` calls it again to resolve the manifest. Staging is
    // what downloads, so without the memo every install downloads the whole
    // graph twice.
    const deps = stagingDeps(["b.dep", "a.root"])
    const client = createOpenVsxInstallClient(deps)

    await client.getPlugin("a.root")
    await client.getPlugin("a.root")

    expect(deps.download).toHaveBeenCalledTimes(2) // two nodes, one graph
    expect(deps.resolveGraph).toHaveBeenCalledTimes(1)
  })

  it("shares one download between overlapping in-flight getPlugin calls", async () => {
    const deps = stagingDeps(["a.root"])
    const client = createOpenVsxInstallClient(deps)

    // The memo holds the in-flight promise, not its result, so a second
    // caller arriving mid-download joins it instead of racing it.
    await Promise.all([client.getPlugin("a.root"), client.getPlugin("a.root")])

    expect(deps.download).toHaveBeenCalledTimes(1)
  })

  it("does not memoise a failed staging as a permanent no", async () => {
    let attempt = 0
    const deps = stagingDeps(
      ["a.root"],
      {},
      {
        resolveGraph: jest.fn(async () => {
          if (++attempt === 1) throw new Error("network down")
          return plan(["a.root"])
        }),
      }
    )
    const client = createOpenVsxInstallClient(deps)

    await expect(client.getPlugin("a.root")).rejects.toThrow("network down")
    // Retrying after fixing the network must re-download, not replay the error.
    await expect(client.getPlugin("a.root")).resolves.toMatchObject({
      manifest: expect.objectContaining({ id: "a.root" }),
    })
  })

  it("evicts a previous stage rather than accumulating 80MB graphs", async () => {
    const { removeFile } = jest.requireMock("@/lib/file/file-operations")
    const deps = stagingDeps(["a.root"])
    ;(deps.resolveGraph as jest.Mock).mockImplementation(async (o: { extensionId: string }) =>
      plan([o.extensionId])
    )
    const client = createOpenVsxInstallClient(deps)

    await client.getPlugin("a.root")
    await client.getPlugin("z.other")

    expect(removeFile).toHaveBeenCalledWith("/tmp/a.root.vsix")
  })
})

// =============================================================================
// Commit + rollback
// =============================================================================

describe("commitGraph", () => {
  it("dep_failure_rolls_back_entire_graph", async () => {
    // The root's own commit fails after both dependencies are already on disk.
    // Leaving them behind would strand two extensions the user never chose to
    // install on their own.
    const deps = stagingDeps(["c.deep", "b.mid", "a.root"])
    ;(deps.commit as jest.Mock).mockImplementation(async (p: PreparedVscodeExtension) => {
      if (p.adapted.manifest.id === "a.root") throw new Error("disk full")
      return row(p.adapted.manifest.id)
    })

    const graph = await stageGraph(plan(["c.deep", "b.mid", "a.root"]), deps)
    await expect(commitGraph(graph, deps)).rejects.toThrow("disk full")

    // Reverse order — dependents come off before their dependencies.
    expect(deps.uninstall.mock.calls.map((c) => (c[0] as PluginRow).id)).toEqual([
      "b.mid",
      "c.deep",
    ])
  })

  it("partial_install_never_persisted", async () => {
    const deps = stagingDeps(["b.dep", "a.root"])
    ;(deps.commit as jest.Mock).mockImplementation(async (p: PreparedVscodeExtension) => {
      if (p.adapted.manifest.id === "a.root") throw new Error("boom")
      return row(p.adapted.manifest.id)
    })
    const client = createOpenVsxInstallClient(deps)

    const result = await runMarketplaceInstall({
      pluginId: "a.root",
      client,
      requestConflictReview: async () => "continue",
      requestPermissionReview: async () => "approve",
      requestConfig: async () => ({ result: "save", value: {} }),
      rollback: null,
    })

    expect(result).toMatchObject({ status: "failed", stage: "install" })
    // Every row this run created is gone; the graph is all-or-nothing.
    const committed = deps.commit.mock.calls.map(
      (c) => (c[0] as PreparedVscodeExtension).adapted.manifest.id
    )
    const rolledBack = deps.uninstall.mock.calls.map((c) => (c[0] as PluginRow).id)
    expect(committed.filter((id) => id !== "a.root")).toEqual(rolledBack)
  })

  it("keeps rolling back after one uninstall fails", async () => {
    // One stuck directory must not strand the rest of the graph installed.
    const deps = stagingDeps(["c.deep", "b.mid", "a.root"])
    ;(deps.commit as jest.Mock).mockImplementation(async (p: PreparedVscodeExtension) => {
      if (p.adapted.manifest.id === "a.root") throw new Error("boom")
      return row(p.adapted.manifest.id)
    })
    ;(deps.uninstall as jest.Mock).mockImplementation(async (r: PluginRow) => {
      if (r.id === "b.mid") throw new Error("directory locked")
    })

    const graph = await stageGraph(plan(["c.deep", "b.mid", "a.root"]), deps)
    await expect(commitGraph(graph, deps)).rejects.toThrow("boom")

    expect(deps.uninstall.mock.calls.map((c) => (c[0] as PluginRow).id)).toEqual([
      "b.mid",
      "c.deep",
    ])
  })

  it("returns every created row on success", async () => {
    const deps = stagingDeps(["b.dep", "a.root"])
    const graph = await stageGraph(plan(["b.dep", "a.root"]), deps)

    const rows = await commitGraph(graph, deps)

    expect(rows.map((r) => r.id)).toEqual(["b.dep", "a.root"])
    expect(deps.uninstall).not.toHaveBeenCalled()
  })

  it("concurrent_installs_serialize", async () => {
    // Two overlapping graphs committing at once would each decide what to roll
    // back from a view of the plugin table the other is mutating: A commits
    // the shared dependency, B sees it installed and marks it "pre-existing,
    // leave alone", A then fails and removes it — and B is left pointing at a
    // directory that no longer exists.
    const events: string[] = []
    const gate = deferred()
    const aIsInsideItsFirstCommit = deferred()
    let held = false

    const deps = stagingDeps(["shared.dep", "a.root"])
    ;(deps.commit as jest.Mock).mockImplementation(async (p: PreparedVscodeExtension) => {
      const id = p.adapted.manifest.id
      events.push(`enter:${id}`)
      if (!held) {
        // Park the very first commit, holding the lock open.
        held = true
        aIsInsideItsFirstCommit.resolve()
        await gate.promise
      }
      events.push(`exit:${id}`)
      return row(id)
    })

    const graphA = await stageGraph(plan(["shared.dep", "a.root"]), deps)
    const graphB = await stageGraph(plan(["shared.dep", "z.other"]), deps)

    const runA = commitGraph(graphA, deps)
    const runB = commitGraph(graphB, deps)
    await aIsInsideItsFirstCommit.promise

    // The load-bearing assertion: A holds the lock, so B has not touched a
    // single row. Without the mutex B would already be inside its own
    // `enter:shared.dep`.
    expect(events).toEqual(["enter:shared.dep"])

    gate.resolve()
    await Promise.all([runA, runB])

    // A's commits are contiguous — B never interleaves into them.
    expect(events).toEqual([
      "enter:shared.dep",
      "exit:shared.dep",
      "enter:a.root",
      "exit:a.root",
      "enter:shared.dep",
      "exit:shared.dep",
      "enter:z.other",
      "exit:z.other",
    ])
  })

  it("releases the lock when a graph fails so the next install is not wedged", async () => {
    const deps = stagingDeps(["a.root"])
    ;(deps.commit as jest.Mock).mockRejectedValueOnce(new Error("first fails"))

    const graph = await stageGraph(plan(["a.root"]), deps)
    await expect(commitGraph(graph, deps)).rejects.toThrow("first fails")

    ;(deps.commit as jest.Mock).mockImplementation(async (p: PreparedVscodeExtension) =>
      row(p.adapted.manifest.id)
    )
    const second = await stageGraph(plan(["a.root"]), deps)
    await expect(commitGraph(second, deps)).resolves.toHaveLength(1)
  })
})

// =============================================================================
// Version agreement
// =============================================================================

describe("installPlugin version agreement", () => {
  it("refuses a version other than the one whose permissions were reviewed", async () => {
    const deps = stagingDeps(["a.root"])
    const client = createOpenVsxInstallClient(deps)

    await client.getPlugin("a.root")
    await expect(client.installPlugin("a.root", "9.9.9")).rejects.toThrow(
      /permissions you reviewed were resolved from 1\.0\.0/
    )
    expect(deps.commit).not.toHaveBeenCalled()
  })

  it("accepts the version it staged", async () => {
    const deps = stagingDeps(["a.root"])
    const client = createOpenVsxInstallClient(deps)

    await client.getPlugin("a.root")
    await expect(client.installPlugin("a.root", "1.0.0")).resolves.toBeDefined()
  })
})

// =============================================================================
// The production defaults
// =============================================================================

describe("default download", () => {
  /** Deps with `download` left at its real implementation. */
  const realDownloadDeps = (overrides: Partial<OpenVsxInstallFlowDeps> = {}) => {
    const { download: _drop, ...rest } = stagingDeps(["a.root"])
    void _drop
    return { ...rest, download: undefined, ...overrides } as OpenVsxInstallFlowDeps
  }

  it("refuses to install bytes Open VSX published no digest for", async () => {
    // `files.sha256` is a URL to a digest file. Its absence means there is
    // nothing to verify against — and installing unverified executable bytes
    // because the registry omitted a field is not a trade we make.
    const noDigest = plan(["a.root"])
    delete noDigest.nodes[0].entry.files.sha256

    await expect(stageGraph(noDigest, realDownloadDeps())).rejects.toThrow(
      /refusing to install unverified bytes/
    )
  })

  it("refuses outside the desktop app rather than bypassing the user's proxy", async () => {
    // `proxyFetch`'s Rust backend returns `body: String` and structurally
    // cannot carry binary, so a TS-direct download would silently ignore the
    // user's proxy config.
    const { canUseTauriInvoke } = jest.requireMock("@/lib/native/utils")
    canUseTauriInvoke.mockReturnValue(false)

    await expect(stageGraph(plan(["a.root"]), realDownloadDeps())).rejects.toThrow(
      /requires the Cognia desktop app/
    )
    canUseTauriInvoke.mockReturnValue(true)
  })

  it("hands the Rust downloader the registry's own URLs", async () => {
    const { invoke } = jest.requireMock("@tauri-apps/api/core")
    invoke.mockResolvedValue({
      tempPath: "/tmp/a.root.vsix",
      sha256Hex: "sha-a.root",
      sizeBytes: 3,
    })

    await stageGraph(plan(["a.root"]), realDownloadDeps())

    expect(invoke).toHaveBeenCalledWith("plugin_vscode_download_vsix", {
      downloadUrl: "https://open-vsx.org/api/a/root/1.0.0/file/a.root.vsix",
      sha256Url: "https://open-vsx.org/api/a/root/1.0.0/file/a.root.sha256",
    })
  })
})

describe("default uninstall", () => {
  it("drops the Dexie row before the directory", async () => {
    // A leftover directory with no row is inert. A row pointing at a deleted
    // directory is a plugin the manager will try to load and fail on — so the
    // row goes first.
    const { deletePlugin } = jest.requireMock("@/lib/db/plugins")
    const { removeFile } = jest.requireMock("@/lib/file/file-operations")
    const order: string[] = []
    deletePlugin.mockImplementation(async () => void order.push("row"))
    removeFile.mockImplementation(async (p: string) => {
      if (p.startsWith("/ext/")) order.push("dir")
    })

    const deps = stagingDeps(["b.dep", "a.root"])
    ;(deps.commit as jest.Mock).mockImplementation(async (p: PreparedVscodeExtension) => {
      if (p.adapted.manifest.id === "a.root") throw new Error("boom")
      return row(p.adapted.manifest.id)
    })
    const graph = await stageGraph(plan(["b.dep", "a.root"]), deps)

    await expect(commitGraph(graph, { ...deps, uninstall: undefined })).rejects.toThrow("boom")

    expect(deletePlugin).toHaveBeenCalledWith("b.dep")
    expect(removeFile).toHaveBeenCalledWith("/ext/b.dep", { recursive: true })
    expect(order).toEqual(["row", "dir"])
  })

  it("skips the filesystem for a browser-mode placeholder path", async () => {
    // Browser mode records `vsix://<id>@<sha>` — there is no directory to
    // remove, and handing that to the fs plugin would throw.
    const { removeFile } = jest.requireMock("@/lib/file/file-operations")
    const deps = stagingDeps(["b.dep", "a.root"])
    ;(deps.commit as jest.Mock).mockImplementation(async (p: PreparedVscodeExtension) => {
      const id = p.adapted.manifest.id
      if (id === "a.root") throw new Error("boom")
      return { id, path: `vsix://${id}@abc123` } as PluginRow
    })
    const graph = await stageGraph(plan(["b.dep", "a.root"]), deps)

    await expect(commitGraph(graph, { ...deps, uninstall: undefined })).rejects.toThrow("boom")

    expect(removeFile).not.toHaveBeenCalledWith(
      expect.stringContaining("vsix://"),
      expect.anything()
    )
  })
})

// =============================================================================
// The real chain, end to end
// =============================================================================

describe("staging a real .vsix through the undefaulted pipeline", () => {
  /** A minimal but genuine `.vsix`, matching `vsix-installer.test.ts`. */
  async function buildVsix(): Promise<Uint8Array> {
    const zip = new JSZip()
    zip.file(
      "extension/package.json",
      JSON.stringify({
        publisher: "cognia",
        name: "hello",
        version: "1.0.0",
        main: "./out/extension.js",
        engines: { vscode: ">=1.74.0" },
      })
    )
    zip.file("extension/out/extension.js", "const cp = require('child_process'); cp.spawn('sh')")
    return zip.generateAsync({ type: "uint8array" })
  }

  it("parses, infers permissions, and installs from the path Rust staged", async () => {
    // Everything real except the two IO edges: the real `prepareVscodeExtension`
    // (JSZip + the @babel/parser permission walk) and the real
    // `commitVscodeExtension`.
    const { readBinaryFile, removeFile } = jest.requireMock("@/lib/file/file-operations")
    const { invoke } = jest.requireMock("@tauri-apps/api/core")
    const { upsertPlugin } = jest.requireMock("@/lib/db/plugins")
    removeFile.mockResolvedValue(undefined)

    const bytes = await buildVsix()
    const { vsix } = await prepareVscodeExtension(bytes, "openvsx")
    readBinaryFile.mockResolvedValue(bytes)
    invoke.mockResolvedValue({
      extensionId: "cognia.hello",
      installPath: "/data/cognia/vscode-extensions/cognia.hello",
      sha256Hex: vsix.sha256,
      packageJson: {},
    })

    const graph = await stageGraph(plan(["cognia.hello"]), {
      resolveGraph: jest.fn(async () => plan(["cognia.hello"])),
      download: jest.fn(async () => ({
        tempPath: "/tmp/cognia.hello.vsix",
        sha256Hex: vsix.sha256,
        sizeBytes: bytes.length,
      })),
    })

    // The permission the bundle actually implies — inferred from the AST, not
    // read off the manifest. This is the payload the consent prompt shows.
    expect(graph.manifest.permissions).toContain("process:spawn")

    await commitGraph(graph, {})

    // The marketplace path must use the staged file, not a base64 round trip:
    // on an 80 MB extension the ~107 MB JS string is the difference between
    // installing and OOMing the webview.
    expect(invoke).toHaveBeenCalledWith("plugin_vscode_install_vsix_from_path", {
      tempPath: "/tmp/cognia.hello.vsix",
    })
    expect(invoke).not.toHaveBeenCalledWith("plugin_vscode_install_vsix", expect.anything())
    expect(upsertPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cognia.hello", source: "marketplace", enabled: false })
    )
  })
})

describe("internal invariants", () => {
  it("refuses to build a consent manifest for a graph missing its root", async () => {
    const orphaned = plan(["b.dep"])
    orphaned.rootId = "a.root"

    await expect(stageGraph(orphaned, stagingDeps(["b.dep"]))).rejects.toThrow(
      /missing its root extension/
    )
  })

  it("logs but survives a temp file that will not delete", async () => {
    const { removeFile } = jest.requireMock("@/lib/file/file-operations")
    const { loggers } = jest.requireMock("@cognia/logging")
    removeFile.mockRejectedValue(new Error("permission denied"))

    const deps = stagingDeps(["a.root"])
    const client = createOpenVsxInstallClient(deps)
    await client.getPlugin("a.root")

    // A failed cleanup must not become the error the user sees.
    await expect(client.discard()).resolves.toBeUndefined()
    expect(loggers.plugin.warn).toHaveBeenCalled()
  })
})

describe("discard", () => {
  it("drops staged temp files when the user walks away", async () => {
    const { removeFile } = jest.requireMock("@/lib/file/file-operations")
    const deps = stagingDeps(["a.root"])
    const client = createOpenVsxInstallClient(deps)

    await client.getPlugin("a.root")
    await client.discard()

    expect(removeFile).toHaveBeenCalledWith("/tmp/a.root.vsix")
  })

  it("is safe to call when nothing is staged", async () => {
    const client = createOpenVsxInstallClient(stagingDeps(["a.root"]))
    await expect(client.discard()).resolves.toBeUndefined()
  })

  it("is safe when the user walks away before the staging fails", async () => {
    // Closing the dialog mid-download, where the download then fails: there is
    // nothing staged to discard, and the staging error belongs to the caller
    // that asked for it — not to `discard`.
    const deps = stagingDeps(
      ["a.root"],
      {},
      {
        resolveGraph: jest.fn(async () => {
          throw new Error("network down")
        }),
      }
    )
    const client = createOpenVsxInstallClient(deps)

    const pending = client.getPlugin("a.root")
    const discarded = client.discard()

    await expect(pending).rejects.toThrow("network down")
    await expect(discarded).resolves.toBeUndefined()
  })
})
