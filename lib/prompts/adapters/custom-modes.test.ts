/** @jest-environment jsdom */

import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { Plugin } from "@/types/plugin"
import { resourceKey } from "../resources"
import { customModePromptAdapter } from "./custom-modes"

const WORK_MODE = {
  id: "work-plugin:work",
  type: "custom" as const,
  name: "Work",
  description: "Own a task end to end.",
  icon: "BriefcaseBusiness",
  systemPrompt: "You are in WORK MODE.",
  tools: ["work_create_deliverable"],
  outputFormat: "markdown" as const,
  previewEnabled: true,
  permissionMode: "acceptEdits" as const,
}

function contribute(status: Plugin["status"]) {
  usePluginStore.setState({
    plugins: {
      "work-plugin": { status, modes: [WORK_MODE] } as unknown as Plugin,
    },
  })
}

beforeEach(() => {
  useCustomModeStore.setState({ customModes: {} })
  usePluginStore.setState({ plugins: {} })
})

const keyOf = (id: string) => resourceKey("custom-mode", id)

describe("customModePromptAdapter", () => {
  it("lists the user's and plugins' modes by name", async () => {
    const { createMode } = useCustomModeStore.getState()
    const plugin = createMode({
      name: "Zed",
      systemPrompt: "Plugin.",
      source: "plugin",
      pluginId: "p",
    })
    const mine = createMode({ name: "Alpha", systemPrompt: "Mine.", description: "d" })
    const listed = await customModePromptAdapter.list({})
    expect(listed.map((entry) => entry.key)).toEqual([keyOf(mine.id), keyOf(plugin.id)])
    expect(listed[0]).toMatchObject({
      kind: "role",
      operation: "append-rules",
      edit: "source",
      detail: "d",
      ownerSection: "agent-modes",
    })
    expect(listed[1]).toMatchObject({ builtIn: true, edit: "custom-copy" })
  })

  it("saves only the prompt of the user's own mode", async () => {
    const mine = useCustomModeStore
      .getState()
      .createMode({ name: "Mine", systemPrompt: "Old.", tools: ["read_file"] })
    const saved = await customModePromptAdapter.save!(keyOf(mine.id), "New.", undefined, {})
    expect(saved).toEqual({ key: keyOf(mine.id), text: "New." })
    const stored = useCustomModeStore.getState().customModes[mine.id]
    expect(stored.systemPrompt).toBe("New.")
    expect(stored.tools).toEqual(["read_file"])
  })

  it("refuses a plugin mode and copies it into a user mode instead", async () => {
    const plugin = useCustomModeStore
      .getState()
      .createMode({ name: "Plugin", systemPrompt: "Plugin.", source: "plugin", pluginId: "p" })
    await expect(
      customModePromptAdapter.save!(keyOf(plugin.id), "x", undefined, {})
    ).rejects.toThrow("plugin")
    expect((await customModePromptAdapter.read(keyOf(plugin.id), {}))?.readOnlyReason).toBe(
      "plugin"
    )

    const copyKey = await customModePromptAdapter.saveCustom!(
      keyOf(plugin.id),
      "Copy.",
      {},
      {
        name: "My copy",
      }
    )
    const copy = useCustomModeStore.getState().customModes[copyKey.slice("custom-mode:".length)]
    expect(copy).toMatchObject({ name: "My copy", systemPrompt: "Copy.", source: "user" })
    expect(copy.pluginId).toBeUndefined()
    expect(useCustomModeStore.getState().customModes[plugin.id].systemPrompt).toBe("Plugin.")
  })

  it("lists an enabled plugin's contributed mode and copies it with its settings", async () => {
    contribute("enabled")
    const key = keyOf(WORK_MODE.id)
    const listed = await customModePromptAdapter.list({})
    expect(listed).toEqual([
      expect.objectContaining({ key, name: "Work", builtIn: true, edit: "custom-copy" }),
    ])
    expect(await customModePromptAdapter.read(key, {})).toEqual({
      key,
      text: "You are in WORK MODE.",
      readOnlyReason: "plugin",
    })
    await expect(customModePromptAdapter.save!(key, "x", undefined, {})).rejects.toThrow("plugin")

    const copyKey = await customModePromptAdapter.saveCustom!(key, "My work rules.", {})
    const copy = useCustomModeStore.getState().customModes[copyKey.slice("custom-mode:".length)]
    expect(copy).toMatchObject({
      name: "Work",
      systemPrompt: "My work rules.",
      tools: ["work_create_deliverable"],
      outputFormat: "markdown",
      previewEnabled: true,
      permissionMode: "acceptEdits",
      source: "user",
    })
    expect(copy.pluginId).toBeUndefined()
  })

  it("drops a disabled plugin's mode, as every picker does", async () => {
    contribute("disabled")
    expect(await customModePromptAdapter.list({})).toEqual([])
    expect(await customModePromptAdapter.read(keyOf(WORK_MODE.id), {})).toBeUndefined()
  })

  it("reads a missing mode as absent and refuses to save or copy it", async () => {
    expect(await customModePromptAdapter.read(keyOf("gone"), {})).toBeUndefined()
    await expect(customModePromptAdapter.save!(keyOf("gone"), "x", undefined, {})).rejects.toThrow(
      "not found"
    )
    await expect(customModePromptAdapter.saveCustom!(keyOf("gone"), "x", {})).rejects.toThrow(
      "not found"
    )
    await expect(customModePromptAdapter.read("preset:x", {})).rejects.toThrow("not a custom mode")
  })
})
