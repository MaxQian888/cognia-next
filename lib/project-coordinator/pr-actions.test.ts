import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/lib/git/commands", () => ({ gitPush: jest.fn(async () => undefined) }))

import { gitPush } from "@/lib/git/commands"
import { repositoryTarget } from "@/lib/policy/action-review/outbound-targets"
import type { ProjectPrWatch } from "./pr-watch"
import { availablePrActions, createThreadPr, mergeThreadPr, pushThreadBranch } from "./pr-actions"

const withPr = {
  executionContext: { branch: "thread/x", worktreePath: "/wt/x" },
  projectThread: {
    coordinatorSessionId: "c",
    brief: "b",
    proposedBy: "user",
    prRef: { repo: "o/n", branch: "thread/x", number: 7, url: "https://github.com/o/n/pull/7" },
  },
} as unknown as ChatSession

describe("availablePrActions", () => {
  it("maps each PR state to what the user can do", () => {
    expect(availablePrActions(withPr, "ci_failed")).toEqual(["fix-ci", "review"])
    expect(availablePrActions(withPr, "changes_requested")).toEqual(["address-comments", "review"])
    expect(availablePrActions(withPr, "merge_conflict")).toEqual(["resolve-conflicts", "review"])
    expect(availablePrActions(withPr, "mergeable")).toEqual(["merge", "review"])
    expect(availablePrActions(withPr, "ci_pending")).toEqual(["review"])
    expect(availablePrActions(withPr, "merged")).toEqual([])
  })

  it("offers Create PR for a pushed-branch thread with no PR, nothing without a branch", () => {
    const noPr = {
      executionContext: withPr.executionContext,
      projectThread: undefined,
    } as ChatSession
    expect(availablePrActions(noPr, undefined)).toEqual(["create"])
    expect(availablePrActions({} as ChatSession, undefined)).toEqual([])
  })
})

function watch(octokit?: unknown): ProjectPrWatch {
  return { octokitFor: () => octokit } as unknown as ProjectPrWatch
}

describe("mergeThreadPr", () => {
  it("squash-merges through the stack adapter", async () => {
    const request = jest.fn(async () => ({ status: 200, data: { merged: true }, headers: {} }))
    const record = jest.fn(async () => {
      // A person's merge is on record before GitHub sees it.
      expect(request).not.toHaveBeenCalled()
    })
    await mergeThreadPr({ ...withPr, id: "t" }, watch({ request }), record)
    expect(record).toHaveBeenCalledWith({
      targets: [repositoryTarget("o/n")],
      operation: "github.mergePr",
      surface: "thread-pr",
      sessionId: "t",
    })
    expect(request).toHaveBeenCalledWith("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner: "o",
      repo: "n",
      pull_number: 7,
      merge_method: "squash",
    })
  })

  it("refuses without a PR or GitHub access", async () => {
    const record = jest.fn()
    await expect(mergeThreadPr({} as ChatSession, watch({}), record)).rejects.toThrow(
      /no pull request/
    )
    await expect(mergeThreadPr(withPr, watch(undefined), record)).rejects.toThrow(
      /No GitHub access/
    )
    // Nothing was written, so nothing is recorded.
    expect(record).not.toHaveBeenCalled()
  })
})

describe("createThreadPr", () => {
  it("pushes the branch and opens a draft PR against the trunk", async () => {
    const request = jest.fn(async (route: string) =>
      route.startsWith("GET")
        ? { status: 200, data: [], headers: {} }
        : {
            status: 201,
            data: { number: 9, html_url: "https://github.com/o/n/pull/9" },
            headers: {},
          }
    )
    const push = jest.fn(async () => undefined)
    const record = jest.fn(async () => {
      expect(push).not.toHaveBeenCalled()
    })
    const pr = await createThreadPr(
      { id: "t", title: "Fix login", executionContext: withPr.executionContext },
      {
        watch: watch({ request }),
        push,
        resolveBase: async () => ({ fullName: "o/n", defaultBranch: "main" }),
        record,
      }
    )
    expect(record).toHaveBeenCalledWith({
      targets: [repositoryTarget("o/n")],
      operation: "github.openPr",
      surface: "thread-pr",
      sessionId: "t",
    })
    expect(push).toHaveBeenCalledWith("/wt/x", "thread/x")
    expect(pr).toEqual({ number: 9, url: "https://github.com/o/n/pull/9", created: true })
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.objectContaining({ head: "thread/x", base: "main", title: "Fix login", draft: true })
    )
  })

  it("refuses without a branch or a github.com repository", async () => {
    const deps = {
      watch: watch({}),
      push: jest.fn(),
      resolveBase: async () => null,
      record: jest.fn(),
    }
    await expect(createThreadPr({ id: "t", title: "x" }, deps)).rejects.toThrow(/no branch/)
    await expect(
      createThreadPr({ id: "t", title: "x", executionContext: withPr.executionContext }, deps)
    ).rejects.toThrow(/github.com/)
    expect(deps.record).not.toHaveBeenCalled()
  })
})

describe("pushThreadBranch", () => {
  it("pushes to origin with upstream", async () => {
    await pushThreadBranch("/wt/x", "thread/x")
    expect(gitPush).toHaveBeenCalledWith("/wt/x", {
      remote: "origin",
      branch: "thread/x",
      setUpstream: true,
    })
  })
})
