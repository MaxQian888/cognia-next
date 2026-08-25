import type { SessionExecutionContext } from "@/types/execution-context"
import type { Project } from "@/types"

import {
  NO_EXECUTION_ROOT,
  resolveExecutionRoot,
  resolveSessionExecutionRoot,
  sessionExecutionRootPath,
} from "./session-root"
import { resolvePanelRoot } from "./panel-follow"

const REPO = "/repos/app"
const WORKTREE = "/repos/.worktrees/app-feature"

function project(path: string | null, id = "p1"): Pick<Project, "id" | "roots"> {
  return {
    id,
    roots: path ? [{ id: "r1", path, isPrimary: true }] : [],
  } as Pick<Project, "id" | "roots">
}

function localContext(projectRoot = REPO): SessionExecutionContext {
  return {
    location: "local",
    projectRoot,
    workspaceBinding: { kind: "project", projectId: "p1" },
    taskWorkspace: {},
  } as unknown as SessionExecutionContext
}

function managedContext(
  localRoot: string | undefined,
  availability: "available" | "missing-on-device" = "available"
): SessionExecutionContext {
  return {
    location: "managedWorktree",
    projectRoot: REPO,
    workspaceBinding: { kind: "managed", workspaceId: "ws-1" },
    managedWorkspace: { availability, localRoot },
    taskWorkspace: {},
  } as unknown as SessionExecutionContext
}

function leasedContext(aliasPath: string): SessionExecutionContext {
  return {
    location: "managedWorktree",
    projectRoot: REPO,
    workspaceBinding: { kind: "managed", workspaceId: "ws-1" },
    execution: { roots: [{ role: "primary", aliasPath }] },
    taskWorkspace: {},
  } as unknown as SessionExecutionContext
}

describe("resolveExecutionRoot", () => {
  it("prefers the conversation's execution root over the workspace root", () => {
    expect(
      resolveExecutionRoot({ executionContext: managedContext(WORKTREE), project: project(REPO) })
    ).toEqual({ root: WORKTREE, source: "execution", managed: true })
  })

  it("falls back to the workspace root when no binding exists yet", () => {
    // A brand-new conversation's first turn genuinely runs in the workspace
    // root. What was wrong before was reaching for it while a binding existed.
    expect(resolveExecutionRoot({ project: project(REPO) })).toEqual({
      root: REPO,
      source: "workspace",
      managed: false,
    })
  })

  it("falls back when a managed workspace is not materialized on this device", () => {
    expect(
      resolveExecutionRoot({
        executionContext: managedContext(undefined, "missing-on-device"),
        project: project(REPO),
      })
    ).toEqual({ root: REPO, source: "workspace", managed: false })
  })

  it("reads the lease's primary alias ahead of the managed local root", () => {
    expect(resolveExecutionRoot({ executionContext: leasedContext("/leases/a") })).toMatchObject({
      root: "/leases/a",
      source: "execution",
      managed: true,
    })
  })

  it("does not call a plain local binding managed", () => {
    expect(resolveExecutionRoot({ executionContext: localContext() })).toEqual({
      root: REPO,
      source: "execution",
      managed: false,
    })
  })

  it("does not warn when a managed alias resolves to the project root itself", () => {
    // `managed` is about the DIRECTORY, not the binding's label.
    const context = managedContext(REPO)
    expect(resolveExecutionRoot({ executionContext: context }).managed).toBe(false)
  })

  it("resolves to nothing rather than guessing", () => {
    expect(resolveExecutionRoot({})).toEqual(NO_EXECUTION_ROOT)
    expect(resolveExecutionRoot({ project: project(null) })).toEqual(NO_EXECUTION_ROOT)
  })

  it("ignores a whitespace-only root on either side", () => {
    expect(
      resolveExecutionRoot({
        executionContext: localContext("   "),
        project: project("  "),
      })
    ).toEqual(NO_EXECUTION_ROOT)
  })
})

describe("resolveSessionExecutionRoot", () => {
  const projects = [project(REPO, "p1"), project("/repos/other", "p2")]

  it("resolves the session's own workspace, not the one on screen", () => {
    const target = resolveSessionExecutionRoot(
      { projectId: "p2" },
      projects,
      // The on-screen workspace must lose to the session's own.
      project(REPO, "p1")
    )
    expect(target.root).toBe("/repos/other")
    expect(target.project?.id).toBe("p2")
  })

  it("returns no project for a session naming a workspace that is gone", () => {
    // Falling back to the active workspace here would re-introduce exactly the
    // mis-attribution this resolver exists to prevent.
    const target = resolveSessionExecutionRoot({ projectId: "deleted" }, projects, project(REPO))
    expect(target.project).toBeUndefined()
    expect(target).toEqual(NO_EXECUTION_ROOT)
  })

  it("uses the fallback workspace only when the session names none", () => {
    expect(resolveSessionExecutionRoot({}, projects, project(REPO, "p1")).root).toBe(REPO)
    expect(resolveSessionExecutionRoot({}, projects).root).toBeNull()
  })

  it("keeps the workspace even when it has no root, so callers can tell the two empties apart", () => {
    const rootless = [project(null, "p3")]
    const target = resolveSessionExecutionRoot({ projectId: "p3" }, rootless)
    expect(target.project?.id).toBe("p3")
    expect(target.root).toBeNull()
  })

  it("beats the workspace root with the session's worktree", () => {
    const target = resolveSessionExecutionRoot(
      { projectId: "p1", executionContext: managedContext(WORKTREE) },
      projects
    )
    expect(target).toMatchObject({ root: WORKTREE, source: "execution", managed: true })
  })

  it("tolerates a null session", () => {
    expect(resolveSessionExecutionRoot(null, projects)).toEqual(NO_EXECUTION_ROOT)
    expect(resolveSessionExecutionRoot(undefined, projects)).toEqual(NO_EXECUTION_ROOT)
  })
})

describe("sessionExecutionRootPath", () => {
  it("returns undefined rather than null, for callers that spread it into options", () => {
    expect(sessionExecutionRootPath({ projectId: "missing" }, [])).toBeUndefined()
    expect(sessionExecutionRootPath({ projectId: "p1" }, [project(REPO)])).toBe(REPO)
  })
})

describe("the panels and the rest of the app share one chain", () => {
  // The whole point of extracting this: a panel and a non-panel surface must
  // not be able to answer "which directory" differently. A pinnable panel with
  // no pin, and a plain session resolve, are the same question.
  const cases: Array<{ name: string; context?: SessionExecutionContext }> = [
    { name: "no binding" },
    { name: "local binding", context: localContext() },
    { name: "managed worktree", context: managedContext(WORKTREE) },
    { name: "unmaterialized worktree", context: managedContext(undefined, "missing-on-device") },
    { name: "leased alias", context: leasedContext("/leases/a") },
  ]

  it.each(cases)("agrees for $name", ({ context }) => {
    const panel = resolvePanelRoot({
      panel: "editor",
      executionContext: context,
      activeProject: project(REPO),
    })
    const session = resolveSessionExecutionRoot(
      { projectId: "p1", ...(context ? { executionContext: context } : {}) },
      [project(REPO)]
    )
    expect({ root: panel.root, source: panel.source, managed: panel.managed }).toEqual({
      root: session.root,
      source: session.source,
      managed: session.managed,
    })
  })

  it("counts the cases, so a shrunk table cannot pass by checking nothing", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5)
  })
})
