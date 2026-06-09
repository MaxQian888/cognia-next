import { defineGuardrail } from "./define-guardrail"
import type { PluginGuardrail } from "@/types/plugin/plugin-agent-guardrails"

describe("defineGuardrail", () => {
  it("returns the guardrail unchanged (identity pass-through)", () => {
    const g: PluginGuardrail = {
      id: "no-secrets",
      type: "output",
      run: () => ({ tripwireTriggered: false }),
    }
    expect(defineGuardrail(g)).toBe(g)
  })

  it("preserves an input guardrail's run result", async () => {
    const g = defineGuardrail({
      id: "len",
      type: "input",
      run: ({ prompt }) => ({ tripwireTriggered: prompt.length > 10 }),
    })
    expect(await g.run({ prompt: "short" } as never)).toEqual({ tripwireTriggered: false })
  })
})
