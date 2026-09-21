import {
  draftIssueDescription,
  improveIssueDescription,
  suggestIssueMetadata,
  suggestIssueRelations,
  suggestIssueTitle,
} from "./ai-issue-assist"
import type { LlmClient } from "@/lib/twin/distill/llm"

function stubClient(reply: string | ((prompt: string) => string) | Error): {
  client: LlmClient
  calls: { prompt: string; system?: string }[]
} {
  const calls: { prompt: string; system?: string }[] = []
  const client: LlmClient = {
    complete: async (prompt, options) => {
      calls.push({ prompt, system: options?.system })
      if (reply instanceof Error) throw reply
      return typeof reply === "function" ? reply(prompt) : reply
    },
  }
  return { client, calls }
}

const safe = () => true
const unsafe = () => false

describe("draftIssueDescription", () => {
  it("returns cleaned markdown for a title", async () => {
    const { client } = stubClient("```markdown\n## Summary\n\nBody here.\n```")
    const res = await draftIssueDescription("Fix login redirect loop", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "text", text: "## Summary\n\nBody here." })
  })

  it("skips empty titles without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await draftIssueDescription("   ", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("skips PII titles without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await draftIssueDescription("token abc", { client, isPiiSafe: unsafe })
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })

  it("skips empty model output", async () => {
    const { client } = stubClient("   ")
    const res = await draftIssueDescription("x", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("includes the project name in the prompt when provided", async () => {
    const { client, calls } = stubClient("body")
    await draftIssueDescription("Fix crash", { client, isPiiSafe: safe, projectName: "Demo" })
    expect(calls[0].prompt).toContain("Project: Demo")
    expect(calls[0].prompt).toContain("Fix crash")
  })
})

describe("improveIssueDescription", () => {
  it("rewrites a draft body", async () => {
    const { client } = stubClient("## Summary\n\nTighter version.")
    const res = await improveIssueDescription("it broke lol", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "text", text: "## Summary\n\nTighter version." })
  })

  it("skips when the rewrite equals the input", async () => {
    const { client } = stubClient("same text")
    const res = await improveIssueDescription("same text", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips PII drafts without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await improveIssueDescription("key=secret", { client, isPiiSafe: unsafe })
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })
})

describe("suggestIssueMetadata", () => {
  const labelNames = ["bug", "ui", "documentation"]

  it("parses a valid suggestion and canonicalizes label names", async () => {
    const { client } = stubClient('{"priority":"high","labels":["Bug","ui","nonexistent","BUG"]}')
    const res = await suggestIssueMetadata(
      { title: "Crash on save", description: "", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({
      kind: "suggestion",
      suggestion: { priority: "high", labelNames: ["bug", "ui"] },
    })
  })

  it("skips when nothing usable comes back", async () => {
    const { client } = stubClient('{"priority":"not-a-priority","labels":["other"]}')
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips on non-JSON output", async () => {
    const { client } = stubClient("I think it's a bug!")
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips on empty title+description without calling", async () => {
    const { client, calls } = stubClient("{}")
    const res = await suggestIssueMetadata(
      { title: " ", description: " ", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("returns a priority-only suggestion when labels do not match", async () => {
    const { client } = stubClient('{"priority":"urgent","labels":[]}')
    const res = await suggestIssueMetadata(
      { title: "prod down", description: "", labelNames: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "suggestion", suggestion: { priority: "urgent", labelNames: [] } })
  })

  it("skips PII content without calling the model", async () => {
    const { client, calls } = stubClient("{}")
    const res = await suggestIssueMetadata(
      { title: "x", description: "secret", labelNames },
      { client, isPiiSafe: unsafe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })
})

describe("suggestIssueTitle", () => {
  it("returns a cleaned single-line title from the body", async () => {
    const { client } = stubClient('"Fix the login redirect loop on mobile.\nExtra ignored line"')
    const res = await suggestIssueTitle("## Steps\n\nOpen login…", {
      client,
      isPiiSafe: safe,
    })
    expect(res).toEqual({ kind: "text", text: "Fix the login redirect loop on mobile" })
  })

  it("skips empty bodies without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await suggestIssueTitle("  ", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("skips PII bodies", async () => {
    const { client, calls } = stubClient("x")
    const res = await suggestIssueTitle("ssn 123", { client, isPiiSafe: unsafe })
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })
})

describe("suggestIssueRelations", () => {
  const candidates = [
    { id: "i1", identifier: "DEMO-1", title: "Auth refactor" },
    { id: "i2", identifier: "DEMO-2", title: "Login redirect loop" },
    { id: "i3", identifier: "DEMO-3", title: "Dashboard polish" },
  ]

  it("maps identifiers back to issue ids and drops unknowns", async () => {
    const { client } = stubClient(
      '{"parent": "demo-1", "blockedBy": ["DEMO-2", "NOPE-9"], "duplicates": ["DEMO-3"]}'
    )
    const res = await suggestIssueRelations(
      { title: "Login loop on mobile", description: "", candidates },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({
      kind: "suggestion",
      suggestion: { parentId: "i1", blockedByIds: ["i2"], duplicateIds: ["i3"] },
    })
  })

  it("skips without a model call when there are no candidates", async () => {
    const { client, calls } = stubClient("{}")
    const res = await suggestIssueRelations(
      { title: "x", description: "y", candidates: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("skips all-empty link results", async () => {
    const { client } = stubClient('{"parent": null, "blockedBy": [], "duplicates": []}')
    const res = await suggestIssueRelations(
      { title: "x", description: "", candidates },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips unparseable replies", async () => {
    const { client } = stubClient("not json at all")
    const res = await suggestIssueRelations(
      { title: "x", description: "", candidates },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })
})

describe("suggestIssueMetadata estimate", () => {
  it("accepts a bucketed estimate", async () => {
    const { client } = stubClient('{"priority": "high", "labels": [], "estimate": 5}')
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({
      kind: "suggestion",
      suggestion: { priority: "high", labelNames: [], estimate: 5 },
    })
  })

  it("drops out-of-bucket estimates", async () => {
    const { client } = stubClient('{"priority": null, "labels": [], "estimate": 7}')
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })
})
