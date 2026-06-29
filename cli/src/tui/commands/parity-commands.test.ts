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

  it("/context routes through the runtime (so it can append the SDK breakdown)", () => {
    expect(find("context").handler!(ctx())).toEqual({
      kind: "runtime",
      runtime: { feature: "context", action: "run" },
    })
  })

  it("/compact emits a compact effect (path-agnostic) carrying any focus", () => {
    expect(find("compact").handler!(ctx(""))).toEqual({ kind: "compact", focus: undefined })
    expect(find("compact").handler!(ctx("the API changes", "deepseek"))).toEqual({
      kind: "compact",
      focus: "the API changes",
    })
  })

  it("/diff emits a gitDiff effect (App shells git diff)", () => {
    expect(find("diff").handler!(ctx())).toEqual({ kind: "gitDiff" })
    expect(find("diff").aliases).toContain("changes")
  })

  it("/export emits a run runtime request carrying the format arg", () => {
    expect(find("export").handler!(ctx("jsonl"))).toEqual({
      kind: "runtime",
      runtime: { feature: "export", action: "run", arg: "jsonl" },
    })
  })

  it("/resume opens the session picker (openSessions effect)", () => {
    expect(find("resume").handler!(ctx())).toEqual({ kind: "openSessions" })
  })

  it("/continue resumes the most recent session directly (resumeLast effect)", () => {
    expect(find("continue").handler!(ctx())).toEqual({ kind: "resumeLast" })
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

  it("/init subcommands route to their init actions", () => {
    const init = find("init")
    const sub = (name: string) => {
      const s = init.subcommands?.find((c) => c.name === name)
      if (!s) throw new Error(`missing /init subcommand ${name}`)
      return s.handler(ctx())
    }
    expect(sub("create")).toEqual({
      kind: "runtime",
      runtime: { feature: "init", action: "create" },
    })
    expect(sub("regenerate")).toEqual({
      kind: "runtime",
      runtime: { feature: "init", action: "create" },
    })
    expect(sub("rewrite")).toEqual({
      kind: "runtime",
      runtime: { feature: "init", action: "rewrite" },
    })
    expect(sub("optimize")).toEqual({
      kind: "runtime",
      runtime: { feature: "init", action: "rewrite" },
    })
    expect(sub("preview")).toEqual({
      kind: "runtime",
      runtime: { feature: "init", action: "preview" },
    })
    expect(sub("scaffold")).toEqual({
      kind: "runtime",
      runtime: { feature: "init", action: "scaffold" },
    })
    expect(sub("apply")).toEqual({ kind: "runtime", runtime: { feature: "init", action: "apply" } })
  })

  it("/permissions lists by default and routes its clear subcommand", () => {
    const cmd = find("permissions")
    expect(cmd.handler!(ctx())).toEqual({
      kind: "runtime",
      runtime: { feature: "permissions", action: "list" },
    })
    const clear = cmd.subcommands?.find((s) => s.name === "clear")
    expect(clear?.handler(ctx())).toEqual({
      kind: "runtime",
      runtime: { feature: "permissions", action: "clear" },
    })
    const remove = cmd.subcommands?.find((s) => s.name === "remove")
    expect(remove?.handler(ctx("Bash"))).toEqual({
      kind: "runtime",
      runtime: { feature: "permissions", action: "remove", arg: "Bash" },
    })
  })
})
