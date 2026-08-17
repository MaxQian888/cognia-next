/**
 * Built-in provider roster (ADR-0129). `registerBuiltinGlobalSearchProviders`
 * (re)registers every built-in by id — idempotent, so the dialog can call it
 * on mount and a plugin host earlier — and returns the ids it owns.
 */

import { registerGlobalSearchProvider } from "../registry"
import type { GlobalSearchProvider } from "../types"
import { actionsProvider } from "./actions"
import { pluginActionsProvider, workbenchPanelsProvider } from "./host"
import { issuesProvider } from "./issues"
import { memoriesProvider, skillsProvider, templatesProvider, workflowsProvider } from "./library"
import { createMessagesProvider, type MessagesProviderDeps } from "./messages"
import { navigationProvider } from "./navigation"
import { charactersProvider, teamsProvider } from "./people"
import { sessionsProvider } from "./sessions"
import { settingsProvider } from "./settings"
import {
  inboxProvider,
  mcpServersProvider,
  pluginsProvider,
  scheduledTasksProvider,
} from "./system"
import { workspacesProvider } from "./workspaces"

export interface BuiltinProviderOptions {
  /** Streaming / dirty rows the message engine should scan ahead of the index. */
  messages?: MessagesProviderDeps
}

/** Every built-in provider, in registration order. */
export function builtinGlobalSearchProviders(
  options: BuiltinProviderOptions = {}
): GlobalSearchProvider[] {
  return [
    actionsProvider,
    sessionsProvider,
    createMessagesProvider(options.messages),
    navigationProvider,
    settingsProvider,
    workbenchPanelsProvider,
    charactersProvider,
    teamsProvider,
    workspacesProvider,
    workflowsProvider,
    skillsProvider,
    memoriesProvider,
    templatesProvider,
    scheduledTasksProvider,
    pluginsProvider,
    pluginActionsProvider,
    mcpServersProvider,
    inboxProvider,
    issuesProvider,
  ]
}

/** Register (or refresh) the built-ins. Returns their ids. */
export function registerBuiltinGlobalSearchProviders(
  options: BuiltinProviderOptions = {}
): string[] {
  const providers = builtinGlobalSearchProviders(options)
  for (const provider of providers) registerGlobalSearchProvider(provider)
  return providers.map((p) => p.id)
}
