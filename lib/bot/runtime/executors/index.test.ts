import { PLUGIN_BOT_EXECUTORS } from "@/types/plugin/plugin-bot"

import { BOT_EXECUTORS } from "./index"

describe("BOT_EXECUTORS", () => {
  it("has exactly one runner per declared executor", () => {
    // Exhaustive by type, and pinned here too: a new executor that can be
    // declared but not run is a Bot that installs and then does nothing.
    expect(Object.keys(BOT_EXECUTORS).sort()).toEqual([...PLUGIN_BOT_EXECUTORS].sort())
    for (const executor of PLUGIN_BOT_EXECUTORS) {
      expect(typeof BOT_EXECUTORS[executor]).toBe("function")
    }
  })
})
