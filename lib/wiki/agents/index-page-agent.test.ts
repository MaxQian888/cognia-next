/**
 * Coverage for `IndexPageAgent` — LLM-driven (with mock) + the markdown
 * post-processing exposed via `__TESTING__`.
 */

import {
  __TESTING__,
  assembleIndexPage,
  runIndexPageAgent,
  type ArticleSummary,
} from "./index-page-agent"
import type { LlmClient } from "@/lib/twin/distill/llm"

const ARTICLES: ArticleSummary[] = [
  { slug: "lib-twin", module: "lib/twin", summary: "twin runtime", pageRank: 0.9 },
  { slug: "lib-wiki", module: "lib/wiki", summary: "wiki indexer", pageRank: 0.7 },
]

const SAMPLE_INDEX = [
  "# Cognia code wiki",
  "",
  "Overview paragraph.",
  "",
  "## Twin",
  "- **`lib/twin/`** — runtime. See [[lib-twin]].",
  "",
  "## Wiki",
  "- **`lib/wiki/`** — indexer. See [[lib-wiki]].",
].join("\n")

describe("runIndexPageAgent", () => {
  it("invokes the LLM with articles ordered by pageRank descending", async () => {
    const calls: { prompt: string }[] = []
    const llm: LlmClient = {
      async complete(prompt) {
        calls.push({ prompt })
        return SAMPLE_INDEX
      },
    }
    // Pass articles in reverse order; the agent should re-sort them in the prompt.
    const draft = await runIndexPageAgent({ llm }, [...ARTICLES].reverse())
    expect(calls).toHaveLength(1)
    const prompt = calls[0].prompt
    const idxA = prompt.indexOf("[[lib-twin]]")
    const idxB = prompt.indexOf("[[lib-wiki]]")
    expect(idxA).toBeGreaterThanOrEqual(0)
    expect(idxA).toBeLessThan(idxB)
    expect(draft.contentMd).toContain("# Cognia code wiki")
    expect(draft.referencedSlugs.sort()).toEqual(["lib-twin", "lib-wiki"])
  })
})

describe("assembleIndexPage", () => {
  it("strips a leading ```markdown fence", () => {
    const fenced = "```markdown\n" + SAMPLE_INDEX + "\n```"
    const draft = assembleIndexPage(ARTICLES, fenced)
    expect(draft.contentMd).not.toContain("```markdown")
    expect(draft.contentMd).toContain("# Cognia code wiki")
  })

  it("collects every [[slug]] reference into referencedSlugs", () => {
    const draft = assembleIndexPage(ARTICLES, SAMPLE_INDEX)
    expect(draft.referencedSlugs.sort()).toEqual(["lib-twin", "lib-wiki"])
  })

  it("dedupes repeated [[slug]] references", () => {
    const draft = assembleIndexPage(ARTICLES, SAMPLE_INDEX + "\n[[lib-twin]] again")
    expect(draft.referencedSlugs.filter((s) => s === "lib-twin")).toHaveLength(1)
  })

  it("throws when the body references a slug that doesn't exist", () => {
    const broken = SAMPLE_INDEX + "\n- [[ghost]]"
    expect(() => assembleIndexPage(ARTICLES, broken)).toThrow(/unresolved slugs/)
  })
})

describe("internal helpers", () => {
  it("stripFencedBody returns the inner body", () => {
    expect(__TESTING__.stripFencedBody("```\nbody\n```")).toBe("body")
  })

  it("stripFencedBody passes through unfenced input", () => {
    expect(__TESTING__.stripFencedBody("plain")).toBe("plain")
  })

  it("collectReferencedSlugs returns sorted unique slugs", () => {
    expect(__TESTING__.collectReferencedSlugs("[[zebra]] [[apple]] [[apple]]")).toEqual([
      "apple",
      "zebra",
    ])
  })

  it("MAX_OUTPUT_TOKENS is exposed", () => {
    expect(__TESTING__.MAX_OUTPUT_TOKENS).toBeGreaterThan(500)
  })
})
