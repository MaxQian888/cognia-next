import type { SubAgentTemplate } from "@/types/agent/sub-agent"

import {
  dispatchRailUnavailable,
  extractPlaceholders,
  nativeDelegationEligible,
  promptSource,
  reachability,
  taskTemplateOverridden,
  variableDiagnostics,
} from "./template-diagnostics"

const tpl = (over: Partial<SubAgentTemplate> = {}): SubAgentTemplate => ({
  id: "t1",
  name: "T",
  description: "desc",
  category: "general",
  taskTemplate: "",
  config: {},
  ...over,
})

describe("promptSource", () => {
  it("prefers the system prompt — it outranks the task template", () => {
    expect(promptSource(tpl({ config: { systemPrompt: "sp" }, taskTemplate: "tt" }))).toBe(
      "systemPrompt"
    )
  })

  it("falls back to the task template, then the description", () => {
    expect(promptSource(tpl({ taskTemplate: "tt" }))).toBe("taskTemplate")
    expect(promptSource(tpl())).toBe("description")
  })
})

describe("taskTemplateOverridden", () => {
  it("flags authored work that will never run", () => {
    expect(
      taskTemplateOverridden(tpl({ config: { systemPrompt: "sp" }, taskTemplate: "tt" }))
    ).toBe(true)
  })

  it("stays quiet when only one of the two is set", () => {
    expect(taskTemplateOverridden(tpl({ taskTemplate: "tt" }))).toBe(false)
    expect(taskTemplateOverridden(tpl({ config: { systemPrompt: "sp" } }))).toBe(false)
  })

  it("ignores a whitespace-only task template", () => {
    expect(
      taskTemplateOverridden(tpl({ config: { systemPrompt: "sp" }, taskTemplate: "   \n " }))
    ).toBe(false)
  })
})

describe("extractPlaceholders", () => {
  it("pulls names out and de-duplicates them", () => {
    expect(extractPlaceholders("Hi {{name}}, meet {{name}} and {{other}}")).toEqual([
      "name",
      "other",
    ])
  })

  it("tolerates inner whitespace and dotted / dashed names", () => {
    expect(extractPlaceholders("{{ a.b-c }}")).toEqual(["a.b-c"])
  })

  it("returns nothing for an absent template", () => {
    expect(extractPlaceholders(undefined)).toEqual([])
    expect(extractPlaceholders("no placeholders here")).toEqual([])
  })
})

describe("variableDiagnostics", () => {
  it("reports placeholders with no declaration", () => {
    expect(
      variableDiagnostics("{{a}} {{b}}", [{ name: "a", description: "", required: false }])
    ).toEqual({ undeclared: ["b"], unused: [] })
  })

  it("reports declarations the template never references", () => {
    expect(
      variableDiagnostics("{{a}}", [
        { name: "a", description: "", required: false },
        { name: "z", description: "", required: false },
      ])
    ).toEqual({ undeclared: [], unused: ["z"] })
  })

  it("is clean when the two agree", () => {
    expect(
      variableDiagnostics("{{a}}", [{ name: " a ", description: "", required: false }])
    ).toEqual({ undeclared: [], unused: [] })
  })

  it("ignores blank declared names rather than reporting them as unused", () => {
    expect(variableDiagnostics("", [{ name: "  ", description: "", required: false }])).toEqual({
      undeclared: [],
      unused: [],
    })
  })
})

describe("nativeDelegationEligible", () => {
  it("is false once a provider or an external preset pins the runtime", () => {
    expect(nativeDelegationEligible({ provider: "openai" })).toBe(false)
    expect(nativeDelegationEligible({ externalPresetId: "claude-code" })).toBe(false)
    expect(nativeDelegationEligible({ model: "sonnet" })).toBe(true)
    expect(nativeDelegationEligible(undefined)).toBe(true)
  })
})

describe("reachability", () => {
  it("reports a disabled template as excluded everywhere", () => {
    expect(reachability(tpl({ disabled: true }))).toBe("disabled")
  })

  it("reports a built-in as a fork source — both resolvers skip isBuiltIn", () => {
    expect(reachability(tpl({ isBuiltIn: true }))).toBe("fork-only")
  })

  it("reports a provider-pinned template as dispatch-only", () => {
    expect(reachability(tpl({ config: { provider: "openai" } }))).toBe("dispatch-only")
  })

  it("reports an external-preset template as dispatch-only", () => {
    expect(reachability(tpl({ config: { externalPresetId: "codex" } }))).toBe("dispatch-only")
  })

  it("reports an ordinary user template as directly reachable", () => {
    expect(reachability(tpl())).toBe("direct")
  })

  it("puts disabled ahead of built-in", () => {
    expect(reachability(tpl({ isBuiltIn: true, disabled: true }))).toBe("disabled")
  })
})

describe("dispatchRailUnavailable", () => {
  it("warns only for dispatch-only templates while nesting is off", () => {
    expect(dispatchRailUnavailable("dispatch-only", { nestingEnabled: false })).toBe(true)
    expect(dispatchRailUnavailable("dispatch-only", { nestingEnabled: true })).toBe(false)
    expect(dispatchRailUnavailable("direct", { nestingEnabled: false })).toBe(false)
  })
})
