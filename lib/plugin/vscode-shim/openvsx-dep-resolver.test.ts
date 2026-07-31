/**
 * Guards for Open VSX dependency-graph resolution.
 *
 * Every test here names a specific way a registry — hostile, compromised, or
 * merely wrong — could turn one "Install" click into something the user did
 * not ask for. The registry is untrusted input; these are the checks that make
 * that true in practice rather than in a comment.
 *
 * The fake client answers `/query` from a fixture graph, which lets a cycle, a
 * depth bomb, or a registry that contradicts itself be expressed in a few
 * lines. No network, no Dexie.
 */

import { MAX_DEPTH, MAX_NODES, resolveDependencyGraph } from "./openvsx-dep-resolver"
import type { OpenVsxQueryEntry, OpenVsxQueryResponse } from "./openvsx-client"
import type { OpenVsxTargetPlatform } from "./openvsx-platform"

const HOST: OpenVsxTargetPlatform = "darwin-arm64"

/** A `/query` entry shaped like the live API's. */
function entry(id: string, overrides: Partial<OpenVsxQueryEntry> = {}): OpenVsxQueryEntry {
  const [namespace, name] = id.split(".")
  return {
    namespace,
    name,
    version: "1.0.0",
    targetPlatform: HOST,
    files: {
      download: `https://open-vsx.org/api/${namespace}/${name}/1.0.0/file/${id}.vsix`,
      sha256: `https://open-vsx.org/api/${namespace}/${name}/1.0.0/file/${id}.sha256`,
    },
    ...overrides,
  }
}

/** Registry references are `{url, namespace, extension}` objects, not strings. */
function ref(id: string) {
  const [namespace, extension] = id.split(".")
  return { namespace, extension }
}

/**
 * A fake registry. `graph` maps an extension id to the entries `/query`
 * returns for it; a missing id answers `totalSize: 0`, which is what a real
 * platform miss looks like.
 *
 * `platformFilter` is the interesting knob. A well-behaved registry filters
 * server-side, so an off-platform entry never comes back and the platform
 * guards are unreachable — which is precisely why they exist: they are the
 * check on a registry that *doesn't* behave. `"ignore"` models that registry
 * (compromised, buggy, or a mirror that reimplemented the endpoint), which is
 * the only way an off-platform build reaches the resolver at all.
 */
function fakeClient(
  graph: Record<string, OpenVsxQueryEntry[]>,
  platformFilter: "honour" | "ignore" = "honour"
) {
  const queryExtension = jest.fn(
    async (options: {
      extensionId: string
      targetPlatform?: string
      includeAllVersions?: boolean
    }): Promise<OpenVsxQueryResponse> => {
      const published = graph[options.extensionId] ?? []
      const entries =
        platformFilter === "ignore"
          ? published
          : published.filter(
              (e) =>
                options.targetPlatform === undefined ||
                e.targetPlatform === options.targetPlatform ||
                e.targetPlatform === undefined
            )
      return { offset: 0, totalSize: entries.length, extensions: entries }
    }
  )
  return { queryExtension }
}

const resolve = (extensionId: string, client: { queryExtension: jest.Mock }, extra = {}) =>
  resolveDependencyGraph({ extensionId, host: HOST, client, ...extra })

describe("resolveDependencyGraph", () => {
  it("orders the plan so dependencies install before their dependents", async () => {
    const client = fakeClient({
      "a.root": [entry("a.root", { dependencies: [ref("b.mid")] })],
      "b.mid": [entry("b.mid", { dependencies: [ref("c.leaf")] })],
      "c.leaf": [entry("c.leaf")],
    })

    const plan = await resolve("a.root", client)

    expect(plan.nodes.map((n) => n.extensionId)).toEqual(["c.leaf", "b.mid", "a.root"])
    expect(plan.rootId).toBe("a.root")
    expect(plan.nodes.find((n) => n.isRoot)?.extensionId).toBe("a.root")
  })

  it("cycle_terminates_and_reports", async () => {
    // A -> B -> A. Without the ancestor check this recurses until the stack
    // dies; the plan still has to come out installable.
    const client = fakeClient({
      "a.a": [entry("a.a", { dependencies: [ref("b.b")] })],
      "b.b": [entry("b.b", { dependencies: [ref("a.a")] })],
    })

    const plan = await resolve("a.a", client)

    expect(plan.nodes.map((n) => n.extensionId).sort()).toEqual(["a.a", "b.b"])
    // Reported, not swallowed: the cycle is the registry's bug and the UI
    // should be able to say so.
    expect(plan.cycles).toEqual([["a.a", "b.b", "a.a"]])
  })

  it("depth_bomb_rejected_at_max_depth", async () => {
    // A chain one link longer than the limit allows.
    const graph: Record<string, OpenVsxQueryEntry[]> = {}
    const chain = Array.from({ length: MAX_DEPTH + 2 }, (_, i) => `n${i}.ext`)
    chain.forEach((id, i) => {
      const next = chain[i + 1]
      graph[id] = [entry(id, next ? { dependencies: [ref(next)] } : {})]
    })
    const client = fakeClient(graph)

    await expect(resolve(chain[0], client)).rejects.toMatchObject({
      name: "OpenVsxDependencyError",
      reason: "depth_exceeded",
    })
  })

  it("stops querying once the depth limit is hit rather than walking the whole bomb", async () => {
    // The guard runs before the query, so a chain of 500 fabricated links
    // costs MAX_DEPTH round trips, not 500.
    const graph: Record<string, OpenVsxQueryEntry[]> = {}
    const chain = Array.from({ length: 500 }, (_, i) => `n${i}.ext`)
    chain.forEach((id, i) => {
      const next = chain[i + 1]
      graph[id] = [entry(id, next ? { dependencies: [ref(next)] } : {})]
    })
    const client = fakeClient(graph)

    await expect(resolve(chain[0], client)).rejects.toThrow(/deeper than/)
    expect(client.queryExtension.mock.calls.length).toBeLessThanOrEqual(MAX_DEPTH + 1)
  })

  it("node_count_bomb_rejected", async () => {
    // A flat root advertising far more dependencies than the plan may hold.
    const deps = Array.from({ length: MAX_NODES + 10 }, (_, i) => `d${i}.ext`)
    const graph: Record<string, OpenVsxQueryEntry[]> = {
      "a.root": [entry("a.root", { dependencies: deps.map(ref) })],
    }
    for (const id of deps) graph[id] = [entry(id)]
    const client = fakeClient(graph)

    await expect(resolve("a.root", client)).rejects.toMatchObject({
      name: "OpenVsxDependencyError",
      reason: "node_limit_exceeded",
    })
  })

  it("diamond_dep_installed_once", async () => {
    // A -> B -> D and A -> C -> D. D is one node, installed once.
    const client = fakeClient({
      "a.root": [entry("a.root", { dependencies: [ref("b.left"), ref("c.right")] })],
      "b.left": [entry("b.left", { dependencies: [ref("d.shared")] })],
      "c.right": [entry("c.right", { dependencies: [ref("d.shared")] })],
      "d.shared": [entry("d.shared")],
    })

    const plan = await resolve("a.root", client)

    const ids = plan.nodes.map((n) => n.extensionId)
    expect(ids.filter((id) => id === "d.shared")).toHaveLength(1)
    expect(ids).toHaveLength(4)
    // Still ordered: the shared dep precedes both of its dependents.
    expect(ids.indexOf("d.shared")).toBeLessThan(ids.indexOf("b.left"))
    expect(ids.indexOf("d.shared")).toBeLessThan(ids.indexOf("c.right"))
    // Reaching a node twice is a diamond, not a cycle.
    expect(plan.cycles).toEqual([])
  })

  it("conflicting_versions_abort_before_install", async () => {
    // A registry that answers the same question two different ways. The plan
    // it implies is not installable — two versions cannot share a directory —
    // so resolution aborts while nothing has been downloaded, let alone
    // written.
    let answered = 0
    const client = fakeClient({
      "a.root": [entry("a.root", { dependencies: [ref("b.left"), ref("c.right")] })],
      "b.left": [entry("b.left", { dependencies: [ref("d.shared")] })],
      "c.right": [entry("c.right", { dependencies: [ref("d.shared")] })],
    })
    // Captured BEFORE the override, or the delegation below is a recursive
    // call into itself.
    const passthrough = client.queryExtension.getMockImplementation()!
    client.queryExtension.mockImplementation(async (options) => {
      if (options.extensionId === "d.shared") {
        answered += 1
        return {
          offset: 0,
          totalSize: 1,
          extensions: [entry("d.shared", { version: answered === 1 ? "1.0.0" : "2.0.0" })],
        }
      }
      return passthrough(options)
    })

    await expect(resolve("a.root", client)).rejects.toMatchObject({
      name: "OpenVsxDependencyError",
      reason: "version_conflict",
      extensionId: "d.shared",
    })
  })

  it("mixed_target_platform_aborts", async () => {
    // The root has a darwin-arm64 build; its dependency ships only for
    // win32-x64 and has no universal fallback. Installing the x64 build under
    // emulation would surface as a native-binary crash much later, attributed
    // to cognia rather than to the mismatch — so the set is refused.
    const client = fakeClient(
      {
        "a.root": [entry("a.root", { dependencies: [ref("b.native")] })],
        "b.native": [entry("b.native", { targetPlatform: "win32-x64" })],
      },
      "ignore"
    )

    await expect(resolve("a.root", client)).rejects.toMatchObject({
      name: "OpenVsxDependencyError",
      reason: "mixed_target_platform",
      extensionId: "b.native",
    })
  })

  it("accepts a universal dependency alongside a platform-specific root", async () => {
    // The inverse guard: `universal` runs everywhere, so mixing it in is not a
    // substitution and must not be refused.
    const client = fakeClient({
      "a.root": [entry("a.root", { dependencies: [ref("b.portable")] })],
      "b.portable": [entry("b.portable", { targetPlatform: "universal" })],
    })

    const plan = await resolve("a.root", client)

    expect(plan.nodes.map((n) => n.targetPlatform)).toEqual(["universal", "darwin-arm64"])
  })

  it("falls back to the universal build when the host platform has none", async () => {
    // A platform miss is `totalSize: 0` with HTTP 200, so the retry is
    // required — an empty result is otherwise indistinguishable from "no such
    // extension".
    const client = fakeClient({
      "a.root": [entry("a.root", { targetPlatform: "universal" })],
    })

    const plan = await resolve("a.root", client)

    expect(plan.nodes[0].targetPlatform).toBe("universal")
    expect(client.queryExtension).toHaveBeenCalledWith(
      expect.objectContaining({ targetPlatform: HOST })
    )
    expect(client.queryExtension).toHaveBeenCalledWith(
      expect.objectContaining({ targetPlatform: "universal" })
    )
  })

  it("reports an unpublished dependency instead of installing a partial set", async () => {
    const client = fakeClient({
      "a.root": [entry("a.root", { dependencies: [ref("b.missing")] })],
    })

    await expect(resolve("a.root", client)).rejects.toMatchObject({
      name: "OpenVsxDependencyError",
      reason: "unresolvable_dependency",
      extensionId: "b.missing",
    })
  })

  it("lets the root's own platform failure keep its own message", async () => {
    // `mixed_target_platform` would be a nonsense diagnosis for the extension
    // the user actually picked — there is no "mix" of one.
    const client = fakeClient(
      { "a.root": [entry("a.root", { targetPlatform: "win32-x64" })] },
      "ignore"
    )

    await expect(resolve("a.root", client)).rejects.toMatchObject({
      name: "OpenVsxPlatformError",
      reason: "no_matching_build",
    })
  })

  it("selects the newest stable version, never the pre-release the alias points at", async () => {
    // rust-analyzer's `latest` is literally `preRelease: true`.
    const client = fakeClient({
      "a.root": [
        entry("a.root", { version: "2.0.0", preRelease: true, versionAlias: ["latest"] }),
        entry("a.root", { version: "1.5.0" }),
      ],
    })

    const plan = await resolve("a.root", client)

    expect(plan.nodes[0].version).toBe("1.5.0")
  })

  it("honours a pinned root version without pinning its dependencies", async () => {
    const client = fakeClient({
      "a.root": [
        entry("a.root", { version: "2.0.0", dependencies: [ref("b.dep")] }),
        entry("a.root", { version: "1.0.0", dependencies: [ref("b.dep")] }),
      ],
      // A reference carries no version, so the dep always resolves to newest
      // stable regardless of what the root was pinned to.
      "b.dep": [entry("b.dep", { version: "9.9.9" }), entry("b.dep", { version: "1.0.0" })],
    })

    const plan = await resolve("a.root", client, { requestedVersion: "1.0.0" })

    expect(plan.nodes.find((n) => n.isRoot)?.version).toBe("1.0.0")
    expect(plan.nodes.find((n) => !n.isRoot)?.version).toBe("9.9.9")
  })

  it("picks the downloadable build for the resolved version", async () => {
    const client = fakeClient({
      "a.root": [
        entry("a.root", { targetPlatform: HOST, downloadable: false }),
        entry("a.root", { targetPlatform: "universal" }),
      ],
    })

    const plan = await resolve("a.root", client)

    expect(plan.nodes[0].targetPlatform).toBe("universal")
  })
})

describe("extensionPack (bundledExtensions)", () => {
  it("reports pack members as advisory instead of installing them", async () => {
    // `vscjava.vscode-java-pack` bundles ~24 extensions. They are independent
    // installs, not requirements: installing them off one click is exactly
    // what `consent_covers_full_transitive_set` forbids, and treating them as
    // requirements would let one unavailable member block the pack.
    const client = fakeClient({
      "p.pack": [
        entry("p.pack", {
          bundledExtensions: [ref("m.one"), ref("m.two"), ref("m.one")],
        }),
      ],
      "m.one": [entry("m.one")],
      "m.two": [entry("m.two")],
    })

    const plan = await resolve("p.pack", client)

    expect(plan.nodes.map((n) => n.extensionId)).toEqual(["p.pack"])
    // Deduped, and surfaced so the UI can offer them separately.
    expect(plan.bundled.map((b) => `${b.namespace}.${b.extension}`)).toEqual(["m.one", "m.two"])
    // Never queried — a pack member's availability is not this install's problem.
    expect(client.queryExtension).toHaveBeenCalledTimes(1)
  })

  it("does not let an unavailable pack member block the pack", async () => {
    const client = fakeClient({
      "p.pack": [entry("p.pack", { bundledExtensions: [ref("gone.forever")] })],
    })

    const plan = await resolve("p.pack", client)

    expect(plan.nodes).toHaveLength(1)
    expect(plan.bundled).toHaveLength(1)
  })

  it("omits a pack member that is also a hard dependency", async () => {
    // It is already in `nodes`; listing it again would invite a second install
    // of something already installed.
    const client = fakeClient({
      "p.pack": [
        entry("p.pack", { dependencies: [ref("m.one")], bundledExtensions: [ref("m.one")] }),
      ],
      "m.one": [entry("m.one")],
    })

    const plan = await resolve("p.pack", client)

    expect(plan.nodes.map((n) => n.extensionId)).toEqual(["m.one", "p.pack"])
    expect(plan.bundled).toEqual([])
  })
})
