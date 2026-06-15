/**
 * `/keybind` — view and rebind the customizable keyboard chords.
 *
 *   /keybind                      open the action picker (reuses the select overlay)
 *   /keybind <action>             show the action's current binding + how to change it
 *   /keybind <action> <spec>      rebind it (e.g. `/keybind inspect ctrl+j`)
 *   /keybind <action> default     reset it to the built-in default
 *
 * Pure handler: returns a `keybind` effect the App persists via `setKeybindings`
 * and live-merges. The picker re-dispatches `/keybind <action>` through the
 * generic select overlay — no bespoke wiring (mirrors `/theme`).
 */
import {
  KEYBINDABLE_ACTIONS,
  KEYBINDING_LABELS,
  formatKeySpec,
  parseKeySpec,
  resolveKeybindings,
  type KeybindableAction,
} from "../input/keybindings"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function isAction(x: string): x is KeybindableAction {
  return (KEYBINDABLE_ACTIONS as readonly string[]).includes(x)
}

export function keybindHandler(ctx: CommandContext): CommandEffect {
  const bindings = resolveKeybindings(ctx.config.keybindings)
  const args = ctx.args.trim()
  if (!args) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Rebind a key",
        items: KEYBINDABLE_ACTIONS.map((a) => ({
          id: a,
          label: KEYBINDING_LABELS[a],
          hint: formatKeySpec(bindings[a]),
        })),
        index: 0,
        onSelectCommand: "keybind",
      },
    }
  }

  const [action, ...rest] = args.split(/\s+/)
  if (!isAction(action)) {
    return {
      kind: "notice",
      message: `Unknown action "${action}" — rebindable: ${KEYBINDABLE_ACTIONS.join(", ")}`,
    }
  }
  const spec = rest.join(" ").trim()
  if (!spec) {
    return {
      kind: "notice",
      message: `${KEYBINDING_LABELS[action]} = ${formatKeySpec(bindings[action])} · rebind with /keybind ${action} <key> (e.g. ctrl+j) · reset with /keybind ${action} default`,
    }
  }
  if (spec.toLowerCase() === "default" || spec.toLowerCase() === "reset") {
    // Empty spec = reset to the built-in default.
    return { kind: "keybind", action, spec: "" }
  }
  if (!parseKeySpec(spec)) {
    return {
      kind: "notice",
      message: `Invalid key "${spec}" — use ctrl/shift/alt + a single letter, e.g. ctrl+g`,
    }
  }
  return { kind: "keybind", action, spec }
}

export const KEYBIND_COMMANDS: CommandDescriptor[] = [
  {
    name: "keybind",
    aliases: ["keybinding", "keys"],
    description: "view and customize keyboard shortcuts",
    category: "config",
    argumentHint: "[<action> [<key> | default]]",
    handler: keybindHandler,
  },
]
