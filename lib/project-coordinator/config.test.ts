import type { Project } from "@/types"
import {
  DEFAULT_DAILY_THREAD_CAP,
  MAX_CONCURRENT_THREADS_LIMIT,
  MAX_DAILY_THREAD_CAP,
  PROJECT_GOAL_MAX_CHARS,
  isCoordinatorEnabled,
  isProjectPausedConfig,
  patchCoordinatorConfig,
  resolveCoordinatorConfig,
  resolveThreadExecutionLocation,
  resolveThreadRoot,
} from "./config"

const roots = [
  { id: "r-main", path: "/repo", isPrimary: true },
  { id: "r-docs", path: "/docs", isPrimary: false },
]

function project(coordinator?: Project["coordinator"], withRoots = roots) {
  return { roots: withRoots, coordinator } as Pick<Project, "roots" | "coordinator">
}

describe("resolveCoordinatorConfig", () => {
  it("defaults an absent config to disabled, auto execution and the default cap", () => {
    expect(resolveCoordinatorConfig(undefined)).toEqual({
      enabled: false,
      threadExecution: "auto",
      preferences: {
        proposeBeforeStart: false,
        dailyThreadCap: DEFAULT_DAILY_THREAD_CAP,
        autoFixPr: false,
      },
      model: {},
    })
  })

  it("clamps numeric preferences and trims text", () => {
    const resolved = resolveCoordinatorConfig({
      coordinator: {
        enabled: true,
        goal: `  ${"g".repeat(PROJECT_GOAL_MAX_CHARS + 20)}  `,
        icon: "  🚀 ",
        preferences: { maxConcurrentThreads: 99.7, dailyThreadCap: 10_000, autoFixPr: true },
      },
    })
    expect(resolved.goal).toHaveLength(PROJECT_GOAL_MAX_CHARS)
    expect(resolved.icon).toBe("🚀")
    expect(resolved.preferences).toEqual({
      maxConcurrentThreads: MAX_CONCURRENT_THREADS_LIMIT,
      proposeBeforeStart: false,
      dailyThreadCap: MAX_DAILY_THREAD_CAP,
      autoFixPr: true,
    })
  })

  it("ignores non-numeric preference values instead of throwing", () => {
    const resolved = resolveCoordinatorConfig({
      coordinator: {
        enabled: true,
        preferences: { maxConcurrentThreads: Number.NaN, dailyThreadCap: 0 },
      },
    })
    expect(resolved.preferences.maxConcurrentThreads).toBeUndefined()
    expect(resolved.preferences.dailyThreadCap).toBe(1)
  })
})

describe("flags", () => {
  it("reads enabled and paused", () => {
    expect(isCoordinatorEnabled(project({ enabled: true }))).toBe(true)
    expect(isCoordinatorEnabled(project(undefined))).toBe(false)
    expect(isProjectPausedConfig(project({ enabled: true, paused: { at: 1 } }))).toBe(true)
    expect(isProjectPausedConfig(null)).toBe(false)
  })
})

describe("resolveThreadRoot", () => {
  it("returns the named root, falling back to the primary", () => {
    expect(resolveThreadRoot(project(), "r-docs")?.path).toBe("/docs")
    expect(resolveThreadRoot(project(), "unknown")?.path).toBe("/repo")
    expect(resolveThreadRoot(project(), undefined)?.path).toBe("/repo")
    expect(resolveThreadRoot(project(undefined, []), undefined)).toBeUndefined()
  })
})

describe("resolveThreadExecutionLocation", () => {
  it("isolates a thread in a worktree when auto and the root is a git repo", async () => {
    const isGitRepo = jest.fn(async () => true)
    await expect(resolveThreadExecutionLocation(project(), "r-docs", { isGitRepo })).resolves.toBe(
      "managedWorktree"
    )
    expect(isGitRepo).toHaveBeenCalledWith("/docs")
  })

  it("shares the directory when auto and the root is not git, or the probe fails", async () => {
    await expect(
      resolveThreadExecutionLocation(project(), undefined, { isGitRepo: async () => false })
    ).resolves.toBe("local")
    await expect(
      resolveThreadExecutionLocation(project(), undefined, {
        isGitRepo: async () => {
          throw new Error("no bridge")
        },
      })
    ).resolves.toBe("local")
  })

  it("runs rootless workspaces locally", async () => {
    const isGitRepo = jest.fn()
    await expect(
      resolveThreadExecutionLocation(project(undefined, []), undefined, { isGitRepo })
    ).resolves.toBe("local")
    expect(isGitRepo).not.toHaveBeenCalled()
  })

  it("honours an explicit mode without probing", async () => {
    const isGitRepo = jest.fn()
    await expect(
      resolveThreadExecutionLocation(
        project({ enabled: true, threadExecution: "local" }),
        undefined,
        {
          isGitRepo,
        }
      )
    ).resolves.toBe("local")
    await expect(
      resolveThreadExecutionLocation(
        project({ enabled: true, threadExecution: "managedWorktree" }),
        undefined,
        { isGitRepo }
      )
    ).resolves.toBe("managedWorktree")
    expect(isGitRepo).not.toHaveBeenCalled()
  })
})

describe("patchCoordinatorConfig", () => {
  it("merges preferences shallowly and keeps enabled explicit", () => {
    const next = patchCoordinatorConfig(
      { enabled: true, preferences: { dailyThreadCap: 5, autoFixPr: true } },
      { preferences: { dailyThreadCap: 8 } }
    )
    expect(next).toEqual({ enabled: true, preferences: { dailyThreadCap: 8, autoFixPr: true } })
    expect(patchCoordinatorConfig(undefined, { goal: "x" })).toEqual({ enabled: false, goal: "x" })
  })
})
