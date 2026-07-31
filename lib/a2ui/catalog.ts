/**
 * A2UI Component Catalog
 * Registry for mapping A2UI component types to React implementations
 */

import type {
  A2UIComponentType,
  A2UIComponent,
  A2UICatalogEntry,
  A2UIComponentCatalog,
  A2UIComponentProps,
  A2UIWidgetMetadata,
} from "@/types/a2ui/schema"
import { routeRichOutputProfile } from "./output-profiles"

/**
 * Default catalog ID
 */
export const DEFAULT_CATALOG_ID = "cognia-standard-v1"

/**
 * Standard component catalog with component type mappings
 * React components are registered separately via registerComponent
 */
const standardCatalogDefinition: Omit<A2UIComponentCatalog, "components"> & {
  componentTypes: A2UIComponentType[]
} = {
  id: DEFAULT_CATALOG_ID,
  name: "Cognia Standard Catalog",
  version: "1.0.0",
  componentTypes: [
    "Text",
    "Button",
    "TextField",
    "TextArea",
    "Select",
    "Checkbox",
    "Radio",
    "RadioGroup",
    "Slider",
    "DatePicker",
    "TimePicker",
    "DateTimePicker",
    "Card",
    "Row",
    "Column",
    "List",
    "Image",
    "Chart",
    "Table",
    "Dialog",
    "Divider",
    "Spacer",
    "Progress",
    "Badge",
    "Alert",
    "Link",
    "Icon",
    "RichOutput",
    "ComparisonCards",
    "StepperShell",
    "MockupFrame",
    "WidgetStatus",
    "Switch",
    "Loading",
    "Error",
    "Empty",
    "Animation",
    "InteractiveGuide",
    "Avatar",
    "Tooltip",
    "Skeleton",
    "Spinner",
    "Toast",
    "Combobox",
    "DropdownMenu",
    "ContextMenu",
    "Popover",
    "HoverCard",
    "Breadcrumb",
    "Carousel",
    "Drawer",
    "Sheet",
    "ScrollArea",
    "Pagination",
    "Sidebar",
    "InputOTP",
    "ToggleGroup",
    "ButtonGroup",
    "InputGroup",
    "Collapsible",
    "Tabs",
    "Accordion",
    "Toggle",
    "FormGroup",
    "AcademicAnalysis",
    "AcademicSearchResults",
  ],
}

/**
 * Component registry - stores React component implementations
 */
const componentRegistry = new Map<string, A2UICatalogEntry>()

/**
 * Catalog registry - stores catalog definitions
 */
const catalogRegistry = new Map<string, A2UIComponentCatalog>()

/**
 * Register a React component for an A2UI component type
 */
export function registerComponent(
  type: A2UIComponentType,
  component: React.ComponentType<A2UIComponentProps<A2UIComponent>>,
  options?: {
    catalogId?: string
    description?: string
    schema?: Record<string, unknown>
  }
): void {
  const catalogId = options?.catalogId || DEFAULT_CATALOG_ID
  const key = `${catalogId}:${type}`

  componentRegistry.set(key, {
    type,
    component,
    description: options?.description,
    schema: options?.schema,
  })
}

/**
 * Register multiple components at once
 */
export function registerComponents(
  components: Array<{
    type: A2UIComponentType
    component: React.ComponentType<A2UIComponentProps<A2UIComponent>>
    description?: string
  }>,
  catalogId: string = DEFAULT_CATALOG_ID
): void {
  for (const { type, component, description } of components) {
    registerComponent(type, component, { catalogId, description })
  }
}

/**
 * Get a registered component by type
 */
export function getComponent(
  type: A2UIComponentType,
  catalogId: string = DEFAULT_CATALOG_ID
): A2UICatalogEntry | undefined {
  // Try exact catalog match first
  const key = `${catalogId}:${type}`
  const entry = componentRegistry.get(key)
  if (entry) {
    return entry
  }

  // Fall back to default catalog
  if (catalogId !== DEFAULT_CATALOG_ID) {
    const defaultKey = `${DEFAULT_CATALOG_ID}:${type}`
    return componentRegistry.get(defaultKey)
  }

  return undefined
}

/**
 * Check if a component type is registered
 */
export function hasComponent(
  type: A2UIComponentType,
  catalogId: string = DEFAULT_CATALOG_ID
): boolean {
  return getComponent(type, catalogId) !== undefined
}

/**
 * Get all registered component types for a catalog
 */
export function getRegisteredTypes(catalogId: string = DEFAULT_CATALOG_ID): A2UIComponentType[] {
  const types: A2UIComponentType[] = []
  const prefix = `${catalogId}:`

  for (const key of componentRegistry.keys()) {
    if (key.startsWith(prefix)) {
      types.push(key.substring(prefix.length) as A2UIComponentType)
    }
  }

  return types
}

/**
 * List catalog ids currently available to the renderer.
 *
 * The standard catalog is always selectable because its built-in React
 * implementations are bundled with the renderer. Custom ids are discovered
 * from both complete catalog registrations and individual component
 * registrations, without maintaining a second registry of ids.
 */
export function getRegisteredCatalogIds(): string[] {
  const ids = new Set<string>([DEFAULT_CATALOG_ID, ...catalogRegistry.keys()])

  for (const [key, entry] of componentRegistry.entries()) {
    const suffix = `:${entry.type}`
    if (key.endsWith(suffix)) {
      ids.add(key.slice(0, -suffix.length))
    }
  }

  return [DEFAULT_CATALOG_ID, ...[...ids].filter((id) => id !== DEFAULT_CATALOG_ID).sort()]
}

/**
 * Create a component catalog from registered components
 */
export function createCatalog(catalogId: string = DEFAULT_CATALOG_ID): A2UIComponentCatalog {
  const components: Record<string, A2UICatalogEntry> = {}
  const prefix = `${catalogId}:`

  for (const [key, entry] of componentRegistry.entries()) {
    if (key.startsWith(prefix)) {
      const type = key.substring(prefix.length)
      components[type] = entry
    }
  }

  // Also include components from default catalog if different
  if (catalogId !== DEFAULT_CATALOG_ID) {
    const defaultPrefix = `${DEFAULT_CATALOG_ID}:`
    for (const [key, entry] of componentRegistry.entries()) {
      if (key.startsWith(defaultPrefix)) {
        const type = key.substring(defaultPrefix.length)
        if (!components[type]) {
          components[type] = entry
        }
      }
    }
  }

  return {
    id: catalogId,
    name:
      catalogId === DEFAULT_CATALOG_ID ? "Cognia Standard Catalog" : `Custom Catalog: ${catalogId}`,
    version: "1.0.0",
    components,
  }
}

/**
 * Register a complete catalog
 */
export function registerCatalog(catalog: A2UIComponentCatalog): void {
  catalogRegistry.set(catalog.id, catalog)

  // Also register individual components
  for (const [type, entry] of Object.entries(catalog.components)) {
    componentRegistry.set(`${catalog.id}:${type}`, entry)
  }
}

/**
 * Get a catalog by ID
 */
export function getCatalog(
  catalogId: string = DEFAULT_CATALOG_ID
): A2UIComponentCatalog | undefined {
  // Check if catalog is explicitly registered
  const registered = catalogRegistry.get(catalogId)
  if (registered) {
    return registered
  }

  // Build catalog from registered components
  const types = getRegisteredTypes(catalogId)
  if (types.length > 0) {
    return createCatalog(catalogId)
  }

  return undefined
}

/**
 * Unregister a component
 */
export function unregisterComponent(
  type: A2UIComponentType,
  catalogId: string = DEFAULT_CATALOG_ID
): boolean {
  const key = `${catalogId}:${type}`
  return componentRegistry.delete(key)
}

/**
 * Clear all registered components
 */
export function clearRegistry(): void {
  componentRegistry.clear()
  catalogRegistry.clear()
}

/**
 * Get standard catalog component types
 */
export function getStandardComponentTypes(): A2UIComponentType[] {
  return [...standardCatalogDefinition.componentTypes]
}

/**
 * Component type categories for organization
 */
export const componentCategories = {
  display: [
    "Text",
    "Image",
    "Icon",
    "Badge",
    "Alert",
    "Progress",
    "Divider",
    "Spacer",
    "RichOutput",
    "ComparisonCards",
    "WidgetStatus",
    "Avatar",
    "Skeleton",
    "Spinner",
    "Toast",
    "Loading",
    "Error",
    "Empty",
    "Animation",
  ] as A2UIComponentType[],
  input: [
    "TextField",
    "TextArea",
    "Select",
    "Checkbox",
    "Radio",
    "RadioGroup",
    "Slider",
    "DatePicker",
    "TimePicker",
    "DateTimePicker",
    "Switch",
    "Combobox",
    "InputOTP",
    "ToggleGroup",
    "Toggle",
  ] as A2UIComponentType[],
  action: ["Button", "Link", "ButtonGroup"] as A2UIComponentType[],
  layout: [
    "Row",
    "Column",
    "Card",
    "List",
    "Dialog",
    "StepperShell",
    "MockupFrame",
    "InputGroup",
    "Collapsible",
    "ScrollArea",
    "Tabs",
    "Accordion",
    "FormGroup",
  ] as A2UIComponentType[],
  data: [
    "Chart",
    "Table",
    "Pagination",
    "AcademicAnalysis",
    "AcademicSearchResults",
  ] as A2UIComponentType[],
  overlay: [
    "Tooltip",
    "Popover",
    "HoverCard",
    "DropdownMenu",
    "ContextMenu",
  ] as A2UIComponentType[],
  navigation: [
    "Breadcrumb",
    "Carousel",
    "Drawer",
    "Sheet",
    "Sidebar",
    "InteractiveGuide",
  ] as A2UIComponentType[],
}

const DEFAULT_WIDGET_METADATA: Required<
  Pick<A2UIWidgetMetadata, "hostStrategy" | "sizing" | "theme" | "status" | "showChrome">
> = {
  hostStrategy: "native",
  sizing: "auto",
  theme: "inherit",
  status: "ready",
  showChrome: true,
}

type A2UIWidgetDefaults = Partial<
  Pick<A2UIWidgetMetadata, "hostStrategy" | "sizing" | "theme" | "status" | "showChrome">
>

export function resolveWidgetDefaults(
  widget?: A2UIWidgetMetadata,
  defaults: A2UIWidgetDefaults = {}
): A2UIWidgetMetadata {
  return {
    ...DEFAULT_WIDGET_METADATA,
    ...defaults,
    ...widget,
  }
}

export function resolveWidgetMetadata(
  component: A2UIComponent,
  defaults: A2UIWidgetDefaults = {}
): A2UIWidgetMetadata {
  const inferred = resolveWidgetDefaults(undefined, defaults)

  if (
    component.component === "RichOutput" &&
    "profileId" in component &&
    typeof component.profileId === "string"
  ) {
    const routedProfile = routeRichOutputProfile(
      component.profileId as Parameters<typeof routeRichOutputProfile>[0]
    )
    inferred.hostStrategy = routedProfile.profile.hostStrategy
    inferred.sizing =
      routedProfile.profile.hostStrategy === "native" ||
      routedProfile.profile.hostStrategy === "lazy-runtime"
        ? "auto"
        : "content-height"

    if (routedProfile.usedFallback) {
      inferred.status = "fallback"
    }
  }

  return {
    ...inferred,
    ...component.widget,
  }
}

/**
 * Get category for a component type
 */
export function getComponentCategory(type: A2UIComponentType): string | undefined {
  for (const [category, types] of Object.entries(componentCategories)) {
    if (types.includes(type)) {
      return category
    }
  }
  return undefined
}

/**
 * Validate component against catalog schema
 */
export function validateComponent(
  component: A2UIComponent,
  catalogId: string = DEFAULT_CATALOG_ID
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Check required fields
  if (!component.id) {
    errors.push("Component must have an id")
  }

  if (!component.component) {
    errors.push("Component must have a component type")
  }

  // Check if component type is registered
  if (!hasComponent(component.component, catalogId)) {
    errors.push(`Unknown component type: ${component.component}`)
  }

  // Additional type-specific validation could be added here
  // based on JSON Schema from catalog entry

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Default fallback component type
 */
export const FALLBACK_COMPONENT_TYPE = "Text" as A2UIComponentType
