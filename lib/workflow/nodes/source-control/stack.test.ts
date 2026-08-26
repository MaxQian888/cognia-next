import type { StepExecutionContext } from "@/types/workflow/visual"

const gitStackParents = jest.fn(async () => [] as Array<[string, string]>)
const gitStackSetParent = jest.fn(async () => undefined)
const gitStackValidate = jest.fn(async () => [] as unknown[])
const gitStackRestack = jest.fn(async () => ({
  method: "replay",
  updates: [{ branch: "me/ui", from: "aaa", to: "bbb" }],
  conflict: null,
}))
const gitStackPush = jest.fn(async () => ({ pushed: ["me/api", "me/ui"], forceIfIncludes: true }))

jest.mock("@/lib/git/commands", () => ({
  gitStackParents: (repo: string) => gitStackParents(repo),
  gitStackSetParent: (repo: string, branch: string, parent: string | null) =>
    gitStackSetParent(repo, branch, parent),
  gitStackValidate: (repo: string, branches: string[]) => gitStackValidate(repo, branches),
  gitStackRestack: (repo: string, onto: string, branches: string[]) =>
    gitStackRestack(repo, onto, branches),
  gitStackPush: (repo: string, remote: string, branches: string[]) =>
    gitStackPush(repo, remote, branches),
}))
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: { getState: () => ({ rootDir: "/repo" }) },
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ projects: { get: async () => undefined } }),
}))

import "./stack"
import { getExecutor } from "../registry"

function run(kind: string, params: Record<string, unknown>) {
  const reg = getExecutor(kind as never, 1)
  if (!reg) throw new Error(`no executor for ${kind}`)
  return reg.execute({ params } as unknown as StepExecutionContext)
}

/** `main <- me/api <- me/ui <- me/docs`, as the parent pointers record it. */
function chain(): Array<[string, string]> {
  return [
    ["me/api", "main"],
    ["me/ui", "me/api"],
    ["me/docs", "me/ui"],
  ]
}

function layerState(branch: string, parent: string | null, over: Record<string, unknown> = {}) {
  return {
    branch,
    parent,
    head: `sha-${branch}`,
    containsParent: true,
    checkedOutIn: null,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  gitStackParents.mockResolvedValue([])
})

describe("action.stack.list", () => {
  it("reports the chains the repository records, bottom layer first", async () => {
    gitStackParents.mockResolvedValue(chain())
    const result = await run("action.stack.list", {})
    expect(result.output).toMatchObject({
      repoPath: "/repo",
      count: 1,
      stacks: [
        {
          trunk: "main",
          tip: "me/docs",
          branches: ["me/api", "me/ui", "me/docs"],
        },
      ],
    })
  })

  it("returns an empty list, not a failure, for a repository with no stacks", async () => {
    const result = await run("action.stack.list", {})
    expect(result.output).toMatchObject({ count: 0, stacks: [], stack: null })
  })
})

describe("action.stack.parent", () => {
  it("records a pointer", async () => {
    await run("action.stack.parent", { branch: "me/ui", parent: "me/api" })
    expect(gitStackSetParent).toHaveBeenCalledWith("/repo", "me/ui", "me/api")
  })

  it("an omitted parent clears the pointer rather than leaving it alone", async () => {
    // The node either writes or clears. "Leave it as it was" is not a state it
    // can express, because a silently-skipped write is how a stack keeps a
    // pointer it was told to drop.
    const result = await run("action.stack.parent", { branch: "me/api" })
    expect(gitStackSetParent).toHaveBeenCalledWith("/repo", "me/api", null)
    expect(result.output).toMatchObject({ parent: null })
  })

  it("refuses without a branch", async () => {
    await expect(run("action.stack.parent", {})).rejects.toThrow(/branch is required/)
  })
})

describe("action.stack.validate", () => {
  it("resolves every layer from a tip branch", async () => {
    gitStackParents.mockResolvedValue(chain())
    gitStackValidate.mockResolvedValue([
      layerState("me/api", "main"),
      layerState("me/ui", "me/api"),
      layerState("me/docs", "me/ui"),
    ])
    const result = await run("action.stack.validate", { tipBranch: "me/docs" })
    expect(gitStackValidate).toHaveBeenCalledWith("/repo", ["me/api", "me/ui", "me/docs"])
    expect(result.output).toMatchObject({ ok: true, trunk: "main", remedy: "none" })
    expect(result.decision).toBe("ok")
  })

  it("routes on the verdict, and names what would fix it", async () => {
    gitStackParents.mockResolvedValue(chain())
    gitStackValidate.mockResolvedValue([
      layerState("me/api", "main"),
      layerState("me/ui", "me/api", { containsParent: false }),
      layerState("me/docs", "me/ui"),
    ])
    const result = await run("action.stack.validate", { tipBranch: "me/docs" })
    expect(result.decision).toBe("problems")
    expect(result.output).toMatchObject({ ok: false, remedy: "restack" })
  })

  it("takes an explicit branch list and asks git for its trunk", async () => {
    gitStackParents.mockResolvedValue(chain())
    gitStackValidate.mockResolvedValue([
      layerState("me/api", "main"),
      layerState("me/ui", "me/api"),
    ])
    const result = await run("action.stack.validate", { branches: ["me/api", "me/ui"] })
    expect(result.output).toMatchObject({ trunk: "main" })
  })

  it("refuses an unknown tip rather than validating nothing", async () => {
    gitStackParents.mockResolvedValue(chain())
    await expect(run("action.stack.validate", { tipBranch: "me/nope" })).rejects.toThrow(
      /no stack found with tip me\/nope/
    )
  })

  it("refuses an empty branch list rather than widening to the whole repository", async () => {
    await expect(run("action.stack.validate", { branches: [] })).rejects.toThrow(
      /branches is required/
    )
  })
})

describe("action.stack.restack", () => {
  it("defaults `onto` to the trunk the chain records", async () => {
    gitStackParents.mockResolvedValue(chain())
    const result = await run("action.stack.restack", { tipBranch: "me/docs" })
    expect(gitStackRestack).toHaveBeenCalledWith("/repo", "main", ["me/api", "me/ui", "me/docs"])
    expect(result.decision).toBe("restacked")
    expect(result.output).toMatchObject({ restacked: true, method: "replay" })
  })

  it("reports a conflict as an outcome, not an exception", async () => {
    // The sequencer is mid-flight and a later node resolves it. Throwing here
    // would discard the conflict's own description along with the run.
    gitStackParents.mockResolvedValue(chain())
    gitStackRestack.mockResolvedValue({
      method: "rebase",
      updates: [],
      conflict: { branch: "me/ui", paths: ["a.ts"] },
    })
    const result = await run("action.stack.restack", { tipBranch: "me/docs" })
    expect(result.decision).toBe("conflict")
    expect(result.output).toMatchObject({ restacked: false, conflict: { branch: "me/ui" } })
  })

  it("needs an `onto` when the branches were listed by hand", async () => {
    await expect(run("action.stack.restack", { branches: ["me/ui"] })).rejects.toThrow(
      /onto is required/
    )
  })
})

describe("action.stack.push", () => {
  it("pushes every layer to origin by default", async () => {
    gitStackParents.mockResolvedValue(chain())
    const result = await run("action.stack.push", { tipBranch: "me/docs" })
    expect(gitStackPush).toHaveBeenCalledWith("/repo", "origin", ["me/api", "me/ui", "me/docs"])
    expect(result.output).toMatchObject({ remote: "origin", forceIfIncludes: true })
  })

  it("surfaces the weaker lease rather than hiding it", async () => {
    gitStackPush.mockResolvedValue({ pushed: ["me/ui"], forceIfIncludes: false })
    const result = await run("action.stack.push", { branches: ["me/ui"], remote: "upstream" })
    expect(result.output).toMatchObject({ remote: "upstream", forceIfIncludes: false })
  })
})
