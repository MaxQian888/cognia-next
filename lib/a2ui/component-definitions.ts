/**
 * Renderer-valid starting descriptors for the standard A2UI catalog.
 *
 * Whole-app generator factories are intentionally not reused here: they emit
 * opinionated multi-component applications. The editor needs the smaller
 * contract of one insertable, rooted bundle, including required structural
 * dependencies such as overlay/menu trigger components.
 */

import type { A2UIComponent, A2UIComponentType } from "@/types/a2ui/schema"

export interface A2UIComponentBundle {
  rootId: string
  components: A2UIComponent[]
}

/** Return a deterministic component id that does not collide with the surface. */
export function createAvailableComponentId(type: string, occupiedIds: ReadonlySet<string>): string {
  const base =
    type
      .trim()
      .replace(/([a-z\d])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z\d]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "component"
  if (!occupiedIds.has(base)) return base

  let suffix = 2
  while (occupiedIds.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function descriptor(
  id: string,
  component: A2UIComponentType,
  properties: Record<string, unknown> = {}
): A2UIComponent {
  return { id, component, ...properties } as A2UIComponent
}

function valuePath(id: string): { path: string } {
  const escapedId = id.replaceAll("~", "~0").replaceAll("/", "~1")
  return { path: `/components/${escapedId}/value` }
}

function withTrigger(
  type: string,
  id: string,
  properties: Record<string, unknown> = {}
): A2UIComponentBundle {
  const triggerId = `${id}-trigger`
  return {
    rootId: id,
    components: [
      descriptor(id, type, { trigger: triggerId, ...properties }),
      descriptor(triggerId, "Button", { text: type, action: `open-${id}` }),
    ],
  }
}

/** Create a complete minimal bundle for any built-in or custom catalog type. */
export function createA2UIComponentBundle(type: string, id: string): A2UIComponentBundle {
  const path = valuePath(id)
  let root: A2UIComponent

  switch (type) {
    case "Text":
      root = descriptor(id, type, { text: type })
      break
    case "Button":
      root = descriptor(id, type, { text: type, action: `click-${id}` })
      break
    case "TextField":
    case "TextArea":
    case "DatePicker":
    case "TimePicker":
    case "DateTimePicker":
    case "InputOTP":
      root = descriptor(id, type, { value: path, label: type })
      break
    case "Select":
    case "Combobox":
      root = descriptor(id, type, {
        value: path,
        label: type,
        options: [{ value: "option", label: "Option" }],
      })
      break
    case "Checkbox":
      root = descriptor(id, type, { checked: path, label: type })
      break
    case "Radio":
      root = descriptor(id, type, { value: "option", label: type, checked: path })
      break
    case "RadioGroup":
      root = descriptor(id, type, {
        value: path,
        label: type,
        options: [{ value: "option", label: "Option" }],
      })
      break
    case "Slider":
      root = descriptor(id, type, { value: path, min: 0, max: 100, step: 1, label: type })
      break
    case "Switch":
      root = descriptor(id, type, { checked: path, label: type })
      break
    case "ToggleGroup":
      root = descriptor(id, type, {
        value: path,
        label: type,
        options: [{ value: "option", label: "Option" }],
      })
      break
    case "Card":
      root = descriptor(id, type, { title: type, children: [], footer: [] })
      break
    case "Row":
    case "Column":
    case "List":
    case "MockupFrame":
    case "ButtonGroup":
    case "InputGroup":
    case "FormGroup":
    case "Carousel":
    case "ScrollArea":
      root = descriptor(id, type, { children: [] })
      break
    case "Collapsible":
      root = descriptor(id, type, { title: type, children: [] })
      break
    case "Dialog":
      root = descriptor(id, type, { open: false, title: type, children: [], actions: [] })
      break
    case "Image":
      root = descriptor(id, type, { src: "", alt: type })
      break
    case "Chart":
      root = descriptor(id, type, { chartType: "bar", data: [], xKey: "name", yKeys: ["value"] })
      break
    case "Table":
      root = descriptor(id, type, { columns: [], data: [] })
      break
    case "Divider":
    case "Spacer":
    case "Loading":
    case "Empty":
    case "Avatar":
    case "Skeleton":
    case "Spinner":
    case "AcademicAnalysis":
    case "AcademicSearchResults":
      root = descriptor(id, type)
      break
    case "Progress":
      root = descriptor(id, type, { value: 0, max: 100, label: type })
      break
    case "Badge":
      root = descriptor(id, type, { text: type })
      break
    case "Alert":
      root = descriptor(id, type, { message: type })
      break
    case "Link":
      root = descriptor(id, type, { text: type, href: "#" })
      break
    case "Icon":
      root = descriptor(id, type, { name: "Circle" })
      break
    case "RichOutput":
      root = descriptor(id, type, { profileId: "quick-factual-answer", content: "" })
      break
    case "ComparisonCards":
      root = descriptor(id, type, { items: [] })
      break
    case "StepperShell":
      root = descriptor(id, type, { steps: [] })
      break
    case "WidgetStatus":
      root = descriptor(id, type, { status: "ready", message: type })
      break
    case "Error":
      root = descriptor(id, type, { message: type })
      break
    case "Animation":
      root = descriptor(id, type, { type: "fadeIn", children: [] })
      break
    case "InteractiveGuide":
      root = descriptor(id, type, {
        title: type,
        steps: [{ id: "step-1", title: "Step 1", content: [] }],
      })
      break
    case "Tabs":
      root = descriptor(id, type, {
        tabs: [{ id: "tab-1", label: "Tab 1", children: [] }],
        defaultTab: "tab-1",
      })
      break
    case "Accordion":
      root = descriptor(id, type, {
        items: [{ id: "item-1", title: "Item 1", children: [] }],
      })
      break
    case "Toggle":
      root = descriptor(id, type, { label: type, pressed: path, action: `toggle-${id}` })
      break
    case "Tooltip":
      root = descriptor(id, type, { text: type, children: [] })
      break
    case "Popover":
    case "HoverCard":
    case "Drawer":
    case "Sheet":
      return withTrigger(type, id, { title: type, children: [] })
    case "DropdownMenu":
    case "ContextMenu":
      return withTrigger(type, id, { items: [] })
    case "Breadcrumb":
      root = descriptor(id, type, { items: [{ label: type, current: true }] })
      break
    case "Pagination":
      root = descriptor(id, type, { currentPage: 1, totalPages: 1 })
      break
    case "Sidebar":
      root = descriptor(id, type, { groups: [] })
      break
    case "Toast":
      root = descriptor(id, type, { message: type })
      break
    default:
      root = descriptor(id, type)
      break
  }

  return { rootId: id, components: [root] }
}
