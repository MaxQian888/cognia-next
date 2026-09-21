/** `defineCommandHooks` is a typesafety pass-through for `manifest.commandHooks`. */

import type { HooksConfig } from "@/lib/claude/hooks"

import { defineCommandHooks } from "./define-command-hooks"

describe("defineCommandHooks", () => {
  it("returns the same object reference passed in", () => {
    const config: HooksConfig = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node ${COGNIA_PLUGIN_ROOT}/guard.mjs" }],
        },
      ],
    }

    expect(defineCommandHooks(config)).toBe(config)
  })

  it("preserves every handler field a runner honours", () => {
    const config: HooksConfig = {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "node ${COGNIA_PLUGIN_ROOT}/boot.mjs",
              timeout: 5,
              async: true,
            },
            { type: "http", url: "https://example.test/hook", headers: { a: "b" } },
          ],
          agents: "chat",
        },
      ],
    }

    const result = defineCommandHooks(config)

    expect(result.SessionStart?.[0]?.hooks).toHaveLength(2)
    expect(result.SessionStart?.[0]?.agents).toBe("chat")
  })
})
