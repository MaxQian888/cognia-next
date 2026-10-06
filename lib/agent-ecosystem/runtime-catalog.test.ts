import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import CATALOG from "@/protocol/external-agent-runtimes.json"
import { INTEGRATION_MANIFESTS } from "./catalog"
import { mergeIntegrationRuntimeRows, type RuntimeCatalogFile } from "./runtime-catalog"

const catalog = CATALOG as unknown as RuntimeCatalogFile

function row(runtimeId: string, displayName = runtimeId): ExternalAgentRuntimeCatalogEntry {
  return {
    runtimeId,
    presetIds: [runtimeId],
    displayName,
    ownership: "system",
    protocol: "acp",
    transport: "stdio",
    platforms: ["darwin"],
    distributions: [],
    sandbox: { required: true, windowsExceptionEligible: false },
  }
}

function manifest(
  id: string,
  rows: ExternalAgentRuntimeCatalogEntry[],
  waivers?: Record<string, string>,
  runtimeIds = rows.map((entry) => entry.runtimeId)
): AgentIntegrationManifest {
  return {
    ecosystem: {
      id,
      runtimeIds,
      sessionSourceIds: [],
      migrationVendor: null,
      vendorRootKeys: [],
      configRootKey: null,
      probeRootKeys: [],
      pluginEcosystem: null,
      subagentSourceId: null,
      memoryAgentId: null,
    },
    protocols: [],
    runtimes: rows,
    ...(waivers ? { unpinnedLaunchWaivers: waivers } : {}),
  }
}

const base: RuntimeCatalogFile = {
  version: 1,
  unpinnedLaunchWaivers: { note: "n", runtimes: { a: "old a", keep: "authored" } },
  runtimes: [row("a", "stale"), row("keep"), row("b", "stale")],
}

describe("mergeIntegrationRuntimeRows", () => {
  it("leaves the committed catalog unchanged: every package-owned row matches its manifest", () => {
    expect(mergeIntegrationRuntimeRows(catalog, INTEGRATION_MANIFESTS)).toEqual(catalog)
  })

  it("takes owned rows from manifests in place and appends new ones", () => {
    const merged = mergeIntegrationRuntimeRows(base, [
      manifest("x", [row("b", "B"), row("a", "A"), row("c", "C")]),
    ])
    expect(merged.runtimes.map((entry) => [entry.runtimeId, entry.displayName])).toEqual([
      ["a", "A"],
      ["keep", "keep"],
      ["b", "B"],
      ["c", "C"],
    ])
  })

  it("owns the waivers of its runtimes and leaves authored ones alone", () => {
    expect(
      mergeIntegrationRuntimeRows(base, [manifest("x", [row("a"), row("b")])]).unpinnedLaunchWaivers
        .runtimes
    ).toEqual({ keep: "authored" })
    expect(
      mergeIntegrationRuntimeRows(base, [manifest("x", [row("a"), row("b")], { b: "new b" })])
        .unpinnedLaunchWaivers.runtimes
    ).toEqual({ keep: "authored", b: "new b" })
  })

  it("refuses rows that do not match the ecosystem, double claims and foreign waivers", () => {
    expect(() =>
      mergeIntegrationRuntimeRows(base, [manifest("x", [row("a")], undefined, ["a", "b"])])
    ).toThrow(/do not match ecosystem.runtimeIds/)
    expect(() =>
      mergeIntegrationRuntimeRows(base, [manifest("x", [row("a")]), manifest("y", [row("a")])])
    ).toThrow(/more than one manifest/)
    expect(() =>
      mergeIntegrationRuntimeRows(base, [manifest("x", [row("a")], { keep: "theirs" })])
    ).toThrow(/does not own/)
  })

  it("does not alias manifest rows into the result", () => {
    const owned = row("a", "A")
    const merged = mergeIntegrationRuntimeRows(base, [manifest("x", [owned, row("b")])])
    expect(merged.runtimes[0]).toEqual(owned)
    expect(merged.runtimes[0]).not.toBe(owned)
  })
})
