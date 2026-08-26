/**
 * Catalogue guard for the stack panel's DYNAMIC translation keys.
 *
 * `pnpm lint:i18n` checks keys written as string literals and skips the ~1,600
 * built from an expression. The panel builds four: `problem.${kind}`,
 * `remedy.${remedy}`, `forge.${status}` and `mergeBlocked.${reason}`. A new
 * member without a message renders a raw key — at the exact moment somebody's
 * stack is broken, their credential is missing, or their merge stopped, and
 * they most need the sentence — so the unions are imported rather than
 * re-listed here, and a new member fails this test instead of falling outside
 * it.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { MERGE_BLOCK_REASONS } from "./merge"
import { STACK_PROBLEM_KINDS, STACK_REMEDIES } from "./validate"

/** Every non-ready forge, as the panel keys them. Mirrors `StackForge`. */
const FORGE_UNAVAILABLE = ["noRemote", "unsupportedHost", "noCredential"] as const

const LOCALES = ["en", "zh-CN"] as const

function stackMessages(locale: string): Record<string, Record<string, string>> {
  const path = join(process.cwd(), "i18n/messages", locale, "sourceControl.json")
  return (JSON.parse(readFileSync(path, "utf8")).stacks ?? {}) as Record<
    string,
    Record<string, string>
  >
}

describe.each(LOCALES)("stack panel dynamic keys — %s", (locale) => {
  const messages = stackMessages(locale)

  it("has a sentence for every problem the validator can produce", () => {
    const problems = messages.problem ?? {}
    expect(STACK_PROBLEM_KINDS.filter((kind) => !problems[kind])).toEqual([])
  })

  it("has a sentence for every remedy", () => {
    const remedies = messages.remedy ?? {}
    expect(STACK_REMEDIES.filter((remedy) => !remedies[remedy])).toEqual([])
  })

  it("has no orphan message for a problem that no longer exists", () => {
    // A stale message is how a union quietly shrinks without anyone noticing
    // the surface that used to render it.
    expect(Object.keys(messages.problem ?? {}).sort()).toEqual([...STACK_PROBLEM_KINDS].sort())
    expect(Object.keys(messages.remedy ?? {}).sort()).toEqual([...STACK_REMEDIES].sort())
  })

  it("has a sentence for every forge that cannot be published to", () => {
    const forge = messages.forge ?? {}
    expect(FORGE_UNAVAILABLE.filter((status) => !forge[status])).toEqual([])
    expect(Object.keys(forge).sort()).toEqual([...FORGE_UNAVAILABLE].sort())
  })

  it("has a sentence for every reason a merge can stop", () => {
    const blocked = messages.mergeBlocked ?? {}
    expect(MERGE_BLOCK_REASONS.filter((reason) => !blocked[reason])).toEqual([])
    expect(Object.keys(blocked).sort()).toEqual([...MERGE_BLOCK_REASONS].sort())
  })

  it("names the host and the repository in the two forge messages that have one", () => {
    // Both are actionable only if they say which host, or which repository.
    const forge = messages.forge ?? {}
    expect(forge.unsupportedHost).toContain("{host}")
    expect(forge.noCredential).toContain("{repository}")
  })

  it("names the branch in every problem that has one", () => {
    // The panel passes `branch` for five of the six kinds; a message that
    // forgets the placeholder reads as a generic complaint about the stack.
    const problems = messages.problem ?? {}
    for (const kind of STACK_PROBLEM_KINDS) {
      if (kind === "forkOnly") continue
      expect(problems[kind]).toContain("{branch}")
    }
    expect(problems.forkOnly).toContain("{repository}")
  })
})
