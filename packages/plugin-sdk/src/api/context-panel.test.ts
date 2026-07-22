import { defineContextPanel } from "./context-panel"

describe("plugin-sdk api/context-panel", () => {
  it("publishes a runtime helper that preserves the panel contract", () => {
    const panel = defineContextPanel({
      id: "repository-inspector",
      entry: "dist/panels.js",
      export: "RepositoryInspector",
      resourceKinds: ["project-file"],
      activity: "inspect",
      labelKey: "panels.repositoryInspector",
      label: "Repository inspector",
    })

    expect(panel).toEqual(expect.objectContaining({ id: "repository-inspector" }))
  })
})
