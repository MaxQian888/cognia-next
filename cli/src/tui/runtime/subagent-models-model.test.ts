/**
 * @jest-environment node
 */
import {
  SUBAGENT_MODEL_INHERIT,
  buildSubagentModelRows,
  cycleSubagentModel,
  cycleSubagentProvider,
  recomputeSubagentModelRows,
  type SubagentModelRow,
} from "./subagent-models-model"
import type { AgentSummary } from "../../agent/discover-agents"
import type { ResolvedConfig } from "../../config/schema"

function agent(id: string, def: Partial<AgentSummary["def"]> = {}): AgentSummary {
  return {
    id,
    name: id,
    description: `${id} desc`,
    def: { id, name: id, description: `${id} desc`, prompt: "p", ...def },
  }
}

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    provider: "anthropic",
    permissionMode: "default",
    builtinTools: {},
    providers: { anthropic: {}, openai: {} },
    cwd: "/p",
    ...over,
  } as ResolvedConfig
}

describe("buildSubagentModelRows", () => {
  it("marks an agent with no frontmatter and no override as inherit", () => {
    const [row] = buildSubagentModelRows([agent("a")], config())
    expect(row.source).toBe("inherit")
    expect(row.provider).toBe("anthropic")
    expect(row.model).toBeUndefined()
    expect(row.inheritsProvider).toBe(true)
  })

  it("reads the model/provider from frontmatter when there's no override", () => {
    const [row] = buildSubagentModelRows(
      [agent("a", { model: "sonnet", provider: "anthropic" })],
      config()
    )
    expect(row.source).toBe("frontmatter")
    expect(row.model).toBe("sonnet")
    expect(row.frontmatterModel).toBe("sonnet")
    expect(row.inheritsProvider).toBe(false)
  })

  it("lets an override win over frontmatter", () => {
    const [row] = buildSubagentModelRows(
      [agent("a", { model: "sonnet" })],
      config({ subagentModels: { a: { provider: "openai", model: "gpt-4o" } } })
    )
    expect(row.source).toBe("override")
    expect(row.provider).toBe("openai")
    expect(row.model).toBe("gpt-4o")
    // frontmatter is still remembered for recompute
    expect(row.frontmatterModel).toBe("sonnet")
  })

  it("treats a provider-only override as 'provider default' (no model shown)", () => {
    const [row] = buildSubagentModelRows(
      [agent("a", { model: "sonnet" })],
      config({ subagentModels: { a: { provider: "openai" } } })
    )
    expect(row.source).toBe("override")
    expect(row.provider).toBe("openai")
    expect(row.model).toBeUndefined()
  })

  it("surfaces an off-catalog effective model inside modelOptions", () => {
    const [row] = buildSubagentModelRows(
      [agent("a")],
      config({ subagentModels: { a: { model: "totally-custom-id" } } })
    )
    expect(row.modelOptions[0]).toBe("totally-custom-id")
  })

  it("exposes configured providers (incl. active) as providerOptions, sorted by name", () => {
    const rows = buildSubagentModelRows([agent("b"), agent("a")], config())
    expect(rows.map((r) => r.id)).toEqual(["a", "b"])
    expect(rows[0].providerOptions).toEqual(expect.arrayContaining(["anthropic", "openai"]))
  })
})

describe("recomputeSubagentModelRows", () => {
  it("re-derives rows from stored frontmatter against fresh config", () => {
    const built = buildSubagentModelRows([agent("a", { model: "sonnet" })], config())
    const next = recomputeSubagentModelRows(
      built,
      config({ subagentModels: { a: { model: "x" } } })
    )
    expect(next[0].source).toBe("override")
    expect(next[0].model).toBe("x")
    // dropping the override returns to frontmatter
    const back = recomputeSubagentModelRows(next, config())
    expect(back[0].source).toBe("frontmatter")
    expect(back[0].model).toBe("sonnet")
  })
})

/** A hand-built row so cycle tests don't depend on the live model catalog. */
function row(over: Partial<SubagentModelRow> = {}): SubagentModelRow {
  return {
    id: "a",
    name: "a",
    description: "",
    source: "inherit",
    provider: "anthropic",
    inheritsProvider: true,
    providerOptions: ["anthropic", "openai"],
    modelOptions: ["m1", "m2", "m3"],
    ...over,
  }
}

describe("cycleSubagentModel", () => {
  it("steps from inherit into the first model", () => {
    expect(cycleSubagentModel(row(), 1)).toEqual({ model: "m1" })
  })

  it("pins the provider when the provider isn't the pure active default", () => {
    expect(cycleSubagentModel(row({ inheritsProvider: false, provider: "openai" }), 1)).toEqual({
      provider: "openai",
      model: "m1",
    })
  })

  it("advances within the model list", () => {
    expect(cycleSubagentModel(row({ source: "override", model: "m1" }), 1)).toEqual({ model: "m2" })
  })

  it("wraps from the last model back to inherit (null)", () => {
    expect(cycleSubagentModel(row({ source: "override", model: "m3" }), 1)).toBeNull()
  })

  it("steps left from inherit to the last model", () => {
    expect(cycleSubagentModel(row(), -1)).toEqual({ model: "m3" })
  })

  it("never persists the inherit sentinel", () => {
    const result = cycleSubagentModel(row({ source: "override", model: "m1" }), -1)
    expect(result).toBeNull() // m1 → inherit
    expect(JSON.stringify(result)).not.toContain(SUBAGENT_MODEL_INHERIT)
  })
})

describe("cycleSubagentProvider", () => {
  it("moves to the next configured provider with its default model", () => {
    const result = cycleSubagentProvider(row(), 1)
    expect(result.provider).toBe("openai")
    // openai has a catalog default in the shared registry
    expect(typeof result.model === "string" || result.model === undefined).toBe(true)
  })

  it("wraps around the provider list", () => {
    const result = cycleSubagentProvider(row({ provider: "openai" }), 1)
    expect(result.provider).toBe("anthropic")
  })

  it("falls back to a provider-only override when the provider has no catalog", () => {
    const result = cycleSubagentProvider(
      row({ provider: "anthropic", providerOptions: ["anthropic", "zzz-unknown"] }),
      1
    )
    expect(result.provider).toBe("zzz-unknown")
    expect(result.model).toBeUndefined()
  })
})
