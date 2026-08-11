import type { StepExecutionContext } from "@/types/workflow/visual"

const gitStage = jest.fn().mockResolvedValue(undefined)
const gitCommit = jest.fn().mockResolvedValue("hash123")
const gitPush = jest.fn().mockResolvedValue(undefined)
const gitCreateBranch = jest.fn().mockResolvedValue(undefined)
const gitCheckoutBranch = jest.fn().mockResolvedValue(undefined)
let mockRootDir: string | null = "/repo"

jest.mock("@/lib/git/commands", () => ({
  gitStage: (repo: string, paths: string[]) => gitStage(repo, paths),
  gitCommit: (repo: string, msg: string, amend: boolean, signoff: boolean) =>
    gitCommit(repo, msg, amend, signoff),
  gitPush: (repo: string, opts: unknown) => gitPush(repo, opts),
  gitCreateBranch: (repo: string, name: string, checkout: boolean, from?: string) =>
    gitCreateBranch(repo, name, checkout, from),
  gitCheckoutBranch: (repo: string, name: string) => gitCheckoutBranch(repo, name),
}))
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: { getState: () => ({ rootDir: mockRootDir }) },
}))

import "."
import { getExecutor } from "../registry"

function run(kind: string, params: Record<string, unknown>) {
  const reg = getExecutor(kind as never, 1)
  if (!reg) throw new Error(`no executor for ${kind}`)
  return reg.execute({ params } as unknown as StepExecutionContext)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRootDir = "/repo"
})

describe("action.git.* node executors", () => {
  it("stage: stages explicit paths against the bound repo", async () => {
    const r = await run("action.git.stage", { paths: ["a.ts", "b.ts"] })
    expect(gitStage).toHaveBeenCalledWith("/repo", ["a.ts", "b.ts"])
    expect(r.output).toMatchObject({ repoPath: "/repo", staged: ["a.ts", "b.ts"] })
  })

  it("stage: defaults to staging everything", async () => {
    await run("action.git.stage", {})
    expect(gitStage).toHaveBeenCalledWith("/repo", ["."])
  })

  it("commit: commits with the message and returns the hash", async () => {
    const r = await run("action.git.commit", { message: "feat: x", signoff: true })
    expect(gitCommit).toHaveBeenCalledWith("/repo", "feat: x", false, true)
    expect(r.output).toMatchObject({ hash: "hash123", message: "feat: x" })
  })

  it("commit: throws without a message", async () => {
    await expect(run("action.git.commit", {})).rejects.toThrow(/message/)
  })

  it("push: forwards remote/branch/setUpstream", async () => {
    await run("action.git.push", { remote: "origin", branch: "main", setUpstream: true })
    expect(gitPush).toHaveBeenCalledWith("/repo", {
      remote: "origin",
      branch: "main",
      setUpstream: true,
    })
  })

  it("branch: creates and checks out by default", async () => {
    const r = await run("action.git.branch", { name: "feature" })
    expect(gitCreateBranch).toHaveBeenCalledWith("/repo", "feature", true, undefined)
    expect(r.output).toMatchObject({ branch: "feature", checkedOut: true })
  })

  it("branch: falls back to checkout when creation fails", async () => {
    gitCreateBranch.mockRejectedValueOnce(new Error("already exists"))
    await run("action.git.branch", { name: "existing" })
    expect(gitCheckoutBranch).toHaveBeenCalledWith("/repo", "existing")
  })

  it("uses an explicit repoPath over the bound root", async () => {
    await run("action.git.stage", { repoPath: "/other", paths: ["x"] })
    expect(gitStage).toHaveBeenCalledWith("/other", ["x"])
  })

  it("throws when no repo is bound and none is given", async () => {
    mockRootDir = null
    await expect(run("action.git.stage", {})).rejects.toThrow(/no repo/)
  })
})
