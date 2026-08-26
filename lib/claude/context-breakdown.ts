/**
 * Normalised, render-ready model of *what* is occupying the context window.
 *
 * Two very different inputs converge on one shape here:
 *
 * - the SDK-authoritative `getContextUsage()` snapshot (desktop + Anthropic
 *   path), which knows the real window occupancy — system prompt, built-in
 *   tools, MCP tools, memory files, subagents, skills, and the free remainder;
 * - the renderer-side transcript estimate (`lib/analysis/context-source-breakdown`),
 *   the only thing available on the web / non-Anthropic path.
 *
 * Both produce {@link ContextBreakdown}, so `ContextDetailPanel` renders one
 * layout instead of two divergent ones, and the honesty label (live vs
 * estimated) is carried on the model rather than inferred by the view.
 *
 * Pure: no React, no store reads — unit-tested directly.
 */

import type { UIMessage } from "ai"
import type { SdkContextUsage } from "@cognia/agent-config-types"

import { buildContextSourceBreakdown } from "@/lib/analysis/context-source-breakdown"
import { AUTO_COMPACT_FRACTION } from "@/lib/claude/usage"

/**
 * Stable group identity. The first block mirrors the SDK's own categories, the
 * second the transcript estimate's sources; `other` carries an SDK category
 * this build doesn't know a label for (forward-compatible — it renders under
 * its raw upstream name rather than disappearing).
 */
export type ContextGroupId =
  | "messages"
  | "systemPrompt"
  | "systemTools"
  | "mcp"
  | "memory"
  | "agents"
  | "commands"
  | "skills"
  | "userMessages"
  | "mentionedFiles"
  | "toolOutputs"
  | "thinking"
  | "taskCoordination"
  | "free"
  | "other"

/** One expandable entry inside a group (a single MCP tool, memory file, …). */
export interface ContextGroupItem {
  label: string
  /** Secondary qualifier — the MCP server, the memory scope, the agent source. */
  hint?: string
  tokens: number
}

export interface ContextGroup {
  id: ContextGroupId
  /**
   * Unique per row, and it has to be: the panel uses it as a React key AND as
   * the handle in its `expanded` list, so two rows sharing one would expand
   * together and let React reuse the wrong row's DOM.
   *
   * An id alone is not unique. It repeats for loaded + deferred, several SDK
   * category names collapse onto one id (`System tools` and `Built-in tools`
   * both match the `systemTools` pattern), and EVERY name this build does not
   * recognise becomes `other`. {@link buildSdkContextBreakdown} therefore
   * disambiguates on the way in.
   */
  key: string
  tokens: number
  /** Share of the whole window, clamped to [0, 1]. */
  fraction: number
  /** Declared but not yet loaded into the window (SDK "deferred" categories). */
  deferred: boolean
  /** Upstream name, kept only for `other` so unknown categories stay readable. */
  rawName?: string
  items: ContextGroupItem[]
  /**
   * How many things the group covers. Usually `items.length`, but slash
   * commands report a count without a list, so the two are tracked separately.
   */
  itemCount: number
}

export interface ContextBreakdown {
  /** Occupied groups, largest first. Never includes `free`. */
  groups: ContextGroup[]
  /** The unused remainder, when it can be computed. */
  free: ContextGroup | null
  usedTokens: number
  maxTokens: number
  /** `live` = SDK-reported, `estimate` = derived from the visible transcript. */
  source: "live" | "estimate"
  /**
   * What each group's `fraction` is a share OF.
   *
   * `window` — the real context window (live path; rows + free = 100%).
   * `attributed` — only what the estimate could attribute. The transcript
   * estimate cannot see the system prompt, tool schemas or memory, so scoring
   * it against the window would invent a "free space" that isn't free. Saying
   * "share of what we could measure" is the honest denominator.
   */
  denominator: "window" | "attributed"
}

/** Category names the SDK emits, normalised to `[a-z]` for matching. */
const CATEGORY_IDS: Array<[RegExp, ContextGroupId]> = [
  [/^messages$/, "messages"],
  [/^(memoryfiles|memory)$/, "memory"],
  [/^(systemtools|builtintools|tools)$/, "systemTools"],
  [/^skills$/, "skills"],
  [/^(mcptools|mcp)$/, "mcp"],
  [/^systemprompt$/, "systemPrompt"],
  [/^(customagents|subagents|agents)$/, "agents"],
  [/^(slashcommands|customcommands|commands)$/, "commands"],
  [/^(freespace|free)$/, "free"],
]

const DEFERRED_SUFFIX = /\(deferred\)\s*$/i

/** Map an SDK category name onto a known group id (or `other`). */
export function classifyCategory(name: string): ContextGroupId {
  const normalized = name
    .replace(DEFERRED_SUFFIX, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
  for (const [pattern, id] of CATEGORY_IDS) if (pattern.test(normalized)) return id
  return "other"
}

const sumTokens = (rows?: Array<{ tokens?: number }>) =>
  (rows ?? []).reduce((acc, row) => acc + (row.tokens ?? 0), 0)

function itemsFor(usage: SdkContextUsage, id: ContextGroupId): ContextGroupItem[] {
  switch (id) {
    case "systemPrompt":
      return (usage.systemPromptSections ?? []).map((s) => ({ label: s.name, tokens: s.tokens }))
    case "systemTools":
      return (usage.systemTools ?? []).map((s) => ({ label: s.name, tokens: s.tokens }))
    case "mcp":
      return (usage.mcpTools ?? []).map((s) => ({
        label: s.name,
        hint: s.serverName,
        tokens: s.tokens,
      }))
    case "memory":
      return (usage.memoryFiles ?? []).map((s) => ({
        label: s.path,
        hint: s.type,
        tokens: s.tokens,
      }))
    case "agents":
      return (usage.agents ?? []).map((s) => ({
        label: s.agentType,
        hint: s.source,
        tokens: s.tokens,
      }))
    case "skills":
      return (usage.skills?.skillFrontmatter ?? []).map((s) => ({
        label: s.name,
        hint: s.source,
        tokens: s.tokens,
      }))
    default:
      return []
  }
}

/** Declared count for groups that report one without an item list. */
function declaredCount(usage: SdkContextUsage, id: ContextGroupId): number | null {
  if (id === "commands") return usage.slashCommands?.totalCommands ?? null
  if (id === "skills") return usage.skills?.totalSkills ?? null
  return null
}

/**
 * Item list for a DEFERRED group. Only built-in tools publish one — the SDK
 * lists the tools it declared but did not load. Every other deferred category
 * gets an empty list rather than borrowing the loaded group's items, which
 * would claim tokens are in the window when the category says they are not.
 */
function deferredItemsFor(usage: SdkContextUsage, id: ContextGroupId): ContextGroupItem[] {
  if (id !== "systemTools") return []
  return (usage.deferredBuiltinTools ?? []).map((tool) => ({
    label: tool.name,
    tokens: tool.tokens,
  }))
}

function makeGroup(
  id: ContextGroupId,
  tokens: number,
  maxTokens: number,
  opts: {
    deferred?: boolean
    rawName?: string
    items?: ContextGroupItem[]
    count?: number | null
    /** Pre-disambiguated row key; defaults to the id (+ deferred marker). */
    key?: string
  }
): ContextGroup {
  const items = opts.items ?? []
  return {
    id,
    key: opts.key ?? (opts.deferred ? `${id}:deferred` : id),
    tokens,
    fraction: maxTokens > 0 ? Math.min(1, Math.max(0, tokens / maxTokens)) : 0,
    deferred: Boolean(opts.deferred),
    rawName: opts.rawName,
    items: [...items].sort((a, b) => b.tokens - a.tokens),
    // A declared count only wins when it is at least as large as the list we
    // are about to render. `?? items.length` let a reported `totalSkills: 0`
    // through beside a populated `skillFrontmatter`, so the row's header
    // claimed nothing while its expansion listed several.
    itemCount: Math.max(opts.count ?? 0, items.length),
  }
}

/**
 * Build the breakdown from an SDK snapshot.
 *
 * `categories` is preferred when present: it is the only source that accounts
 * for conversation messages and the free remainder. When it is absent (older
 * sidecars, partial snapshots) the typed detail arrays are summed instead and
 * `messages` is inferred as the unattributed remainder of `totalTokens`, so the
 * panel still adds up to the headline number.
 */
export function buildSdkContextBreakdown(usage: SdkContextUsage): ContextBreakdown {
  const maxTokens = usage.maxTokens
  const usedTokens = usage.totalTokens
  const groups: ContextGroup[] = []
  let free: ContextGroup | null = null

  // Row keys must be unique across `groups` AND `free` — the panel renders them
  // in one list, keyed for React and for its `expanded` set.
  //
  // The FIRST row of a kind keeps the bare id, so the common payload produces
  // exactly the keys it always did; only a genuine collision gets a suffix.
  // Collisions are real: several SDK names classify onto one id (`System tools`
  // and `Built-in tools` both match the `systemTools` pattern) and every name
  // this build does not recognise becomes `other`.
  const usedKeys = new Set<string>()
  const uniqueKey = (base: string): string => {
    let key = base
    for (let n = 2; usedKeys.has(key); n += 1) key = `${base}#${n}`
    usedKeys.add(key)
    return key
  }

  if (usage.categories?.length) {
    for (const category of usage.categories) {
      const tokens = category.tokens ?? 0
      if (tokens <= 0) continue
      const id = classifyCategory(category.name)
      const deferred = Boolean(category.isDeferred) || DEFERRED_SUFFIX.test(category.name)
      const rawName = category.name.replace(DEFERRED_SUFFIX, "").trim()
      if (id === "free") {
        free = makeGroup("free", tokens, maxTokens, { key: uniqueKey("free") })
        continue
      }
      groups.push(
        makeGroup(id, tokens, maxTokens, {
          deferred,
          rawName: id === "other" ? rawName : undefined,
          key: uniqueKey(deferred ? `${id}:deferred` : id),
          // Deferred rows describe tools that are NOT in the window, so the
          // loaded item lists never attach to them — only the SDK's own
          // deferred inventory does.
          items: deferred ? deferredItemsFor(usage, id) : itemsFor(usage, id),
          count: deferred ? null : declaredCount(usage, id),
        })
      )
    }
  } else {
    const derived: Array<[ContextGroupId, number]> = [
      ["systemPrompt", sumTokens(usage.systemPromptSections)],
      ["systemTools", sumTokens(usage.systemTools)],
      ["mcp", sumTokens(usage.mcpTools)],
      ["memory", sumTokens(usage.memoryFiles)],
      ["agents", sumTokens(usage.agents)],
      ["commands", usage.slashCommands?.tokens ?? 0],
    ]
    let attributed = 0
    for (const [id, tokens] of derived) {
      if (tokens <= 0) continue
      attributed += tokens
      groups.push(
        makeGroup(id, tokens, maxTokens, {
          key: uniqueKey(id),
          items: itemsFor(usage, id),
          count: declaredCount(usage, id),
        })
      )
    }
    const messages = usedTokens - attributed
    if (messages > 0) {
      groups.push(makeGroup("messages", messages, maxTokens, { key: uniqueKey("messages") }))
    }
  }

  if (!free && maxTokens > usedTokens) {
    free = makeGroup("free", maxTokens - usedTokens, maxTokens, { key: uniqueKey("free") })
  }

  groups.sort((a, b) => b.tokens - a.tokens)
  return { groups, free, usedTokens, maxTokens, source: "live", denominator: "window" }
}

/**
 * Build the same shape from the visible transcript. Used on every host the
 * live SDK query can't reach — the numbers are estimates, which the `source`
 * flag makes the view say out loud.
 */
export function buildEstimateContextBreakdown(
  messages: UIMessage[],
  usedTokens: number,
  maxTokens: number
): ContextBreakdown {
  const { rows, totalTokens } = buildContextSourceBreakdown(messages)
  const groups = rows.map((row) => makeGroup(row.id, row.tokens, totalTokens, {}))
  groups.sort((a, b) => b.tokens - a.tokens)
  // No free-space row here on purpose. The estimate only sees the transcript,
  // so `max - used` is not headroom it measured — it is the part of the window
  // it is blind to, and drawing it as "free" would be a fabricated fact.
  return {
    groups,
    free: null,
    usedTokens,
    maxTokens,
    source: "estimate",
    denominator: "attributed",
  }
}

/**
 * Where the auto-compaction threshold shown next to the window bar comes from.
 *
 * The renderer used to draw "Auto-compact at 83.5%" unconditionally. That is a
 * claim about behaviour, and it is false in three real cases: the CLI's
 * threshold was moved, auto-compaction was turned off, or the turn ran on an
 * external agent that compacts on its own terms (every external protocol
 * reports `context-management: unsupported`). Resolve it instead of asserting.
 */
export interface AutoCompactionPolicy {
  /** Fraction of the window at which compaction fires — null when unknown. */
  threshold: number | null
  enabled: boolean
  source: "sdk" | "builtin" | "agent-owned" | "unknown"
}

/**
 * `sdkUsage` is authoritative when present. Otherwise the built-in sidecar's
 * own constant applies — but only to turns the sidecar actually ran.
 */
export function resolveAutoCompaction(
  sdkUsage: SdkContextUsage | null | undefined,
  opts: { occupancyReported: boolean; agentOwned: boolean }
): AutoCompactionPolicy {
  if (sdkUsage) {
    const enabled = sdkUsage.isAutoCompactEnabled ?? true
    const raw = sdkUsage.autoCompactThreshold
    // The field is a fraction in every observed payload, but a build reporting
    // an absolute token count would otherwise render as a 9200%-style nonsense
    // marker, so normalise anything above 1 against the window.
    const threshold =
      raw === undefined
        ? AUTO_COMPACT_FRACTION
        : raw > 1
          ? sdkUsage.maxTokens > 0
            ? Math.min(1, raw / sdkUsage.maxTokens)
            : null
          : raw
    return { threshold: enabled ? threshold : null, enabled, source: "sdk" }
  }
  if (opts.agentOwned) return { threshold: null, enabled: false, source: "agent-owned" }
  if (!opts.occupancyReported) return { threshold: null, enabled: false, source: "unknown" }
  return { threshold: AUTO_COMPACT_FRACTION, enabled: true, source: "builtin" }
}
