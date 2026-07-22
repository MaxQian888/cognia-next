/**
 * Cross-boundary parity guard for the permission gate.
 *
 * There are TWO matchers, and only one of them is the gate that actually runs.
 * `resolveBashPermission` (here, renderer-side) backs Auto-mode and the
 * approval UI. `resolveForToolCall` (`sidecar/dispatch/permission-resolver.mjs`)
 * is what `canUseTool` in `anthropic.mjs` consults to hard-reject a call before
 * it executes. The sidecar cannot import `lib/`, so it hand-mirrors this
 * module — and a mirror drifts silently.
 *
 * That drift is not academic: callers author a deny ruleset, test it against
 * the renderer matcher because that is the importable one, and ship believing
 * the sidecar enforces the same thing. `plugins/github-delivery` did exactly
 * that.
 *
 * This test lives under `lib/` (not `/sidecar/`, which Jest ignores) and
 * imports BOTH; `permission-resolver.mjs` has zero imports so it transforms
 * cleanly.
 *
 * What parity means here: the two are NOT interchangeable by design. The
 * renderer prepends `DEFAULT_RULESET` (`*: allow`), so an unmatched command is
 * "allow, not explicit" — a signal to fall back to the classifier. The sidecar
 * has no such default and returns "ask" — a signal to fall through to the
 * approval round-trip. The invariant that MUST hold is the security-relevant
 * one: anything an explicit rule denies is denied by both, through every
 * spelling the shell accepts.
 */
import { ISSUE_LOOP_PERMISSION_RULESET } from "@/plugins/github-delivery/src/drivers/sidecar-driver"
import { resolveBashPermission, type Ruleset } from "./ruleset"
import { resolveForToolCall } from "../../../sidecar/dispatch/permission-resolver.mjs"

const sidecarVerdict = (ruleset: Ruleset, command: string): string =>
  (resolveForToolCall as (r: Ruleset, t: string, i: unknown) => string)(ruleset, "Bash", {
    command,
  })

const rendererVerdict = (ruleset: Ruleset, command: string): string =>
  resolveBashPermission(command, [ruleset]).verdict

const DENY_RULESET: Ruleset = { Bash: { "git push": "deny", "git push **": "deny" } }

/**
 * Every spelling that must be denied on BOTH sides. Each one is a way a shell
 * runs `git push` without the segment text literally starting with it.
 */
const MUST_DENY = [
  "git push",
  "git push origin main",
  "npm test && git push",
  "cd /tmp; git push",
  "cat x | git push",
  "sleep 1 & git push",
  "echo $(git push)",
  "echo `git push`",
  "(git push)",
  "echo $(echo $(git push))",
]

describe("renderer ↔ sidecar permission parity", () => {
  it.each(MUST_DENY)("both matchers deny %s", (command) => {
    expect(rendererVerdict(DENY_RULESET, command)).toBe("deny")
    expect(sidecarVerdict(DENY_RULESET, command)).toBe("deny")
  })

  it("both matchers leave an unrelated command undenied", () => {
    for (const command of ["npm test", "git status", `git commit -m "a; b"`]) {
      expect(rendererVerdict(DENY_RULESET, command)).not.toBe("deny")
      expect(sidecarVerdict(DENY_RULESET, command)).not.toBe("deny")
    }
  })

  // The reason this file exists. The Issue → PR driver hands its ruleset to the
  // sidecar, so the sidecar matcher is the one enforcing it — the driver's own
  // suite can only reach the renderer one.
  describe("github-delivery issue-loop ruleset holds under the sidecar matcher", () => {
    const ruleset = ISSUE_LOOP_PERMISSION_RULESET as unknown as Ruleset

    it.each([
      "git push",
      "git push --force origin main",
      "gh pr create --fill",
      "git remote set-url origin https://x@github.com/a/b.git",
      "git -C /tmp/checkout push",
      "git -c user.name=x push origin main",
      "git  push",
      "env gh pr create --fill",
      "npm test && git push origin main",
      "echo $(git push)",
      "echo `gh pr merge 1`",
    ])("denies %s", (command) => {
      expect(sidecarVerdict(ruleset, command)).toBe("deny")
    })

    it("still permits the commands the driver needs", () => {
      for (const command of [
        "npm test",
        "git status",
        "git add -A",
        'git commit -m "fix the push flow"',
        "git log --grep=push",
      ]) {
        expect(sidecarVerdict(ruleset, command)).not.toBe("deny")
      }
    })
  })
})
