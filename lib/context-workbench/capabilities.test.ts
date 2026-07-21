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
  expect(resolveContextCapabilities({ kind: "project-file", previewable: true })).toEqual(
    expect.arrayContaining(["history", "preview"])
  )
  expect(resolveContextCapabilities({ kind: "project-file", previewable: false })).not.toEqual(
    expect.arrayContaining(["preview"])
  )
  expect(resolveContextCapabilities({ kind: "workflow" })).toEqual(
    expect.arrayContaining(["run", "templates", "history"])
  )
})

it("gives a session only the non-document capabilities", () => {
  const withoutWorkspace = resolveContextCapabilities({
    kind: "session",
    workspaceAvailable: false,
  })
  expect(withoutWorkspace).toEqual(expect.arrayContaining(["inspect", "preview", "history"]))
  // A session is not a document: nothing to comment on, review or ask AI about.
  expect(withoutWorkspace).not.toEqual(expect.arrayContaining(["ai"]))
  expect(withoutWorkspace).not.toEqual(expect.arrayContaining(["comments"]))
  expect(withoutWorkspace).not.toEqual(expect.arrayContaining(["review"]))
  expect(withoutWorkspace).not.toEqual(expect.arrayContaining(["workspace"]))

  expect(resolveContextCapabilities({ kind: "session", workspaceAvailable: true })).toContain(
    "workspace"
  )
})

it("detects the project preview formats handled by the native renderer", () => {
  expect(isProjectFilePreviewable("README.md")).toBe(true)
  expect(isProjectFilePreviewable("src/main.ts")).toBe(false)
})
