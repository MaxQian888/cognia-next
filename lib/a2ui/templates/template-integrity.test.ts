/**
 * A2UI Template Integrity Tests
 *
 * Validates all 13 app templates for structural correctness:
 * - Component tree integrity (root, children references, uniqueness, orphans)
 * - Data model path coverage (all bound paths resolve)
 * - Component type registration (all types are known)
 * - Action handler coverage (all actions are handled or delegated)
 */

import { appTemplates } from "./index"
import { getValueByPath } from "@/lib/a2ui/data-model"
import type { A2UIAppTemplate } from "./types"

// Loose structural view used for traversal: every component has an `id` and
// `component` discriminator, plus opt-in fields we read for tree/data/action checks.
type LooseComponent = {
  id: string
  component: string
  children?: string[]
  action?: string
  itemClickAction?: string
  rowClickAction?: string
  [key: string]: unknown
}

// --- Registered component types ---
const registeredTypes = new Set([
  "Row",
  "Column",
  "Card",
  "Divider",
  "Spacer",
  "Dialog",
  "Tabs",
  "Accordion",
  "StepperShell",
  "MockupFrame",
  "Text",
  "Image",
  "Icon",
  "Link",
  "Badge",
  "Alert",
  "Progress",
  "Loading",
  "Error",
  "Empty",
  "RichOutput",
  "ComparisonCards",
  "WidgetStatus",
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
  "Toggle",
  "FormGroup",
  "Switch",
  "Chart",
  "Table",
  "List",
  "DataExplorer",
  "Animation",
  "InteractiveGuide",
  "AcademicAnalysis",
])

// --- Handled actions (from action-handlers.ts switch cases) ---
const handledActions = new Set([
  "add_task",
  "toggle_task",
  "delete_task",
  "filter_all",
  "filter_pending",
  "filter_done",
  "input_0",
  "input_1",
  "input_2",
  "input_3",
  "input_4",
  "input_5",
  "input_6",
  "input_7",
  "input_8",
  "input_9",
  "input_decimal",
  "num_0",
  "num_1",
  "num_2",
  "num_3",
  "num_4",
  "num_5",
  "num_6",
  "num_7",
  "num_8",
  "num_9",
  "op_add",
  "op_sub",
  "op_mul",
  "op_div",
  "op_subtract",
  "op_multiply",
  "op_divide",
  "op_percent",
  "calculate",
  "clear",
  "backspace",
  "delete",
  "negate",
  "start",
  "start_timer",
  "pause",
  "pause_timer",
  "reset",
  "reset_timer",
  "set_1",
  "set_1min",
  "set_5",
  "set_5min",
  "set_10",
  "set_10min",
  "set_15",
  "set_25",
  "set_25min",
  "save_note",
  "select_note",
  "delete_note",
  "convert",
  "add_item",
  "toggle_item",
  "clear_list",
  "add_habit",
  "toggle_habit",
  "add_expense",
  "delete_expense",
  "view_expense",
  "submit",
  "submit_form",
  "submit_contact",
  "clear_form",
  "execute",
  "refresh",
  "refresh_data",
  "calculate_bmi",
  "calculate_age",
  "calculate_loan",
  "add_steps",
  "add_water_1",
  "add_water_2",
  "add_water_3",
  // Delegated actions (forwarded to onAction callback)
  "follow",
  "message",
  "view_activity",
])

const delegatedActions = new Set(["follow", "message", "view_activity"])

// --- Helpers ---

function extractPaths(component: LooseComponent): string[] {
  const paths: string[] = []
  const propsToCheck = ["value", "text", "items", "data", "src", "name"]
  for (const prop of propsToCheck) {
    const val = component[prop]
    if (val && typeof val === "object" && "path" in (val as object)) {
      paths.push((val as { path: string }).path)
    }
  }
  return paths
}

function extractActions(components: LooseComponent[]): string[] {
  const actions: string[] = []
  for (const comp of components) {
    if (comp.action) actions.push(comp.action)
    if (comp.itemClickAction) actions.push(comp.itemClickAction)
    if (comp.rowClickAction) actions.push(comp.rowClickAction)
  }
  return actions
}

// --- Tests ---

describe("A2UI Template Integrity", () => {
  it("should have exactly 13 templates", () => {
    expect(appTemplates).toHaveLength(13)
  })

  describe.each(appTemplates.map((t) => ({ name: t.name, template: t })))(
    "$name",
    ({ template }: { template: A2UIAppTemplate }) => {
      const components = template.components as unknown as LooseComponent[]
      const componentMap = new Map(components.map((c) => [c.id, c]))

      // --- 1. Component Tree Integrity ---

      describe("Component Tree Integrity", () => {
        it("should have a root component", () => {
          const root = components.find((c) => c.id === "root")
          expect(root).toBeDefined()
        })

        it("should have unique component IDs", () => {
          const ids = components.map((c) => c.id)
          const uniqueIds = new Set(ids)
          expect(uniqueIds.size).toBe(ids.length)
        })

        it("should have all children reference existing component IDs", () => {
          const missingRefs: string[] = []
          for (const comp of components) {
            if (Array.isArray(comp.children)) {
              for (const childId of comp.children) {
                if (!componentMap.has(childId)) {
                  missingRefs.push(`${comp.id} -> ${childId}`)
                }
              }
            }
          }
          expect(missingRefs).toEqual([])
        })

        it("should have no orphan components (except root and dynamic list items)", () => {
          const referencedIds = new Set<string>()
          referencedIds.add("root")

          for (const comp of components) {
            if (Array.isArray(comp.children)) {
              for (const childId of comp.children) {
                referencedIds.add(childId)
              }
            }
          }

          // List components may have dynamic item templates that aren't referenced via children
          const listComponentIds = new Set(
            components.filter((c) => c.component === "List").map((c) => c.id)
          )

          const orphans = components
            .filter((c) => !referencedIds.has(c.id))
            .filter((c) => {
              // Allow items that belong to a List (dynamic rendering)
              return !listComponentIds.has(c.id)
            })
            .map((c) => c.id)

          expect(orphans).toEqual([])
        })
      })

      // --- 2. Data Model Path Coverage ---

      describe("Data Model Path Coverage", () => {
        it("should resolve all data-bound paths in the data model", () => {
          const unresolvedPaths: string[] = []
          for (const comp of components) {
            const paths = extractPaths(comp)
            for (const path of paths) {
              const value = getValueByPath(template.dataModel, path)
              if (value === undefined) {
                unresolvedPaths.push(`${comp.id}.path="${path}"`)
              }
            }
          }
          expect(unresolvedPaths).toEqual([])
        })
      })

      // --- 3. Component Type Registration ---

      describe("Component Type Registration", () => {
        it("should only use registered component types", () => {
          const unregistered = components
            .filter((c) => !registeredTypes.has(c.component))
            .map((c) => `${c.id}: ${c.component}`)
          expect(unregistered).toEqual([])
        })
      })

      // --- 4. Action Handler Coverage ---

      describe("Action Handler Coverage", () => {
        it("should only reference handled or delegated actions", () => {
          const actions = extractActions(components)
          const unhandled = actions.filter((a) => !handledActions.has(a))
          expect(unhandled).toEqual([])
        })

        it("should correctly categorise delegated actions", () => {
          const actions = extractActions(components)
          const delegated = actions.filter((a) => delegatedActions.has(a))
          for (const action of delegated) {
            expect(handledActions.has(action)).toBe(true)
          }
        })
      })
    }
  )
})
