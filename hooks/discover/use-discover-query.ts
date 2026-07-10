"use client"

/**
 * Unified Dexie subscription for the discover page.
 *
 * Each implemented category gets exactly one `useLiveQuery` subscription;
 * inactive categories pass a no-op resolver so the hook order stays stable
 * (React hook rules) without paying a real database subscription cost.
 * Synchronous categories (workflow templates / connectors / OCR providers —
 * driven by in-memory registries, not Dexie) skip the subscription entirely
 * and resolve in a single `useMemo`.
 *
 * Sort + filter are URL-driven (see `useDiscoverRouteState`). The hook
 * accepts them as the optional third argument so the caller doesn't have to
 * branch by category — the dispatcher below applies them where they make
 * semantic sense and ignores them elsewhere.
 */

import { useMemo, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import type { Character, McpServer, Skill, Team } from "@/lib/claude/types"
import { FAVORITES_CATEGORY, type DiscoverView } from "@/lib/discover/categories"
import { favoriteKey } from "@/hooks/discover/use-discover-favorites"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { OcrProvider } from "@/types/ocr"
import type { TwinDraft, TwinSource } from "@/types/twin"
import type { ConnectorMeta } from "@/lib/connectors/adapter-metadata"
import type { WorkflowCopilotTemplate } from "@/lib/workflow/copilot-templates"
import type { DiscoverFilter, DiscoverSort } from "@/hooks/discover/use-discover-route-state"
import { listCharacters } from "@/lib/db/characters"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listPlugins } from "@/lib/db/plugins"
import { listSkills } from "@/lib/db/skills"
import { listTeams } from "@/lib/db/teams"
import { getDb } from "@/lib/db/schema"
import { listConnectorMetadata } from "@/lib/connectors/adapter-metadata"
import { getSharedOcrRegistry } from "@/lib/ocr/registry"
import { listCopilotTemplates } from "@/lib/workflow/copilot-templates"
import type { McpPreset } from "@/lib/claude/mcp-presets"
import { MCP_PRESETS } from "@/lib/claude/mcp-presets"
import type { SlashCommandDefinition } from "@/lib/slash-commands/registry"
import {
  getSlashCommandsVersion,
  listSlashCommands,
  subscribeSlashCommands,
} from "@/lib/slash-commands/registry"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { BUILT_IN_TEAM_TEMPLATES } from "@/types/agent/agent-team"
import { listAgentTeamTemplateEntries } from "@/lib/plugin/registries/agent-team-template-registry"
import { getAvailablePresets, getPresetDisplayInfo } from "@/lib/ai/agent/external/presets"
import { resolveDispatchableSubagents } from "@/lib/claude/agents/subagents"

/**
 * Normalized team-template shape shared by the built-in `BUILT_IN_TEAM_TEMPLATES`
 * and plugin-contributed `PluginAgentTeamTemplateDef` entries so the card /
 * inspector render one shape regardless of source.
 */
export interface DiscoverTeamTemplate {
  id: string
  name: string
  description: string
  teammateCount: number
  category?: string
  isBuiltIn: boolean
  /** Set for plugin-contributed templates — enables `getTemplateWarnings`. */
  pluginId?: string
}

/** Normalized external-agent preset shape (from `getPresetDisplayInfo`). */
export interface DiscoverExternalAgentPreset {
  id: string
  name: string
  description: string
  tags: string[]
  setupHint?: string
  docsUrl?: string
}

export type DiscoverItem =
  | { kind: "character"; id: string; data: Character }
  | { kind: "team"; id: string; data: Team }
  | { kind: "skill"; id: string; data: Skill }
  | { kind: "plugin"; id: string; data: PluginRow }
  | { kind: "mcpServer"; id: string; data: McpServer }
  | { kind: "connector"; id: string; data: ConnectorMeta }
  | { kind: "ocrProvider"; id: string; data: OcrProvider }
  | { kind: "workflowTemplate"; id: string; data: WorkflowCopilotTemplate }
  | { kind: "twinSource"; id: string; data: TwinSource }
  | { kind: "twinDraft"; id: string; data: TwinDraft }
  | { kind: "slashCommand"; id: string; data: SlashCommandDefinition }
  | { kind: "mcpPreset"; id: string; data: McpPreset }
  | { kind: "teamTemplate"; id: string; data: DiscoverTeamTemplate }
  | { kind: "externalAgentPreset"; id: string; data: DiscoverExternalAgentPreset }
  | { kind: "subagent"; id: string; data: PluginSubagentDef }

export interface DiscoverQueryOptions {
  sort?: DiscoverSort
  filter?: DiscoverFilter
  /**
   * Favorite keys (`${kind}:${id}`) from `useDiscoverFavorites`. Required for
   * the favorites pseudo-category (which aggregates every favorited item) and
   * for the `favorites` filter; defaults to empty.
   */
  favoriteKeys?: ReadonlySet<string>
}

const EMPTY_KEYS: ReadonlySet<string> = new Set()

export interface DiscoverQueryResult {
  items: DiscoverItem[]
  /** True while the active category's first read is still in flight. */
  loading: boolean
}

const EMPTY: readonly never[] = []

function matchesQuery(text: string | undefined | null, trimmed: string): boolean {
  if (trimmed.length === 0) return true
  if (!text) return false
  return text.toLowerCase().includes(trimmed)
}

function compareByRecent(aTs: number, bTs: number): number {
  // Most recent first.
  return bTs - aTs
}

/**
 * Normalize built-in + plugin-contributed agent-team templates into one list.
 * Synchronous — reads the static `BUILT_IN_TEAM_TEMPLATES` array and the
 * in-memory plugin overlay (`listAgentTeamTemplateEntries`).
 */
function buildTeamTemplates(): DiscoverTeamTemplate[] {
  const builtIns = BUILT_IN_TEAM_TEMPLATES.map<DiscoverTeamTemplate>((tpl) => ({
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    teammateCount: tpl.teammates.length,
    category: tpl.category,
    isBuiltIn: true,
  }))
  const plugins = listAgentTeamTemplateEntries().map<DiscoverTeamTemplate>((e) => ({
    id: e.id,
    name: e.entry.name,
    description: e.entry.description,
    teammateCount: e.entry.teammates?.length ?? 0,
    category: e.entry.category,
    isBuiltIn: false,
    pluginId: e.pluginId,
  }))
  return [...builtIns, ...plugins]
}

/**
 * Project every available external-agent preset (static + plugin overlay) into
 * its display shape. Skips ids with no resolvable display info.
 */
function buildExternalAgentPresets(): DiscoverExternalAgentPreset[] {
  const out: DiscoverExternalAgentPreset[] = []
  for (const id of getAvailablePresets()) {
    const info = getPresetDisplayInfo(id)
    if (!info) continue
    out.push({
      id,
      name: info.name,
      description: info.description,
      tags: info.tags ?? [],
      setupHint: info.setupHint,
      docsUrl: info.docsUrl,
    })
  }
  return out
}

/** The dispatchable subagents (host built-ins + plugin overlay + user templates). */
function buildSubagents(): Array<{ id: string; def: PluginSubagentDef }> {
  // `hidden` subagents stay dispatchable but out of the Discover browser.
  return resolveDispatchableSubagents().filter(({ def }) => !def.hidden)
}

export function useDiscoverQuery(
  category: DiscoverView,
  query: string,
  opts: DiscoverQueryOptions = {}
): DiscoverQueryResult {
  const trimmed = query.trim().toLowerCase()
  const sort: DiscoverSort = opts.sort ?? "name"
  const filter: DiscoverFilter = opts.filter ?? "all"
  const favoriteKeys = opts.favoriteKeys ?? EMPTY_KEYS
  // The favorites pseudo-category aggregates every kind, so its Dexie reads
  // must be live whenever it (not just the matching real category) is active.
  const isFavoritesView = category === FAVORITES_CATEGORY

  // Slash commands live in an in-memory registry (not Dexie). Subscribe to its
  // version counter so newly (un)registered plugin commands re-derive the list.
  // The value is unused directly — it is the change signal for the memo below.
  const slashVersion = useSyncExternalStore(
    subscribeSlashCommands,
    getSlashCommandsVersion,
    getSlashCommandsVersion
  )

  // Every call site is unconditional so React hook order stays the same on
  // every render. Inactive categories resolve to the shared empty array —
  // useLiveQuery sees no Dexie reads and so installs no subscription.
  const charactersRaw = useLiveQuery<readonly Character[]>(
    () =>
      category === "characters" || isFavoritesView
        ? listCharacters()
        : Promise.resolve<readonly Character[]>(EMPTY),
    [category]
  )
  const teamsRaw = useLiveQuery<readonly Team[]>(
    () =>
      category === "teams" || isFavoritesView
        ? listTeams()
        : Promise.resolve<readonly Team[]>(EMPTY),
    [category]
  )
  const skillsRaw = useLiveQuery<readonly Skill[]>(
    () =>
      category === "skills" || isFavoritesView
        ? listSkills()
        : Promise.resolve<readonly Skill[]>(EMPTY),
    [category]
  )
  const pluginsRaw = useLiveQuery<readonly PluginRow[]>(
    () =>
      category === "plugins" || isFavoritesView
        ? listPlugins()
        : Promise.resolve<readonly PluginRow[]>(EMPTY),
    [category]
  )
  const mcpServersRaw = useLiveQuery<readonly McpServer[]>(
    () =>
      category === "mcpTools" || isFavoritesView
        ? listMcpServers()
        : Promise.resolve<readonly McpServer[]>(EMPTY),
    [category]
  )
  const twinSourcesRaw = useLiveQuery<readonly TwinSource[]>(
    () =>
      category === "twinIngest" || isFavoritesView
        ? // `importedAt` is not a Dexie index (see lib/db/schema.ts); sortBy()
          // does an in-memory sort, matching the pattern used for twinDrafts.
          getDb()
            .twinSources.toCollection()
            .sortBy("importedAt")
            .then((arr) => arr.reverse() as TwinSource[])
        : Promise.resolve<readonly TwinSource[]>(EMPTY),
    [category]
  )
  const twinDraftsRaw = useLiveQuery<readonly TwinDraft[]>(
    () =>
      category === "twinDrafts" || isFavoritesView
        ? // `createdAt` is not a Dexie index on twinDrafts (see lib/db/schema.ts),
          // so use sortBy() — in-memory sort that does not require an index — and
          // reverse the resulting array for newest-first.
          getDb()
            .twinDrafts.toCollection()
            .sortBy("createdAt")
            .then((arr) => arr.reverse() as TwinDraft[])
        : Promise.resolve<readonly TwinDraft[]>(EMPTY),
    [category]
  )

  const items = useMemo<DiscoverItem[]>(() => {
    // Not dead code: `listSlashCommands()` below reads a mutable registry, so
    // this version counter must participate in the memo to force
    // re-derivation when the registry bumps.
    void slashVersion
    const build = (): DiscoverItem[] => {
      switch (category) {
        case "characters": {
          let arr = [...(charactersRaw ?? EMPTY)].filter(
            (c) =>
              matchesQuery(c.name, trimmed) || matchesQuery(c.description ?? undefined, trimmed)
          )
          if (filter === "builtin") arr = arr.filter((c) => c.isBuiltIn === true)
          arr.sort((a, b) => a.name.localeCompare(b.name))
          return arr.map<DiscoverItem>((data) => ({ kind: "character", id: data.id, data }))
        }
        case "teams": {
          let arr = [...(teamsRaw ?? EMPTY)].filter(
            (t) =>
              matchesQuery(t.name, trimmed) || matchesQuery(t.description ?? undefined, trimmed)
          )
          if (filter === "builtin") arr = arr.filter((t) => t.isBuiltIn === true)
          if (sort === "recent") {
            arr.sort((a, b) =>
              compareByRecent(a.updatedAt ?? a.createdAt ?? 0, b.updatedAt ?? b.createdAt ?? 0)
            )
          } else {
            arr.sort((a, b) => a.name.localeCompare(b.name))
          }
          return arr.map<DiscoverItem>((data) => ({ kind: "team", id: data.id, data }))
        }
        case "skills": {
          let arr = [...(skillsRaw ?? EMPTY)].filter(
            (s) =>
              matchesQuery(s.name, trimmed) || matchesQuery(s.description ?? undefined, trimmed)
          )
          if (filter === "builtin") arr = arr.filter((s) => s.isBuiltIn === true)
          if (filter === "enabled") arr = arr.filter((s) => s.status !== "disabled")
          arr.sort((a, b) => a.name.localeCompare(b.name))
          return arr.map<DiscoverItem>((data) => ({ kind: "skill", id: data.id, data }))
        }
        case "plugins": {
          let arr = [...(pluginsRaw ?? EMPTY)].filter((p) => matchesQuery(p.name || p.id, trimmed))
          // `installed` is a no-op (every PluginRow is installed by definition); we
          // accept it so the same chip can target plugins + connectors uniformly.
          if (filter === "enabled") arr = arr.filter((p) => p.enabled === true)
          if (filter === "builtin") arr = arr.filter((p) => p.source === "builtin")
          if (sort === "recent") {
            arr.sort((a, b) => compareByRecent(a.updatedAt, b.updatedAt))
          } else {
            arr.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
          }
          return arr.map<DiscoverItem>((data) => ({ kind: "plugin", id: data.id, data }))
        }
        case "mcpTools": {
          let arr = [...(mcpServersRaw ?? EMPTY)].filter(
            (s) => matchesQuery(s.name, trimmed) || matchesQuery(s.transport, trimmed)
          )
          if (filter === "enabled") arr = arr.filter((s) => s.enabled === true)
          if (filter === "builtin") arr = arr.filter((s) => !s.pluginId)
          if (sort === "recent") {
            // McpServer has no updatedAt index — fall back to name sort.
            arr.sort((a, b) => a.name.localeCompare(b.name))
          } else {
            arr.sort((a, b) => a.name.localeCompare(b.name))
          }
          return arr.map<DiscoverItem>((data) => ({ kind: "mcpServer", id: data.id, data }))
        }
        case "connectors": {
          // Synchronous registry — no Dexie subscription needed.
          let arr = listConnectorMetadata().filter(
            (m) => matchesQuery(m.type, trimmed) || matchesQuery(m.status, trimmed)
          )
          if (filter === "installed") arr = arr.filter((m) => m.status === "stable")
          if (filter === "builtin") arr = arr.filter((m) => m.status !== "planned")
          return arr.map<DiscoverItem>((data) => ({ kind: "connector", id: data.type, data }))
        }
        case "ocrProviders": {
          let arr = getSharedOcrRegistry()
            .list()
            .filter((p) => matchesQuery(p.label, trimmed) || matchesQuery(p.category, trimmed))
          if (filter === "builtin") arr = arr.filter((p) => p.category === "local")
          arr.sort((a, b) => a.label.localeCompare(b.label))
          return arr.map<DiscoverItem>((data) => ({ kind: "ocrProvider", id: data.id, data }))
        }
        case "workflowTemplates": {
          const arr = listCopilotTemplates().filter((t) => {
            const labelEn = t.label.en
            const labelZh = t.label["zh-CN"]
            const descEn = t.description.en
            const descZh = t.description["zh-CN"]
            const tagHit = (t.tags ?? []).some((tag) => matchesQuery(tag, trimmed))
            return (
              matchesQuery(labelEn, trimmed) ||
              matchesQuery(labelZh, trimmed) ||
              matchesQuery(descEn, trimmed) ||
              matchesQuery(descZh, trimmed) ||
              tagHit ||
              matchesQuery(t.id, trimmed)
            )
          })
          return arr.map<DiscoverItem>((data) => ({ kind: "workflowTemplate", id: data.id, data }))
        }
        case "twinIngest":
          return [...(twinSourcesRaw ?? EMPTY)]
            .filter((s) => matchesQuery(s.title, trimmed) || matchesQuery(s.kind, trimmed))
            .map<DiscoverItem>((data) => ({ kind: "twinSource", id: data.id, data }))
        case "twinDrafts":
          return [...(twinDraftsRaw ?? EMPTY)]
            .filter((d) => {
              // TwinDraft has no top-level name; the display label lives in
              // payload.data.name (Partial<Character | Skill>). Fall back to
              // the draft kind and id so empty payloads still match search.
              const payloadName =
                typeof d.payload?.data?.name === "string"
                  ? (d.payload.data.name as string)
                  : undefined
              return (
                matchesQuery(payloadName, trimmed) ||
                matchesQuery(d.kind, trimmed) ||
                matchesQuery(d.id, trimmed)
              )
            })
            .map<DiscoverItem>((data) => ({ kind: "twinDraft", id: data.id, data }))
        case "slashCommands": {
          // `slashVersion` (memo dep) drives re-derivation; read fresh here.
          let arr = listSlashCommands().filter(
            (c) =>
              matchesQuery(c.name, trimmed) ||
              matchesQuery(c.description, trimmed) ||
              matchesQuery(c.id, trimmed)
          )
          if (filter === "builtin") arr = arr.filter((c) => c.source === "builtin")
          arr.sort((a, b) => a.name.localeCompare(b.name))
          return arr.map<DiscoverItem>((data) => ({ kind: "slashCommand", id: data.id, data }))
        }
        case "mcpPresets": {
          const arr = MCP_PRESETS.filter(
            (p) =>
              matchesQuery(p.name, trimmed) ||
              matchesQuery(p.description, trimmed) ||
              (p.tags ?? []).some((tag) => matchesQuery(tag, trimmed))
          )
          return arr.map<DiscoverItem>((data) => ({ kind: "mcpPreset", id: data.id, data }))
        }
        case "teamTemplates": {
          let arr = buildTeamTemplates().filter(
            (tpl) => matchesQuery(tpl.name, trimmed) || matchesQuery(tpl.description, trimmed)
          )
          if (filter === "builtin") arr = arr.filter((tpl) => tpl.isBuiltIn)
          arr.sort((a, b) => a.name.localeCompare(b.name))
          return arr.map<DiscoverItem>((data) => ({ kind: "teamTemplate", id: data.id, data }))
        }
        case "agentPresets": {
          // Two kinds share this browse gallery: external-agent presets (Codex /
          // Claude Code / Cursor / …) and dispatchable subagents. `builtin`/etc.
          // filters don't map cleanly onto a browse-all gallery, so they no-op
          // here (the `favorites` filter still applies globally below).
          const presets = buildExternalAgentPresets()
            .filter(
              (p) =>
                matchesQuery(p.name, trimmed) ||
                matchesQuery(p.description, trimmed) ||
                p.tags.some((tag) => matchesQuery(tag, trimmed))
            )
            .map<DiscoverItem>((data) => ({ kind: "externalAgentPreset", id: data.id, data }))
          const subs = buildSubagents()
            .filter(
              (s) =>
                matchesQuery(s.def.name, trimmed) ||
                matchesQuery(s.def.description, trimmed) ||
                matchesQuery(s.id, trimmed)
            )
            .map<DiscoverItem>((s) => ({ kind: "subagent", id: s.id, data: s.def }))
          return [...presets, ...subs]
        }
        case FAVORITES_CATEGORY: {
          // Aggregate every kind, then keep only favorited items. The favorites
          // view is a curated short list, so the search box does not narrow it.
          const all: DiscoverItem[] = [
            ...[...(charactersRaw ?? EMPTY)].map<DiscoverItem>((data) => ({
              kind: "character",
              id: data.id,
              data,
            })),
            ...[...(teamsRaw ?? EMPTY)].map<DiscoverItem>((data) => ({
              kind: "team",
              id: data.id,
              data,
            })),
            ...[...(skillsRaw ?? EMPTY)].map<DiscoverItem>((data) => ({
              kind: "skill",
              id: data.id,
              data,
            })),
            ...[...(pluginsRaw ?? EMPTY)].map<DiscoverItem>((data) => ({
              kind: "plugin",
              id: data.id,
              data,
            })),
            ...[...(mcpServersRaw ?? EMPTY)].map<DiscoverItem>((data) => ({
              kind: "mcpServer",
              id: data.id,
              data,
            })),
            ...listConnectorMetadata().map<DiscoverItem>((data) => ({
              kind: "connector",
              id: data.type,
              data,
            })),
            ...getSharedOcrRegistry()
              .list()
              .map<DiscoverItem>((data) => ({ kind: "ocrProvider", id: data.id, data })),
            ...listCopilotTemplates().map<DiscoverItem>((data) => ({
              kind: "workflowTemplate",
              id: data.id,
              data,
            })),
            ...[...(twinSourcesRaw ?? EMPTY)].map<DiscoverItem>((data) => ({
              kind: "twinSource",
              id: data.id,
              data,
            })),
            ...[...(twinDraftsRaw ?? EMPTY)].map<DiscoverItem>((data) => ({
              kind: "twinDraft",
              id: data.id,
              data,
            })),
            ...listSlashCommands().map<DiscoverItem>((data) => ({
              kind: "slashCommand",
              id: data.id,
              data,
            })),
            ...MCP_PRESETS.map<DiscoverItem>((data) => ({ kind: "mcpPreset", id: data.id, data })),
            ...buildTeamTemplates().map<DiscoverItem>((data) => ({
              kind: "teamTemplate",
              id: data.id,
              data,
            })),
            ...buildExternalAgentPresets().map<DiscoverItem>((data) => ({
              kind: "externalAgentPreset",
              id: data.id,
              data,
            })),
            ...buildSubagents().map<DiscoverItem>((s) => ({
              kind: "subagent",
              id: s.id,
              data: s.def,
            })),
          ]
          return all.filter((i) => favoriteKeys.has(favoriteKey(i.kind, i.id)))
        }
        default:
          return []
      }
    }

    const built = build()
    // The `favorites` filter narrows ANY category to starred items. (On the
    // favorites pseudo-category it is a redundant no-op.)
    if (filter === "favorites") {
      return built.filter((i) => favoriteKeys.has(favoriteKey(i.kind, i.id)))
    }
    return built
  }, [
    category,
    charactersRaw,
    teamsRaw,
    skillsRaw,
    pluginsRaw,
    mcpServersRaw,
    twinSourcesRaw,
    twinDraftsRaw,
    slashVersion,
    trimmed,
    sort,
    filter,
    favoriteKeys,
  ])

  // `useLiveQuery` returns `undefined` until its first read resolves. Treat
  // the relevant raw query's undefined as "loading"; other categories have
  // synchronous Promise.resolve resolvers so they never report loading.
  const loading = ((): boolean => {
    switch (category) {
      case "characters":
        return charactersRaw === undefined
      case "teams":
        return teamsRaw === undefined
      case "skills":
        return skillsRaw === undefined
      case "plugins":
        return pluginsRaw === undefined
      case "mcpTools":
        return mcpServersRaw === undefined
      case "twinIngest":
        return twinSourcesRaw === undefined
      case "twinDrafts":
        return twinDraftsRaw === undefined
      case FAVORITES_CATEGORY:
        // The favorites view depends on every Dexie-backed kind; it is loading
        // until each has resolved its first read.
        return (
          charactersRaw === undefined ||
          teamsRaw === undefined ||
          skillsRaw === undefined ||
          pluginsRaw === undefined ||
          mcpServersRaw === undefined ||
          twinSourcesRaw === undefined ||
          twinDraftsRaw === undefined
        )
      // Synchronous in-memory registries.
      case "connectors":
      case "ocrProviders":
      case "workflowTemplates":
      default:
        return false
    }
  })()

  return { items, loading }
}
