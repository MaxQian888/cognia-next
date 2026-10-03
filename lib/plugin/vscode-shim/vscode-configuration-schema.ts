/**
 * A VS Code extension's `contributes.configuration` as a plugin
 * `configSchema`, and its `package.nls*.json` strings.
 *
 * Settings keep their VS Code keys (`myExt.server.path`) as flat schema
 * property names, so the plugin settings form shows and stores them, and
 * the extension reads them back under the same keys. Text written as
 * `%key%` is looked up in `package.nls.json` (VS Code's default bundle).
 *
 * Mapped: types (the first non-`null` of a type list; inferred from the
 * default when absent), defaults, descriptions (plain and Markdown), enums
 * with their labels and descriptions, numeric and length bounds, patterns
 * and their messages, `uri` / `email` formats and multi-line text, order,
 * scope and deprecation, nested `items` / `properties`. Dropped, each with a
 * warning: properties with no type and no default (nothing to show),
 * `configurationDefaults` (language-specific defaults; there are no
 * language overrides here).
 */

import type {
  PluginConfigProperty,
  PluginConfigSchema,
  PluginConfigScope,
} from "@/types/plugin/plugin"
import type {
  VsCodeConfigurationProperty,
  VsCodeConfigurationSection,
  VsCodeManifest,
} from "@/types/plugin/plugin-vscode"

/** The default bundle, and one bundle per app locale. */
export interface NlsBundles {
  defaults: Record<string, string>
  /** App locale (`en`, `zh-CN`, …) → key → text. */
  locales: Record<string, Record<string, string>>
}

const NLS_FILE = /^package\.nls(?:\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*))?\.json$/

/** A VS Code locale id (`zh-cn`, `pt-br`) as the app spells it (`zh-CN`, `pt-BR`). */
export function appLocaleOf(vscodeLocale: string): string {
  const [language, ...rest] = vscodeLocale.split("-")
  return [language.toLowerCase(), ...rest.map((part) => part.toUpperCase())].join("-")
}

function stringEntries(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, text] of Object.entries(value)) {
    // VS Code also allows `{ message, comment }` entries.
    if (typeof text === "string") out[key] = text
    else if (text && typeof (text as { message?: unknown }).message === "string") {
      out[key] = (text as { message: string }).message
    }
  }
  return out
}

/** Read every `package.nls*.json` at the extension's root. Unparseable bundles are skipped with a warning. */
export function readNlsBundles(
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[]
): NlsBundles {
  const bundles: NlsBundles = { defaults: {}, locales: {} }
  for (const [path, bytes] of files) {
    const match = NLS_FILE.exec(path)
    if (!match) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, ""))
    } catch {
      warnings.push(`Skipped ${path}: it is not valid JSON.`)
      continue
    }
    const entries = stringEntries(parsed)
    if (match[1] === undefined) bundles.defaults = entries
    else bundles.locales[appLocaleOf(match[1])] = entries
  }
  if (Object.keys(bundles.defaults).length > 0) {
    bundles.locales.en = { ...bundles.defaults, ...(bundles.locales.en ?? {}) }
  }
  return bundles
}

/** The `%key%` of a localizable string, if it is one. */
export function nlsKeyOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined
  const match = /^%([^%]+)%$/.exec(text.trim())
  return match ? match[1] : undefined
}

/** `text` with a `%key%` replaced by the default bundle's string (or left as written when missing). */
export function resolveNls(text: string, bundles: NlsBundles): string
export function resolveNls(text: string | undefined, bundles: NlsBundles): string | undefined
export function resolveNls(text: string | undefined, bundles: NlsBundles): string | undefined {
  const key = nlsKeyOf(text)
  return key !== undefined ? (bundles.defaults[key] ?? text) : text
}

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"])

function typeOf(property: VsCodeConfigurationProperty): PluginConfigProperty["type"] | undefined {
  const declared = Array.isArray(property.type)
    ? property.type
    : property.type !== undefined
      ? [property.type]
      : []
  const usable = declared.find((type) => type !== "null" && SCHEMA_TYPES.has(type))
  if (usable) return usable as PluginConfigProperty["type"]
  const value = property.default
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return "array"
  const runtime = typeof value
  return runtime === "string" ||
    runtime === "number" ||
    runtime === "boolean" ||
    runtime === "object"
    ? runtime
    : undefined
}

function scopeOf(scope: VsCodeConfigurationProperty["scope"]): PluginConfigScope | undefined {
  switch (scope) {
    case "application":
    case "machine":
    case "window":
    case "resource":
      return scope
    case "machine-overridable":
      return "machine"
    case "language-overridable":
      return "resource"
    default:
      return undefined
  }
}

function texts(list: unknown, bundles: NlsBundles): string[] | undefined {
  return Array.isArray(list)
    ? list.map((entry) => (typeof entry === "string" ? resolveNls(entry, bundles) : ""))
    : undefined
}

/** `enableFooBar` → `Enable Foo Bar`, as VS Code titles a setting. */
function humanize(segment: string): string {
  const words = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** VS Code's setting title: `server.path` under the extension prefix → `Server: Path`. */
export function settingTitle(key: string): string {
  const segments = key.split(".")
  const [name, ...categories] = (segments.length > 1 ? segments.slice(1) : segments).reverse()
  const category = categories.reverse().map(humanize).join(" › ")
  return category ? `${category}: ${humanize(name)}` : humanize(name)
}

function mapProperty(
  key: string,
  property: VsCodeConfigurationProperty,
  bundles: NlsBundles,
  warnings: string[],
  top: boolean
): PluginConfigProperty | undefined {
  const type = typeOf(property)
  if (!type) {
    warnings.push(`Setting "${key}" has no type and no default, so it is not shown in settings.`)
    return undefined
  }
  const out: PluginConfigProperty = { type }
  if (top) out.title = settingTitle(key)
  if (property.default !== undefined) out.default = property.default
  const description = resolveNls(property.description, bundles)
  if (description) out.description = description
  const markdown = resolveNls(property.markdownDescription, bundles)
  if (markdown) out.markdownDescription = markdown
  if (Array.isArray(property.enum)) out.enum = property.enum
  const enumDescriptions = texts(property.enumDescriptions, bundles)
  if (enumDescriptions) out.enumDescriptions = enumDescriptions
  const markdownEnum = texts(property.markdownEnumDescriptions, bundles)
  if (markdownEnum) out.markdownEnumDescriptions = markdownEnum
  const labels = texts(property.enumItemLabels, bundles)
  if (labels) out.enumItemLabels = labels
  if (typeof property.minimum === "number") out.minimum = property.minimum
  if (typeof property.maximum === "number") out.maximum = property.maximum
  if (typeof property.minLength === "number") out.minLength = property.minLength
  if (typeof property.maxLength === "number") out.maxLength = property.maxLength
  if (typeof property.pattern === "string") out.pattern = property.pattern
  const patternMessage = resolveNls(property.patternErrorMessage, bundles)
  if (patternMessage) out.patternMessage = patternMessage
  if (property.editPresentation === "multilineText") out.format = "textarea"
  else if (property.format === "uri" || property.format === "uri-reference") out.format = "uri"
  else if (property.format === "email") out.format = "email"
  if (typeof property.order === "number") out.order = property.order
  const scope = scopeOf(property.scope)
  if (scope) out.scope = scope
  const deprecation =
    resolveNls(property.markdownDeprecationMessage, bundles) ??
    resolveNls(property.deprecationMessage, bundles)
  if (deprecation) out.deprecationMessage = deprecation
  if (type === "array" && property.items && !Array.isArray(property.items)) {
    const items = mapProperty(`${key}[]`, property.items, bundles, warnings, false)
    if (items) out.items = items
  }
  if (type === "object" && property.properties) {
    const properties: Record<string, PluginConfigProperty> = {}
    for (const [name, child] of Object.entries(property.properties)) {
      const mapped = mapProperty(`${key}.${name}`, child, bundles, warnings, false)
      if (mapped) properties[name] = mapped
    }
    if (Object.keys(properties).length > 0) out.properties = properties
  }
  return out
}

function sectionsOf(contributes: VsCodeManifest["contributes"]): VsCodeConfigurationSection[] {
  const raw = contributes?.configuration
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list.filter(
    (section): section is VsCodeConfigurationSection =>
      Boolean(section) &&
      typeof section === "object" &&
      typeof (section as { properties?: unknown }).properties === "object" &&
      (section as { properties?: unknown }).properties !== null
  )
}

/**
 * The extension's settings as a `configSchema`, or `undefined` when it
 * contributes none. Sections are merged in order; a key declared twice keeps
 * its first declaration, as VS Code does.
 */
export function vscodeConfigurationToSchema(
  contributes: VsCodeManifest["contributes"],
  bundles: NlsBundles,
  warnings: string[]
): PluginConfigSchema | undefined {
  const properties: Record<string, PluginConfigProperty> = {}
  for (const section of sectionsOf(contributes)) {
    for (const [key, property] of Object.entries(section.properties)) {
      if (Object.hasOwn(properties, key)) continue
      if (!property || typeof property !== "object") continue
      const mapped = mapProperty(key, property, bundles, warnings, true)
      if (mapped) properties[key] = mapped
    }
  }
  if (
    contributes?.configurationDefaults &&
    Object.keys(contributes.configurationDefaults).length > 0
  ) {
    warnings.push(
      "configurationDefaults are not applied: settings have no language-specific values here."
    )
  }
  return Object.keys(properties).length > 0 ? { type: "object", properties } : undefined
}
