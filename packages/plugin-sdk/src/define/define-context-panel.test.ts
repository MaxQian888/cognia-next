import { defineContextPanel } from "./define-context-panel"

it("preserves a declarative Context Workbench panel definition", () => {
  const panel = defineContextPanel({
    id: "outline",
    entry: "dist/panels.js",
    export: "OutlinePanel",
    resourceKinds: ["project-file", "canvas-document"],
    activity: "inspect",
    labelKey: "panels.outline",
    label: "Outline",
    icon: "file-text",
    preferredMode: "wide",
    retention: "stateful",
  })

  expect(panel).toEqual(expect.objectContaining({ id: "outline", preferredMode: "wide" }))
})
