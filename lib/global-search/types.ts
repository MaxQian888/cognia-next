/**
 * Unified global search — contracts (ADR-0129).
 *
 * One search surface (the ⌘K dialog) fans a query out to many *providers*, each
 * owning one kind of item (conversations, message hits, commands, pages, …).
 * Providers are plain data + async functions so they can live in `lib/`, be
 * unit-tested without React, and be registered by plugins through the same
 * seam the built-ins use.
 *
 * Everything user-facing on an item is already-resolved text: providers get a
 * translator through the context and hand back strings, so the dialog never
 * has to know which namespace a kind's labels live in.
 */

import type { LucideIcon } from "lucide-react"

import type { AvatarSubject } from "@/lib/ui/avatar"
import type { Snippet } from "@/lib/chat/search/snippet"
import type { Platform } from "@/lib/platform/detect"
import type { QuickActionEntry } from "@/lib/plugin/registries/quick-action-registry"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"

/** Every kind of item the dialog knows how to render and act on. */
export type GlobalSearchKind =
  | "action"
  | "navigation"
  | "settings"
  | "session"
  | "message"
  | "character"
  | "team"
  | "workspace"
  | "workflow"
  | "skill"
  | "memory"
  | "template"
  | "scheduled-task"
  | "plugin"
  | "plugin-action"
  | "mcp-server"
  | "inbox-conversation"
  | "workbench-panel"
  /** A package for the Pi coding agent (ADR-0119), not a Cognia plugin. */
  | "pi-package"

/** The scope tabs across the top of the dialog. */
export type GlobalSearchScope =
  "all" | "chats" | "messages" | "commands" | "pages" | "people" | "library"

export const GLOBAL_SEARCH_SCOPES: readonly GlobalSearchScope[] = [
  "all",
  "chats",
  "messages",
  "commands",
  "pages",
  "people",
  "library",
]

/**
 * Which scoped tabs each kind participates in. `all` is implicit for every
 * kind. `message` appears in both `chats` (collapsed per conversation) and
 * `messages` (the deep list) — the provider reads the scope to decide.
 */
export const KIND_SCOPES: Readonly<Record<GlobalSearchKind, readonly GlobalSearchScope[]>> = {
  action: ["commands"],
  navigation: ["pages"],
  settings: ["pages"],
  session: ["chats"],
  message: ["chats", "messages"],
  character: ["people"],
  team: ["people"],
  workspace: ["library"],
  workflow: ["library"],
  skill: ["library"],
  memory: ["library"],
  template: ["library"],
  "scheduled-task": ["library"],
  plugin: ["library"],
  "plugin-action": ["commands"],
  "mcp-server": ["library"],
  "inbox-conversation": ["library"],
  "workbench-panel": ["commands"],
  "pi-package": ["library"],
}

/**
 * Display order of groups in the *All* scope before best-score re-ranking.
 * Lower = earlier. Commands and conversations first — they are what a
 * keystroke into ⌘K most often means.
 */
export const KIND_PRIORITY: Readonly<Record<GlobalSearchKind, number>> = {
  action: 0,
  session: 1,
  message: 2,
  navigation: 3,
  settings: 4,
  "workbench-panel": 5,
  character: 6,
  team: 7,
  workspace: 8,
  workflow: 9,
  skill: 10,
  memory: 11,
  template: 12,
  "scheduled-task": 13,
  plugin: 14,
  "plugin-action": 15,
  "mcp-server": 16,
  "inbox-conversation": 17,
  // Last of the library kinds: these are another agent's packages, so they
  // should never outrank the user's own workflows, skills or plugins.
  "pi-package": 19,
}

/** What the dialog does when an item is chosen. */
export type GlobalSearchAction =
  | { type: "open-session"; sessionId: string; messageId?: string }
  | { type: "navigate"; href: string }
  | { type: "open-settings"; tab: string; focus?: string }
  | { type: "command"; id: string }
  | { type: "reveal-panel"; panelId: string }
  | { type: "quick-action"; entry: QuickActionEntry }
  | { type: "switch-workspace"; projectId: string }
  | { type: "switch-guild"; kind: "dm" | "canvas" | "team"; teamId?: string }
  | { type: "new-chat-with-character"; characterId: string; characterName: string }
  /**
   * Begin installing something into an external agent. Deliberately *not* a
   * `navigate`: the href that opens the owning surface with the right item
   * pre-selected is an implementation detail of one handler, and baking it into
   * every provider item would spread the deep-link format across the codebase.
   *
   * It also never installs directly. The handler routes to the owning surface,
   * which opens its own pre-install gate — a palette that installed on Enter
   * would skip the overlap and budget warnings that are the only ones a user
   * gets, since Pi itself never warns.
   */
  | { type: "install"; target: "pi-package"; spec: string }
  | { type: "callback"; run: () => void | Promise<void> }

/** Icon slot: a lucide component or an avatar subject (characters, teams). */
export type GlobalSearchIcon = { lucide: LucideIcon } | { avatar: AvatarSubject }

/** Per-kind extras the row renderer turns into chips / badges. */
export interface GlobalSearchItemExtra {
  /** Message hit: author role. */
  role?: string
  /** Conversation / message hit lives in an archived conversation. */
  archived?: boolean
  /** Message hit: identical branch copies folded into this row. */
  otherBranchCount?: number
  /** Message hit: occurrences of the needle in the message. */
  occurrenceCount?: number
  /** Item is the currently active one (workspace, session, panel). */
  current?: boolean
  /** Message hit: highlighted excerpt. */
  snippet?: Snippet
  /** Item is disabled / not runnable here, with a reason to show. */
  disabledReason?: string
}

export interface GlobalSearchItem {
  /** Unique across providers — conventionally `${kind}:${localId}`. */
  id: string
  kind: GlobalSearchKind
  title: string
  /** Character indices in `title` to highlight. */
  titlePositions?: readonly number[]
  subtitle?: string
  subtitlePositions?: readonly number[]
  /** Right-aligned hint: a route, a section name, a kind label. */
  meta?: string
  icon?: GlobalSearchIcon
  /** Extra tokens the provider matched against (not displayed). */
  keywords?: readonly string[]
  /** Normalised relevance in `[0, 1]`; higher first. */
  score: number
  /** When the underlying record last changed (for the relative-time chip). */
  timestamp?: number
  extra?: GlobalSearchItemExtra
  action: GlobalSearchAction
}

/** How complete a provider's answer is. */
export type GlobalSearchCoverage = "complete" | "partial" | "indexing"

export interface GlobalSearchProviderResult {
  items: GlobalSearchItem[]
  /** Total matches known to exist when more than `items` were found. */
  total?: number
  /** `true` when the provider stopped early — the caller can ask for more. */
  truncated?: boolean
  coverage?: GlobalSearchCoverage
}

/** Parsed query — see `query-parser.ts`. */
export interface GlobalSearchFilters {
  /** `from:user` / `from:assistant` (`me` / `ai` aliases). */
  roles?: readonly string[]
  /** `is:archived` — include archived conversations (default excludes them). */
  archived?: boolean
  /** `after:` inclusive lower bound, epoch ms. */
  after?: number
  /** `before:` exclusive upper bound, epoch ms. */
  before?: number
  /** `workspace:current` restricts to the active workspace; default `all`. */
  workspace?: "current" | "all"
  /** `title:` — match conversation titles only (skip message content). */
  titleOnly?: boolean
  /** `in:` — restrict to these kinds. */
  kinds?: readonly GlobalSearchKind[]
}

export interface ParsedGlobalSearchQuery {
  /** The raw string as typed. */
  raw: string
  /** Free text with prefixes and filter tokens removed, trimmed. */
  text: string
  /** Lower-cased `text` — the needle every provider matches with. */
  needle: string
  /** Scope forced by a leading `>` / `@` prefix, if any. */
  prefixScope?: GlobalSearchScope
  filters: GlobalSearchFilters
  /** Filter tokens recognised, in input order — the dialog shows them as chips. */
  tokens: readonly ParsedFilterToken[]
}

export interface ParsedFilterToken {
  key: string
  value: string
  /** The exact substring in `raw` this token came from. */
  source: string
}

/**
 * Everything a provider may need that lives in React / stores. Assembled by
 * the dialog once per run. Providers must not import stores directly for data
 * that is already here — that is what keeps them testable.
 */
export interface GlobalSearchContext {
  /** Root translator: `t("globalSearch.kinds.session")`. */
  t: (key: string, values?: Record<string, string | number | Date>) => string
  locale: string
  platform: Platform
  isTauri: boolean
  now: number
  activeProjectId: string | null
  activeSessionId: string | null
  /** Cross-workspace, already exposure-filtered for the main list. */
  sessions: readonly ChatSession[]
  /** Every workspace (project) the store knows, archived ones included. */
  workspaces: readonly Project[]
  /** The scope the dialog is showing — providers may project differently. */
  scope: GlobalSearchScope
  /** Host capabilities the dialog resolved (settings reachability etc.). */
  host: GlobalSearchHostContext
}

/** Shell facts providers gate on. Filled by the dialog from hooks. */
export interface GlobalSearchHostContext {
  /** Settings sections reachable from this client (`SettingsSectionId`s). */
  reachableSettingsSections: ReadonlySet<string>
  /** Skill recorder plugin present → its palette entry is offered. */
  recorderAvailable: boolean
  theme: "light" | "dark" | "system" | string | undefined
  hasApiKey: boolean
  /** Plugin quick actions already filtered for the palette surface + `when`. */
  pluginQuickActions: readonly QuickActionEntry[]
  /** Panels of the workbench in front, with their labels already resolved. */
  workbenchPanels: readonly { id: string; label: string; activity?: string }[]
}

export interface GlobalSearchProviderInput {
  query: ParsedGlobalSearchQuery
  ctx: GlobalSearchContext
  /** Upper bound on `items.length` the caller will render. */
  limit: number
  signal: AbortSignal
}

export interface GlobalSearchProvider {
  /** Stable id, e.g. `builtin.sessions` or `plugin.<id>.<name>`. */
  id: string
  kind: GlobalSearchKind
  /**
   * Answer a non-empty query. May be sync — the engine awaits either way.
   * Throwing marks the group as errored; it never fails the whole run.
   */
  search(
    input: GlobalSearchProviderInput
  ): Promise<GlobalSearchProviderResult> | GlobalSearchProviderResult
  /**
   * Items to show for the empty query (recent conversations, primary
   * commands). Optional — kinds without a natural default stay silent.
   */
  suggest?(
    input: Omit<GlobalSearchProviderInput, "query">
  ): Promise<GlobalSearchItem[]> | GlobalSearchItem[]
}

/** One rendered group in the result list. */
export interface GlobalSearchGroup {
  kind: GlobalSearchKind
  providerId: string
  items: GlobalSearchItem[]
  /** Best score in the group — drives group order in the *All* scope. */
  bestScore: number
  total: number
  truncated: boolean
  coverage: GlobalSearchCoverage
  error?: string
}

export interface GlobalSearchOutcome {
  groups: GlobalSearchGroup[]
  /** Sum of every group's `total`. */
  totalHits: number
  /** Worst coverage across groups: `indexing` > `partial` > `complete`. */
  coverage: GlobalSearchCoverage
  tookMs: number
  /** The engine was aborted before finishing — treat as stale. */
  aborted: boolean
}

/** Scope a kind belongs to for tab counting (first listed scope). */
export function primaryScopeOf(kind: GlobalSearchKind): GlobalSearchScope {
  return KIND_SCOPES[kind][0]!
}

/** Whether `kind` should run for `scope`. */
export function kindInScope(kind: GlobalSearchKind, scope: GlobalSearchScope): boolean {
  return scope === "all" || KIND_SCOPES[kind].includes(scope)
}
