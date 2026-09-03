import {
  createGitBranchesProvider,
  createGitWorktreesProvider,
  sourceControlHref,
  type GitProviderDeps,
  type GitSearchSnapshot,
} from "./git"
import type { GlobalSearchContext, GlobalSearchItem } from "../types"
import type { GitBranch, GitWorktree } from "@/types/git"

const ctx = {
  now: 10_000,
  t: (key: string) => key,
} as unknown as GlobalSearchContext

function branch(overrides: Partial<GitBranch> & { name: string }): GitBranch {
  return {
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
    ...overrides,
  }
}

function worktree(overrides: Partial<GitWorktree> & { path: string }): GitWorktree {
  return {
    branch: null,
    head: "a1b2c3d",
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    isMain: false,
    ...overrides,
  }
}

const SNAPSHOT: GitSearchSnapshot = {
  rootDir: "/repo",
  branches: [
    branch({ name: "main", isCurrent: true, upstream: "origin/main", checkedOutIn: "/repo" }),
    branch({ name: "feature-x" }),
    branch({ name: "held-one", checkedOutIn: "/repo/wt/held-one" }),
    branch({ name: "agent/run_a/alice/t1", checkedOutIn: "/repo/wt/run-a" }),
    branch({ name: "origin/feature-x", isRemote: true }),
  ],
  worktrees: [
    worktree({ path: "/repo", branch: "main", isMain: true }),
    worktree({ path: "/repo/wt/held-one", branch: "held-one" }),
    worktree({ path: "/repo/wt/detached-one" }),
  ],
}

function deps(overrides: Partial<GitProviderDeps> = {}): GitProviderDeps {
  return {
    readSnapshot: () => SNAPSHOT,
    available: () => true,
    ...overrides,
  }
}

async function search(
  provider: ReturnType<typeof createGitBranchesProvider>,
  needle: string
): Promise<GlobalSearchItem[]> {
  const result = await provider.search({
    query: { needle, filters: {}, raw: needle } as never,
    ctx,
    limit: 20,
    signal: new AbortController().signal,
  })
  return result.items
}

describe("git branches provider", () => {
  it("finds a branch by name, which nineteen providers could not", async () => {
    const items = await search(createGitBranchesProvider(deps()), "feature-x")
    expect(items.map((item) => item.title)).toContain("feature-x")
  })

  it("says which worktree holds a branch rather than implying it is here", async () => {
    const items = await search(createGitBranchesProvider(deps()), "held-one")
    const row = items.find((item) => item.title === "held-one")
    expect(row?.extra).toMatchObject({ placement: "otherWorktree" })
    expect(row?.subtitle).toBe("globalSearch.git.inWorktree")
  })

  /**
   * Enter must never check out. A working-tree switch from a fuzzy match is
   * the worst outcome a palette can produce, so the row navigates and lets the
   * panel offer the checkout under its own placement rules and its own gate.
   */
  it("navigates to the worktree that holds it, and mutates nothing", async () => {
    const items = await search(createGitBranchesProvider(deps()), "held-one")
    const row = items.find((item) => item.title === "held-one")
    expect(row?.action).toEqual({
      type: "navigate",
      // The worktree that actually holds it, not the panel's current root.
      href: sourceControlHref("/repo/wt/held-one"),
    })
  })

  it("navigates to the bound repository for a branch that lives here", async () => {
    const items = await search(createGitBranchesProvider(deps()), "feature-x")
    const row = items.find((item) => item.title === "feature-x")
    expect(row?.action).toEqual({ type: "navigate", href: sourceControlHref("/repo") })
  })

  it("finds an agent branch by the word agent", async () => {
    const items = await search(createGitBranchesProvider(deps()), "agent")
    expect(items.map((item) => item.title)).toContain("agent/run_a/alice/t1")
  })

  it("returns nothing where Source Control is not offered", async () => {
    const items = await search(createGitBranchesProvider(deps({ available: () => false })), "main")
    expect(items).toEqual([])
  })

  /**
   * A local branch and its remote-tracking ref share a short name. Keying on
   * the name alone would collapse them into one row.
   */
  it("keeps a local branch and its remote ref as separate rows", async () => {
    const items = await search(createGitBranchesProvider(deps()), "feature-x")
    const ids = items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("git-branch:l:feature-x")
    expect(ids).toContain("git-branch:r:origin/feature-x")
  })
})

describe("git worktrees provider", () => {
  it("finds a worktree by its directory name", async () => {
    const items = await search(createGitWorktreesProvider(deps()), "held-one")
    expect(items.map((item) => item.title)).toContain("held-one")
  })

  it("names the branch a worktree is on, and says so when there is none", async () => {
    const items = await search(createGitWorktreesProvider(deps()), "detached-one")
    const row = items.find((item) => item.title === "detached-one")
    expect(row?.subtitle).toBe("globalSearch.git.detached")
  })

  it("binds to the worktree it names", async () => {
    const items = await search(createGitWorktreesProvider(deps()), "held-one")
    const row = items.find((item) => item.title === "held-one")
    expect(row?.action).toEqual({ type: "navigate", href: sourceControlHref("/repo/wt/held-one") })
  })

  // The param has to survive a path with slashes and spaces, or the page binds
  // to a truncated root and shows the wrong tree.
  it("encodes the root so a path with separators survives the query string", () => {
    expect(sourceControlHref("/repo/wt/a b")).toBe("/source-control?root=%2Frepo%2Fwt%2Fa%20b")
    expect(sourceControlHref(null)).toBe("/source-control")
  })

  it("returns nothing where Source Control is not offered", async () => {
    const items = await search(
      createGitWorktreesProvider(deps({ available: () => false })),
      "held-one"
    )
    expect(items).toEqual([])
  })
})
