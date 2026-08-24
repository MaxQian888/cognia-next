/** Safe boundary between property editing and tree-owned component references. */

import type {
  A2UIAlertVariant,
  A2UIButtonVariant,
  A2UIChartType,
  A2UIComponent,
  A2UITextVariant,
  A2UIWidgetStatus,
  A2UITextComponent,
  A2UIButtonComponent,
  A2UITextFieldComponent,
  A2UIRadioGroupComponent,
  A2UIRowComponent,
  A2UIColumnComponent,
  A2UIImageComponent,
  A2UIDividerComponent,
  A2UIProgressComponent,
  A2UIBadgeComponent,
  A2UIToggleComponent,
  A2UIMockupFrameComponent,
} from "@/types/a2ui/schema"
import type {
  A2UIAvatarComponent,
  A2UIButtonGroupComponent,
  A2UIDropdownMenuComponent,
  A2UIHoverCardComponent,
  A2UILoadingComponent,
  A2UIPopoverComponent,
  A2UISheetComponent,
  A2UIMarkdownComponent,
  A2UISidebarComponent,
  A2UISkeletonComponent,
  A2UISpinnerComponent,
  A2UIToastComponent,
  A2UIToggleGroupComponent,
  A2UITooltipComponent,
} from "@/types/artifact/a2ui"
import type { A2UIAnimationType, AnimationDirection } from "@/types/a2ui/animation"
import { getComponentCollectionSlots } from "./component-tree"
import { deepClone } from "./data-model"

type UnknownRecord = Record<string, unknown>

const IMMUTABLE_KEYS = new Set(["id", "component"])
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])
const REQUIRED_REFERENCE_TYPES = new Set([
  "ContextMenu",
  "DropdownMenu",
  "Drawer",
  "HoverCard",
  "Popover",
  "Sheet",
])

export interface A2UIEnumPropertyDefinition {
  property: string
  options: readonly string[]
}

function enumProperty<T extends string>(
  property: string,
  options: readonly T[]
): A2UIEnumPropertyDefinition {
  return { property, options }
}

const ALIGN_START_OPTIONS = ["start", "center", "end"] as const
const SIDE_OPTIONS = ["top", "right", "bottom", "left"] as const
const SIZE_OPTIONS = ["sm", "md", "lg"] as const

const ENUM_PROPERTY_DEFINITIONS: Readonly<Record<string, readonly A2UIEnumPropertyDefinition[]>> = {
  Text: [
    enumProperty<A2UITextVariant>("variant", [
      "body",
      "heading1",
      "heading2",
      "heading3",
      "heading4",
      "caption",
      "code",
      "label",
    ]),
    enumProperty<NonNullable<A2UITextComponent["align"]>>("align", ["left", "center", "right"]),
  ],
  Button: [
    enumProperty<A2UIButtonVariant>("variant", [
      "default",
      "primary",
      "secondary",
      "destructive",
      "outline",
      "ghost",
      "link",
    ]),
    enumProperty<NonNullable<A2UIButtonComponent["iconPosition"]>>("iconPosition", [
      "left",
      "right",
    ]),
  ],
  TextField: [
    enumProperty<NonNullable<A2UITextFieldComponent["type"]>>("type", [
      "text",
      "email",
      "password",
      "number",
      "tel",
      "url",
    ]),
  ],
  RadioGroup: [
    enumProperty<NonNullable<A2UIRadioGroupComponent["orientation"]>>("orientation", [
      "horizontal",
      "vertical",
    ]),
  ],
  Row: [
    enumProperty<NonNullable<A2UIRowComponent["align"]>>("align", [
      "start",
      "center",
      "end",
      "stretch",
    ]),
    enumProperty<NonNullable<A2UIRowComponent["justify"]>>("justify", [
      "start",
      "center",
      "end",
      "between",
      "around",
      "evenly",
    ]),
  ],
  Column: [
    enumProperty<NonNullable<A2UIColumnComponent["align"]>>("align", [
      "start",
      "center",
      "end",
      "stretch",
    ]),
  ],
  Image: [
    enumProperty<NonNullable<A2UIImageComponent["objectFit"]>>("objectFit", [
      "contain",
      "cover",
      "fill",
      "none",
    ]),
  ],
  Chart: [
    enumProperty<A2UIChartType>("chartType", [
      "line",
      "bar",
      "pie",
      "area",
      "scatter",
      "radar",
      "donut",
    ]),
  ],
  Divider: [
    enumProperty<NonNullable<A2UIDividerComponent["orientation"]>>("orientation", [
      "horizontal",
      "vertical",
    ]),
  ],
  Progress: [
    enumProperty<NonNullable<A2UIProgressComponent["variant"]>>("variant", ["linear", "circular"]),
  ],
  Badge: [
    enumProperty<NonNullable<A2UIBadgeComponent["variant"]>>("variant", [
      "default",
      "secondary",
      "destructive",
      "outline",
    ]),
  ],
  Alert: [
    enumProperty<A2UIAlertVariant>("variant", [
      "default",
      "info",
      "success",
      "warning",
      "error",
      "destructive",
    ]),
  ],
  Toggle: [
    enumProperty<NonNullable<A2UIToggleComponent["variant"]>>("variant", ["default", "outline"]),
    enumProperty<NonNullable<A2UIToggleComponent["size"]>>("size", ["default", "sm", "lg"]),
  ],
  MockupFrame: [
    enumProperty<NonNullable<A2UIMockupFrameComponent["frameStyle"]>>("frameStyle", [
      "browser",
      "mobile",
      "desktop",
    ]),
  ],
  WidgetStatus: [
    enumProperty<A2UIWidgetStatus>("status", ["ready", "loading", "fallback", "error"]),
  ],
  Animation: [
    enumProperty<A2UIAnimationType>("type", [
      "fadeIn",
      "fadeOut",
      "slideIn",
      "slideOut",
      "scale",
      "bounce",
      "pulse",
      "shake",
      "highlight",
      "none",
    ]),
    enumProperty<AnimationDirection>("direction", ["up", "down", "left", "right"]),
  ],
  Loading: [enumProperty<NonNullable<A2UILoadingComponent["size"]>>("size", SIZE_OPTIONS)],
  Avatar: [enumProperty<NonNullable<A2UIAvatarComponent["size"]>>("size", SIZE_OPTIONS)],
  Tooltip: [enumProperty<NonNullable<A2UITooltipComponent["side"]>>("side", SIDE_OPTIONS)],
  Skeleton: [
    enumProperty<NonNullable<A2UISkeletonComponent["variant"]>>("variant", [
      "text",
      "circular",
      "rectangular",
    ]),
  ],
  Spinner: [enumProperty<NonNullable<A2UISpinnerComponent["size"]>>("size", SIZE_OPTIONS)],
  Toast: [
    enumProperty<NonNullable<A2UIToastComponent["variant"]>>("variant", [
      "default",
      "success",
      "error",
      "warning",
      "info",
      "loading",
    ]),
  ],
  DropdownMenu: [
    enumProperty<NonNullable<A2UIDropdownMenuComponent["align"]>>("align", ALIGN_START_OPTIONS),
    enumProperty<NonNullable<A2UIDropdownMenuComponent["side"]>>("side", SIDE_OPTIONS),
  ],
  Popover: [
    enumProperty<NonNullable<A2UIPopoverComponent["align"]>>("align", ALIGN_START_OPTIONS),
    enumProperty<NonNullable<A2UIPopoverComponent["side"]>>("side", SIDE_OPTIONS),
  ],
  HoverCard: [
    enumProperty<NonNullable<A2UIHoverCardComponent["align"]>>("align", ALIGN_START_OPTIONS),
    enumProperty<NonNullable<A2UIHoverCardComponent["side"]>>("side", SIDE_OPTIONS),
  ],
  Sheet: [enumProperty<NonNullable<A2UISheetComponent["side"]>>("side", SIDE_OPTIONS)],
  Sidebar: [enumProperty<NonNullable<A2UISidebarComponent["side"]>>("side", ["left", "right"])],
  Markdown: [
    enumProperty<NonNullable<A2UIMarkdownComponent["rhythm"]>>("rhythm", ["document", "chat"]),
  ],
  ToggleGroup: [
    enumProperty<NonNullable<A2UIToggleGroupComponent["size"]>>("size", ["sm", "default", "lg"]),
  ],
  ButtonGroup: [
    enumProperty<NonNullable<A2UIButtonGroupComponent["orientation"]>>("orientation", [
      "horizontal",
      "vertical",
    ]),
  ],
}

/** Discover every constrained enum property, including optional fields not yet present. */
export function getA2UIEnumPropertyDefinitions(
  componentType: string
): readonly A2UIEnumPropertyDefinition[] {
  return ENUM_PROPERTY_DEFINITIONS[componentType] ?? []
}

/** Return one constrained enum editor definition when the schema declares it. */
export function getA2UIEnumPropertyDefinition(
  componentType: string,
  property: string
): A2UIEnumPropertyDefinition | undefined {
  return getA2UIEnumPropertyDefinitions(componentType).find(
    (definition) => definition.property === property
  )
}

function hasValidEnumPropertyChanges(
  componentType: string,
  source: UnknownRecord,
  properties: UnknownRecord
): boolean {
  return getA2UIEnumPropertyDefinitions(componentType).every((definition) => {
    if (!Object.prototype.hasOwnProperty.call(properties, definition.property)) return true
    const value = properties[definition.property]
    return (
      definition.options.includes(value as string) || Object.is(value, source[definition.property])
    )
  })
}

function structuralPropertyKeys(component: A2UIComponent): Set<string> {
  const keys = new Set<string>()
  for (const slot of getComponentCollectionSlots(component)) {
    const topLevelKey = slot.id.split("/")[1]
    if (topLevelKey) keys.add(topLevelKey)
  }

  const record = component as unknown as UnknownRecord
  if (REQUIRED_REFERENCE_TYPES.has(component.component) || typeof record.trigger === "string") {
    keys.add("trigger")
  }
  if (component.component === "List" || (record.template as UnknownRecord | undefined)?.itemId) {
    keys.add("template")
  }
  if (component.component === "Tabs") keys.add("tabs")
  if (component.component === "Accordion") keys.add("items")
  if (component.component === "InteractiveGuide") keys.add("steps")
  return keys
}

function isJsonCompatible(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (ancestors.has(value)) return false

  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false

  const nextAncestors = new Set(ancestors).add(value)
  if (Array.isArray(value)) return value.every((entry) => isJsonCompatible(entry, nextAncestors))
  return Object.entries(value as UnknownRecord).every(
    ([key, entry]) => !UNSAFE_KEYS.has(key) && isJsonCompatible(entry, nextAncestors)
  )
}

interface CollectionMetadataConfig {
  field: "tabs" | "items" | "steps"
  referenceField: "children" | "content"
  allowedFields: ReadonlySet<string>
  validate: (entry: UnknownRecord) => boolean
}

function isStringOrPath(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (isJsonCompatible(value) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as UnknownRecord).path === "string")
  )
}

function optionalType(value: unknown, type: "string" | "boolean"): boolean {
  return value === undefined || typeof value === type
}

function collectionMetadataConfig(component: A2UIComponent): CollectionMetadataConfig | null {
  switch (component.component) {
    case "Tabs":
      return {
        field: "tabs",
        referenceField: "children",
        allowedFields: new Set(["id", "label", "icon", "disabled"]),
        validate: (entry) =>
          typeof entry.id === "string" &&
          entry.id.length > 0 &&
          typeof entry.label === "string" &&
          optionalType(entry.icon, "string") &&
          optionalType(entry.disabled, "boolean"),
      }
    case "Accordion":
      return {
        field: "items",
        referenceField: "children",
        allowedFields: new Set(["id", "title", "defaultOpen"]),
        validate: (entry) =>
          typeof entry.id === "string" &&
          entry.id.length > 0 &&
          typeof entry.title === "string" &&
          optionalType(entry.defaultOpen, "boolean"),
      }
    case "InteractiveGuide":
      return {
        field: "steps",
        referenceField: "content",
        allowedFields: new Set(["id", "title", "description", "action", "icon", "isOptional"]),
        validate: (entry) =>
          typeof entry.id === "string" &&
          entry.id.length > 0 &&
          isStringOrPath(entry.title) &&
          (entry.description === undefined || isStringOrPath(entry.description)) &&
          optionalType(entry.action, "string") &&
          optionalType(entry.icon, "string") &&
          optionalType(entry.isOptional, "boolean"),
      }
    default:
      return null
  }
}

/** Return editable metadata for structural slots, excluding component references. */
export function getEditableStructuralMetadata(component: A2UIComponent): Record<string, unknown> {
  const source = component as unknown as UnknownRecord
  if (component.component === "List") {
    const template = source.template
    if (
      typeof template === "object" &&
      template !== null &&
      !Array.isArray(template) &&
      typeof (template as UnknownRecord).itemId === "string" &&
      typeof (template as UnknownRecord).dataPath === "string"
    ) {
      return { template: { dataPath: (template as UnknownRecord).dataPath } }
    }
    return {}
  }

  const config = collectionMetadataConfig(component)
  const entries = config ? source[config.field] : undefined
  if (!config || !Array.isArray(entries)) return {}
  return {
    [config.field]: entries.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return {}
      return Object.fromEntries(
        Object.entries(entry as UnknownRecord)
          .filter(([key, value]) => config.allowedFields.has(key) && isJsonCompatible(value))
          .map(([key, value]) => [key, deepClone(value)])
      )
    }),
  }
}

/** Replace structural metadata while preserving all child/content/itemId references. */
export function replaceEditableStructuralMetadata(
  component: A2UIComponent,
  metadata: Record<string, unknown>
): A2UIComponent | null {
  const source = component as unknown as UnknownRecord
  if (component.component === "List") {
    if (Object.keys(metadata).length !== 1 || !isRecordValue(metadata.template)) return null
    const nextTemplateMetadata = metadata.template
    if (
      Object.keys(nextTemplateMetadata).some((key) => key !== "dataPath") ||
      typeof nextTemplateMetadata.dataPath !== "string" ||
      !isRecordValue(source.template) ||
      typeof source.template.itemId !== "string"
    ) {
      return null
    }
    return {
      ...source,
      template: { ...source.template, dataPath: nextTemplateMetadata.dataPath },
    } as unknown as A2UIComponent
  }

  const config = collectionMetadataConfig(component)
  if (
    !config ||
    Object.keys(metadata).length !== 1 ||
    !Array.isArray(metadata[config.field]) ||
    !Array.isArray(source[config.field])
  ) {
    return null
  }

  const existingEntries = source[config.field] as unknown[]
  if (existingEntries.some((entry) => !isRecordValue(entry) || typeof entry.id !== "string")) {
    return null
  }
  const existingById = new Map(
    (existingEntries as UnknownRecord[]).map((entry) => [entry.id as string, entry])
  )
  const nextMetadata = metadata[config.field] as unknown[]
  if (
    nextMetadata.some(
      (entry) =>
        !isRecordValue(entry) ||
        Object.keys(entry).some((key) => !config.allowedFields.has(key)) ||
        !isJsonCompatible(entry) ||
        !config.validate(entry)
    )
  ) {
    return null
  }

  const metadataEntries = nextMetadata as UnknownRecord[]
  const ids = metadataEntries.map((entry) => entry.id as string)
  if (new Set(ids).size !== ids.length) return null
  for (const [id, existing] of existingById) {
    if (!ids.includes(id) && referenceIds(existing[config.referenceField]).length > 0) return null
  }

  const nextEntries = metadataEntries.map((entry) => {
    const id = entry.id as string
    const existing = existingById.get(id)
    const preservedUnknownEntries = existing
      ? Object.entries(existing).filter(
          ([key]) => !config.allowedFields.has(key) && key !== config.referenceField
        )
      : []
    return Object.fromEntries([
      ...preservedUnknownEntries,
      ...Object.entries(entry).map(([key, value]) => [key, deepClone(value)]),
      [config.referenceField, existing ? referenceIds(existing[config.referenceField]) : []],
    ])
  })

  return { ...source, [config.field]: nextEntries } as unknown as A2UIComponent
}

function isRecordValue(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function referenceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

/** Return only properties owned by the inspector, as a detached JSON-compatible object. */
export function getEditableComponentProperties(component: A2UIComponent): Record<string, unknown> {
  const structuralKeys = structuralPropertyKeys(component)
  return Object.fromEntries(
    Object.entries(component as unknown as UnknownRecord)
      .filter(
        ([key, value]) =>
          !IMMUTABLE_KEYS.has(key) && !structuralKeys.has(key) && isJsonCompatible(value)
      )
      .map(([key, value]) => [key, deepClone(value)])
  )
}

/**
 * Replace inspector-owned properties while preserving component identity and
 * every structural reference. Returns null for boundary violations.
 */
export function replaceEditableComponentProperties(
  component: A2UIComponent,
  properties: Record<string, unknown>
): A2UIComponent | null {
  const structuralKeys = structuralPropertyKeys(component)
  const propertyKeys = Object.keys(properties)
  if (
    propertyKeys.some(
      (key) =>
        IMMUTABLE_KEYS.has(key) ||
        UNSAFE_KEYS.has(key) ||
        structuralKeys.has(key) ||
        !isJsonCompatible(properties[key])
    )
  ) {
    return null
  }

  const source = component as unknown as UnknownRecord
  if (!hasValidEnumPropertyChanges(component.component, source, properties)) return null
  const preservedEntries = Object.entries(source).filter(
    ([key, value]) => IMMUTABLE_KEYS.has(key) || structuralKeys.has(key) || !isJsonCompatible(value)
  )
  return Object.fromEntries([
    ...preservedEntries,
    ...Object.entries(properties).map(([key, value]) => [key, deepClone(value)]),
  ]) as unknown as A2UIComponent
}
