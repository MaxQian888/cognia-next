import {
  FOLLOWING_PANELS,
  PINNABLE_PANELS,
  isPinnablePanel,
  reconcileSelectedRoot,
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

describe("reconcileSelectedRoot — the editor's selection IS its pin", () => {
  const MAIN = "/repos/app"
  const TREE = "/repos/.worktrees/feature"
  const OTHER = "/repos/.worktrees/other"
  const available = [MAIN, TREE, OTHER]

  it("follows when nothing is selected yet", () => {
    expect(reconcileSelectedRoot({ followed: TREE, available })).toEqual({
      selected: TREE,
      pinned: false,
    })
  })

  it("reports a deliberate divergence as pinned", () => {
    expect(reconcileSelectedRoot({ selected: MAIN, followed: TREE, available })).toEqual({
      selected: MAIN,
      pinned: true,
    })
  })

  it("moves an editor that was following when the target moves", () => {
    // The user switched to a conversation running in another tree.
    expect(
      reconcileSelectedRoot({
        selected: MAIN,
        previousFollowed: MAIN,
        followed: TREE,
        available,
      })
    ).toEqual({ selected: TREE, pinned: false })
  })

  it("leaves a pinned editor alone when the target moves", () => {
    expect(
      reconcileSelectedRoot({
        selected: OTHER,
        previousFollowed: MAIN,
        followed: TREE,
        available,
      })
    ).toEqual({ selected: OTHER, pinned: true })
  })

  it("drops a selection that is no longer offered, and lands on the follow target", () => {
    // A worktree the user had pinned to was deleted. Holding a directory that
    // is gone is worse than resuming follow.
    expect(
      reconcileSelectedRoot({ selected: "/repos/.worktrees/gone", followed: TREE, available })
    ).toEqual({ selected: TREE, pinned: false })
  })

  it("falls back to the first available root when the follow target is not offered", () => {
    expect(reconcileSelectedRoot({ followed: "/elsewhere", available })).toEqual({
      selected: MAIN,
      pinned: true,
    })
  })

  it("keeps the follow target even when nothing is available yet", () => {
    // Worktree discovery has not settled; the panel still knows where it goes.
    expect(reconcileSelectedRoot({ followed: TREE, available: [] })).toEqual({
      selected: TREE,
      pinned: false,
    })
  })

  it("is never pinned when there is nothing to follow", () => {
    expect(reconcileSelectedRoot({ selected: MAIN, available })).toEqual({
      selected: MAIN,
      pinned: false,
    })
  })

  it("ignores whitespace-only paths on every input", () => {
    expect(
      reconcileSelectedRoot({
        selected: "   ",
        followed: "  ",
        previousFollowed: " ",
        available: ["  ", MAIN],
      })
    ).toEqual({ selected: MAIN, pinned: false })
  })
})

describe("a pin still says whether it is a worktree", () => {
  it("flags a pin onto the conversation's own managed worktree", () => {
    // The pinned branch used to hardcode `managed: false`, so a pinned worktree
    // rendered with the plain folder icon — the "looks like an ordinary
    // checkout" mistake the flag exists to prevent.
    const out = resolvePanelRoot({
      panel: "sourceControl",
      executionContext: managed,
      activeProject: project,
      pinnedRoot: "/repos/app/.cognia/wt/1",
    })
    expect(out).toEqual({
      root: "/repos/app/.cognia/wt/1",
      source: "pinned",
      managed: true,
    })
  })

  it("does not claim an unrelated pinned directory is a worktree", () => {
    // The resolver knows nothing about a directory the conversation is not in,
    // so it must not guess.
    const out = resolvePanelRoot({
      panel: "sourceControl",
      executionContext: managed,
      activeProject: project,
      pinnedRoot: "/tmp/scratch",
    })
    expect(out).toEqual({ root: "/tmp/scratch", source: "pinned", managed: false })
  })

  it("still ignores a pin on a panel that must follow", () => {
    const out = resolvePanelRoot({
      panel: "terminal",
      executionContext: managed,
      activeProject: project,
      pinnedRoot: "/tmp/scratch",
    })
    expect(out.source).toBe("execution")
    expect(out.managed).toBe(true)
  })
})
