/**
 * A2UI Templates Tests
 */

import {
  generateTemplateId,
  todoListTemplate,
  calculatorTemplate,
  surveyFormTemplate,
  dataDashboardTemplate,
  timerTemplate,
  notesTemplate,
  weatherTemplate,
  contactFormTemplate,
  unitConverterTemplate,
  habitTrackerTemplate,
  shoppingListTemplate,
  expenseTrackerTemplate,
  profileCardTemplate,
  appTemplates,
  getTemplateById,
  getTemplatesByCategory,
  searchTemplates,
  createAppFromTemplate,
  templateCategories,
} from "./templates"

describe("A2UI Templates", () => {
  describe("generateTemplateId", () => {
    it("should generate unique IDs", () => {
      const id1 = generateTemplateId("test")
      const id2 = generateTemplateId("test")
      expect(id1).not.toBe(id2)
    })

    it("should include prefix in generated ID", () => {
      const id = generateTemplateId("myapp")
      expect(id).toContain("myapp")
    })

    it("should use default prefix when not provided", () => {
      const id = generateTemplateId()
      expect(id).toContain("app")
    })

    it("should generate UUID-based IDs", () => {
      const id = generateTemplateId("test")
      // Format: prefix-uuid (uuid contains hyphens)
      expect(id).toMatch(/^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })
  })

  describe("todoListTemplate", () => {
    it("should have required template properties", () => {
      expect(todoListTemplate.id).toBe("todo-list")
      expect(todoListTemplate.name).toBe("Todo List")
      expect(todoListTemplate.icon).toBe("CheckSquare")
      expect(todoListTemplate.category).toBe("productivity")
    })

    it("should have valid components", () => {
      expect(Array.isArray(todoListTemplate.components)).toBe(true)
      expect(todoListTemplate.components.length).toBeGreaterThan(0)
      expect(todoListTemplate.components.every((c) => c.id && c.component)).toBe(true)
    })

    it("should have valid data model", () => {
      expect(todoListTemplate.dataModel).toHaveProperty("newTask")
      expect(todoListTemplate.dataModel).toHaveProperty("tasks")
      expect(todoListTemplate.dataModel).toHaveProperty("stats")
    })
  })

  describe("calculatorTemplate", () => {
    it("should have required template properties", () => {
      expect(calculatorTemplate.id).toBe("calculator")
      expect(calculatorTemplate.name).toBe("Calculator")
      expect(calculatorTemplate.category).toBe("utility")
    })

    it("should have calculator buttons", () => {
      const buttons = calculatorTemplate.components.filter((c) => c.component === "Button")
      expect(buttons.length).toBeGreaterThan(10) // Numbers + operators
    })

    it("should have display in data model", () => {
      expect(calculatorTemplate.dataModel).toHaveProperty("display")
    })
  })

  describe("surveyFormTemplate", () => {
    it("should have required template properties", () => {
      expect(surveyFormTemplate.id).toBe("survey-form")
      expect(surveyFormTemplate.category).toBe("form")
    })

    it("should have form fields", () => {
      const inputs = surveyFormTemplate.components.filter(
        (c) => c.component === "TextField" || c.component === "TextArea" || c.component === "Slider"
      )
      expect(inputs.length).toBeGreaterThan(0)
    })
  })

  describe("dataDashboardTemplate", () => {
    it("should have required template properties", () => {
      expect(dataDashboardTemplate.id).toBe("data-dashboard")
      expect(dataDashboardTemplate.category).toBe("data")
    })

    it("should have chart component", () => {
      const charts = dataDashboardTemplate.components.filter((c) => c.component === "Chart")
      expect(charts.length).toBeGreaterThan(0)
    })

    it("should have stats in data model", () => {
      expect(dataDashboardTemplate.dataModel).toHaveProperty("stats")
    })
  })

  describe("timerTemplate", () => {
    it("should have required template properties", () => {
      expect(timerTemplate.id).toBe("timer")
      expect(timerTemplate.category).toBe("utility")
    })

    it("should have timer controls", () => {
      const buttons = timerTemplate.components.filter((c) => c.component === "Button")
      expect(buttons.length).toBeGreaterThan(0)
    })

    it("should have timer state in data model", () => {
      expect(timerTemplate.dataModel).toHaveProperty("seconds")
      expect(timerTemplate.dataModel).toHaveProperty("isRunning")
    })
  })

  describe("notesTemplate", () => {
    it("should have required template properties", () => {
      expect(notesTemplate.id).toBe("notes")
      expect(notesTemplate.category).toBe("productivity")
    })

    it("should have search and note input", () => {
      const textFields = notesTemplate.components.filter((c) => c.component === "TextField")
      expect(textFields.length).toBeGreaterThan(0)
    })
  })

  describe("weatherTemplate", () => {
    it("should have required template properties", () => {
      expect(weatherTemplate.id).toBe("weather")
      expect(weatherTemplate.category).toBe("utility")
    })

    it("should have weather data in data model", () => {
      expect(weatherTemplate.dataModel).toHaveProperty("weather")
      expect(weatherTemplate.dataModel.weather).toHaveProperty("temperature")
      expect(weatherTemplate.dataModel.weather).toHaveProperty("condition")
    })
  })

  describe("contactFormTemplate", () => {
    it("should have required template properties", () => {
      expect(contactFormTemplate.id).toBe("contact-form")
      expect(contactFormTemplate.category).toBe("form")
    })

    it("should have form fields", () => {
      const inputs = contactFormTemplate.components.filter(
        (c) => c.component === "TextField" || c.component === "TextArea" || c.component === "Select"
      )
      expect(inputs.length).toBeGreaterThan(0)
    })
  })

  describe("appTemplates", () => {
    it("should contain all templates", () => {
      expect(appTemplates).toContain(todoListTemplate)
      expect(appTemplates).toContain(calculatorTemplate)
      expect(appTemplates).toContain(surveyFormTemplate)
      expect(appTemplates).toContain(dataDashboardTemplate)
      expect(appTemplates).toContain(timerTemplate)
      expect(appTemplates).toContain(notesTemplate)
      expect(appTemplates).toContain(weatherTemplate)
      expect(appTemplates).toContain(contactFormTemplate)
    })

    it("should have unique IDs", () => {
      const ids = appTemplates.map((t) => t.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })

  describe("getTemplateById", () => {
    it("should find template by ID", () => {
      const template = getTemplateById("todo-list")
      expect(template).toBe(todoListTemplate)
    })

    it("should return undefined for unknown ID", () => {
      const template = getTemplateById("non-existent")
      expect(template).toBeUndefined()
    })
  })

  describe("getTemplatesByCategory", () => {
    it("should filter templates by category", () => {
      const productivityTemplates = getTemplatesByCategory("productivity")
      expect(productivityTemplates.every((t) => t.category === "productivity")).toBe(true)
    })

    it("should return utility templates", () => {
      const utilityTemplates = getTemplatesByCategory("utility")
      expect(utilityTemplates.length).toBeGreaterThan(0)
      expect(utilityTemplates).toContain(calculatorTemplate)
    })

    it("should return form templates", () => {
      const formTemplates = getTemplatesByCategory("form")
      expect(formTemplates.length).toBeGreaterThan(0)
    })
  })

  describe("searchTemplates", () => {
    it("should search by name", () => {
      const results = searchTemplates("todo")
      expect(results).toContain(todoListTemplate)
    })

    it("should search by description", () => {
      const results = searchTemplates("task")
      expect(results.length).toBeGreaterThan(0)
    })

    it("should search by tags", () => {
      const results = searchTemplates("productivity")
      expect(results.length).toBeGreaterThan(0)
    })

    it("should be case insensitive", () => {
      const results1 = searchTemplates("CALCULATOR")
      const results2 = searchTemplates("calculator")
      expect(results1).toEqual(results2)
    })

    it("should return empty array for no matches", () => {
      const results = searchTemplates("xyznonexistent")
      expect(results).toEqual([])
    })
  })

  describe("createAppFromTemplate", () => {
    it("should create app messages from template", () => {
      const { surfaceId, messages } = createAppFromTemplate(todoListTemplate)

      expect(surfaceId).toBeTruthy()
      expect(Array.isArray(messages)).toBe(true)
      expect(messages.length).toBe(4) // createSurface, updateComponents, dataModelUpdate, surfaceReady
    })

    it("should use provided surface ID", () => {
      const { surfaceId } = createAppFromTemplate(calculatorTemplate, "custom-id")
      expect(surfaceId).toBe("custom-id")
    })

    it("should generate surface ID if not provided", () => {
      const { surfaceId } = createAppFromTemplate(notesTemplate)
      expect(surfaceId).toContain("notes")
    })

    it("should include correct message types", () => {
      const { messages } = createAppFromTemplate(timerTemplate)

      expect(messages[0].type).toBe("createSurface")
      expect(messages[1].type).toBe("updateComponents")
      expect(messages[2].type).toBe("dataModelUpdate")
      expect(messages[3].type).toBe("surfaceReady")
    })

    it("should include template components in messages", () => {
      const { messages } = createAppFromTemplate(calculatorTemplate)
      const updateMsg = messages.find((m) => m.type === "updateComponents")

      expect(updateMsg).toBeDefined()
      expect(updateMsg?.components).toEqual(calculatorTemplate.components)
    })

    it("should include template data model in messages", () => {
      const { messages } = createAppFromTemplate(surveyFormTemplate)
      const dataMsg = messages.find((m) => m.type === "dataModelUpdate")

      expect(dataMsg).toBeDefined()
      expect(dataMsg?.data).toEqual(surveyFormTemplate.dataModel)
    })
  })

  describe("templateCategories", () => {
    it("should define all categories", () => {
      expect(templateCategories.length).toBeGreaterThan(0)
    })

    it("should have required category properties", () => {
      templateCategories.forEach((cat) => {
        expect(cat).toHaveProperty("id")
        expect(cat).toHaveProperty("name")
        expect(cat).toHaveProperty("icon")
        expect(cat).toHaveProperty("description")
      })
    })

    it("should include productivity category", () => {
      expect(templateCategories.some((c) => c.id === "productivity")).toBe(true)
    })

    it("should include utility category", () => {
      expect(templateCategories.some((c) => c.id === "utility")).toBe(true)
    })

    it("should include form category", () => {
      expect(templateCategories.some((c) => c.id === "form")).toBe(true)
    })

    it("should include data category", () => {
      expect(templateCategories.some((c) => c.id === "data")).toBe(true)
    })
  })

  describe("Template validation", () => {
    it("all templates should have root component", () => {
      appTemplates.forEach((template) => {
        const rootComponent = template.components.find((c) => c.id === "root")
        expect(rootComponent).toBeDefined()
      })
    })

    it("all templates should have valid component references", () => {
      appTemplates.forEach((template) => {
        const componentIds = new Set(template.components.map((c) => c.id))

        template.components.forEach((component) => {
          const comp = component as { children?: string[] }
          if (comp.children) {
            comp.children.forEach((childId: string) => {
              expect(componentIds.has(childId)).toBe(true)
            })
          }
        })
      })
    })
  })

  describe("unitConverterTemplate", () => {
    it("should have required template properties", () => {
      expect(unitConverterTemplate.id).toBe("unit-converter")
      expect(unitConverterTemplate.name).toBe("Unit Converter")
      expect(unitConverterTemplate.category).toBe("utility")
    })

    it("should have converter data model", () => {
      expect(unitConverterTemplate.dataModel).toHaveProperty("inputValue")
      expect(unitConverterTemplate.dataModel).toHaveProperty("fromUnit")
      expect(unitConverterTemplate.dataModel).toHaveProperty("toUnit")
      expect(unitConverterTemplate.dataModel).toHaveProperty("result")
    })

    it("should have convert button", () => {
      const convertBtn = unitConverterTemplate.components.find(
        (c) => c.component === "Button" && (c as { action?: string }).action === "convert"
      )
      expect(convertBtn).toBeDefined()
    })
  })

  describe("habitTrackerTemplate", () => {
    it("should have required template properties", () => {
      expect(habitTrackerTemplate.id).toBe("habit-tracker")
      expect(habitTrackerTemplate.name).toBe("Habit Tracker")
      expect(habitTrackerTemplate.category).toBe("productivity")
    })

    it("should have habits data model", () => {
      expect(habitTrackerTemplate.dataModel).toHaveProperty("newHabit")
      expect(habitTrackerTemplate.dataModel).toHaveProperty("habits")
      expect(habitTrackerTemplate.dataModel).toHaveProperty("stats")
    })

    it("should have add habit action", () => {
      const addBtn = habitTrackerTemplate.components.find(
        (c) => c.component === "Button" && (c as { action?: string }).action === "add_habit"
      )
      expect(addBtn).toBeDefined()
    })
  })

  describe("shoppingListTemplate", () => {
    it("should have required template properties", () => {
      expect(shoppingListTemplate.id).toBe("shopping-list")
      expect(shoppingListTemplate.name).toBe("Shopping List")
      expect(shoppingListTemplate.category).toBe("productivity")
    })

    it("should have items data model", () => {
      expect(shoppingListTemplate.dataModel).toHaveProperty("newItem")
      expect(shoppingListTemplate.dataModel).toHaveProperty("items")
      expect(shoppingListTemplate.dataModel).toHaveProperty("totalText")
    })

    it("should have add item action", () => {
      const addBtn = shoppingListTemplate.components.find(
        (c) => c.component === "Button" && (c as { action?: string }).action === "add_item"
      )
      expect(addBtn).toBeDefined()
    })
  })

  describe("expenseTrackerTemplate", () => {
    it("should have required template properties", () => {
      expect(expenseTrackerTemplate.id).toBe("expense-tracker")
      expect(expenseTrackerTemplate.name).toBe("Expense Tracker")
      expect(expenseTrackerTemplate.category).toBe("data")
    })

    it("should have expense data model", () => {
      expect(expenseTrackerTemplate.dataModel).toHaveProperty("newExpense")
      expect(expenseTrackerTemplate.dataModel).toHaveProperty("expenses")
      expect(expenseTrackerTemplate.dataModel).toHaveProperty("stats")
    })

    it("should have add expense action", () => {
      const addBtn = expenseTrackerTemplate.components.find(
        (c) => c.component === "Button" && (c as { action?: string }).action === "add_expense"
      )
      expect(addBtn).toBeDefined()
    })

    it("should have category selector", () => {
      const categorySelect = expenseTrackerTemplate.components.find((c) => c.component === "Select")
      expect(categorySelect).toBeDefined()
    })
  })

  describe("profileCardTemplate", () => {
    it("should have required template properties", () => {
      expect(profileCardTemplate.id).toBe("profile-card")
      expect(profileCardTemplate.name).toBe("Profile Card")
      expect(profileCardTemplate.category).toBe("social")
    })

    it("should have profile data model", () => {
      expect(profileCardTemplate.dataModel).toHaveProperty("profile")
      expect(profileCardTemplate.dataModel).toHaveProperty("stats")
      const profile = profileCardTemplate.dataModel.profile as Record<string, unknown>
      expect(profile).toHaveProperty("name")
      expect(profile).toHaveProperty("title")
      expect(profile).toHaveProperty("bio")
    })

    it("should have action buttons", () => {
      const followBtn = profileCardTemplate.components.find(
        (c) => c.component === "Button" && (c as { action?: string }).action === "follow"
      )
      const messageBtn = profileCardTemplate.components.find(
        (c) => c.component === "Button" && (c as { action?: string }).action === "message"
      )
      expect(followBtn).toBeDefined()
      expect(messageBtn).toBeDefined()
    })
  })

  describe("appTemplates array", () => {
    it("should include all 13 templates", () => {
      expect(appTemplates.length).toBe(13)
    })

    it("should include all new templates", () => {
      const templateIds = appTemplates.map((t) => t.id)
      expect(templateIds).toContain("unit-converter")
      expect(templateIds).toContain("habit-tracker")
      expect(templateIds).toContain("shopping-list")
      expect(templateIds).toContain("expense-tracker")
      expect(templateIds).toContain("profile-card")
    })

    it("should have social category template", () => {
      const socialTemplates = getTemplatesByCategory("social")
      expect(socialTemplates.length).toBeGreaterThan(0)
    })
  })
})
