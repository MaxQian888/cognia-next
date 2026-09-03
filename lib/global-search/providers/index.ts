/**
 * Built-in provider roster (ADR-0129). `registerBuiltinGlobalSearchProviders`
 * (re)registers every built-in by id — idempotent, so the dialog can call it
 * on mount and a plugin host earlier — and returns the ids it owns.
 */

import { registerGlobalSearchProvider } from "../registry"
import type { GlobalSearchProvider } from "../types"
import { actionsProvider } from "./actions"
import { devicesProvider } from "./devices"
import { gitBranchesProvider, gitWorktreesProvider } from "./git"
import { sitesProvider } from "./sites"
import { squadsProvider } from "./squads"
import { pluginActionsProvider, workbenchPanelsProvider } from "./host"
import { inboxContactsProvider, inboxProvider } from "./inbox"
import { issuesProvider } from "./issues"
import { memoriesProvider, skillsProvider, templatesProvider, workflowsProvider } from "./library"
import { createMessagesProvider, type MessagesProviderDeps } from "./messages"
import { navigationProvider } from "./navigation"
import { charactersProvider, teamsProvider } from "./people"
import { piPackagesProvider } from "./pi-packages"
import { sessionsProvider } from "./sessions"
import { settingsProvider } from "./settings"
import { mcpServersProvider, pluginsProvider, scheduledTasksProvider } from "./system"
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
    inboxContactsProvider,
    // Desktop-only in effect: the provider returns [] outside the Tauri shell,
    // where Pi's config file and CLI do not exist.
    piPackagesProvider,
    issuesProvider,
    devicesProvider,
    // Rows exist in every shell — the console renders over whichever local
    // database that shell owns (ADR-0084). Only the privileged actions on
    // `/sites` are host-gated, and the palette does not offer those.
    sitesProvider,
    // Not `teamsProvider` above, which finds a guild of Characters. A Squad is
    // an `AgentTeam`, and typing its name found nothing before this.
    squadsProvider,
    // Scoped to whichever repository the panel is bound to, and empty on a
    // client that is not offered Source Control at all. Both return [] rather
    // than fetching, so the per-keystroke cost is a store read.
    gitBranchesProvider,
    gitWorktreesProvider,
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
