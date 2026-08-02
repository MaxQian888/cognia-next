/**
 * Vocabulary parity between the sidecar gate and the action-review contract.
 *
 * `lib/claude/permissions/ruleset.sidecar-parity.test.ts` already pins the
 * *semantics* of the two matchers. This test pins something narrower and
 * different: that every verdict string `resolveForToolCall` can physically
 * return is a member of {@link ActionReviewVerdict}.
 *
 * It matters because the sidecar is the one producer that cannot import the
 * contract. `sidecar/package.json` has exactly one workspace dependency
 * (`@cognia/redact`), so `permission-resolver.mjs` is a hand-mirror with no
 * type checking against `action-review.ts` whatsoever. If someone adds a
 * fourth verdict there — a "prompt" or a "defer" — nothing else in the repo
 * fails; the value simply flows into an `ActionReviewRequest.verdict` field
 * typed to reject it, and gets persisted onto a receipt as a lie.
 *
 * Like the other parity guards: if this fails, add the member to the contract
 * (and its constant, and the i18n keys), do not widen the expectation.
 */
import {
  ACTION_REVIEW_VERDICTS,
  type ActionReviewVerdict,
} from "@cognia/agent-config-types/action-review"
import type { Ruleset } from "@/lib/claude/permissions/ruleset"
import {
  resolveForToolCall,
  resolveToolVerdict,
} from "../../../sidecar/dispatch/permission-resolver.mjs"

const forToolCall = resolveForToolCall as (r: Ruleset, tool: string, input: unknown) => string
const forTool = resolveToolVerdict as (r: Ruleset, tool: string, target: string) => string

/**
 * Rulesets and calls chosen to drive the resolver down every branch that can
 * produce a verdict: no rule, an explicit allow, an explicit deny, a glob hit,
 * a compound command whose worst segment wins, and a non-command tool.
 */
const CASES: Array<{ label: string; ruleset: Ruleset; tool: string; input: unknown }> = [
  { label: "no matching rule", ruleset: {}, tool: "Bash", input: { command: "ls" } },
  {
    label: "explicit allow",
    ruleset: { Bash: { "git status": "allow" } },
    tool: "Bash",
    input: { command: "git status" },
  },
  {
    label: "explicit deny",
    ruleset: { Bash: { "git push": "deny" } },
    tool: "Bash",
    input: { command: "git push" },
  },
  {
    label: "glob deny",
    ruleset: { Bash: { "rm **": "deny" } },
    tool: "Bash",
    input: { command: "rm -rf /tmp/x" },
  },
  {
    label: "compound command — worst segment wins",
    ruleset: { Bash: { "git push": "deny" } },
    tool: "Bash",
    input: { command: "ls && git push" },
  },
  {
    label: "explicit ask",
    ruleset: { Bash: { curl: "ask" } },
    tool: "Bash",
    input: { command: "curl https://example.com" },
  },
  {
    label: "file tool with a path target",
    ruleset: { Write: { "**/.env": "deny" } },
    tool: "Write",
    input: { file_path: "/repo/.env" },
  },
  {
    label: "unknown tool, empty input",
    ruleset: {},
    tool: "SomeFutureTool",
    input: {},
  },
]

describe("sidecar verdict vocabulary parity", () => {
  it.each(CASES)(
    "resolveForToolCall returns a contract verdict for $label",
    ({ ruleset, tool, input }) => {
      const verdict = forToolCall(ruleset, tool, input)
      expect(ACTION_REVIEW_VERDICTS).toContain(verdict as ActionReviewVerdict)
    }
  )

  // `resolveToolVerdict` is the lower-level matcher, and its documented
  // contract is "a verdict, or `null` when no rule matched" — the sentinel
  // `resolveForToolCall` collapses to "ask". So the invariant here is narrower:
  // null is the ONLY non-verdict value it may produce. A fifth value would
  // still be caught.
  it.each([
    ["no rule", {} as Ruleset, "Read", "/repo/a.ts"],
    ["non-object ruleset", null as unknown as Ruleset, "Read", "/repo/a.ts"],
    ["allow rule", { Read: { "**": "allow" } } as Ruleset, "Read", "/repo/a.ts"],
    ["deny rule", { Read: { "**/.env": "deny" } } as Ruleset, "Read", "/repo/.env"],
    ["ask rule", { Read: { "**/secrets/**": "ask" } } as Ruleset, "Read", "/repo/secrets/k"],
  ])(
    "resolveToolVerdict returns a contract verdict or null for %s",
    (_label, ruleset, tool, target) => {
      const verdict = forTool(ruleset, tool, target)
      if (verdict === null) return
      expect(ACTION_REVIEW_VERDICTS).toContain(verdict as ActionReviewVerdict)
    }
  )

  it("resolveToolVerdict still reaches all three verdicts", () => {
    const observed = new Set(
      (
        [
          [{ Read: { "**": "allow" } }, "/repo/a.ts"],
          [{ Read: { "**/.env": "deny" } }, "/repo/.env"],
          [{ Read: { "**/secrets/**": "ask" } }, "/repo/secrets/k"],
        ] as Array<[Ruleset, string]>
      ).map(([ruleset, target]) => forTool(ruleset, "Read", target))
    )
    expect([...observed].sort()).toEqual([...ACTION_REVIEW_VERDICTS].sort())
  })

  it("observes every contract verdict across the case matrix", () => {
    // Proves the matrix actually exercises the resolver rather than trivially
    // passing because one branch happens to be reachable.
    const observed = new Set(CASES.map((c) => forToolCall(c.ruleset, c.tool, c.input)))
    expect([...observed].sort()).toEqual([...ACTION_REVIEW_VERDICTS].sort())
  })
})
