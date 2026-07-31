import { LOG_COMMANDS } from "./log-commands"

describe("LOG_COMMANDS", () => {
  it("registers /logs as a runtime effect on the log panel", () => {
    const logs = LOG_COMMANDS.find((c) => c.name === "logs")
    if (!logs?.handler) throw new Error("/logs is not registered with a handler")
    expect(logs.category).toBe("system")
    expect(logs.handler({ args: "" } as never)).toEqual({
      kind: "runtime",
      runtime: { feature: "logs", action: "panel" },
    })
  })
})
