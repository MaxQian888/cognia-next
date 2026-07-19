/**
 * Validation boundary for portable A2UI app and backup payloads.
 *
 * JSON imports are untrusted even when they came from Cognia previously. This
 * module validates resource bounds, JSON safety, component-graph integrity,
 * data bindings, surface metadata, and instance metadata before the app store
 * or renderer sees any value.
 */

import type { Locale } from "@/i18n/config"
import type { A2UIComponent, A2UISurfaceType, A2UIWidgetMetadata } from "@/types/a2ui/schema"
import {
  collectComponentSubtreeIds,
  getComponentChildReferences,
  hasComponentReferenceCycle,
} from "./component-tree"
import {
  collectComponentDataPaths,
  isA2UIDataModel,
  isSafeDataModelKey,
  parseJsonPointer,
} from "./data-model"

export const A2UI_APP_EXPORT_VERSION = "1.0"
export const A2UI_MAX_IMPORT_BYTES = 10 * 1024 * 1024
export const A2UI_MAX_BACKUP_APPS = 1_000
export const A2UI_MAX_COMPONENTS_PER_APP = 5_000

const MAX_JSON_DEPTH = 100
const MAX_JSON_NODES = 100_000
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"])
const SURFACE_TYPES = new Set<A2UISurfaceType>(["inline", "dialog", "panel", "fullscreen"])
const WIDGET_HOST_STRATEGIES = new Set([
  "native",
  "artifact-preview",
  "sandboxed-html",
  "lazy-runtime",
])
const WIDGET_SIZINGS = new Set(["auto", "content-height", "fixed-height"])
const WIDGET_THEMES = new Set(["inherit", "light", "dark"])
const WIDGET_STATUSES = new Set(["ready", "loading", "fallback", "error"])

type UnknownRecord = Record<string, unknown>

export type A2UIImportErrorCode =
  | "input_too_large"
  | "invalid_json"
  | "invalid_envelope"
  | "unsupported_version"
  | "invalid_app"
  | "too_many_apps"

export interface A2UIImportError {
  code: A2UIImportErrorCode
  message: string
  appIndex?: number
}

export type A2UIImportResult<T> =
  { success: true; value: T } | { success: false; error: A2UIImportError }

export interface A2UIImportedAuthor {
  name?: string
  email?: string
  url?: string
}

export interface A2UIImportedStats {
  views?: number
  uses?: number
  rating?: number
  ratingCount?: number
}

export interface A2UIImportedMetadata {
  createdAt?: number
  lastModified?: number
  description?: string
  version?: string
  author?: A2UIImportedAuthor
  category?: string
  tags?: string[]
  thumbnail?: string
  thumbnailUpdatedAt?: number
  stats?: A2UIImportedStats
  publishedAt?: number
  isPublished?: boolean
  storeId?: string
  screenshots?: string[]
}

export interface A2UIImportedApp {
  name: string
  templateId: string
  locale: Locale
  components: A2UIComponent[]
  dataModel: Record<string, unknown>
  surfaceType: A2UISurfaceType
  catalogId?: string
  title: string
  widget?: A2UIWidgetMetadata
  rootId: string
  metadata: A2UIImportedMetadata
}

export interface A2UIImportedBackup {
  apps: A2UIImportedApp[]
}

function failure(code: A2UIImportErrorCode, message: string): A2UIImportResult<never> {
  return { success: false, error: { code, message } }
}

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasImportSizeWithinLimit(jsonData: string): boolean {
  if (jsonData.length > A2UI_MAX_IMPORT_BYTES) return false
  return new TextEncoder().encode(jsonData).byteLength <= A2UI_MAX_IMPORT_BYTES
}

function parseJsonEnvelope(jsonData: string): A2UIImportResult<UnknownRecord> {
  if (!hasImportSizeWithinLimit(jsonData)) {
    return failure("input_too_large", "A2UI import exceeds the maximum payload size")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonData)
  } catch {
    return failure("invalid_json", "A2UI import is not valid JSON")
  }

  if (!isRecord(parsed)) {
    return failure("invalid_envelope", "A2UI import must be a JSON object")
  }
  if (!isSafeJsonTree(parsed)) {
    return failure("invalid_envelope", "A2UI import contains unsafe or excessive JSON data")
  }
  if (parsed.version !== undefined && parsed.version !== A2UI_APP_EXPORT_VERSION) {
    return failure("unsupported_version", "A2UI import version is not supported")
  }
  return { success: true, value: parsed }
}

function isSafeJsonTree(root: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  let nodes = 0

  while (pending.length > 0) {
    const { value, depth } = pending.pop()!
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      continue
    }
    if (typeof value !== "object") return false

    if (Array.isArray(value)) {
      for (const entry of value) pending.push({ value: entry, depth: depth + 1 })
      continue
    }
    if (!isRecord(value)) return false
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) return false
      pending.push({ value: entry, depth: depth + 1 })
    }
  }
  return true
}

function optionalString(record: UnknownRecord, key: string): string | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === "string" ? value : null
}

function optionalFiniteNumber(record: UnknownRecord, key: string): number | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function validateWidget(value: unknown): A2UIWidgetMetadata | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null

  if (
    (value.hostStrategy !== undefined &&
      (typeof value.hostStrategy !== "string" ||
        !WIDGET_HOST_STRATEGIES.has(value.hostStrategy))) ||
    (value.sizing !== undefined &&
      (typeof value.sizing !== "string" || !WIDGET_SIZINGS.has(value.sizing))) ||
    (value.theme !== undefined &&
      (typeof value.theme !== "string" || !WIDGET_THEMES.has(value.theme))) ||
    (value.status !== undefined &&
      (typeof value.status !== "string" || !WIDGET_STATUSES.has(value.status))) ||
    (value.showChrome !== undefined && typeof value.showChrome !== "boolean") ||
    (value.fallbackText !== undefined && typeof value.fallbackText !== "string") ||
    (value.minHeight !== undefined &&
      (typeof value.minHeight !== "number" ||
        !Number.isFinite(value.minHeight) ||
        value.minHeight < 0))
  ) {
    return null
  }

  return {
    hostStrategy: value.hostStrategy as A2UIWidgetMetadata["hostStrategy"],
    sizing: value.sizing as A2UIWidgetMetadata["sizing"],
    theme: value.theme as A2UIWidgetMetadata["theme"],
    status: value.status as A2UIWidgetMetadata["status"],
    showChrome: value.showChrome as boolean | undefined,
    fallbackText: value.fallbackText as string | undefined,
    minHeight: value.minHeight as number | undefined,
  }
}

function validateStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null
  return [...value] as string[]
}

function validateAuthor(value: unknown): A2UIImportedAuthor | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const name = optionalString(value, "name")
  const email = optionalString(value, "email")
  const url = optionalString(value, "url")
  if (name === null || email === null || url === null) return null
  return { name, email, url }
}

function validateStats(value: unknown): A2UIImportedStats | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const views = optionalFiniteNumber(value, "views")
  const uses = optionalFiniteNumber(value, "uses")
  const rating = optionalFiniteNumber(value, "rating")
  const ratingCount = optionalFiniteNumber(value, "ratingCount")
  if (
    views === null ||
    uses === null ||
    rating === null ||
    ratingCount === null ||
    (rating !== undefined && rating > 5)
  ) {
    return null
  }
  return { views, uses, rating, ratingCount }
}

function validateMetadata(app: UnknownRecord): A2UIImportedMetadata | null {
  const createdAt = optionalFiniteNumber(app, "createdAt")
  const lastModified = optionalFiniteNumber(app, "lastModified")
  const description = optionalString(app, "description")
  const version = optionalString(app, "version")
  const author = validateAuthor(app.author)
  const category = optionalString(app, "category")
  const tags = validateStringArray(app.tags)
  const thumbnail = optionalString(app, "thumbnail")
  const thumbnailUpdatedAt = optionalFiniteNumber(app, "thumbnailUpdatedAt")
  const stats = validateStats(app.stats)
  const publishedAt = optionalFiniteNumber(app, "publishedAt")
  const storeId = optionalString(app, "storeId")
  const screenshots = validateStringArray(app.screenshots)
  if (
    createdAt === null ||
    lastModified === null ||
    description === null ||
    version === null ||
    author === null ||
    category === null ||
    tags === null ||
    thumbnail === null ||
    thumbnailUpdatedAt === null ||
    stats === null ||
    publishedAt === null ||
    storeId === null ||
    screenshots === null ||
    (app.isPublished !== undefined && typeof app.isPublished !== "boolean")
  ) {
    return null
  }

  const metadata: A2UIImportedMetadata = {}
  if (createdAt !== undefined) metadata.createdAt = createdAt
  if (lastModified !== undefined) metadata.lastModified = lastModified
  if (description !== undefined) metadata.description = description
  if (version !== undefined) metadata.version = version
  if (author !== undefined) metadata.author = author
  if (category !== undefined) metadata.category = category
  if (tags !== undefined) metadata.tags = tags
  if (thumbnail !== undefined) metadata.thumbnail = thumbnail
  if (thumbnailUpdatedAt !== undefined) metadata.thumbnailUpdatedAt = thumbnailUpdatedAt
  if (stats !== undefined) metadata.stats = stats
  if (publishedAt !== undefined) metadata.publishedAt = publishedAt
  if (app.isPublished !== undefined) metadata.isPublished = app.isPublished
  if (storeId !== undefined) metadata.storeId = storeId
  if (screenshots !== undefined) metadata.screenshots = screenshots
  return metadata
}

function isValidDataPointer(path: string): boolean {
  try {
    return parseJsonPointer(path).every((segment) => isSafeDataModelKey(segment))
  } catch {
    return false
  }
}

function hasValidComponentShape(component: UnknownRecord): boolean {
  for (const field of ["children", "footer", "actions"] as const) {
    const value = component[field]
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    ) {
      return false
    }
  }

  for (const field of ["tabs", "items"] as const) {
    const entries = component[field]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (
        isRecord(entry) &&
        entry.children !== undefined &&
        (!Array.isArray(entry.children) ||
          entry.children.some((childId) => typeof childId !== "string"))
      ) {
        return false
      }
    }
  }

  if (Array.isArray(component.steps)) {
    for (const step of component.steps) {
      if (
        isRecord(step) &&
        step.content !== undefined &&
        (!Array.isArray(step.content) ||
          step.content.some((childId) => typeof childId !== "string"))
      ) {
        return false
      }
    }
  }
  if (component.trigger !== undefined && typeof component.trigger !== "string") return false
  if (
    isRecord(component.template) &&
    component.template.itemId !== undefined &&
    typeof component.template.itemId !== "string"
  ) {
    return false
  }

  const pending: unknown[] = [component]
  while (pending.length > 0) {
    const value = pending.pop()
    if (!value || typeof value !== "object") continue
    if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "path")) {
      const path = (value as UnknownRecord).path
      if (typeof path !== "string" || !isValidDataPointer(path)) return false
    }
    pending.push(...(Array.isArray(value) ? value : Object.values(value)))
  }
  return true
}

function validateComponentGraph(
  value: unknown,
  requestedRootId: unknown
): A2UIImportResult<{ components: A2UIComponent[]; rootId: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > A2UI_MAX_COMPONENTS_PER_APP) {
    return failure("invalid_app", "A2UI app must contain a bounded, non-empty component list")
  }

  const components: A2UIComponent[] = []
  const componentMap: Record<string, A2UIComponent> = Object.create(null)
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      candidate.id.trim().length === 0 ||
      UNSAFE_OBJECT_KEYS.has(candidate.id) ||
      typeof candidate.component !== "string" ||
      candidate.component.trim().length === 0 ||
      !hasValidComponentShape(candidate) ||
      componentMap[candidate.id]
    ) {
      return failure("invalid_app", "A2UI app contains an invalid or duplicate component")
    }
    const component = candidate as unknown as A2UIComponent
    components.push(component)
    componentMap[component.id] = component
  }

  const incoming = new Map(components.map((component) => [component.id, 0]))
  for (const component of components) {
    for (const reference of getComponentChildReferences(component)) {
      if (!componentMap[reference.id]) {
        return failure("invalid_app", "A2UI component graph contains a missing reference")
      }
      const count = (incoming.get(reference.id) ?? 0) + 1
      if (count > 1) {
        return failure("invalid_app", "A2UI component graph is not a tree")
      }
      incoming.set(reference.id, count)
    }

    for (const path of collectComponentDataPaths(component)) {
      if (!isValidDataPointer(path)) {
        return failure("invalid_app", "A2UI component contains an invalid data path")
      }
    }
  }

  let rootId: string
  if (requestedRootId !== undefined) {
    if (typeof requestedRootId !== "string" || !componentMap[requestedRootId]) {
      return failure("invalid_app", "A2UI app rootId does not identify a component")
    }
    rootId = requestedRootId
  } else {
    const candidates = components.filter((component) => incoming.get(component.id) === 0)
    if (candidates.length !== 1) {
      return failure("invalid_app", "A2UI app does not have one unambiguous root component")
    }
    rootId = candidates[0].id
  }

  if (incoming.get(rootId) !== 0 || hasComponentReferenceCycle(componentMap, rootId)) {
    return failure("invalid_app", "A2UI component graph contains an invalid root or cycle")
  }
  if (collectComponentSubtreeIds(componentMap, rootId).size !== components.length) {
    return failure("invalid_app", "A2UI component graph contains detached components")
  }
  return { success: true, value: { components, rootId } }
}

function validateImportedApp(
  value: unknown,
  fallbackLocale: Locale
): A2UIImportResult<A2UIImportedApp> {
  if (!isRecord(value)) {
    return failure("invalid_app", "A2UI import does not contain an app object")
  }

  const graph = validateComponentGraph(value.components, value.rootId)
  if (!graph.success) return graph

  const dataModel = value.dataModel === undefined ? {} : value.dataModel
  if (!isA2UIDataModel(dataModel)) {
    return failure("invalid_app", "A2UI app contains an invalid data model")
  }

  const surfaceType = value.surfaceType === undefined ? "inline" : value.surfaceType
  if (typeof surfaceType !== "string" || !SURFACE_TYPES.has(surfaceType as A2UISurfaceType)) {
    return failure("invalid_app", "A2UI app contains an invalid surface type")
  }
  const widget = validateWidget(value.widget)
  if (widget === null) {
    return failure("invalid_app", "A2UI app contains invalid widget metadata")
  }

  const rawName = optionalString(value, "name")
  const rawTemplateId = optionalString(value, "templateId")
  const catalogId = optionalString(value, "catalogId")
  const rawTitle = optionalString(value, "title")
  if (rawName === null || rawTemplateId === null || catalogId === null || rawTitle === null) {
    return failure("invalid_app", "A2UI app contains invalid string metadata")
  }
  const metadata = validateMetadata(value)
  if (!metadata) {
    return failure("invalid_app", "A2UI app contains invalid instance metadata")
  }

  const defaultName = fallbackLocale === "zh-CN" ? "导入的应用" : "Imported App"
  const name = rawName?.trim() || defaultName
  const templateId = rawTemplateId?.trim() || "imported"
  const locale: Locale =
    value.locale === "zh-CN" || value.locale === "en" ? value.locale : fallbackLocale

  return {
    success: true,
    value: {
      name,
      templateId,
      locale,
      components: graph.value.components,
      dataModel,
      surfaceType: surfaceType as A2UISurfaceType,
      catalogId,
      title: rawTitle?.trim() || name,
      widget,
      rootId: graph.value.rootId,
      metadata,
    },
  }
}

export function parseA2UIAppImport(
  jsonData: string,
  fallbackLocale: Locale
): A2UIImportResult<A2UIImportedApp> {
  const envelope = parseJsonEnvelope(jsonData)
  if (!envelope.success) return envelope
  return validateImportedApp(envelope.value.app, fallbackLocale)
}

export function parseA2UIBackupImport(
  jsonData: string,
  fallbackLocale: Locale
): A2UIImportResult<A2UIImportedBackup> {
  const envelope = parseJsonEnvelope(jsonData)
  if (!envelope.success) return envelope
  if (!Array.isArray(envelope.value.apps)) {
    return failure("invalid_envelope", "A2UI backup must contain an apps array")
  }
  if (envelope.value.apps.length > A2UI_MAX_BACKUP_APPS) {
    return failure("too_many_apps", "A2UI backup contains too many apps")
  }

  const apps: A2UIImportedApp[] = []
  for (let index = 0; index < envelope.value.apps.length; index += 1) {
    const result = validateImportedApp(envelope.value.apps[index], fallbackLocale)
    if (!result.success) {
      return {
        success: false,
        error: { ...result.error, code: "invalid_app", appIndex: index },
      }
    }
    apps.push(result.value)
  }
  return { success: true, value: { apps } }
}
