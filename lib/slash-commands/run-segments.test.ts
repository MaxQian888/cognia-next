import { runSegments } from "./run-segments"
import { parseSegments } from "./parse-segments"
import type { SlashCommand } from "./builtin"

function cmd(partial: Partial<SlashCommand> & { name: string }): SlashCommand {
  return { description: "", scope: "builtin", ...partial }
}

const applyTemplate = (template: string, args: string): string =>
  template.replace(/\$ARGUMENTS/g, args.trim())

/**
 * Build a deps bundle. `runAction` mimics the composer's `handleSlashCommand`:
 * it invokes the command's handler with a minimal context (here just the args).
 */
function makeDeps(commands: SlashCommand[], onAction?: (name: string, args: string) => void) {
  const commandMap = new Map(commands.map((c) => [c.name, c]))
  const runAction = async (command: SlashCommand, args: string): Promise<void> => {
    onAction?.(command.name, args)
    await command.handler?.({ args } as never)
  }
  return { commandMap, runAction, applyTemplate }
}

const run = (input: string, deps: ReturnType<typeof makeDeps>) =>
  runSegments(
    parseSegments(input, (n) => deps.commandMap.has(n)),
    deps
  )

describe("runSegments", () => {
  it("passes plain prose straight through as outgoingText", async () => {
    const deps = makeDeps([])
    const res = await run("just a normal message", deps)
    expect(res.outgoingText).toBe("just a normal message")
    expect(res.ranAction).toBe(false)
    expect(res.overrides).toBeNull()
    expect(res.errors).toEqual([])
  })

  it("runs action handlers in source order with per-segment args", async () => {
    const calls: string[] = []
    const order: string[] = []
    const a = cmd({ name: "alpha", handler: () => void calls.push("alpha") })
    const b = cmd({ name: "beta", handler: () => void calls.push("beta") })
    const deps = makeDeps([a, b], (_name, args) => order.push(args))
    const res = await run("/beta x\n/alpha y", deps)
    expect(calls).toEqual(["beta", "alpha"])
    expect(order).toEqual(["x", "y"])
    expect(res.ranAction).toBe(true)
    // action-only batch with no prose → nothing to send
    expect(res.outgoingText).toBe("")
  })

  it("expands templates and concatenates them with prose in order", async () => {
    const review = cmd({ name: "review", template: "Please review: $ARGUMENTS" })
    const deps = makeDeps([review])
    const res = await run("/review auth flow\nand check error handling", deps)
    expect(res.outgoingText).toBe("Please review: auth flow\n\nand check error handling")
  })

  it("unions allowedTools/paths across templates and takes model last-wins", async () => {
    const c1 = cmd({
      name: "one",
      template: "A",
      model: "model-1",
      allowedTools: ["Read"],
      paths: ["/p1"],
    })
    const c2 = cmd({
      name: "two",
      template: "B",
      model: "model-2",
      allowedTools: ["Read", "Write"],
      paths: ["/p2"],
    })
    const deps = makeDeps([c1, c2])
    const res = await run("/one\n/two", deps)
    expect(res.overrides?.model).toBe("model-2")
    expect(res.overrides?.allowedTools?.sort()).toEqual(["Read", "Write"])
    expect(res.overrides?.paths?.sort()).toEqual(["/p1", "/p2"])
    expect(res.outgoingText).toBe("A\n\nB")
  })

  it("isolates a failing action command and continues the rest", async () => {
    const boom = cmd({
      name: "boom",
      handler: () => {
        throw new Error("kaboom")
      },
    })
    const ok = cmd({ name: "ok", handler: () => {} })
    const deps = makeDeps([boom, ok])
    const res = await run("/boom\n/ok\nstill here", deps)
    expect(res.errors).toEqual([{ name: "boom", message: "kaboom" }])
    expect(res.outgoingText).toBe("still here")
    expect(res.ranAction).toBe(true)
  })

  it("builds partial overrides with only allowedTools (model/paths absent)", async () => {
    const c = cmd({ name: "tools", template: "T", allowedTools: ["Read"] })
    const deps = makeDeps([c])
    const res = await run("/tools", deps)
    expect(res.overrides).toEqual({ model: undefined, allowedTools: ["Read"], paths: undefined })
  })

  it("returns null overrides when no template contributes any", async () => {
    const t = cmd({ name: "plain", template: "hi" })
    const deps = makeDeps([t])
    const res = await run("/plain", deps)
    expect(res.overrides).toBeNull()
    expect(res.outgoingText).toBe("hi")
  })

  it("keeps an unknown command's raw text when the map lacks it (defensive)", async () => {
    const deps = makeDeps([])
    const segs = [
      { kind: "command" as const, name: "ghost", args: "x", raw: "/ghost x", start: 0, end: 8 },
    ]
    const res = await runSegments(segs, deps)
    expect(res.outgoingText).toBe("/ghost x")
  })

  it("treats a command with neither handler nor template as raw text", async () => {
    const bare = cmd({ name: "bare" })
    const deps = makeDeps([bare])
    const res = await run("/bare hi there", deps)
    expect(res.outgoingText).toBe("/bare hi there")
  })

  it("skips whitespace-only text segments between commands", async () => {
    const tmpl = cmd({ name: "t", template: "X" })
    const deps = makeDeps([tmpl])
    const res = await run("/t\n   \n/t", deps)
    expect(res.outgoingText).toBe("X\n\nX")
  })

  it("awaits async action handlers before resolving", async () => {
    let done = false
    const slow = cmd({
      name: "slow",
      handler: async () => {
        await Promise.resolve()
        done = true
      },
    })
    const deps = makeDeps([slow])
    await run("/slow", deps)
    expect(done).toBe(true)
  })
})
