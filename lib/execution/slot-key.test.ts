import { slotKeyForExecutionContext, slotKeyForPath } from "./slot-key"
import type { SessionExecutionContext } from "@/types/execution-context"

const ctx = (over: Record<string, unknown>) => over as unknown as SessionExecutionContext

describe("slotKeyForExecutionContext", () => {
  it("keys a local conversation by the directory it works in", () => {
    expect(
      slotKeyForExecutionContext(
        ctx({ projectRoot: "/repos/app", workspaceBinding: { kind: "project" } })
      )
    ).toBe("dir:/repos/app")
  })

  it("gives each managed worktree its own slot", () => {
    // Holding one worktree must not block the others — that is the whole point
    // of cutting one.
    const worktree = (n: number) =>
      slotKeyForExecutionContext(
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
      slotKeyForExecutionContext(
        ctx({ environmentId: "env-7", location: "remote", projectRoot: "/workspace" })
      )
    ).toBe("env:env-7")
  })

  it("keys a local environment by its directory, not its id", () => {
    expect(
      slotKeyForExecutionContext(
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
    expect(slotKeyForExecutionContext(null)).toBeUndefined()
    expect(slotKeyForExecutionContext(undefined)).toBeUndefined()
    expect(
      slotKeyForExecutionContext(ctx({ workspaceBinding: { kind: "project" } }))
    ).toBeUndefined()
  })

  it("gives no slot when a managed workspace is unavailable", () => {
    expect(
      slotKeyForExecutionContext(
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
