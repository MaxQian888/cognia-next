import { buildPrompt, MAX_ANSWER_CHARS, parseAnswer } from "./answer"
import type { CommandSourceV1 } from "./command-source"
import type { ThreadItem } from "./context"

const source = {
  repository: "acme/widgets",
  verb: "ask",
  request: "why does it crash?",
  actor: { id: 42, login: "octo-cat" },
} as CommandSourceV1
const item = { number: 7, isPullRequest: false } as ThreadItem
const selection = {
  items: [
    { id: "parent", kind: "parent", source: "u", text: "Issue #7", bytes: 8, truncated: false },
  ],
  omitted: { comment: 2 },
  truncatedItems: 0,
  bytes: 8,
  estimatedTokens: 2,
}

it("frames GitHub text as untrusted data and states the read-only contract", () => {
  const prompt = buildPrompt(source, item, selection, true)
  expect(prompt).toContain("read-only")
  expect(prompt).toContain("never post to GitHub yourself")
  expect(prompt).toContain('"omitted":{"comment":2}')
  expect(prompt).toContain('{"answer":"markdown answer"}')
  expect(prompt).not.toContain("Part of the context was cut")
  const review = buildPrompt(
    { ...source, verb: "review" },
    { ...item, isPullRequest: true },
    selection,
    false
  )
  expect(review).toContain("Do not approve or request changes")
  expect(review).toContain("Part of the context was cut")
  expect(review).toContain('"findings"')
})

it("accepts only a well-formed answer", () => {
  expect(parseAnswer('```json\n{"answer":" Because. "}\n```', "ask")).toEqual({
    kind: "ask",
    answer: "Because.",
  })
  expect(parseAnswer('Here you go: {"answer":"x"}', "ask")).toEqual({ kind: "ask", answer: "x" })
  for (const bad of [
    "",
    "prose only",
    '{"answer":""}',
    '{"answer":1}',
    `{"answer":"${"x".repeat(MAX_ANSWER_CHARS + 1)}"}`,
  ])
    expect(() => parseAnswer(bad, "ask")).toThrow()
  // Two objects are ambiguous, not "the first one".
  expect(() => parseAnswer('{"answer":"a"} {"answer":"b"}', "ask")).toThrow()
})

it("accepts only findings a review can carry", () => {
  expect(
    parseAnswer(
      JSON.stringify({
        summary: "Looks fine",
        findings: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: " Null check " }],
      }),
      "review"
    )
  ).toEqual({
    kind: "review",
    summary: "Looks fine",
    findings: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "Null check" }],
  })
  expect(parseAnswer('{"summary":"ok"}', "review")).toEqual({
    kind: "review",
    summary: "ok",
    findings: [],
  })
  for (const finding of [
    { path: "/etc/passwd", line: 1, side: "RIGHT", body: "x" },
    { path: "a/../b", line: 1, side: "RIGHT", body: "x" },
    { path: "a", line: 0, side: "RIGHT", body: "x" },
    { path: "a", line: 1, side: "UP", body: "x" },
    { path: "a", line: 1, side: "LEFT", body: " " },
  ])
    expect(() =>
      parseAnswer(JSON.stringify({ summary: "s", findings: [finding] }), "review")
    ).toThrow("findings")
  expect(() => parseAnswer('{"summary":""}', "review")).toThrow("summary")
})
