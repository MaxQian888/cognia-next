/**
 * Pipeline Integration Tests
 * End-to-end: template -> messages -> store -> ready
 */

import { act } from "@testing-library/react"
import { useA2UIStore } from "@/stores/a2ui/a2ui-store"
import { appTemplates, createAppFromTemplate, getTemplateById } from "../templates"
import { getValueByPath, extractReferencedPaths } from "../data-model"
import type { A2UIAppTemplate } from "../templates"
import type { A2UIComponent } from "@/types/a2ui/schema"
import {
  generateCalculatorApp,
  generateTimerApp,
  generateTodoApp,
  generateNotesApp,
  generateFormApp,
  generateTrackerApp,
  generateDashboardApp,
  generateCustomApp,
} from "../app-generator/generators"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  act(() => {
    useA2UIStore.getState().reset()
  })
}

function feedMessages(template: A2UIAppTemplate): string {
  const { surfaceId, messages } = createAppFromTemplate(template)
  act(() => {
    useA2UIStore.getState().processMessages(messages)
  })
  return surfaceId
}

// ---------------------------------------------------------------------------
// 1. Template-to-Store Pipeline (all 13 templates)
// ---------------------------------------------------------------------------

describe("Template-to-Store Pipeline", () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })

  describe.each(appTemplates)('template "$name" ($id)', (template) => {
    it("should create a surface with correct surfaceId", () => {
      const surfaceId = feedMessages(template)

      const surface = useA2UIStore.getState().getSurface(surfaceId)
      expect(surface).toBeDefined()
      expect(surface!.id).toBe(surfaceId)
    })

    it("should populate components matching the template", () => {
      const surfaceId = feedMessages(template)

      const surface = useA2UIStore.getState().getSurface(surfaceId)
      expect(surface).toBeDefined()

      // Every template component should be present keyed by id
      for (const comp of template.components) {
        expect(surface!.components[comp.id]).toBeDefined()
        expect(surface!.components[comp.id].component).toBe(
          (comp as A2UIComponent & { component: string }).component
        )
      }

      // The number of components in the surface should match the template
      expect(Object.keys(surface!.components)).toHaveLength(template.components.length)
    })

    it("should populate dataModel matching the template", () => {
      const surfaceId = feedMessages(template)

      const surface = useA2UIStore.getState().getSurface(surfaceId)
      expect(surface).toBeDefined()

      // All top-level keys from the template dataModel should be present
      for (const key of Object.keys(template.dataModel)) {
        expect(surface!.dataModel).toHaveProperty(key)
      }
    })

    it("should mark the surface as ready", () => {
      const surfaceId = feedMessages(template)

      const surface = useA2UIStore.getState().getSurface(surfaceId)
      expect(surface).toBeDefined()
      expect(surface!.ready).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Data Binding Round-Trip
// ---------------------------------------------------------------------------

describe("Data Binding Round-Trip", () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })

  it("should round-trip a data value for the todo-list template", () => {
    const template = getTemplateById("todo-list")
    expect(template).toBeDefined()

    const surfaceId = feedMessages(template!)

    act(() => {
      useA2UIStore.getState().setDataValue(surfaceId, "/newTask", "Buy milk")
    })

    const readBack = useA2UIStore.getState().getDataValue<string>(surfaceId, "/newTask")
    expect(readBack).toBe("Buy milk")
  })

  it("should round-trip a data value for the calculator template", () => {
    const template = getTemplateById("calculator")
    expect(template).toBeDefined()

    const surfaceId = feedMessages(template!)

    act(() => {
      useA2UIStore.getState().setDataValue(surfaceId, "/display", "42")
    })

    const readBack = useA2UIStore.getState().getDataValue<string>(surfaceId, "/display")
    expect(readBack).toBe("42")
  })

  it("should round-trip nested data for the notes template", () => {
    const template = getTemplateById("notes")
    expect(template).toBeDefined()

    const surfaceId = feedMessages(template!)

    act(() => {
      useA2UIStore.getState().setDataValue(surfaceId, "/searchQuery", "meeting")
    })

    const readBack = useA2UIStore.getState().getDataValue<string>(surfaceId, "/searchQuery")
    expect(readBack).toBe("meeting")
  })

  it("should emit a data change event on setDataValue", () => {
    const template = getTemplateById("todo-list")!
    const surfaceId = feedMessages(template)

    act(() => {
      useA2UIStore.getState().setDataValue(surfaceId, "/newTask", "Walk the dog")
    })

    const history = useA2UIStore.getState().eventHistory
    expect(history.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Data Model Path Resolution
// ---------------------------------------------------------------------------

describe("Data Model Path Resolution", () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })

  describe.each(appTemplates)('template "$name" ($id) — all paths resolve', (template) => {
    it("should resolve every path reference found in the component tree", () => {
      const surfaceId = feedMessages(template)

      const surface = useA2UIStore.getState().getSurface(surfaceId)
      expect(surface).toBeDefined()

      // Extract all { path } references from the component tree
      const components = Object.values(surface!.components)
      const paths = extractReferencedPaths(components as unknown as { [key: string]: unknown }[])

      // Every extracted path should resolve to a defined value
      for (const path of paths) {
        const resolved = getValueByPath(surface!.dataModel, path)
        expect(resolved).not.toBeUndefined()
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Generator Compatibility
// ---------------------------------------------------------------------------

describe("Generator Compatibility", () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })

  const generatorCases = [
    { name: "generateCalculatorApp", fn: () => generateCalculatorApp("Calc", "basic calculator") },
    { name: "generateTimerApp", fn: () => generateTimerApp("Timer", "5 minute timer") },
    { name: "generateTodoApp", fn: () => generateTodoApp("Todo", "task list") },
    { name: "generateNotesApp", fn: () => generateNotesApp("Notes", "note taking") },
    {
      name: "generateFormApp (survey)",
      fn: () => generateFormApp("Survey", "feedback survey", "survey"),
    },
    {
      name: "generateFormApp (contact)",
      fn: () => generateFormApp("Contact", "contact form", "contact"),
    },
    {
      name: "generateTrackerApp (expense)",
      fn: () => generateTrackerApp("Expenses", "expense tracker"),
    },
    {
      name: "generateTrackerApp (habit)",
      fn: () => generateTrackerApp("Habits", "habit tracker 打卡"),
    },
    { name: "generateDashboardApp", fn: () => generateDashboardApp("Dashboard", "data dashboard") },
    { name: "generateCustomApp", fn: () => generateCustomApp("Custom", "custom input button app") },
  ]

  describe.each(generatorCases)("$name", ({ fn }) => {
    it("should produce a valid components array", () => {
      const app = fn()
      expect(Array.isArray(app.components)).toBe(true)
      expect(app.components.length).toBeGreaterThan(0)
    })

    it("should produce valid component types (each has id and component)", () => {
      const app = fn()
      for (const comp of app.components) {
        expect(typeof comp.id).toBe("string")
        expect(typeof (comp as A2UIComponent & { component: string }).component).toBe("string")
      }
    })

    it("should produce messages that the store can process to a ready surface", () => {
      const app = fn()

      act(() => {
        useA2UIStore.getState().processMessages(app.messages)
      })

      const surface = useA2UIStore.getState().getSurface(app.id)
      expect(surface).toBeDefined()
      expect(surface!.ready).toBe(true)
      expect(Object.keys(surface!.components).length).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// 5. Edge Cases
// ---------------------------------------------------------------------------

describe("Pipeline Edge Cases", () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })

  it("should handle processing the same template twice with different surfaceIds", () => {
    const template = getTemplateById("calculator")!

    const id1 = feedMessages(template)
    const id2 = feedMessages(template)

    expect(id1).not.toBe(id2)
    expect(useA2UIStore.getState().getSurface(id1)).toBeDefined()
    expect(useA2UIStore.getState().getSurface(id2)).toBeDefined()
  })

  it("should set the first created surface as active", () => {
    const template = getTemplateById("timer")!
    const surfaceId = feedMessages(template)

    expect(useA2UIStore.getState().activeSurfaceId).toBe(surfaceId)
  })

  it("should create exactly 4 messages per template (create, components, data, ready)", () => {
    for (const template of appTemplates) {
      const { messages } = createAppFromTemplate(template)
      expect(messages).toHaveLength(4)
      expect(messages[0].type).toBe("createSurface")
      expect(messages[1].type).toBe("updateComponents")
      expect(messages[2].type).toBe("dataModelUpdate")
      expect(messages[3].type).toBe("surfaceReady")
    }
  })

  it("should allow getTemplateById to retrieve every template in appTemplates", () => {
    for (const template of appTemplates) {
      const found = getTemplateById(template.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(template.id)
    }
  })
})
