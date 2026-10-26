import {
  commandChangesDirectory,
  commandChangesGhEnvironment,
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

describe("a command that changes directory", () => {
  it("is recognised in any segment, behind wrappers too", () => {
    expect(commandChangesDirectory("cd web && gh pr create")).toBe(true)
    expect(commandChangesDirectory("(cd web; gh pr create)")).toBe(true)
    expect(commandChangesDirectory("pushd web && gh pr create && popd")).toBe(true)
    expect(commandChangesDirectory("gh pr create --fill")).toBe(false)
    expect(commandChangesDirectory("echo cd && gh pr create")).toBe(false)
  })

  it("does not put a gh write that names no repository on the checkout", () => {
    const context = { localRepository: "git@github.com:acme/web.git" }
    expect(ghWriteTargets("gh pr comment 3 -b x", context)).toEqual([
      repositoryTarget("acme/web", 3),
    ])
    expect(ghWriteTargets("cd ../api && gh pr comment 3 -b x", context)).toEqual([
      unknownGithubTarget(),
    ])
    // A write that names its repository still does.
    expect(ghWriteTargets("cd ../api && gh pr comment 3 -R acme/api -b x", context)).toEqual([
      repositoryTarget("acme/api", 3),
    ])
  })
})

describe("a command that sets GH_REPO or GH_HOST where only the shell can read it", () => {
  it("is recognised: export, a bare assignment, unset, source and eval", () => {
    expect(commandChangesGhEnvironment("export GH_REPO=other/repo; gh pr create --fill")).toBe(true)
    expect(commandChangesGhEnvironment("GH_REPO=other/repo; gh pr create --fill")).toBe(true)
    expect(commandChangesGhEnvironment("unset GH_HOST && gh pr create")).toBe(true)
    expect(commandChangesGhEnvironment("source .env && gh pr create")).toBe(true)
    expect(commandChangesGhEnvironment(". ./env.sh; gh pr create")).toBe(true)
    expect(commandChangesGhEnvironment('eval "$(cat env)"; gh pr create')).toBe(true)
    // A gh segment's own leading assignment is read where it is written.
    expect(commandChangesGhEnvironment("GH_REPO=o/r gh pr create")).toBe(false)
    expect(commandChangesGhEnvironment("gh pr create --fill")).toBe(false)
  })

  it("does not put a write that names no repository on the checkout", () => {
    const context = { localRepository: "allowed/repo" }
    expect(ghWriteTargets("export GH_REPO=other/repo; gh pr create --fill", context)).toEqual([
      unknownGithubTarget(),
    ])
    // Written on the gh segment itself, the repository is read.
    expect(ghWriteTargets("GH_REPO=other/repo gh pr create --fill", context)).toEqual([
      repositoryTarget("other/repo"),
    ])
  })
})
