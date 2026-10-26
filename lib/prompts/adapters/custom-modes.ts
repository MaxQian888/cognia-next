/**
 * Custom and plugin agent modes as Prompt Center resources (ADR-0236 §5.1).
 *
 * A mode's prompt is the mode section a turn appends; the mode's tools,
 * permission and output format are not text and stay with the mode, so this
 * adapter only ever writes `systemPrompt`. Built-in modes are code-owned slots
 * (`agent.mode.<id>`) and are not listed here.
 *
 * A mode an enabled plugin contributes lives in the plugin store, the same
 * place `resolveActiveAgentMode` finds it, under its `<pluginId>:<id>` id. It
 * is owned by its plugin and is changed through a custom copy that keeps its
 * tools, permission and output format; a disabled plugin's mode is gone from
 * the list, as it is from every picker. Rows the custom-mode store tags
 * `source: "plugin"` are treated the same way.
 */

import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceSummary,
} from "../resources"

function idOf(key: string): string {
  const { source, id } = parseResourceKey(key)
  if (source !== "custom-mode" || !id) throw new Error(`not a custom mode resource: ${key}`)
  return id
}

interface ModeRecord {
  mode: AgentModeConfig
  pluginOwned: boolean
}

function modeOf(id: string): ModeRecord | undefined {
  const custom = useCustomModeStore.getState().customModes[id]
  if (custom) return { mode: custom, pluginOwned: custom.source === "plugin" }
  const contributed = usePluginStore
    .getState()
    .getAllModes()
    .find((mode) => mode.id === id)
  return contributed ? { mode: contributed, pluginOwned: true } : undefined
}

function allModes(): ModeRecord[] {
  const custom = Object.values(useCustomModeStore.getState().customModes)
  const records: ModeRecord[] = custom.map((mode) => ({
    mode,
    pluginOwned: mode.source === "plugin",
  }))
  const seen = new Set(custom.map((mode) => mode.id))
  for (const mode of usePluginStore.getState().getAllModes()) {
    if (!seen.has(mode.id)) records.push({ mode, pluginOwned: true })
  }
  return records
}

export const customModePromptAdapter: OwnerPromptAdapter = {
  source: "custom-mode",

  async list() {
    return allModes()
      .sort((a, b) => a.mode.name.localeCompare(b.mode.name))
      .map(({ mode, pluginOwned }): PromptResourceSummary => ({
        key: resourceKey("custom-mode", mode.id),
        source: "custom-mode",
        kind: "role",
        operation: "append-rules",
        name: mode.name,
        builtIn: pluginOwned,
        modified: false,
        edit: pluginOwned ? "custom-copy" : "source",
        ownerSection: "agent-modes",
        ...(mode.description ? { detail: mode.description } : {}),
      }))
  },

  async read(key) {
    const record = modeOf(idOf(key))
    if (!record) return undefined
    return {
      key,
      text: record.mode.systemPrompt ?? "",
      ...(record.pluginOwned ? { readOnlyReason: "plugin" as const } : {}),
    }
  },

  async save(key, text) {
    const id = idOf(key)
    const record = modeOf(id)
    if (!record) throw new Error(`Mode ${id} not found`)
    if (record.pluginOwned) throw new Error(`Mode ${id} belongs to a plugin; edit a copy of it.`)
    useCustomModeStore.getState().updateMode(id, { systemPrompt: text })
    return (await customModePromptAdapter.read(key, {}))!
  },

  async saveCustom(key, text, _ctx, options = {}) {
    const id = idOf(key)
    const store = useCustomModeStore.getState()
    const record = modeOf(id)
    if (!record) throw new Error(`Mode ${id} not found`)
    // A stored row is duplicated with everything it carries; a contributed
    // mode is copied field by field. `createMode` builds an explicit shape
    // without the permission, so it is set with the text below.
    const copy = store.customModes[id]
      ? store.duplicateMode(id)
      : store.createMode({
          name: record.mode.name,
          description: record.mode.description,
          icon: record.mode.icon,
          tools: record.mode.tools,
          outputFormat: record.mode.outputFormat,
          previewEnabled: record.mode.previewEnabled,
          customConfig: record.mode.customConfig,
        })
    if (!copy) throw new Error(`Mode ${id} not found`)
    // The copy is the user's own, whatever the original's origin was.
    store.updateMode(copy.id, {
      systemPrompt: text,
      source: "user",
      pluginId: undefined,
      ...(record.mode.permissionMode ? { permissionMode: record.mode.permissionMode } : {}),
      ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    })
    return resourceKey("custom-mode", copy.id)
  },
}
