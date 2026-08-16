// Smoke test: the barrel is the public surface of the Creator workbench
// (ADR-0117). `app/creator/page.tsx` imports `CreatorGate` and
// `CreatorWorkbench` through it, so a renamed or dropped export breaks the
// route rather than a component — loudly here instead of at runtime.

import * as creator from "./index"

describe("components/creator barrel", () => {
  it("re-exports the gate and the workbench the /creator route mounts", () => {
    expect(creator.CreatorGate).toBeDefined()
    expect(creator.CreatorWorkbench).toBeDefined()
  })

  it("re-exports the panels the workbench composes", () => {
    expect(creator.AuthoringRootCard).toBeDefined()
    expect(creator.CreatorStepRail).toBeDefined()
    expect(creator.PermissionDiffPanel).toBeDefined()
    expect(creator.ReviewPanel).toBeDefined()
  })

  it("re-exports stepStatus, which the rail's callers use to label a step", () => {
    expect(typeof creator.stepStatus).toBe("function")
  })
})
