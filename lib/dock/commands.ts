/**
 * The dock's command surface.
 *
 * Every dock action is a command first and a chord second. That ordering
 * matters: only undo/redo ship bound, so for the rest the command *is* the
 * user-reachable path — the tab menu and the palette both dispatch through
 * here, and rebinding a chord in settings works because the chord was never
 * the thing holding the behaviour.
 *
 * The id set is closed. Nothing dispatches a dock command by an arbitrary
 * string, which is what keeps a layout or a preset from ever naming one.
 */

import {
  registerCommand,
  unregisterCommand,
  type CommandHandler,
} from "@/lib/plugin/commands/registry"

export const DOCK_COMMAND_IDS = [
  "dock.layout.undo",
  "dock.layout.redo",
  "dock.layout.reset",
  "dock.panel.close",
  "dock.panel.float",
  "dock.panel.popout",
  "dock.panel.redock",
  "dock.split.left",
  "dock.split.right",
  "dock.split.up",
  "dock.split.down",
] as const

export type DockCommandId = (typeof DOCK_COMMAND_IDS)[number]

export type DockSplitDirection = "left" | "right" | "up" | "down"

/**
 * What a host can actually do. A host that cannot serve an action omits it and
 * the command is simply not registered — better a missing entry in the palette
 * than one that silently does nothing.
 */
export interface DockCommandActions {
  undo?: () => void
  redo?: () => void
  reset?: () => void
  closeActive?: () => void
  floatActive?: () => void
  popoutActive?: () => void
  redockActive?: () => void
  splitActive?: (direction: DockSplitDirection) => void
}

const SPLIT_DIRECTIONS: Record<string, DockSplitDirection> = {
  "dock.split.left": "left",
  "dock.split.right": "right",
  "dock.split.up": "up",
  "dock.split.down": "down",
}

/** Map the closed id set onto whichever actions the host supplied. */
export function resolveDockCommandHandlers(
  actions: DockCommandActions
): Array<{ id: DockCommandId; handler: CommandHandler }> {
  const handlers: Array<{ id: DockCommandId; handler: CommandHandler }> = []
  const add = (id: DockCommandId, run: (() => void) | undefined) => {
    if (run) handlers.push({ id, handler: () => run() })
  }

  add("dock.layout.undo", actions.undo)
  add("dock.layout.redo", actions.redo)
  add("dock.layout.reset", actions.reset)
  add("dock.panel.close", actions.closeActive)
  add("dock.panel.float", actions.floatActive)
  add("dock.panel.popout", actions.popoutActive)
  add("dock.panel.redock", actions.redockActive)

  const split = actions.splitActive
  if (split) {
    for (const [id, direction] of Object.entries(SPLIT_DIRECTIONS)) {
      handlers.push({ id: id as DockCommandId, handler: () => split(direction) })
    }
  }

  return handlers
}

/**
 * Register the dock's commands. Returns a disposer that unregisters exactly
 * what it registered — a host unmounting must not strip another host's.
 */
export function registerDockCommands(actions: DockCommandActions): () => void {
  const handlers = resolveDockCommandHandlers(actions)
  for (const { id, handler } of handlers) {
    registerCommand({
      id,
      // The shortcut catalog owns the display label; the palette reads the
      // command's own title, so keep the two pointing at one string rather than
      // introducing a second, drifting copy here.
      title: id,
      category: "dock",
      pluginId: null,
      handler,
    })
  }
  return () => {
    for (const { id } of handlers) unregisterCommand(id)
  }
}

export function isDockCommandId(value: string): value is DockCommandId {
  return (DOCK_COMMAND_IDS as readonly string[]).includes(value)
}
