import {
  parseCouncilArgs,
  resolveCouncilRoster,
  executeCouncilCommand,
  type CouncilCommandDeps,
} from "./council"
import type { SlashContext } from "../builtin"

function makeCtx(args: string, chatStatus: SlashContext["chatStatus"] = "idle") {
  const messages: string[] = []
  const ctx = {
    args,
    chatStatus,
    activeSessionId: "s1",
    currentPermissionMode: null,
    startNewSession: () => {},
    openSettings: () => {},
    setPermissionMode: () => {},
    pushSystemMessage: (m: string) => messages.push(typeof m === "string" ? m : JSON.stringify(m)),
  } as unknown as SlashContext
  return { ctx, messages }
}

/** Councillors (no systemPrompt) echo; synthesizer (has systemPrompt) reports. */
function fakeDeps(aliases: string[]): CouncilCommandDeps {
  return {
    loadAliases: async () => aliases,
    runPrompt: async (input) =>
      input.systemPrompt
        ? {
            completion: "## Council Response\nX\n## Council Summary\nConfidence: majority",
            model: "synth",
          }
        : { completion: `from ${input.modelAlias}`, model: input.modelAlias },
  }
}

describe("parseCouncilArgs", () => {
  it("returns the prompt when no flags are present", () => {
    expect(parseCouncilArgs("how do we scale?")).toEqual({
      prompt: "how do we scale?",
      models: undefined,
      synth: undefined,
    })
  })

  it("extracts --models and --synth and leaves the prompt", () => {
    const p = parseCouncilArgs("--models fast,smart  pick a db --synth judge")
    expect(p.models).toEqual(["fast", "smart"])
    expect(p.synth).toBe("judge")
    expect(p.prompt).toBe("pick a db")
  })

  it("trims empty model entries", () => {
    expect(parseCouncilArgs("--models a,,b q").models).toEqual(["a", "b"])
  })
})

describe("resolveCouncilRoster", () => {
  it("uses explicit --models and a distinct synthesizer from available aliases", () => {
    const r = resolveCouncilRoster({ prompt: "q", models: ["a", "b"] }, ["a", "b", "c"])
    expect("councillors" in r && r.councillors.map((c) => c.modelAlias)).toEqual(["a", "b"])
    expect("councillors" in r && r.synthesizerAlias).toBe("c")
  })

  it("auto-selects councillors from configured aliases (capped at 3)", () => {
    const r = resolveCouncilRoster({ prompt: "q" }, ["a", "b", "c", "d"])
    expect("councillors" in r && r.councillors.length).toBe(3)
  })

  it("falls back to a councillor alias as synthesizer when none is distinct", () => {
    const r = resolveCouncilRoster({ prompt: "q", models: ["a"] }, ["a"])
    expect("councillors" in r && r.synthesizerAlias).toBe("a")
  })

  it("dedupes councillor aliases", () => {
    const r = resolveCouncilRoster({ prompt: "q", models: ["a", "a", "b"] }, [])
    expect("councillors" in r && r.councillors.map((c) => c.modelAlias)).toEqual(["a", "b"])
  })

  it("errors when there is nothing to convene", () => {
    const r = resolveCouncilRoster({ prompt: "q" }, [])
    expect("error" in r && r.error).toMatch(/No models to convene/)
  })
})

describe("executeCouncilCommand", () => {
  it("refuses to run mid-turn", async () => {
    const { ctx, messages } = makeCtx("q", "streaming")
    await executeCouncilCommand(ctx, fakeDeps(["a", "b"]))
    expect(messages[0]).toMatch(/turn is in progress/)
  })

  it("shows usage when no prompt is given", async () => {
    const { ctx, messages } = makeCtx("--models a,b")
    await executeCouncilCommand(ctx, fakeDeps(["a", "b"]))
    expect(messages[0]).toMatch(/Usage: `\/council/)
  })

  it("guides the user when no aliases are configured", async () => {
    const { ctx, messages } = makeCtx("pick a db")
    await executeCouncilCommand(ctx, fakeDeps([]))
    expect(messages[0]).toMatch(/No models to convene/)
  })

  it("convenes a council and posts the synthesized report", async () => {
    const { ctx, messages } = makeCtx("queue or outbox?")
    await executeCouncilCommand(ctx, fakeDeps(["fast", "smart", "judge"]))
    expect(messages[0]).toMatch(/Convening a council of 3/)
    expect(messages[1]).toMatch(/Council Response/)
    expect(messages[1]).toMatch(/councillors responded/)
  })

  it("reports a council failure gracefully", async () => {
    const deps: CouncilCommandDeps = {
      loadAliases: async () => ["a", "b"],
      runPrompt: async (input) => {
        if (input.systemPrompt) throw new Error("synth down")
        return { completion: "ok" }
      },
    }
    const { ctx, messages } = makeCtx("q")
    await executeCouncilCommand(ctx, deps)
    expect(messages[messages.length - 1]).toMatch(/Council failed: synth down/)
  })
})
