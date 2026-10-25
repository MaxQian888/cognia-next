import {
  commandHasGhWrite,
  dedupeGithubTargets,
  ghInvocations,
  ghWriteTargets,
  SHELL_TOOL_NAMES,
  shellCommandOf,
} from "./gh-targets"
import { repositoryTarget, unknownGithubTarget } from "./outbound-targets"

describe("gh in shell commands", () => {
  it("finds every gh segment, behind wrappers and inside substitutions", () => {
    expect(
      ghInvocations("git status && sudo gh pr view 1 | cat; echo $(gh pr merge 2)").map(
        (i) => `${i.kind}:${i.command}`
      )
    ).toEqual(["read:pr view", "write:pr merge"])
    expect(commandHasGhWrite("env GH_TOKEN=x gh issue comment 3 -b hi")).toBe(true)
    expect(commandHasGhWrite("gh pr view 3 && echo 'gh pr create'")).toBe(false)
    expect(commandHasGhWrite("/opt/homebrew/bin/gh pr create --fill")).toBe(true)
  })

  it("reads GH_REPO and GH_HOST written before the command or through env", () => {
    expect(ghWriteTargets("GH_REPO=acme/web gh pr create --fill")).toEqual([
      repositoryTarget("acme/web"),
    ])
    expect(ghWriteTargets("env GH_HOST=ghe.corp.io GH_REPO='acme/web' gh issue close 4")).toEqual([
      repositoryTarget("ghe.corp.io/acme/web", 4),
    ])
  })

  it("lands a write that names no repository on the checkout, else unknown", () => {
    expect(
      ghWriteTargets("gh pr comment 12 -b x", { localRepository: "git@github.com:a/b.git" })
    ).toEqual([repositoryTarget("a/b", 12)])
    expect(ghWriteTargets("gh pr comment 12 -b x")).toEqual([unknownGithubTarget()])
    expect(ghWriteTargets("gh gist create a.txt", { localRepository: "a/b" })).toEqual([
      unknownGithubTarget(),
    ])
  })

  it("names every repository a line writes to, once each", () => {
    expect(
      ghWriteTargets(
        "gh pr comment 1 -R a/b -b x && gh pr comment 1 -R a/b -b y; gh api -X POST repos/c/d/issues"
      )
    ).toEqual([repositoryTarget("a/b", 1), repositoryTarget("c/d")])
    expect(ghWriteTargets("gh pr view 1")).toEqual([])
  })

  it("drops the thread when one write names two repositories", () => {
    expect(ghWriteTargets("gh pr comment https://github.com/a/b/pull/3 -R c/d -b x")).toEqual([
      repositoryTarget("c/d"),
      repositoryTarget("a/b"),
    ])
  })
})

describe("shell tool calls", () => {
  it("reads the command of each shell tool by its registered name", () => {
    expect(shellCommandOf("Bash", { command: "gh pr create" })).toBe("gh pr create")
    expect(shellCommandOf("mcp__cognia-plugin-tools__sandbox_bash", { command: "ls" })).toBe("ls")
    expect(
      shellCommandOf("mcp__cognia-tools__shell_execute_advanced", {
        command: "gh",
        args: ["pr", "merge", "3"],
      })
    ).toBe("gh pr merge 3")
    expect(shellCommandOf("start_process", { program: "gh", args: ["run", "rerun", "9"] })).toBe(
      "gh run rerun 9"
    )
    expect(shellCommandOf("send_email", { command: "gh pr create" })).toBeNull()
  })

  it("covers every shell tool name it maps", () => {
    expect([...SHELL_TOOL_NAMES].sort()).toEqual([
      "bash",
      "sandbox_bash",
      "shell_execute_advanced",
      "start_process",
    ])
  })
})

describe("dedupeGithubTargets", () => {
  it("keeps one repository's different threads apart", () => {
    const a = repositoryTarget("a/b", 1)!
    expect(dedupeGithubTargets([a, a, repositoryTarget("a/b", 2)!, unknownGithubTarget()])).toEqual(
      [a, repositoryTarget("a/b", 2), unknownGithubTarget()]
    )
  })
})
