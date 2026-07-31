/** @jest-environment node */
import path from "node:path"

import { loadHooks, mergeHookConfigs, type FileReader } from "./load-hooks"
import type { HooksConfig } from "./types"

describe("mergeHookConfigs", () => {
  it("concatenates cognia groups before claude groups per event", () => {
    const cognia: HooksConfig = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a" }] }],
    }
    const claude: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "b" }] }],
      Stop: [{ hooks: [{ type: "command", command: "c" }] }],
    }
    const merged = mergeHookConfigs(cognia, claude)
    expect(merged.PreToolUse).toHaveLength(2)
    expect((merged.PreToolUse?.[0].hooks[0] as { command: string }).command).toBe("a")
    expect((merged.PreToolUse?.[1].hooks[0] as { command: string }).command).toBe("b")
    expect(merged.Stop).toHaveLength(1)
  })

  it("tolerates undefined sources", () => {
    expect(mergeHookConfigs(undefined, undefined)).toEqual({})
    expect(mergeHookConfigs({ Stop: [{ hooks: [] }] }, undefined).Stop).toHaveLength(1)
    expect(mergeHookConfigs(undefined, { Stop: [{ hooks: [] }] }).Stop).toHaveLength(1)
  })

  it("omits events with no groups", () => {
    expect(mergeHookConfigs({}, {})).toEqual({})
  })
})

describe("loadHooks", () => {
  const home = "/home/.cognia"
  const claudeHome = "/home/.claude"
  const coniaPath = path.join(home, "config.json")
  const claudePath = path.join(claudeHome, "settings.json")

  function reader(files: Record<string, string | null>): FileReader {
    return (p) => (p in files ? files[p] : null)
  }

  it("reads + validates + merges both files", () => {
    const files = {
      [coniaPath]: JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
        },
      }),
      [claudePath]: JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "claude-guard" }] }] },
      }),
    }
    const merged = loadHooks({ home, claudeHome, readFile: reader(files) })
    expect(merged.PreToolUse).toHaveLength(2)
    expect((merged.PreToolUse?.[0].hooks[0] as { command: string }).command).toBe("guard")
    expect((merged.PreToolUse?.[1].hooks[0] as { command: string }).command).toBe("claude-guard")
  })

  it("excludes fleet-managed Claude hook groups while preserving user hooks", () => {
    const files = {
      [claudePath]: JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: '"/home/.cognia/agent-monitor/claude-hook.sh" SessionStart fire',
                },
              ],
            },
            { hooks: [{ type: "command", command: "notify-user-hook" }] },
          ],
        },
      }),
    }

    const loaded = loadHooks({ home, claudeHome, readFile: reader(files) })
    expect(loaded.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "notify-user-hook" }] },
    ])
  })

  it("returns {} when neither file exists", () => {
    expect(loadHooks({ home, claudeHome, readFile: () => null })).toEqual({})
  })

  it("ignores a file with no hooks key", () => {
    const files = { [coniaPath]: JSON.stringify({ other: 1 }) }
    expect(loadHooks({ home, claudeHome, readFile: reader(files) })).toEqual({})
  })

  it("falls back to {} on invalid JSON", () => {
    const files = { [claudePath]: "{ not json" }
    expect(loadHooks({ home, claudeHome, readFile: reader(files) })).toEqual({})
  })

  it("falls back to {} when the hooks block fails validation", () => {
    const files = { [claudePath]: JSON.stringify({ hooks: { PreToolUse: "nope" } }) }
    expect(loadHooks({ home, claudeHome, readFile: reader(files) })).toEqual({})
  })

  it("tolerates a throwing reader", () => {
    const readFile: FileReader = () => {
      throw new Error("EACCES")
    }
    expect(loadHooks({ home, claudeHome, readFile })).toEqual({})
  })
})
