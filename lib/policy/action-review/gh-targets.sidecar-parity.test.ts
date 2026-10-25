/**
 * The sidecar decides which shell `gh` invocations write to GitHub with its
 * own copy of the host's tables, because it cannot import the host's packages
 * (ADR-0239 phase 2). If they drifted, a `gh` write could run past the
 * always-ask under a spelling only the host recognised. This pins the tables,
 * the per-invocation verdicts and the shell tool names equal.
 */
import * as sidecar from "../../../sidecar/src/policy/shell/gh-writes.ts"

import * as host from "@cognia/plugin-contract/lib/claude/permissions/gh-command"

import { ghInvocations, SHELL_TOOL_NAMES, shellCommandOf } from "./gh-targets"

const sorted = (set: ReadonlySet<string>) => [...set].sort()

describe("gh writes: host and sidecar tables", () => {
  it.each([
    ["read commands", host.GH_READ_COMMANDS, sidecar.GH_READ_COMMANDS],
    ["local commands", host.GH_LOCAL_COMMANDS, sidecar.GH_LOCAL_COMMANDS],
    ["groups", host.GH_GROUPS, sidecar.GH_GROUPS],
    ["nested groups", host.GH_NESTED, sidecar.GH_NESTED],
    ["value flags", host.GH_VALUE_FLAGS, sidecar.GH_VALUE_FLAGS],
    ["api body flags", host.GH_API_BODY_FLAGS, sidecar.GH_API_BODY_FLAGS],
    ["shell tools", SHELL_TOOL_NAMES, sidecar.SHELL_TOOL_NAMES],
  ])("%s are equal", (_name, a, b) => {
    expect(sorted(a)).toEqual(sorted(b))
  })
})

const COMMANDS = [
  "gh",
  "gh --version",
  "gh pr",
  "gh pr view 12",
  "gh pr create --fill",
  "gh pr -R o/r create",
  "gh pr --repo=o/r view 3",
  "gh pr comment https://github.com/o/r/pull/12 --body hi",
  "gh pr merge 12 --squash --delete-branch",
  "gh pr create --help",
  "gh pr merge -h",
  "gh issue comment 3 -b 'a; b'",
  "gh issue list --label bug",
  "gh repo create o/n -h https://x.dev",
  "gh repo create --help",
  "gh repo deploy-key list",
  "gh repo deploy-key add k.pub",
  "gh repo deploy-key",
  "gh release create v1 --notes x",
  "gh workflow run ci.yml",
  "gh run watch 9",
  "gh auth login",
  "gh extension install o/gh-x",
  "gh alias set co 'pr checkout'",
  "gh copilot suggest x",
  "gh api repos/o/r/pulls",
  "gh api --paginate repos/o/r/issues",
  "gh api -X POST repos/o/r/issues",
  "gh api -XDELETE repos/o/r/git/refs/tags/v1",
  "gh api --method=head repos/o/r",
  "gh api -X GET --method POST repos/o/r/issues",
  "gh api --method POST -X GET repos/o/r",
  "gh api repos/o/r/issues -f title=x",
  "gh api -X GET search/issues -f q=x",
  "gh api graphql -F query=@q.graphql",
  "gh api --input body.json repos/o/r/pulls",
  "gh -- pr create",
  "sudo gh pr merge 3",
  "env GH_REPO=o/r gh issue create -t x",
  "GH_REPO=o/r /usr/local/bin/gh pr create",
  "command gh pr view 1",
  "git status && gh pr view 1 | cat; echo $(gh pr merge 2)",
  "(cd web && gh pr create --fill)",
  "echo `gh issue close 4`",
  "gh pr view 3 && echo 'gh pr create'",
  "ls -la",
  "",
]

describe("gh writes: host and sidecar verdicts", () => {
  it.each(COMMANDS)("%j", (command) => {
    expect(sidecar.ghInvocationKinds(command)).toEqual(ghInvocations(command).map((i) => i.kind))
  })
})

describe("gh writes: host and sidecar read the same command from a shell call", () => {
  it.each([
    ["bash", { command: "gh pr create" }],
    ["sandbox_bash", { command: "gh pr merge 3" }],
    ["shell_execute_advanced", { command: "gh", args: ["pr", "comment", "3"] }],
    ["start_process", { program: "gh", args: ["run", "rerun", "9"] }],
    ["bash", { command: "   " }],
    ["write", { command: "gh pr create" }],
  ])("%s %j", (name, input) => {
    expect(sidecar.shellCommandOf(name, input)).toBe(shellCommandOf(name, input))
  })
})
