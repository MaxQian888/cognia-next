import type { A2UIComponent, A2UIServerMessage } from "@/types/a2ui/schema"
import {
  createAppMessages,
  generateCalculatorApp,
  generateTimerApp,
  generateTodoApp,
  generateNotesApp,
  generateFormApp,
  generateTrackerApp,
  generateUnitConverterApp,
  generateCustomApp,
  generateDashboardApp,
  generateWeatherApp,
} from "./generators"
import { createGenerationContext } from "./config"
import { weatherTemplate } from "../templates"

describe("createAppMessages", () => {
  it("emits the canonical 4-message bootstrap sequence", () => {
    const components: A2UIComponent[] = [{ id: "root", component: "Column" } as A2UIComponent]
    const dataModel = { answer: 42 }
    const messages = createAppMessages("surface-x", "Title", components, dataModel)
    expect(messages).toHaveLength(4)
    expect(messages[0]).toEqual({
      type: "createSurface",
      surfaceId: "surface-x",
      surfaceType: "inline",
      title: "Title",
    })
    expect(messages[1]).toMatchObject({ type: "updateComponents", surfaceId: "surface-x" })
    expect(messages[2]).toMatchObject({
      type: "dataModelUpdate",
      surfaceId: "surface-x",
      data: dataModel,
    })
    expect(messages[3]).toEqual({ type: "surfaceReady", surfaceId: "surface-x" })
  })

  it("forwards the same surfaceId into every message in the sequence", () => {
    const messages = createAppMessages("s1", "T", [], {})
    for (const m of messages) {
      expect((m as { surfaceId: string }).surfaceId).toBe("s1")
    }
  })
})

function expectGenerated(app: ReturnType<typeof generateCalculatorApp>) {
  expect(app.id).toBeTruthy()
  expect(Array.isArray(app.components)).toBe(true)
  expect(app.components.length).toBeGreaterThan(0)
  expect(Array.isArray(app.messages)).toBe(true)
  expect(app.messages).toHaveLength(4)
}

describe("generateCalculatorApp", () => {
  it("falls back to basic calculator when no keyword matches", () => {
    const app = generateCalculatorApp("Calc", "做一个简单计算工具")
    expectGenerated(app)
    expect(app.dataModel).toEqual({ display: "0", expression: "" })
  })

  it("picks tip-calculator components on 小费/tip keyword", () => {
    const app = generateCalculatorApp("Tip", "计算小费")
    expect(app.components.find((c) => c.id === "tip-slider")).toBeDefined()
    expect(app.dataModel).toMatchObject({ tipPercent: 15, people: 1 })
  })

  it("picks BMI components on bmi/体重 keyword and seeds default body metrics", () => {
    const app = generateCalculatorApp("BMI", "计算 BMI 体重指数")
    expect(app.components.find((c) => c.id === "bmi-value")).toBeDefined()
    expect(app.dataModel).toMatchObject({ height: 170, weight: 65 })
  })

  it("picks age components on 年龄/age keyword", () => {
    const app = generateCalculatorApp("Age", "计算年龄")
    expect(app.components.find((c) => c.id === "date-input")).toBeDefined()
    expect(app.dataModel).toMatchObject({ birthDate: "" })
  })

  it("picks loan components on 贷款/loan keyword with default principal", () => {
    const app = generateCalculatorApp("Loan", "贷款月供计算")
    expect(app.components.find((c) => c.id === "monthly-value")).toBeDefined()
    expect(app.dataModel).toMatchObject({ principal: 100000, rate: 5, years: 30 })
  })

  it("emits messages whose surfaceId tracks the generated app id", () => {
    const app = generateCalculatorApp("X", "")
    const surfaceIds = new Set(app.messages.map((m) => (m as { surfaceId: string }).surfaceId))
    expect(surfaceIds).toEqual(new Set([app.id]))
  })
})

describe("generateTimerApp", () => {
  it("regular timer defaults to a 5-minute preset when no number is in the description", () => {
    const app = generateTimerApp("T", "做个普通计时器")
    expectGenerated(app)
    expect(app.dataModel).toMatchObject({ totalSeconds: 5 * 60, mode: "timer" })
  })

  it("extracts the preset minute count from descriptions like '20 分钟'", () => {
    const app = generateTimerApp("T", "做一个 20 分钟的计时器")
    expect(app.dataModel).toMatchObject({ totalSeconds: 20 * 60 })
  })

  it("selects pomodoro components + mode on '番茄' keyword", () => {
    const app = generateTimerApp("Pomodoro", "番茄钟应用")
    expect(app.dataModel).toMatchObject({ mode: "pomodoro" })
    expect(app.components.find((c) => c.id === "work-btn")).toBeDefined()
  })
})

describe("generateWeatherApp", () => {
  it("reuses the complete weather template with canonical generated messages", () => {
    const app = generateWeatherApp("Weather", "Show local weather")
    expectGenerated(app)
    expect(app.components).toEqual(weatherTemplate.components)
    expect(app.dataModel).toEqual(weatherTemplate.dataModel)
    expect(app.components.find((component) => component.id === "weather-icon")).toBeDefined()
    expect(new Set(app.messages.map((message) => message.surfaceId))).toEqual(new Set([app.id]))
  })

  it("deep-clones template content so generated apps cannot mutate the catalog template", () => {
    const app = generateWeatherApp("Weather", "Show weather")
    ;(app.dataModel.weather as Record<string, unknown>).location = "Changed"
    ;(app.components[0] as { className?: string }).className = "changed"

    expect((weatherTemplate.dataModel.weather as Record<string, unknown>).location).toBe(
      "San Francisco, CA"
    )
    expect(weatherTemplate.components[0]).not.toHaveProperty("className", "changed")
  })
})

describe("generateTodoApp", () => {
  it("threads description flags into the underlying factory", () => {
    const app = generateTodoApp("Todo", "带分类、优先级、截止日期的待办")
    expectGenerated(app)
    // hasDueDate -> the due-date picker appears in the input row
    expect(app.components.find((c) => c.id === "due-date")).toBeDefined()
  })

  it("falls back to the minimal todo (no due-date) when description lacks the keyword", () => {
    const app = generateTodoApp("Todo", "简单的事项清单")
    expect(app.components.find((c) => c.id === "due-date")).toBeUndefined()
  })

  it("seeds an empty stats block + an 'all' filter", () => {
    const app = generateTodoApp("Todo", "")
    expect(app.dataModel).toMatchObject({
      filter: "all",
      stats: { completed: 0, pending: 0, total: 0 },
    })
  })
})

describe("generateNotesApp", () => {
  it("seeds an empty new-note record + an empty search query", () => {
    const app = generateNotesApp("Notes", "")
    expectGenerated(app)
    expect(app.dataModel).toMatchObject({
      searchQuery: "",
      newNote: { title: "", content: "" },
      selectedNoteId: null,
    })
  })
})

describe("generateFormApp", () => {
  it("returns survey components for type='survey'", () => {
    const app = generateFormApp("Survey", "", "survey")
    expectGenerated(app)
    expect(app.components.find((c) => c.id === "q1")).toBeDefined()
  })

  it("returns contact components for type='contact'", () => {
    const app = generateFormApp("Contact", "", "contact")
    expect(app.components.find((c) => c.id === "first-name")).toBeDefined()
    expect(app.components.find((c) => c.id === "email")).toBeDefined()
  })
})

describe("generateTrackerApp", () => {
  it("picks the expense tracker on 支出/expense keyword", () => {
    const app = generateTrackerApp("E", "记账支出追踪")
    expectGenerated(app)
    expect(app.components.find((c) => c.id === "total-card")).toBeDefined()
    expect(app.dataModel).toMatchObject({ totalSpent: 0, budget: 0 })
  })

  it("picks the health tracker on 健康/health keyword", () => {
    const app = generateTrackerApp("H", "健康追踪 + 卡路里")
    expect(app.components.find((c) => c.id === "steps-card")).toBeDefined()
    expect(app.dataModel).toMatchObject({
      todayStats: expect.any(Object),
      goals: { steps: 10000, calories: 2000, water: 8, sleep: 8 },
    })
  })

  it("falls back to habit tracker when no specialized keyword matches", () => {
    const app = generateTrackerApp("Habit", "普通习惯追踪器")
    expect(app.components.find((c) => c.id === "habits-list")).toBeDefined()
    expect(app.dataModel).toMatchObject({ habits: [], streak: 0 })
  })
})

describe("generateUnitConverterApp", () => {
  it("picks temperature units on '温度' / temperature keyword (Chinese ctx)", () => {
    const ctx = createGenerationContext({ description: "温度转换" })
    const app = generateUnitConverterApp("Temp", "做一个温度换算工具", ctx)
    expectGenerated(app)
    expect(app.dataModel).toMatchObject({ converterType: "temperature" })
    const fromUnit = app.components.find((c) => c.id === "from-unit") as
      { options: { value: string }[] } | undefined
    expect(fromUnit?.options.map((o) => o.value)).toEqual(["celsius", "fahrenheit", "kelvin"])
  })

  it("picks weight units in English when ctx.language === 'en'", () => {
    const ctx = createGenerationContext({ description: "weight converter", language: "en" })
    const app = generateUnitConverterApp("Weight", "weight kg lb converter", ctx)
    expect(app.dataModel).toMatchObject({ converterType: "weight" })
    const fromUnit = app.components.find((c) => c.id === "from-unit") as
      { options: { value: string; label: string }[] } | undefined
    expect(fromUnit?.options[0].label).toContain("Kilogram")
  })

  it("picks currency units on '汇率' / currency keyword", () => {
    const ctx = createGenerationContext({ description: "汇率" })
    const app = generateUnitConverterApp("FX", "汇率换算 美元", ctx)
    expect(app.dataModel).toMatchObject({ converterType: "currency" })
  })

  it("defaults to length units when no specialized keyword matches", () => {
    const ctx = createGenerationContext({ description: "convert" })
    const app = generateUnitConverterApp("Length", "convert things", ctx)
    expect(app.dataModel).toMatchObject({ converterType: "length" })
  })

  it("populates fromUnit / toUnit seed values from the chosen unit list", () => {
    const ctx = createGenerationContext({ description: "convert" })
    const app = generateUnitConverterApp("Length", "convert things", ctx)
    expect(app.dataModel).toMatchObject({
      fromUnit: expect.any(String),
      toUnit: expect.any(String),
    })
    expect((app.dataModel as { fromUnit: string }).fromUnit).not.toBe(
      (app.dataModel as { toUnit: string }).toUnit
    )
  })
})

describe("generateCustomApp", () => {
  it("renders an input/submit row when the description mentions 输入/input", () => {
    const ctx = createGenerationContext({ description: "输入一些值" })
    const app = generateCustomApp("Custom", "输入值后处理", ctx)
    expectGenerated(app)
    expect(app.components.find((c) => c.id === "main-input")).toBeDefined()
    expect(app.components.find((c) => c.id === "submit-btn")).toBeDefined()
  })

  it("falls back to a static info-text card when no input/button keywords are present", () => {
    const ctx = createGenerationContext({ description: "showcase only" })
    const app = generateCustomApp("Custom", "showcase only", ctx)
    expect(app.components.find((c) => c.id === "info-text")).toBeDefined()
    expect(app.components.find((c) => c.id === "main-input")).toBeUndefined()
  })

  it("appends an action button when the description mentions 按钮/button", () => {
    const ctx = createGenerationContext({ description: "click button" })
    const app = generateCustomApp("Custom", "需要点击按钮触发", ctx)
    expect(app.components.find((c) => c.id === "action-btn")).toBeDefined()
  })

  it("uses an English placeholder for the input when ctx.language === 'en'", () => {
    const ctx = createGenerationContext({ description: "input something", language: "en" })
    const app = generateCustomApp("Custom", "needs input", ctx)
    const input = app.components.find((c) => c.id === "main-input") as
      { placeholder: string } | undefined
    expect(input?.placeholder).toBe("Enter value...")
  })
})

describe("generateDashboardApp", () => {
  it("renders summary + status + chart with a refresh button", () => {
    const app = generateDashboardApp("Sales", "")
    expectGenerated(app)
    for (const id of ["refresh-btn", "summary", "status", "main-chart"]) {
      expect(app.components.find((c) => c.id === id)).toBeDefined()
    }
  })

  it("seeds chartData with 7 weekday samples", () => {
    const app = generateDashboardApp("Sales", "")
    const chartData = (app.dataModel as { chartData: unknown[] }).chartData
    expect(chartData).toHaveLength(7)
  })

  it("wires ComparisonCards to summaryItems with 3 metrics", () => {
    const app = generateDashboardApp("Sales", "")
    const items = (app.dataModel as { summaryItems: unknown[] }).summaryItems
    expect(items).toHaveLength(3)
    const summary = app.components.find((c) => c.id === "summary") as {
      items: { path: string }
    }
    expect(summary.items.path).toBe("/summaryItems")
  })

  it("emits a 4-message bootstrap sequence consistent with the generated id", () => {
    const app = generateDashboardApp("Sales", "")
    const ids = new Set<string>()
    for (const m of app.messages) {
      ids.add((m as { surfaceId: string }).surfaceId)
    }
    expect(ids.size).toBe(1)
    expect(ids.has(app.id)).toBe(true)
  })
})

describe("integration: every generator produces a sequence consumable by an A2UI surface", () => {
  function consumeAsServer(messages: A2UIServerMessage[]): void {
    const types = messages.map((m) => m.type)
    expect(types[0]).toBe("createSurface")
    expect(types).toContain("updateComponents")
    expect(types).toContain("dataModelUpdate")
    expect(types[types.length - 1]).toBe("surfaceReady")
  }

  it("calculator", () => consumeAsServer(generateCalculatorApp("c", "").messages))
  it("timer", () => consumeAsServer(generateTimerApp("c", "番茄 25").messages))
  it("todo", () => consumeAsServer(generateTodoApp("c", "截止日期 todo").messages))
  it("notes", () => consumeAsServer(generateNotesApp("c", "").messages))
  it("survey form", () => consumeAsServer(generateFormApp("c", "", "survey").messages))
  it("contact form", () => consumeAsServer(generateFormApp("c", "", "contact").messages))
  it("tracker", () => consumeAsServer(generateTrackerApp("c", "expense").messages))
  it("converter", () => {
    const ctx = createGenerationContext({ description: "" })
    consumeAsServer(generateUnitConverterApp("c", "", ctx).messages)
  })
  it("custom", () => {
    const ctx = createGenerationContext({ description: "" })
    consumeAsServer(generateCustomApp("c", "", ctx).messages)
  })
  it("dashboard", () => consumeAsServer(generateDashboardApp("c", "").messages))
})
