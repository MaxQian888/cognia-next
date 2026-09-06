/**
 * Assemble a `GlobalSearchContext` outside React.
 *
 * The dialog builds one from ten hooks (`hooks/global-search/
 * use-global-search-context.ts`), which is right for a dialog and unusable for
 * a workflow step, a scheduled run, or the cloud brain. `testing.ts` already
 * proves the shape is constructible without React. This is the production
 * counterpart.
 *
 * Two rules it does not bend:
 *
 *  - `activeProjectId` comes from the caller (a run's `projectId`), never from
 *    a UI store. A scheduled or headless run has no open panel, so a store read
 *    there is not a fallback, it is an empty value dressed up as one.
 *  - Every shell fact it cannot honestly answer is answered conservatively
 *    rather than optimistically. A provider that gates on one then returns
 *    nothing, which is the correct outcome for a surface with no shell.
 */

import { getDb } from "@/lib/db/schema"
import { listSessions } from "@/lib/db/sessions"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { loadMessageResolver, type HeadlessLocale } from "@/lib/headless/i18n"
import { detectPlatform } from "@/lib/platform/detect"
import { isTauri } from "@/lib/tauri"
import { registerBuiltinGlobalSearchProviders } from "./providers"
import type { GlobalSearchContext, GlobalSearchKind, GlobalSearchScope } from "./types"

/**
 * Kinds a graph can act on.
 *
 * The excluded five are excluded by construction, not by preference. Their
 * items carry `{ type: "callback", run: () => ... }` actions and `{ lucide:
 * LucideIcon }` icons: a function and a component reference, neither of which
 * survives a step output or means anything to a downstream node. Excluding
 * them also removes every `GlobalSearchHostContext` field this module would
 * otherwise have to invent an answer for.
 */
export const WORKFLOW_SEARCHABLE_KINDS: readonly GlobalSearchKind[] = [
  "session",
  "message",
  "character",
  "team",
  "squad",
  "workspace",
  "workflow",
  "skill",
  "memory",
  "template",
  "scheduled-task",
  "plugin",
  "mcp-server",
  "inbox-conversation",
  "inbox-contact",
  "issue",
  "device",
  "site",
  "git-branch",
  "git-worktree",
  "pi-package",
]

export interface HeadlessSearchContextInput {
  /** The workspace the caller belongs to. Never read from a store here. */
  activeProjectId?: string | null
  locale?: HeadlessLocale
  scope?: GlobalSearchScope
  now?: number
}

let providersRegistered = false

/**
 * Register the built-ins once per process. The registry is module-level and
 * framework-free, so this is safe outside React, and re-registering is a
 * replace rather than a duplicate.
 */
export function ensureBuiltinSearchProviders(): void {
  if (providersRegistered) return
  registerBuiltinGlobalSearchProviders()
  providersRegistered = true
}

export async function buildHeadlessSearchContext(
  input: HeadlessSearchContextInput = {}
): Promise<GlobalSearchContext> {
  ensureBuiltinSearchProviders()

  const activeProjectId = input.activeProjectId ?? null
  const [t, sessions, workspaces] = await Promise.all([
    // The same aggregate bundle next-intl reads, so a provider's key resolves
    // to the same string it would in the dialog.
    loadMessageResolver(input.locale ?? "en"),
    listSessions().then((rows) => filterExposedSessions(rows, "global-search")),
    getDb().projects.toArray(),
  ])

  return {
    t: (key: string, values?: Record<string, string | number | Date>) =>
      t(key, values as Record<string, string | number> | undefined),
    locale: input.locale ?? "en",
    platform: detectPlatform(),
    isTauri: isTauri(),
    now: input.now ?? Date.now(),
    activeProjectId,
    // A run is not sitting in a conversation, and claiming one would let a
    // provider rank the wrong session first.
    activeSessionId: null,
    sessions,
    workspaces,
    capabilityOverlay: activeProjectId
      ? workspaces.find((w) => w.id === activeProjectId)?.capabilityOverlay
      : undefined,
    scope: input.scope ?? "all",
    // Deliberately the degraded snapshot. Only the navigation provider reads
    // it, and navigation is not in `WORKFLOW_SEARCHABLE_KINDS`.
    runtimeSnapshot: { target: null, vaultState: "unavailable", connectionState: "offline" },
    host: {
      // Every field here belongs to a kind this module excludes. Answering
      // them optimistically would be inventing shell facts a graph has no way
      // to check.
      reachableSettingsSections: new Set<string>(),
      recorderAvailable: false,
      theme: undefined,
      hasApiKey: false,
      pluginQuickActions: [],
      workbenchPanels: [],
      // The one field that is genuinely knowable here.
      canBrowseHostFolders: isTauri(),
    },
  }
}

/** Test-only: forget that the built-ins were registered. */
export function __resetHeadlessSearchProvidersForTesting(): void {
  providersRegistered = false
}
