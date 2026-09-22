/** Ordered, synchronous link matching; plugin code runs only after a match mounts. */
import type { PluginLinkMatcherRegistrationDef } from "@/types/plugin/plugin-link-matcher"

export interface LinkMatcherEntry extends PluginLinkMatcherRegistrationDef {
  pluginId: string
  priority: number
}

interface CompiledPattern {
  protocol?: string
  hostname: string
  subdomains: boolean
  port: string
  path: string[]
  query: boolean
  fragment: boolean
}

interface Registration {
  entry: LinkMatcherEntry
  patterns: CompiledPattern[]
}

const registry: Registration[] = []
const listeners = new Set<() => void>()
let revision = 0

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function compilePattern(value: unknown): CompiledPattern {
  if (typeof value !== "string" || !value || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Link matcher patterns must be non-empty URL globs without whitespace")
  }
  const match = /^(?:(https?):\/\/)?([^/?#]+)(\/[^]*)?$/.exec(value)
  if (!match) throw new Error(`Invalid link matcher pattern: ${value}`)
  const [, scheme, authority, suffix = "/**"] = match
  const host = /^(\*\.)?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::([0-9]{1,5}))?$/.exec(
    authority
  )
  if (
    !host ||
    host[2].split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-")) ||
    (host[3] !== undefined && (Number(host[3]) < 1 || Number(host[3]) > 65535)) ||
    suffix.includes("***")
  ) {
    throw new Error(`Invalid link matcher host or glob: ${value}`)
  }
  const tokens: string[] = []
  for (let index = 0; index < suffix.length; index += 1) {
    const character = suffix[index]
    if (character === "*") {
      if (suffix[index + 1] === "*") {
        tokens.push("**")
        index += 1
      } else {
        tokens.push("*")
      }
    } else {
      tokens.push(character)
    }
  }
  return {
    protocol: scheme ? `${scheme}:` : undefined,
    hostname: host[2].toLowerCase(),
    subdomains: Boolean(host[1]),
    port: host[3] ? String(Number(host[3])) : "",
    path: tokens,
    query: suffix.includes("?"),
    fragment: suffix.includes("#"),
  }
}

/** NFA-style glob evaluation avoids exponential RegExp wildcard backtracking. */
function matchesPath(tokens: string[], path: string): boolean {
  let states = new Set([0])
  const expand = (active: Set<number>) => {
    for (const state of active) {
      if (tokens[state] === "*" || tokens[state] === "**") active.add(state + 1)
    }
  }
  expand(states)
  for (const character of path) {
    const next = new Set<number>()
    for (const state of states) {
      const token = tokens[state]
      if (token === "**" || (token === "*" && character !== "/")) next.add(state)
      else if (token === character) next.add(state + 1)
    }
    if (next.size === 0) return false
    expand(next)
    states = next
  }
  return states.has(tokens.length)
}

/** Shared by manifest validation and runtime registration. */
export function isValidLinkMatcherPattern(value: unknown): value is string {
  try {
    compilePattern(value)
    return true
  } catch {
    return false
  }
}

/** Validate untrusted manifest/programmatic input before any import or mutation. */
export function validateLinkMatcherDefinition(
  def: Pick<PluginLinkMatcherRegistrationDef, "id" | "patterns" | "label" | "priority">
): void {
  if (
    !def ||
    typeof def.id !== "string" ||
    !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(def.id) ||
    def.id.length > 128 ||
    ["__proto__", "constructor", "prototype"].includes(def.id)
  ) {
    throw new Error("Invalid or reserved link matcher id")
  }
  if (!Array.isArray(def.patterns) || def.patterns.length === 0) {
    throw new Error("Link matcher patterns must be a non-empty array")
  }
  for (const pattern of def.patterns) compilePattern(pattern)
  if (def.priority !== undefined && !Number.isFinite(def.priority)) {
    throw new Error("Link matcher priority must be a finite number")
  }
  if (def.label !== undefined && (typeof def.label !== "string" || !def.label.trim())) {
    throw new Error("Link matcher label must be a non-empty string")
  }
}

/** Component validation supports functions/classes, memo, forwardRef and lazy. */
export function isLinkMatcherComponent(value: unknown): boolean {
  if (typeof value === "function") return true
  if (!value || typeof value !== "object" || !("$$typeof" in value)) return false
  return [
    Symbol.for("react.memo"),
    Symbol.for("react.forward_ref"),
    Symbol.for("react.lazy"),
  ].includes(value.$$typeof as symbol)
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** A disposer removes only its own registration and is safe after plugin purge. */
export function registerLinkMatcher(
  pluginId: string,
  def: PluginLinkMatcherRegistrationDef
): () => void {
  validateLinkMatcherDefinition(def)
  if (!isLinkMatcherComponent(def.component))
    throw new Error("Link matcher requires a React component")
  if (typeof pluginId !== "string" || !pluginId.trim())
    throw new Error("Link matcher requires a plugin id")
  if (registry.some(({ entry }) => entry.pluginId === pluginId && entry.id === def.id)) {
    throw new Error(`Plugin ${pluginId} already registered link matcher "${def.id}"`)
  }
  const registration: Registration = {
    entry: Object.freeze({
      ...def,
      patterns: Object.freeze([...def.patterns]) as unknown as string[],
      pluginId,
      priority: def.priority ?? 0,
    }),
    patterns: def.patterns.map(compilePattern),
  }
  registry.push(registration)
  registry.sort(
    (a, b) =>
      b.entry.priority - a.entry.priority ||
      compare(a.entry.pluginId, b.entry.pluginId) ||
      compare(a.entry.id, b.entry.id)
  )
  notify()
  return () => {
    const index = registry.indexOf(registration)
    if (index < 0) return
    registry.splice(index, 1)
    notify()
  }
}

/** Exact host boundary comparison prevents github.com.evil or userinfo spoofing. */
export function getLinkMatcher(href: string): LinkMatcherEntry | undefined {
  if (registry.length === 0) return undefined
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined
  return registry.find(({ patterns }) =>
    patterns.some((pattern) => {
      if (pattern.protocol && pattern.protocol !== url.protocol) return false
      const hostname = url.hostname.toLowerCase()
      if (
        pattern.subdomains
          ? !hostname.endsWith(`.${pattern.hostname}`)
          : hostname !== pattern.hostname
      )
        return false
      const port = url.port || (url.protocol === "https:" ? "443" : "80")
      if (pattern.port ? pattern.port !== port : Boolean(url.port)) return false
      return matchesPath(
        pattern.path,
        url.pathname + (pattern.query ? url.search : "") + (pattern.fragment ? url.hash : "")
      )
    })
  )?.entry
}

export function clearLinkMatchersForPlugin(pluginId: string): void {
  const remaining = registry.filter(({ entry }) => entry.pluginId !== pluginId)
  if (remaining.length === registry.length) return
  registry.splice(0, registry.length, ...remaining)
  notify()
}

export function clearAllLinkMatchers(): void {
  if (registry.length === 0) return
  registry.length = 0
  notify()
}

export function listLinkMatchers(): LinkMatcherEntry[] {
  return registry.map(({ entry }) => entry)
}

export function subscribeLinkMatchers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLinkMatchersRevision(): number {
  return revision
}
