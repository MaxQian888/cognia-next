import {
  SLASH_COMMAND_TOOL_NAME,
  SLASH_BUILTIN_PLUGIN_ID,
  buildSlashCommandManifestEntries,
  isSlashCommandBuiltinTool,
  runSlashCommandBuiltinTool,
  type SlashToolRunDeps,
} from "./slash-builtin-tools"

describe("slash-builtin-tools", () => {
  it("builds a SlashCommand manifest entry, embedding available commands", () => {
    const entries = buildSlashCommandManifestEntries([
      { name: "status", description: "Show status" },
      { name: "deploy" },
    ])
    expect(entries).toHaveLength(1)
    const [e] = entries
    expect(e.name).toBe(SLASH_COMMAND_TOOL_NAME)
    expect(e.pluginId).toBe(SLASH_BUILTIN_PLUGIN_ID)
    expect(e.description).toMatch(/\/status: Show status/)
    expect(e.description).toMatch(/\/deploy/)
    // Honest limitation is stated.
    expect(e.description).toMatch(/chat composer/)
  })

  it("works with no command list", () => {
    const [e] = buildSlashCommandManifestEntries()
    expect(e.description).not.toMatch(/Available commands/)
  })

  it("identifies the SlashCommand tool name", () => {
    expect(isSlashCommandBuiltinTool(SLASH_COMMAND_TOOL_NAME)).toBe(true)
    expect(isSlashCommandBuiltinTool("Skill")).toBe(false)
  })

  it("dispatches a command and returns its message, adding the leading slash", async () => {
    const calls: string[] = []
    const deps: SlashToolRunDeps = {
      dispatch: async (line) => {
        calls.push(line)
        return { message: "done" }
      },
    }
    const out = await runSlashCommandBuiltinTool(
      SLASH_COMMAND_TOOL_NAME,
      { command: "status now" },
      deps,
      { sessionId: "s1" }
    )
    expect(out).toBe("done")
    expect(calls).toEqual(["/status now"])
  })

  it("serialises message + payload, and reports unknown commands", async () => {
    const both: SlashToolRunDeps = {
      dispatch: async () => ({ message: "ok", payload: { n: 1 } }),
    }
    const out = (await runSlashCommandBuiltinTool(
      SLASH_COMMAND_TOOL_NAME,
      { command: "/x" },
      both
    )) as string
    expect(out).toContain("ok")
    expect(out).toContain('"n": 1')

    const unknown: SlashToolRunDeps = { dispatch: async () => null }
    expect(
      await runSlashCommandBuiltinTool(SLASH_COMMAND_TOOL_NAME, { command: "/ghost" }, unknown)
    ).toMatch(/unknown slash command: \/ghost/)
  })

  it("returns errors for missing command, no dispatcher, and wrong tool", async () => {
    expect(await runSlashCommandBuiltinTool(SLASH_COMMAND_TOOL_NAME, {}, {})).toMatch(
      /requires a `command`/
    )
    expect(
      await runSlashCommandBuiltinTool(SLASH_COMMAND_TOOL_NAME, { command: "/x" }, {})
    ).toMatch(/not available/)
    expect(await runSlashCommandBuiltinTool("other", { command: "/x" }, {})).toMatch(
      /unknown slash tool/
    )
  })
})
