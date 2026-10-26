/**
 * Host dispatch seam for the registries the plugin contract owns.
 *
 * Quick actions and tray items can name a slash line, one of their plugin's
 * manifest `commands[]`, or an accelerator. All three are served by host
 * subsystems (the slash-command registry with its lazy plugin activation,
 * the plugin store, the shortcut rail) that the contract cannot import. The
 * host installs the real dispatcher once
 * (`lib/plugin/core/install-plugin-host-dispatch.ts`, called where the plugin
 * store is created); the contract registries call through this port.
 *
 * Unbound (no host, e.g. an SDK unit test) the default dispatcher is inert by
 * design: a slash target throws `PluginHostDispatchUnavailableError`, a
 * manifest-command lookup finds nothing, and an accelerator bind rejects with
 * the same error, which the quick-action registry already logs and drops.
 * Pinned by `plugin-host-dispatch.test.ts`.
 */

import type { ShortcutOptions } from "../../../types/plugin"
import type { SlashCommandContext, SlashCommandResult } from "../../slash-commands/registry"

/** A plugin's manifest command, as the host's plugin store holds it. */
export interface PluginManifestCommandHandle {
  id: string
  execute: () => void | Promise<void>
}

/** Arguments for binding an accelerator onto the host shortcut rail. */
export interface PluginShortcutBindRequest {
  pluginId: string
  /** Chord string, e.g. `"Ctrl+Shift+Y"`. The host normalises it. */
  chord: string
  /** Handler; ignored when `existingCommandId` is provided. */
  run?: () => void
  /** Dispatch through an already-registered command instead of a wrapper. */
  existingCommandId?: string
  options?: ShortcutOptions
}

export interface PluginHostDispatch {
  /** Run a slash line (`/id args`) through the host slash registry. */
  dispatchSlashCommand(line: string, ctx?: SlashCommandContext): Promise<SlashCommandResult | null>
  /** Look up one of `pluginId`'s manifest `commands[]` entries. */
  findManifestCommand(
    pluginId: string,
    commandId: string
  ): Promise<PluginManifestCommandHandle | undefined>
  /** Bind an accelerator; resolves to its disposer. */
  bindPluginShortcut(request: PluginShortcutBindRequest): Promise<() => void>
}

/** Thrown by the unbound dispatcher: no host installed a real one. */
export class PluginHostDispatchUnavailableError extends Error {
  constructor(operation: string) {
    super(`plugin host dispatch is not installed: cannot ${operation} outside the Cognia host`)
    this.name = "PluginHostDispatchUnavailableError"
  }
}

const UNBOUND_DISPATCH: PluginHostDispatch = {
  dispatchSlashCommand: async () => {
    throw new PluginHostDispatchUnavailableError("dispatch a slash command")
  },
  findManifestCommand: async () => undefined,
  bindPluginShortcut: async () => {
    throw new PluginHostDispatchUnavailableError("bind a shortcut")
  },
}

let hostDispatch: PluginHostDispatch = UNBOUND_DISPATCH

/** Host seam: install the dispatcher. Passing `null` restores the inert default. */
export function installPluginHostDispatch(dispatch: PluginHostDispatch | null): void {
  hostDispatch = dispatch ?? UNBOUND_DISPATCH
}

/** The dispatcher the contract registries call through. */
export function getPluginHostDispatch(): PluginHostDispatch {
  return hostDispatch
}

/** Whether a host has installed a dispatcher. */
export function isPluginHostDispatchInstalled(): boolean {
  return hostDispatch !== UNBOUND_DISPATCH
}
