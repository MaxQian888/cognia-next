import {
  FOLLOWING_PANELS,
  PINNABLE_PANELS,
  isPinnablePanel,
  pinDiverges,
  resolvePanelRoot,
} from "./panel-follow"
import type { SessionExecutionContext } from "@/types/execution-context"

const project = { roots: [{ id: "r", path: "/repos/app", isPrimary: true }] }

const local = {
  projectRoot: "/repos/app",
  workspaceBinding: { kind: "project" },
} as unknown as SessionExecutionContext

const managed = {
  projectRoot: "/repos/app",
  workspaceBinding: { kind: "managed" },
  execution: { roots: [{ role: "primary", aliasPath: "/repos/app/.cognia/wt/1" }] },
} as unknown as SessionExecutionContext

describe("resolvePanelRoot", () => {
  it("follows the conversation's execution root", () => {
    expect(
      resolvePanelRoot({ panel: "terminal", executionContext: local, activeProject: project })
    ).toMatchObject({ root: "/repos/app", source: "execution" })
  })

  it("follows a managed worktree alias, not the source repository", () => {
    // The whole defect: a conversation running in a worktree got a terminal in
    // the checkout it was cut from.
    const out = resolvePanelRoot({
      panel: "terminal",
      executionContext: managed,
      activeProject: project,
    })
    expect(out.root).toBe("/repos/app/.cognia/wt/1")
    expect(out.managed).toBe(true)
  })

  it("does not flag a managed binding whose alias IS the project root", () => {
    // "Managed" is about the directory, not the binding's label; warning here
    // would train the user to ignore the warning.
    const sameRoot = {
      projectRoot: "/repos/app",
      workspaceBinding: { kind: "managed" },
      execution: { roots: [{ role: "primary", aliasPath: "/repos/app" }] },
    } as unknown as SessionExecutionContext
    expect(resolvePanelRoot({ panel: "editor", executionContext: sameRoot }).managed).toBe(false)
  })

  it("falls back to the workspace root with no conversation", () => {
    expect(resolvePanelRoot({ panel: "editor", activeProject: project })).toMatchObject({
      root: "/repos/app",
      source: "workspace",
    })
  })

  it("falls back to the workspace root when the context resolves to nothing", () => {
    const unavailable = {
      workspaceBinding: { kind: "managed" },
      managedWorkspace: { availability: "missing" },
    } as unknown as SessionExecutionContext
    expect(
      resolvePanelRoot({ panel: "editor", executionContext: unavailable, activeProject: project })
    ).toMatchObject({ root: "/repos/app", source: "workspace" })
  })

  it("resolves to nothing when there is nothing to resolve", () => {
    expect(resolvePanelRoot({ panel: "editor" })).toEqual({
      root: null,
      source: "none",
      managed: false,
    })
  })

  it("honours a pin on a comparison panel", () => {
    expect(
      resolvePanelRoot({
        panel: "sourceControl",
        pinnedRoot: "/repos/other",
        executionContext: managed,
        activeProject: project,
      })
    ).toMatchObject({ root: "/repos/other", source: "pinned" })
  })

  it("IGNORES a pin on an execution panel", () => {
    // A terminal pinned to a directory the agent is not working in is a loaded
    // gun, and a stale persisted pin must not be able to create one.
    expect(
      resolvePanelRoot({
        panel: "terminal",
        pinnedRoot: "/repos/other",
        executionContext: managed,
      })
    ).toMatchObject({ root: "/repos/app/.cognia/wt/1", source: "execution" })
  })

  it("ignores a blank pin", () => {
    expect(
      resolvePanelRoot({ panel: "editor", pinnedRoot: "   ", activeProject: project })
    ).toMatchObject({ root: "/repos/app", source: "workspace" })
  })
})

describe("panel classification", () => {
  it("offers pinning only to panels where comparing is the point", () => {
    expect(PINNABLE_PANELS).toEqual(["sourceControl", "editor", "search"])
    expect(isPinnablePanel("sourceControl")).toBe(true)
    expect(isPinnablePanel("terminal")).toBe(false)
  })

  it("keeps execution panels on follow", () => {
    expect(FOLLOWING_PANELS).toEqual(["terminal", "schedule", "conversations"])
    for (const panel of FOLLOWING_PANELS) expect(isPinnablePanel(panel)).toBe(false)
  })

  it("has no panel in both lists", () => {
    const overlap = PINNABLE_PANELS.filter((panel) =>
      (FOLLOWING_PANELS as readonly string[]).includes(panel)
    )
    expect(overlap).toEqual([])
  })
})

describe("pinDiverges", () => {
  it("is false for a pin that matches what would be followed anyway", () => {
    // Such a pin makes the header claim a divergence that does not exist.
    expect(pinDiverges("/repos/app", "/repos/app")).toBe(false)
  })

  it("is true for a pin that points somewhere else", () => {
    expect(pinDiverges("/repos/other", "/repos/app")).toBe(true)
  })

  it("is false for no pin at all", () => {
    expect(pinDiverges(null, "/repos/app")).toBe(false)
    expect(pinDiverges(undefined, "/repos/app")).toBe(false)
    expect(pinDiverges("  ", "/repos/app")).toBe(false)
  })

  it("counts a pin as divergent when nothing would be followed", () => {
    expect(pinDiverges("/repos/other", null)).toBe(true)
  })
})
