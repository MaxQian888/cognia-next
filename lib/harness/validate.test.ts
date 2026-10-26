import { HARNESS_COMPONENT_NAMES } from "@/types/harness/snapshot"
import { makeComponents, makeSkill } from "./test-fixtures"
import {
  ALWAYS_ON_GROWTH,
  ALWAYS_ON_SOFT_CAP,
  MAX_SKILLS,
  MAX_SUBAGENTS,
  validateHarnessCandidate,
} from "./validate"

const all = { editable: HARNESS_COMPONENT_NAMES, knownTools: ["Read", "Bash", "Write"] }
const base = makeComponents()

function errorsOf(candidate: ReturnType<typeof makeComponents>, policy = all) {
  return validateHarnessCandidate(candidate, base, policy).errors.join("\n")
}

describe("validateHarnessCandidate", () => {
  it("accepts the base itself and reports a census", () => {
    const report = validateHarnessCandidate(base, base, all)
    expect(report.ok).toBe(true)
    expect(report.census).toMatchObject({ skills: 1, scripts: 1, subagents: 1, toolRules: 1 })
  })

  it("refuses changes to locked components", () => {
    const candidate = makeComponents({ memory: "different" })
    expect(errorsOf(candidate, { ...all, editable: ["systemPrompt"] })).toMatch(
      /memory\.md: the memory component is locked/
    )
    expect(validateHarnessCandidate(candidate, base, { ...all, editable: ["memory"] }).ok).toBe(
      true
    )
  })

  it("refuses an emptied system prompt", () => {
    expect(errorsOf(makeComponents({ systemPrompt: "  " }))).toMatch(/never empty it/)
  })

  it("caps always-on text at the soft cap or the base plus growth", () => {
    const tooLong = makeComponents({ memory: "x".repeat(ALWAYS_ON_SOFT_CAP + 10) })
    expect(errorsOf(tooLong)).toMatch(/always-on text is \d+ chars/)
    const bigBase = makeComponents({ memory: "y".repeat(ALWAYS_ON_SOFT_CAP + 5_000) })
    const grown = makeComponents({
      memory: "y".repeat(ALWAYS_ON_SOFT_CAP + 5_000 + ALWAYS_ON_GROWTH / 2),
    })
    expect(validateHarnessCandidate(grown, bigBase, all).ok).toBe(true)
  })

  it("requires every invoked helper to ship with its skill", () => {
    const candidate = makeComponents({ skills: [makeSkill({ resources: [] })] })
    expect(errorsOf(candidate)).toMatch(
      /invokes `scripts\/summarize\.py` but .* is not in the harness/
    )
  })

  it("checks qualified helper references in always-on text", () => {
    const candidate = makeComponents({
      toolGuidance: "Run skills/csv-report/scripts/missing.py for totals.",
    })
    expect(errorsOf(candidate)).toMatch(
      /always-on text invokes `skills\/csv-report\/scripts\/missing\.py`/
    )
  })

  it("refuses destructive commands in shell scripts and embedded shell strings", () => {
    const shell = makeSkill({
      content: "Run `scripts/clean.sh`.",
      resources: [
        { path: "scripts/clean.sh", kind: "script", content: "rm -rf /\n", encoding: "utf-8" },
      ],
    })
    expect(errorsOf(makeComponents({ skills: [shell] }))).toMatch(/refuses the command `rm -rf \/`/)
    const python = makeSkill({
      resources: [
        {
          path: "scripts/summarize.py",
          kind: "script",
          content: 'import os\nos.system("rm -rf /")\n',
          encoding: "utf-8",
        },
      ],
    })
    expect(errorsOf(makeComponents({ skills: [python] }))).toMatch(/refuses the command/)
  })

  it("refuses scripts with an unsupported extension", () => {
    const skill = makeSkill({
      content: "Use `scripts/tool.exe`.",
      resources: [{ path: "scripts/tool.exe", kind: "script", content: "MZ", encoding: "utf-8" }],
    })
    expect(errorsOf(makeComponents({ skills: [skill] }))).toMatch(/scripts must be one of/)
  })

  it("keeps subagent tools inside what the agent has", () => {
    const candidate = makeComponents({
      subagents: [{ name: "checker", description: "d", prompt: "p", tools: ["Read", "WebFetch"] }],
    })
    expect(errorsOf(candidate)).toMatch(/tools WebFetch are not available to this agent/)
  })

  it("uses the base's subagent tools as the ceiling when the agent's tools are unknown", () => {
    const candidate = makeComponents({
      subagents: [{ name: "checker", description: "d", prompt: "p", tools: ["Bash"] }],
    })
    expect(
      validateHarnessCandidate(candidate, base, { editable: HARNESS_COMPONENT_NAMES }).errors.join()
    ).toMatch(/tools Bash are not available/)
  })

  it("enforces counts", () => {
    const skills = Array.from({ length: MAX_SKILLS + 1 }, (_, i) =>
      makeSkill({ key: `s${i}`, name: `s${i}`, content: "body", resources: [] })
    )
    expect(errorsOf(makeComponents({ skills }))).toMatch(/skills; the limit is 32/)
    const subagents = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => ({
      name: `a${i}`,
      description: "d",
      prompt: "p",
    }))
    expect(errorsOf(makeComponents({ subagents }))).toMatch(/subagents; the limit is 8/)
    expect(errorsOf(makeComponents({ skills: [makeSkill(), makeSkill()] }))).toMatch(
      /defined twice/
    )
  })

  it("refuses new text that carries a credential, but not the person's own base", () => {
    const leaky = makeComponents({ memory: "Use key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" })
    expect(errorsOf(leaky)).toMatch(/memory\.md: contains something that looks like a credential/)
    expect(validateHarnessCandidate(leaky, leaky, all).ok).toBe(true)
  })
})
