import { isProjectFilePreviewable, resolveContextCapabilities } from "./capabilities"

it("computes platform and resource-specific capabilities", () => {
  expect(
    resolveContextCapabilities({
      kind: "artifact",
      previewable: true,
      runnable: false,
      workspaceAvailable: false,
    })
  ).toEqual(expect.arrayContaining(["ai", "comments", "preview", "history"]))
  expect(
    resolveContextCapabilities({
      kind: "artifact",
      previewable: true,
      runnable: false,
      workspaceAvailable: false,
    })
  ).not.toEqual(expect.arrayContaining(["run", "workspace"]))
  expect(resolveContextCapabilities({ kind: "canvas-document", runnable: true })).toContain("run")
  expect(resolveContextCapabilities({ kind: "workflow" })).toEqual(
    expect.arrayContaining(["run", "templates", "history"])
  )
})

it("detects the project preview formats handled by the native renderer", () => {
  expect(isProjectFilePreviewable("README.md")).toBe(true)
  expect(isProjectFilePreviewable("src/main.ts")).toBe(false)
})
