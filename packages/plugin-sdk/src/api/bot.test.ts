import * as sdk from "./bot"
import type {
  BotHandlerV1,
  BotRunContextV1,
  BotRunSnapshotV1,
  PluginBotDef,
  PluginBotTriggerDef,
} from "./bot"

describe("plugin-sdk api/bot", () => {
  it("exposes the authoring helpers and the discriminant lists", () => {
    expect(typeof sdk.defineBot).toBe("function")
    expect(typeof sdk.defineBotHandler).toBe("function")
    expect(sdk.PLUGIN_BOT_EXECUTORS).toEqual(["workflow", "squad", "agent-turn", "handler"])
    expect(sdk.PLUGIN_BOT_TRIGGER_KINDS).toEqual([
      "interaction",
      "event",
      "schedule",
      "poll",
      "derivedState",
      "manual",
    ])
  })

  it("registers nothing, because a Bot is declared and not called in", () => {
    // A `register*` here would exist for TypeScript authors and not for Python
    // ones, since a callback cannot cross the stdio boundary. Keep it absent.
    const surface = sdk as unknown as Record<string, unknown>
    expect(surface.registerBot).toBeUndefined()
    expect(surface.unregisterBotsByPlugin).toBeUndefined()
    expect(surface.listBotEntries).toBeUndefined()
  })

  it("re-exports the manifest and runtime contract types", () => {
    const assertTypes = <
      _T extends
        PluginBotDef | PluginBotTriggerDef | BotHandlerV1 | BotRunContextV1 | BotRunSnapshotV1,
    >(): void => undefined
    assertTypes<PluginBotDef>()
    expect(true).toBe(true)
  })
})
