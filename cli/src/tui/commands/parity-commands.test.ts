import { PARITY_COMMANDS } from "./parity-commands"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { CommandContext, CommandDescriptor } from "./types"
import type { TuiState } from "../state/types"

function find(name: string): CommandDescriptor {
  const d = PARITY_COMMANDS.find((c) => c.name === name)
  if (!d) throw new Error(`missing descriptor ${name}`)
  return d
}

function ctx(args = "", provider = "anthropic"): CommandContext {
  const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", provider }
  return { state: { usage: undefined } as TuiState, config, version: "1.0.0", args }
}

describe("PARITY_COMMANDS", () => {
  it("has unique names and aliases with non-empty descriptions", () => {
    const seen = new Set<string>()
    for (const c of PARITY_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0)
      for (const id of [c.name, ...(c.aliases ?? [])]) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
  })

  it("/context emits a notice with the window report", () => {
    const effect = find("context").handler!(ctx())
    expect(effect.kind).toBe("notice")
    if (effect.kind === "notice") expect(effect.message).toContain("Context window")
  })

  it("/compact sends the template on Anthropic", () => {
    expect(find("compact").handler!(ctx(""))).toEqual({ kind: "send", prompt: "/compact" })
  })

  it("/export emits a run runtime request carrying the format arg", () => {
    expect(find("export").handler!(ctx("jsonl"))).toEqual({
      kind: "runtime",
      runtime: { feature: "export", action: "run", arg: "jsonl" },
    })
  })

  it("/resume emits the resumeLast effect", () => {
    expect(find("resume").handler!(ctx())).toEqual({ kind: "resumeLast" })
  })

  it("/doctor and /init emit their runtime requests", () => {
    expect(find("doctor").handler!(ctx())).toEqual({
      kind: "runtime",
      runtime: { feature: "doctor", action: "run" },
    })
    expect(find("init").handler!(ctx())).toEqual({
      kind: "runtime",
      runtime: { feature: "init", action: "run" },
    })
  })
})
