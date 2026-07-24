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

  it("accepts a webview-backed panel without entry/export", () => {
    const panel = defineContextPanel({
      id: "inspector",
      webview: "inspector",
      resourceKinds: ["session"],
      activity: "inspect",
      labelKey: "panels.inspector",
      label: "Inspector",
    })

    expect(panel).toEqual(expect.objectContaining({ webview: "inspector" }))
  })
})
