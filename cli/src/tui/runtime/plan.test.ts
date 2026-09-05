/**
 * @jest-environment node
 */
import {
  PLAN_APPROVAL_CHOICES,
  PLAN_APPROVED_PROMPT,
  PLAN_BUILD_MODE,
  PLAN_EXECUTE_PROMPT,
  isExitPlanTool,
  looksLikePlan,
  looksLikeQuestion,
  planBodyFromExitInput,
  planDecisionMode,
  planDiffStat,
  planDiffText,
  planFileName,
  planIdFromFile,
  planStats,
  planTitle,
} from "./plan"

describe("looksLikePlan", () => {
  it("keeps a project analysis with headings and technical lists as a normal answer", () => {
    expect(
      looksLikePlan("The plan mode enforces read-only tools. It does not edit your project.")
    ).toBe(false)
    expect(
      looksLikePlan("# Plan mode\nThis section describes the existing permission system.")
    ).toBe(false)
    expect(
      looksLikePlan(
        "# Cognia 项目分析\n## 技术栈\n- Next.js 和 React\n- Rust 核心\n## 总结\n这是一个以工程治理换规模的项目。"
      )
    ).toBe(false)
    expect(
      looksLikePlan(
        "# Architecture\n1. Next.js frontend\n2. Rust backend\n\n" +
          "Existing architecture. ".repeat(30)
      )
    ).toBe(false)
  })

  it("recognizes explicit Chinese plans and action sequences but not fenced examples", () => {
    expect(looksLikePlan("# 实施计划\n1. 修改渲染组件\n2. 添加回归测试")).toBe(true)
    expect(looksLikePlan("1. 修复渲染组件中的布局\n2. 验证窄屏下的交互行为")).toBe(true)
    expect(looksLikePlan("代码示例：\n```markdown\n# Plan\n1. implement\n2. verify\n```")).toBe(
      false
    )
  })
  it("rejects a short clarifying question", () => {
    expect(looksLikePlan("Which file should I start with?")).toBe(false)
  })

  it("rejects empty / whitespace", () => {
    expect(looksLikePlan("")).toBe(false)
    expect(looksLikePlan("   \n  ")).toBe(false)
  })

  it("accepts a reply with a markdown heading", () => {
    expect(looksLikePlan("# Plan\n\nDo the thing.")).toBe(true)
  })

  it("accepts a reply with two or more list steps", () => {
    expect(looksLikePlan("Steps:\n- explore\n- implement")).toBe(true)
    expect(looksLikePlan("1. explore\n2. implement\n3. verify")).toBe(true)
  })

  it("treats a single bullet as not-yet-a-plan", () => {
    expect(looksLikePlan("- just one short note")).toBe(false)
  })

  it("accepts a long prose body even without structure", () => {
    expect(looksLikePlan("x".padEnd(300, "y"))).toBe(false)
  })
})

describe("isExitPlanTool", () => {
  it("matches the native and cross-provider exit-plan tool names", () => {
    expect(isExitPlanTool("ExitPlanMode")).toBe(true)
    expect(isExitPlanTool("exit_plan_mode")).toBe(true)
    expect(isExitPlanTool("mcp__cognia-tools__exit_plan_mode")).toBe(true)
  })

  it("rejects other tools and near-misses", () => {
    expect(isExitPlanTool("Read")).toBe(false)
    expect(isExitPlanTool("exit_plan")).toBe(false)
    expect(isExitPlanTool("")).toBe(false)
  })
})

describe("planBodyFromExitInput", () => {
  it("passes through a string plan", () => {
    expect(planBodyFromExitInput({ plan: "# Plan\n- step a" })).toBe("# Plan\n- step a")
  })

  it("renders an array of strings as a bullet list", () => {
    expect(planBodyFromExitInput({ plan: ["explore", "implement"] })).toBe("- explore\n- implement")
  })

  it("renders an array of step objects via content/title/description", () => {
    expect(
      planBodyFromExitInput({
        steps: [{ content: "a" }, { title: "b" }, { description: "c" }],
      })
    ).toBe("- a\n- b\n- c")
  })

  it("returns null for empty / missing / malformed input", () => {
    expect(planBodyFromExitInput(null)).toBeNull()
    expect(planBodyFromExitInput("nope")).toBeNull()
    expect(planBodyFromExitInput({})).toBeNull()
    expect(planBodyFromExitInput({ plan: "   " })).toBeNull()
    expect(planBodyFromExitInput({ steps: [] })).toBeNull()
  })
})

describe("looksLikeQuestion", () => {
  it("flags a trailing question mark", () => {
    expect(looksLikeQuestion("Which database should I use?")).toBe(true)
  })

  it("flags interrogative openers without a trailing ?", () => {
    expect(looksLikeQuestion("Could you confirm the target directory")).toBe(true)
    expect(looksLikeQuestion("I have a few questions before I start")).toBe(true)
  })

  it("does not flag a genuine plan", () => {
    expect(looksLikeQuestion("# Plan\n\n- explore the parser\n- implement the fix")).toBe(false)
  })

  it("rejects empty input", () => {
    expect(looksLikeQuestion("   ")).toBe(false)
  })
})

describe("planStats", () => {
  it("counts list and numbered items as steps and non-blank lines", () => {
    const raw = "# Plan\n\n- step one\n- step two\n1. step three\n\nsome prose"
    expect(planStats(raw)).toEqual({ steps: 3, lines: 5 })
  })

  it("reports zero steps for unstructured prose", () => {
    expect(planStats("just a paragraph\nof prose")).toEqual({ steps: 0, lines: 2 })
  })

  it("handles an empty body", () => {
    expect(planStats("")).toEqual({ steps: 0, lines: 0 })
  })
})

describe("planTitle", () => {
  it("uses the first heading text, stripped of markers", () => {
    expect(planTitle("## Refactor the parser\n\nbody")).toBe("Refactor the parser")
  })

  it("falls back to the first non-empty line", () => {
    expect(planTitle("\n\nFirst real line\nsecond")).toBe("First real line")
  })

  it("strips a leading bullet marker", () => {
    expect(planTitle("- do the work")).toBe("do the work")
  })

  it("truncates a long title", () => {
    const title = planTitle("# " + "a".repeat(100), 10)
    expect(title).toHaveLength(10)
    expect(title.endsWith("…")).toBe(true)
  })

  it("returns a placeholder for an empty plan", () => {
    expect(planTitle("")).toBe("Untitled plan")
    expect(planTitle("   \n  ")).toBe("Untitled plan")
  })

  it("skips a heading line that is only markers", () => {
    expect(planTitle("##\nreal title")).toBe("real title")
  })
})

describe("planFileName / planIdFromFile", () => {
  it("builds a filename-safe name from a session id and seq", () => {
    expect(planFileName("sess-123", 4)).toBe("sess-123-plan-4.md")
  })

  it("sanitizes unsafe characters and collapses dashes", () => {
    expect(planFileName("a/b:c d", 1)).toBe("a-b-c-d-plan-1.md")
  })

  it("falls back to `session` when the id has no safe chars", () => {
    expect(planFileName("/::/", 2)).toBe("session-plan-2.md")
  })

  it("round-trips the id by dropping the .md extension", () => {
    expect(planIdFromFile("sess-plan-3.md")).toBe("sess-plan-3")
  })
})

describe("constants", () => {
  it("approves into a mode that allows edits", () => {
    expect(PLAN_BUILD_MODE).toBe("acceptEdits")
  })

  it("offers in-context, fresh-session, and edit approve options plus keep", () => {
    expect(PLAN_APPROVAL_CHOICES.map((c) => c.id)).toEqual([
      "approve-auto",
      "approve-confirm",
      "approve-new-session",
      "edit-then-approve",
      "keep",
    ])
  })

  it("has a non-empty approval prompt", () => {
    expect(PLAN_APPROVED_PROMPT.length).toBeGreaterThan(0)
  })
})

describe("planDiffStat", () => {
  it("reports no change for identical plans (blank lines + whitespace ignored)", () => {
    expect(planDiffStat("# Plan\n- a\n- b", "# Plan\n\n- a\n  - b ")).toEqual({
      added: 0,
      removed: 0,
    })
  })

  it("counts added and removed lines", () => {
    // prev: [# Plan, - a, - b]; next: [# Plan, - a, - c, - d]
    expect(planDiffStat("# Plan\n- a\n- b", "# Plan\n- a\n- c\n- d")).toEqual({
      added: 2, // - c, - d
      removed: 1, // - b
    })
  })

  it("counts every line of a plan as added when there was no previous", () => {
    expect(planDiffStat("", "# Plan\n- only")).toEqual({ added: 2, removed: 0 })
  })
})

describe("planDiffText", () => {
  it("marks changed lines with ± and keeps unchanged lines as context", () => {
    const out = planDiffText("# Plan\n- a\n- b", "# Plan\n- a\n- c")
    const lines = out.split("\n")
    expect(lines).toContain("  # Plan")
    expect(lines).toContain("  - a")
    expect(lines).toContain("- - b")
    expect(lines).toContain("+ - c")
  })

  it("emits an all-context body for identical plans (no ± lines)", () => {
    const out = planDiffText("# Plan\n- a", "# Plan\n- a")
    expect(out.split("\n").every((l) => l.startsWith("  "))).toBe(true)
  })

  it("shows the new content as an addition when the previous plan was empty", () => {
    expect(planDiffText("", "new line")).toContain("+ new line")
  })
})

describe("planDecisionMode", () => {
  it("maps auto-approve to the acceptEdits build mode", () => {
    expect(planDecisionMode("approve-auto")).toBe("acceptEdits")
  })

  it("maps confirm-each-edit approve to default mode", () => {
    expect(planDecisionMode("approve-confirm")).toBe("default")
  })

  it("returns null for keep planning (no mode switch)", () => {
    expect(planDecisionMode("keep")).toBeNull()
  })

  it("returns null for the specially-handled fresh-session and edit decisions", () => {
    // These are handled by the App (session reset / editor), not a plain mode switch.
    expect(planDecisionMode("approve-new-session")).toBeNull()
    expect(planDecisionMode("edit-then-approve")).toBeNull()
  })
})

describe("PLAN_EXECUTE_PROMPT", () => {
  const PLAN = "# Add retry to the fetch client\n\n1. Wrap fetch\n2. Add backoff"

  it("embeds the full plan for a context-less fresh session", () => {
    const out = PLAN_EXECUTE_PROMPT(PLAN)
    expect(out).toContain(PLAN)
    expect(out).toMatch(/fresh session/i)
  })

  it("leads with the plan title so the sessions list auto-names the run", () => {
    const out = PLAN_EXECUTE_PROMPT(PLAN)
    // The first line carries the plan title (drives listSessions' titleFrom).
    expect(out.split("\n")[0]).toContain(planTitle(PLAN))
  })
})
