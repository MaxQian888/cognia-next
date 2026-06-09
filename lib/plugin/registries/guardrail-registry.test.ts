import {
  registerGuardrail,
  unregisterGuardrailById,
  unregisterGuardrailsByPlugin,
  getGuardrail,
  listGuardrailIds,
  listGuardrailEntries,
  __resetGuardrailsForTesting,
} from "./guardrail-registry"
import type { PluginGuardrail } from "@/types/plugin/plugin-agent-guardrails"

const g = (id: string): PluginGuardrail => ({
  id,
  type: "input",
  run: () => ({ tripwireTriggered: false }),
})

beforeEach(() => __resetGuardrailsForTesting())

describe("guardrail-registry", () => {
  it("registers and resolves a guardrail by id", () => {
    registerGuardrail("a", g("a"), { pluginId: "p1" })
    expect(getGuardrail("a")?.id).toBe("a")
    expect(listGuardrailIds()).toEqual(["a"])
  })

  it("unregisters a single guardrail by id", () => {
    registerGuardrail("a", g("a"))
    expect(unregisterGuardrailById("a")).toBe(true)
    expect(getGuardrail("a")).toBeUndefined()
  })

  it("bulk-drops every guardrail for a plugin", () => {
    registerGuardrail("a", g("a"), { pluginId: "p1" })
    registerGuardrail("b", g("b"), { pluginId: "p1" })
    registerGuardrail("c", g("c"), { pluginId: "p2" })
    expect(unregisterGuardrailsByPlugin("p1")).toBe(2)
    expect(listGuardrailIds()).toEqual(["c"])
  })

  it("tags entries with their owning plugin", () => {
    registerGuardrail("a", g("a"), { pluginId: "p9" })
    expect(listGuardrailEntries()[0]).toMatchObject({ id: "a", pluginId: "p9" })
  })
})
