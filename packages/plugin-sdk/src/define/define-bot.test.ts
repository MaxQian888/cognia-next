import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { defineBot, defineBotHandler } from "./define-bot"

describe("defineBot", () => {
  it("returns the bot contribution unchanged", () => {
    // No `as const`: the helper is a `const` generic, so the literals are
    // already preserved, and a readonly tuple would no longer be assignable to
    // the manifest's mutable `triggers` array.
    const def: PluginBotDef = {
      id: "daily-digest",
      name: "Daily digest",
      version: "1.0.0",
      executor: "handler",
      entry: "./bots/digest.js",
      triggers: [{ id: "morning", kind: "schedule", cron: "0 9 * * 1-5" }],
    }

    expect(defineBot(def)).toBe(def)
  })

  it("keeps the executor and trigger discriminants literal", () => {
    const def = defineBot({
      id: "triage",
      name: "Triage",
      version: "0.1.0",
      executor: "workflow",
      workflow: "wf_triage",
      triggers: [{ id: "opened", kind: "event", source: "integration", types: ["issues.opened"] }],
    })

    // A widened `string` here would let workflow/team/prompt/entry coexist,
    // which is the whole point of the discriminated union.
    const executor: "workflow" = def.executor
    const kind: "event" = def.triggers[0].kind
    expect(executor).toBe("workflow")
    expect(kind).toBe("event")
  })
})

describe("defineBotHandler", () => {
  it("returns the handler unchanged", () => {
    const handler = async () => ({ summary: "ok" })
    expect(defineBotHandler(handler)).toBe(handler)
  })
})
