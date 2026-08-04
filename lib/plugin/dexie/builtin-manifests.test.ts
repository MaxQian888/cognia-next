import { getBuiltinPluginDexieManifests } from "./builtin-manifests"

it("exposes every built-in dynamic table without importing plugin implementations", () => {
  const manifests = getBuiltinPluginDexieManifests()

  expect([...manifests.keys()].sort()).toEqual(["strix-security", "zhihu-content-pipeline"])
  expect(manifests.get("zhihu-content-pipeline")?.tables.map((table) => table.name)).toEqual([
    "topics",
    "research",
    "drafts",
  ])
})
