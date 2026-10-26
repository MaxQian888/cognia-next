/**
 * The sidecar decides which shell `gh` invocations write to GitHub with a
 * generated copy of the host's classifier, because it cannot import the
 * host's packages (ADR-0239 phase 2). If the copy went stale, a `gh` write
 * could run past the always-ask under a spelling only the host recognised.
 * This pins the copy to its source, and the per-invocation verdicts (which
 * also depend on each side's own shell parsing) and the shell tool names
 * equal.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import * as sidecar from "../../../sidecar/src/policy/shell/gh-writes.ts"

import * as host from "@cognia/plugin-contract/lib/claude/permissions/gh-command"

import { ghInvocations, SHELL_TOOL_NAMES, shellCommandOf } from "./gh-targets"

const sorted = (set: ReadonlySet<string>) => [...set].sort()

describe("gh writes: the sidecar's generated classifier", () => {
  it("is the host's source, regenerated", async () => {
    const generator = (await import("../../../scripts/build/gen-sidecar-gh-command.mjs")) as {
      GH_COMMAND_SOURCE: string
      GH_COMMAND_SIDECAR_COPY: string
      sidecarGhCommand: (source: string) => string
    }
    const root = join(__dirname, "..", "..", "..")
    const source = readFileSync(join(root, generator.GH_COMMAND_SOURCE), "utf8")
    const copy = readFileSync(join(root, generator.GH_COMMAND_SIDECAR_COPY), "utf8")
    // Stale? Run `node scripts/build/gen-sidecar-gh-command.mjs`.
    expect(copy).toBe(generator.sidecarGhCommand(source))
  })

  it.each([
    ["read commands", host.GH_READ_COMMANDS, sidecar.GH_READ_COMMANDS],
    ["local commands", host.GH_LOCAL_COMMANDS, sidecar.GH_LOCAL_COMMANDS],
    ["shell tools", SHELL_TOOL_NAMES, sidecar.SHELL_TOOL_NAMES],
  ])("%s are equal", (_name, a, b) => {
    expect(sorted(a)).toEqual(sorted(b))
  })
})

const COMMANDS = [
  "gh",
  "gh api repos/o/r/issues/1/lock -X PUT --jq -XGET",
  "gh extension exec gh-x",
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
