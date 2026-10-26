import { segmentRules } from "../engine/segment"
import {
  buildDeriveRequest,
  buildDeriveRules,
  isCheckableCandidate,
  MAX_RULES_PER_REQUEST,
  parseDeriveAnswer,
} from "./derive"

const surfaces = [
  {
    surfaceKey: "k",
    surfaceName: "CLAUDE.md",
    units: segmentRules(
      "# Rules\n- Run `pnpm test` after editing files.\n- Be friendly.\n- 提交前运行测试。"
    ),
  },
]

describe("buildDeriveRules", () => {
  it("keeps only rules that may be about tool use", () => {
    const rules = buildDeriveRules(surfaces)
    expect(rules.map((rule) => [rule.id, rule.text])).toEqual([
      ["R1", "Run `pnpm test` after editing files."],
      ["R2", "提交前运行测试。"],
    ])
    expect(isCheckableCandidate(surfaces[0]!.units[0]!)).toBe(false)
  })

  it("caps the request", () => {
    const many = [
      {
        surfaceKey: "k",
        surfaceName: "n",
        units: segmentRules(Array.from({ length: 80 }, (_, i) => `- run step ${i}`).join("\n")),
      },
    ]
    expect(buildDeriveRules(many)).toHaveLength(MAX_RULES_PER_REQUEST)
  })

  it("asks for the checks with the rules as data", () => {
    const request = buildDeriveRequest(buildDeriveRules(surfaces))
    expect(request).toContain("R1 (CLAUDE.md, line 2): Run `pnpm test` after editing files.")
    expect(request).toContain('"not-checkable"')
  })
})

describe("parseDeriveAnswer", () => {
  const rules = buildDeriveRules(surfaces)

  it("keeps valid checks with stable ids and sorts the rest", () => {
    const answer = JSON.stringify({
      checks: [
        {
          rule: "R1",
          kind: "require-after",
          trigger: { family: "edit" },
          expect: { family: "shell", command: "^pnpm test" },
          scope: "turn",
          summary: "Tests after edits",
        },
        {
          rule: "R1",
          kind: "require-after",
          trigger: { family: "edit" },
          expect: { family: "shell", command: "^pnpm test" },
        },
        { rule: "R2", kind: "not-checkable" },
        {
          rule: "R2",
          kind: "require-before",
          trigger: { family: "shell", command: "^git commit" },
        },
        { rule: "R2", kind: "forbid", trigger: { family: "shell", command: "(a+)+" } },
        { rule: "R2", kind: "vibes", trigger: { family: "shell", command: "x" } },
        { rule: "R9", kind: "forbid", trigger: { family: "shell", command: "x" } },
      ],
    })
    const result = parseDeriveAnswer(answer, rules)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({
      kind: "require-after",
      scope: "turn",
      summary: "Tests after edits",
      rule: { surfaceKey: "k", startLine: 2, text: "Run `pnpm test` after editing files." },
    })
    expect(result.checks[0]!.id).toMatch(/^CHK-[0-9a-f]{8}$/)
    expect(result.checks[0]!.rule).not.toHaveProperty("id")
    expect(result.notCheckable).toHaveLength(1)
    expect(result.rejected).toHaveLength(3)
    expect(parseDeriveAnswer(answer, rules).checks[0]!.id).toBe(result.checks[0]!.id)
  })

  it("defaults the scope to the turn and the summary to the rule", () => {
    const answer = JSON.stringify({
      checks: [
        {
          rule: "R2",
          kind: "forbid",
          trigger: { family: "shell", command: "^git push --force" },
          scope: "x",
        },
      ],
    })
    expect(parseDeriveAnswer(answer, rules).checks[0]).toMatchObject({
      scope: "turn",
      summary: "提交前运行测试。",
    })
    expect(() => parseDeriveAnswer("no", rules)).toThrow(/JSON/)
  })
})
