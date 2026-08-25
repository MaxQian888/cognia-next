import { slotKeyForPath, slotKeyForTurn } from "./slot-key"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import type { SessionExecutionContext } from "@/types/execution-context"

const ctx = (over: Record<string, unknown>) => over as unknown as SessionExecutionContext

/**
 * The binding half of the chain, spelled the way a caller composes it now that
 * `slotKeyForExecutionContext` is gone: the execution context supplies the
 * remote case, `resolveSessionWorkspaceRoot` the directory it resolves to.
 */
const slotKeyForBinding = (context: SessionExecutionContext | null | undefined) =>
  context
    ? slotKeyForTurn({
        executionContext: context,
        effectiveCwd: resolveSessionWorkspaceRoot(context),
      })
    : undefined

describe("slotKeyForTurn — the binding half of the chain", () => {
  it("keys a local conversation by the directory it works in", () => {
    expect(
      slotKeyForBinding(ctx({ projectRoot: "/repos/app", workspaceBinding: { kind: "project" } }))
    ).toBe("dir:/repos/app")
  })

  it("gives each managed worktree its own slot", () => {
    // Holding one worktree must not block the others — that is the whole point
    // of cutting one.
    const worktree = (n: number) =>
      slotKeyForBinding(
        ctx({
          projectRoot: "/repos/app",
          workspaceBinding: { kind: "managed" },
          execution: { roots: [{ role: "primary", aliasPath: `/repos/app/.cognia/wt/${n}` }] },
        })
      )
    expect(worktree(1)).not.toBe(worktree(2))
    expect(worktree(1)).toBe("dir:/repos/app/.cognia/wt/1")
  })

  it("treats a remote environment as the unit of exclusion", () => {
    // Two turns in one sandbox conflict the way two in one directory do, and
    // the path a sandbox reports means nothing outside it.
    expect(
      slotKeyForBinding(
        ctx({ environmentId: "env-7", location: "remote", projectRoot: "/workspace" })
      )
    ).toBe("env:env-7")
  })

  it("keys a local environment by its directory, not its id", () => {
    expect(
      slotKeyForBinding(
        ctx({
          environmentId: "env-7",
          location: "local",
          projectRoot: "/repos/app",
          workspaceBinding: { kind: "project" },
        })
      )
    ).toBe("dir:/repos/app")
  })

  it("gives no slot to a conversation that mutates nothing shared", () => {
    // Inventing one would queue work that never conflicts.
    expect(slotKeyForBinding(null)).toBeUndefined()
    expect(slotKeyForBinding(undefined)).toBeUndefined()
    expect(slotKeyForBinding(ctx({ workspaceBinding: { kind: "project" } }))).toBeUndefined()
  })

  it("gives no slot when a managed workspace is unavailable", () => {
    expect(
      slotKeyForBinding(
        ctx({
          workspaceBinding: { kind: "managed" },
          managedWorkspace: { availability: "missing" },
        })
      )
    ).toBeUndefined()
  })

  it("treats a path and its trailing-slash spelling as one slot", () => {
    // Two spellings would be two slots that fail to exclude each other.
    expect(slotKeyForPath("/repos/app/")).toBe(slotKeyForPath("/repos/app"))
  })

  it("matches Windows paths case-insensitively", () => {
    expect(slotKeyForPath("C:\\Repos\\App")).toBe(slotKeyForPath("c:\\repos\\app"))
  })

  it("keeps POSIX paths case-sensitive", () => {
    expect(slotKeyForPath("/Repos/App")).not.toBe(slotKeyForPath("/repos/app"))
  })

  it("namespaces directories away from environments", () => {
    expect(slotKeyForPath("env-7")).not.toBe("env:env-7")
  })

  it("has no slot for a blank path", () => {
    expect(slotKeyForPath("")).toBeUndefined()
    expect(slotKeyForPath("   ")).toBeUndefined()
    expect(slotKeyForPath(null)).toBeUndefined()
  })
})

describe("slotKeyForTurn", () => {
  it("serializes two plain conversations that share a workspace root", () => {
    // The headline case, and the one the binding-only key missed entirely:
    // neither conversation has an execution binding, yet both run in the
    // workspace's primary root.
    const a = slotKeyForTurn({ effectiveCwd: "/repos/app" })
    const b = slotKeyForTurn({ effectiveCwd: "/repos/app" })
    expect(a).toBe("dir:/repos/app")
    expect(b).toBe(a)
  })

  it("follows a per-session working dir over the binding it sits above", () => {
    // `workingDir` outranks the binding in `resolveEffectiveCwd`, so the slot
    // has to name it too — otherwise the turn guards a tree it never touches
    // and leaves the one it does touch unprotected.
    expect(
      slotKeyForTurn({
        executionContext: ctx({ projectRoot: "/repos/b", workspaceBinding: { kind: "project" } }),
        effectiveCwd: "/repos/a",
      })
    ).toBe("dir:/repos/a")
  })

  it("still keys a remote environment by its id, whatever cwd it reports", () => {
    expect(
      slotKeyForTurn({
        executionContext: ctx({ location: "remote", environmentId: "env-7" }),
        effectiveCwd: "/sandbox/work",
      })
    ).toBe("env:env-7")
  })

  it("has no slot when nothing resolves a directory", () => {
    expect(slotKeyForTurn({ effectiveCwd: null })).toBeUndefined()
    expect(slotKeyForTurn({})).toBeUndefined()
  })
})
