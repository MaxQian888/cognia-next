/** @jest-environment node */
import { runPresetInstall } from "./preset-install"
import type { GithubMarketplaceEntry } from "@/lib/plugin/package/github-marketplace"
import type { GithubPluginPreview } from "@/lib/plugin/package/github-source"
import type { RunMarketplaceInstallResult } from "./install-flow"

function entry(name: string, id = `acme/store:${name}`): GithubMarketplaceEntry {
  return {
    id,
    name,
    version: "",
    type: "plugin",
    source: "git",
    github: { owner: "acme", repo: "store", ref: undefined, subdir: `plugins/${name}` },
  } as GithubMarketplaceEntry
}

function preview(manifestId: string, name = manifestId): GithubPluginPreview {
  return {
    manifest: { id: manifestId, name, version: "1.0.0" } as GithubPluginPreview["manifest"],
    sourceFormat: "cognia",
    conversionReport: {},
    generatedFiles: {},
    ref: { owner: "acme", repo: "store", subdir: `plugins/${name}` },
  } as GithubPluginPreview
}

const ok: RunMarketplaceInstallResult = { status: "installed", pluginId: "x" }

describe("runPresetInstall", () => {
  it("installs members in declared order, each through the consent chain", async () => {
    const order: string[] = []
    const result = await runPresetInstall({
      members: [entry("a"), entry("b"), entry("c")],
      isInstalled: () => false,
      preview: async (e) => preview(`id-${e.name}`),
      install: async (id) => {
        order.push(id)
        return ok
      },
    })
    expect(order).toEqual(["id-a", "id-b", "id-c"])
    expect(result.installed).toEqual(["id-a", "id-b", "id-c"])
    expect(result.failed).toEqual([])
    expect(result.cancelled).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it("skips members whose manifest id is already installed", async () => {
    const installed = new Set(["id-b"])
    const result = await runPresetInstall({
      members: [entry("a"), entry("b")],
      isInstalled: (id) => installed.has(id),
      preview: async (e) => preview(`id-${e.name}`),
      install: async () => ok,
    })
    expect(result.skipped).toEqual(["id-b"])
    expect(result.installed).toEqual(["id-a"])
  })

  it("records a failed member and keeps going", async () => {
    const result = await runPresetInstall({
      members: [entry("a"), entry("b"), entry("c")],
      isInstalled: () => false,
      preview: async (e) => preview(`id-${e.name}`),
      install: async (id) =>
        id === "id-b" ? { status: "failed", stage: "install", message: "disk full" } : ok,
    })
    expect(result.installed).toEqual(["id-a", "id-c"])
    expect(result.failed).toEqual([{ id: "id-b", name: "id-b", message: "disk full" }])
    expect(result.cancelled).toEqual([])
  })

  it("records a preview failure by catalog id and keeps going", async () => {
    const result = await runPresetInstall({
      members: [entry("a"), entry("b")],
      isInstalled: () => false,
      preview: async (e) => {
        if (e.name === "a") throw new Error("404")
        return preview(`id-${e.name}`)
      },
      install: async () => ok,
    })
    expect(result.failed).toEqual([{ id: "acme/store:a", name: "a", message: "404" }])
    expect(result.installed).toEqual(["id-b"])
  })

  it("stops on user cancel and reports every un-attempted member as cancelled", async () => {
    const calls: string[] = []
    const result = await runPresetInstall({
      members: [entry("a"), entry("b"), entry("c")],
      isInstalled: () => false,
      preview: async (e) => preview(`id-${e.name}`),
      install: async (id) => {
        calls.push(id)
        return id === "id-b" ? { status: "cancelled", stage: "permission" } : ok
      },
    })
    // "c" was never attempted — its bucket id is the catalog id (no manifest).
    expect(calls).toEqual(["id-a", "id-b"])
    expect(result.installed).toEqual(["id-a"])
    expect(result.cancelled).toEqual(["id-b", "acme/store:c"])
  })

  it("reports progress per completed attempt", async () => {
    const ticks: Array<[number, number, string]> = []
    await runPresetInstall({
      members: [entry("a"), entry("b")],
      isInstalled: () => false,
      preview: async (e) => preview(`id-${e.name}`),
      install: async () => ok,
      onProgress: (done, total, e) => ticks.push([done, total, e.name]),
    })
    expect(ticks).toEqual([
      [1, 2, "a"],
      [2, 2, "b"],
    ])
  })
})
