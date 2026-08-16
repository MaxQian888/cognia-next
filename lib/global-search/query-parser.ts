/**
 * Global-search query syntax (ADR-0129).
 *
 *   >deploy              commands only (VS Code convention)
 *   @alice               people (characters, teams) only
 *   in:messages foo      restrict to a scope or a kind
 *   from:user foo        message author (`me` / `ai` aliases)
 *   is:archived foo      include archived conversations
 *   after:2026-08-01     inclusive lower bound (also `7d`, `2w`, `3m`, `1y`)
 *   before:2026-08-16    exclusive upper bound
 *   workspace:current    active workspace only
 *   title:foo            conversation titles only
 *
 * The parser is deliberately conservative: only `key:value` pairs whose key
 * AND value are recognised are consumed. Anything else — `http://x`, `foo:bar`
 * inside a stack trace, an unknown scope — stays in the free text, so a needle
 * the user typed literally is never silently dropped.
 */

import {
  GLOBAL_SEARCH_SCOPES,
  KIND_SCOPES,
  type GlobalSearchFilters,
  type GlobalSearchKind,
  type GlobalSearchScope,
  type ParsedFilterToken,
  type ParsedGlobalSearchQuery,
} from "./types"

const DAY_MS = 86_400_000

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  user: "user",
  me: "user",
  human: "user",
  assistant: "assistant",
  ai: "assistant",
  bot: "assistant",
  system: "system",
}

/** `in:` accepts scopes, kinds, and a few friendly aliases. */
const IN_ALIASES: Readonly<Record<string, GlobalSearchScope | GlobalSearchKind>> = {
  chat: "chats",
  chats: "chats",
  conversations: "chats",
  sessions: "session",
  session: "session",
  message: "message",
  messages: "messages",
  history: "messages",
  command: "commands",
  commands: "commands",
  actions: "action",
  page: "pages",
  pages: "pages",
  nav: "navigation",
  navigation: "navigation",
  settings: "settings",
  setting: "settings",
  people: "people",
  characters: "character",
  character: "character",
  teams: "team",
  team: "team",
  library: "library",
  workspaces: "workspace",
  workspace: "workspace",
  workflows: "workflow",
  workflow: "workflow",
  skills: "skill",
  skill: "skill",
  memory: "memory",
  memories: "memory",
  templates: "template",
  template: "template",
  tasks: "scheduled-task",
  task: "scheduled-task",
  schedule: "scheduled-task",
  scheduler: "scheduled-task",
  plugins: "plugin",
  plugin: "plugin",
  mcp: "mcp-server",
  inbox: "inbox-conversation",
  panels: "workbench-panel",
  panel: "workbench-panel",
}

function isScope(value: string): value is GlobalSearchScope {
  return (GLOBAL_SEARCH_SCOPES as readonly string[]).includes(value)
}

function isKind(value: string): value is GlobalSearchKind {
  return Object.prototype.hasOwnProperty.call(KIND_SCOPES, value)
}

/** Kinds that belong to a scope (`all` → every kind). */
export function kindsForScope(scope: GlobalSearchScope): GlobalSearchKind[] {
  const kinds = Object.keys(KIND_SCOPES) as GlobalSearchKind[]
  if (scope === "all") return kinds
  return kinds.filter((kind) => KIND_SCOPES[kind].includes(scope))
}

/**
 * Parse a date token. Accepts ISO dates (`2026-08-01`, `2026-08`, `2026`) and
 * relative windows (`7d`, `2w`, `3m`, `1y`, `today`, `yesterday`).
 * Returns the epoch ms at the *start* of that day, or `null`.
 */
export function parseDateToken(value: string, now: number): number | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (v === "today") return startOfToday.getTime()
  if (v === "yesterday") return startOfToday.getTime() - DAY_MS
  const rel = /^(\d{1,3})([dwmy])$/.exec(v)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    const days = unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365
    return startOfToday.getTime() - days * DAY_MS
  }
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(v)
  if (iso) {
    const year = Number(iso[1])
    const month = iso[2] ? Number(iso[2]) : 1
    const day = iso[3] ? Number(iso[3]) : 1
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const date = new Date(year, month - 1, day)
    if (date.getMonth() !== month - 1) return null
    return date.getTime()
  }
  return null
}

interface Consumed {
  filters: GlobalSearchFilters
  token: ParsedFilterToken | null
}

function consumeToken(key: string, value: string, source: string, now: number): Consumed | null {
  const k = key.toLowerCase()
  const v = value.toLowerCase()
  const token = { key: k, value: v, source }
  switch (k) {
    case "in": {
      const resolved = IN_ALIASES[v] ?? (isScope(v) || isKind(v) ? v : undefined)
      if (!resolved) return null
      const kinds = isScope(resolved) ? kindsForScope(resolved) : [resolved]
      return { filters: { kinds }, token }
    }
    case "from": {
      const role = ROLE_ALIASES[v]
      if (!role) return null
      return { filters: { roles: [role] }, token: { ...token, value: role } }
    }
    case "is": {
      if (v !== "archived") return null
      return { filters: { archived: true }, token }
    }
    case "after":
    case "since": {
      const at = parseDateToken(v, now)
      if (at === null) return null
      return { filters: { after: at }, token: { ...token, key: "after" } }
    }
    case "before":
    case "until": {
      const at = parseDateToken(v, now)
      if (at === null) return null
      // `before:2026-08-16` means "strictly earlier than that day": exclusive at
      // the *start* of that day, matching how people read a date bound.
      return { filters: { before: at }, token: { ...token, key: "before" } }
    }
    case "workspace":
    case "ws": {
      if (v === "current" || v === "this")
        return {
          filters: { workspace: "current" },
          token: { ...token, key: "workspace", value: "current" },
        }
      if (v === "all" || v === "any")
        return {
          filters: { workspace: "all" },
          token: { ...token, key: "workspace", value: "all" },
        }
      return null
    }
    case "title": {
      // `title:` alone flips the mode; `title:foo` also contributes the word.
      return { filters: { titleOnly: true }, token }
    }
    default:
      return null
  }
}

function mergeFilters(into: GlobalSearchFilters, add: GlobalSearchFilters): GlobalSearchFilters {
  const next: GlobalSearchFilters = { ...into }
  if (add.roles) next.roles = [...new Set([...(next.roles ?? []), ...add.roles])]
  if (add.kinds) {
    // Intersect successive `in:` tokens; an empty intersection means nothing.
    next.kinds = next.kinds ? next.kinds.filter((k) => add.kinds!.includes(k)) : [...add.kinds]
  }
  if (add.archived !== undefined) next.archived = add.archived
  if (add.after !== undefined) next.after = Math.max(next.after ?? -Infinity, add.after)
  if (add.before !== undefined) next.before = Math.min(next.before ?? Infinity, add.before)
  if (add.workspace) next.workspace = add.workspace
  if (add.titleOnly) next.titleOnly = true
  return next
}

/**
 * Split on whitespace but keep double-quoted phrases together (quotes are
 * stripped from the free text — search is substring, so they carry no meaning
 * beyond grouping).
 */
function tokenize(raw: string): Array<{ text: string; quoted: boolean }> {
  const out: Array<{ text: string; quoted: boolean }> = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) out.push({ text: m[1], quoted: true })
    else out.push({ text: m[2]!, quoted: false })
  }
  return out
}

export interface ParseOptions {
  now?: number
}

export function parseGlobalSearchQuery(
  raw: string,
  { now = Date.now() }: ParseOptions = {}
): ParsedGlobalSearchQuery {
  let body = raw
  let prefixScope: GlobalSearchScope | undefined
  const trimmedStart = raw.trimStart()
  if (trimmedStart.startsWith(">")) {
    prefixScope = "commands"
    body = trimmedStart.slice(1)
  } else if (trimmedStart.startsWith("@")) {
    prefixScope = "people"
    body = trimmedStart.slice(1)
  }

  let filters: GlobalSearchFilters = {}
  const tokens: ParsedFilterToken[] = []
  const words: string[] = []

  for (const part of tokenize(body)) {
    if (!part.quoted) {
      const colon = part.text.indexOf(":")
      if (colon > 0 && colon < part.text.length - 1) {
        const key = part.text.slice(0, colon)
        const value = part.text.slice(colon + 1)
        const consumed = consumeToken(key, value, part.text, now)
        if (consumed) {
          filters = mergeFilters(filters, consumed.filters)
          if (consumed.token) tokens.push(consumed.token)
          // `title:foo` keeps "foo" as the needle.
          if (consumed.token?.key === "title") words.push(value)
          continue
        }
      }
    }
    if (part.text.length > 0) words.push(part.text)
  }

  const text = words.join(" ").trim()
  return {
    raw,
    text,
    needle: text.toLowerCase(),
    prefixScope,
    filters,
    tokens,
  }
}

/** Effective scope: an explicit prefix wins over the tab the user is on. */
export function effectiveScope(
  parsed: ParsedGlobalSearchQuery,
  tab: GlobalSearchScope
): GlobalSearchScope {
  return parsed.prefixScope ?? tab
}

/** Kinds to run for a query on a tab, honouring `in:` and the prefix. */
export function kindsToRun(
  parsed: ParsedGlobalSearchQuery,
  tab: GlobalSearchScope
): GlobalSearchKind[] {
  const scoped = kindsForScope(effectiveScope(parsed, tab))
  const only = parsed.filters.kinds
  if (!only) return scoped
  const allowed = new Set(only)
  const intersection = scoped.filter((k) => allowed.has(k))
  // `in:` pointing outside the current tab still means what the user typed:
  // fall back to the filter itself rather than returning nothing.
  return intersection.length > 0 ? intersection : [...only]
}

/** Strip one recognised filter token from a raw query (chip "×" button). */
export function removeFilterToken(raw: string, token: ParsedFilterToken): string {
  const idx = raw.indexOf(token.source)
  if (idx < 0) return raw
  const before = raw.slice(0, idx)
  const after = raw.slice(idx + token.source.length)
  return `${before.trimEnd()} ${after.trimStart()}`.trim()
}

/** Append a filter token to a raw query, replacing an existing one for that key. */
export function setFilterToken(raw: string, key: string, value: string): string {
  const parsed = parseGlobalSearchQuery(raw)
  let next = raw
  for (const token of parsed.tokens) {
    if (token.key === key) next = removeFilterToken(next, token)
  }
  return `${next.trim()} ${key}:${value}`.trim()
}
