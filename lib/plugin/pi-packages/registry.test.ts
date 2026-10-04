import { OVERLAY_REGISTRY_CAPABILITIES } from "@/lib/plugin/contracts/capability-bridge-map"
import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import {
  __resetContributedPiPackagesForTesting,
  getContributedPiPackage,
  getContributedPiPackagesRevision,
  listContributedPiPackages,
  registerContributedPiPackage,
  subscribeContributedPiPackages,
  unregisterContributedPiPackagesByPlugin,
} from "./registry"

const def = (id: string): PluginPiPackageDef => ({ id, name: id, path: "pi" })

describe("contributed Pi package registry", () => {
  afterEach(() => __resetContributedPiPackagesForTesting())

  it("registers entries under <pluginId>/<packageId> with the install root", () => {
    registerContributedPiPackage(def("latex"), {
      pluginId: "latex-workbench",
      installRoot: "/data/plugins/latex-workbench",
    })
    expect(listContributedPiPackages()).toEqual([
      {
        ref: "latex-workbench/latex",
        pluginId: "latex-workbench",
        def: def("latex"),
        installRoot: "/data/plugins/latex-workbench",
      },
    ])
    expect(getContributedPiPackage("latex-workbench/latex")?.installRoot).toBe(
      "/data/plugins/latex-workbench"
    )
  })

  it("keeps same-id packages from two plugins apart", () => {
    registerContributedPiPackage(def("tools"), { pluginId: "a", installRoot: "/p/a" })
    registerContributedPiPackage(def("tools"), { pluginId: "b", installRoot: "/p/b" })
    expect(listContributedPiPackages().map((entry) => entry.ref)).toEqual(["a/tools", "b/tools"])
  })

  it("unregisters everything a plugin contributed", () => {
    registerContributedPiPackage(def("one"), { pluginId: "a", installRoot: "/p/a" })
    registerContributedPiPackage(def("two"), { pluginId: "a", installRoot: "/p/a" })
    registerContributedPiPackage(def("three"), { pluginId: "b", installRoot: "/p/b" })
    expect(unregisterContributedPiPackagesByPlugin("a")).toBe(2)
    expect(listContributedPiPackages().map((entry) => entry.ref)).toEqual(["b/three"])
  })

  it("returns undefined for malformed or unknown references", () => {
    expect(getContributedPiPackage("no-slash")).toBeUndefined()
    expect(getContributedPiPackage("a/")).toBeUndefined()
    expect(getContributedPiPackage("a/missing")).toBeUndefined()
  })

  it("records an empty install root when the dispatch loop supplies none", () => {
    registerContributedPiPackage(def("bare"), { pluginId: "a" })
    expect(getContributedPiPackage("a/bare")?.installRoot).toBe("")
  })

  it("notifies subscribers and bumps the revision on change", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeContributedPiPackages(listener)
    const before = getContributedPiPackagesRevision()
    registerContributedPiPackage(def("x"), { pluginId: "a", installRoot: "/p/a" })
    expect(listener).toHaveBeenCalled()
    expect(getContributedPiPackagesRevision()).toBeGreaterThan(before)
    unsubscribe()
  })

  it("is wired into the overlay dispatch loop for the pi-package capability", () => {
    const descriptor = OVERLAY_REGISTRY_CAPABILITIES["pi-package"]
    expect(descriptor.manifestField).toBe("piPackages")
    descriptor.registerEntry(def("via-loop") as never, {
      pluginId: "loop-plugin",
      installRoot: "/p/loop",
    })
    expect(getContributedPiPackage("loop-plugin/via-loop")?.installRoot).toBe("/p/loop")
    expect(descriptor.unregisterAllByPlugin("loop-plugin")).toBe(1)
    expect(getContributedPiPackage("loop-plugin/via-loop")).toBeUndefined()
  })
})
