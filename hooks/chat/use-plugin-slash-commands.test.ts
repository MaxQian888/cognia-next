/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { usePluginSlashCommands } from "./use-plugin-slash-commands"
import {
  registerSlashCommand,
  unregisterSlashCommand,
  __resetSlashCommandsForTesting,
} from "@/lib/slash-commands/registry"

afterEach(() => {
  __resetSlashCommandsForTesting()
})

describe("usePluginSlashCommands", () => {
  it("returns registered plugin commands as composer SlashCommands", () => {
    act(() => {
      registerSlashCommand({
        id: "demo.run",
        name: "Run",
        description: "Run it",
        source: "plugin",
        handler: () => ({}),
      })
    })
    const { result } = renderHook(() => usePluginSlashCommands())
    // The projected `name` is the token the user types, which prefers the
    // declared (single-word) name over the id — see
    // `lib/slash-commands/plugin-commands.ts:slashCommandToken`.
    expect(result.current).toEqual([
      expect.objectContaining({ name: "Run", scope: "plugin", description: "Run it" }),
    ])
  })

  it("re-renders when a plugin command is added / removed", () => {
    const { result } = renderHook(() => usePluginSlashCommands())
    expect(result.current).toHaveLength(0)

    act(() => {
      registerSlashCommand({ id: "a.cmd", name: "A", source: "plugin", handler: () => ({}) })
    })
    expect(result.current.map((c) => c.name)).toEqual(["A"])

    act(() => {
      unregisterSlashCommand("a.cmd")
    })
    expect(result.current).toHaveLength(0)
  })
})
