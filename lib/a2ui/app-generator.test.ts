/**
 * A2UI App Generator Tests
 */

import {
  appPatterns,
  detectAppType,
  extractAppName,
  generateCalculatorApp,
  generateTimerApp,
  generateTodoApp,
  generateNotesApp,
  generateFormApp,
  generateTrackerApp,
  generateDashboardApp,
  generateCustomApp,
  generateAppFromDescription,
  generateUnitConverterApp,
  getLocalizedTexts,
  getStyleConfig,
  type AppGenerationRequest,
} from "./app-generator"

describe("A2UI App Generator", () => {
  describe("appPatterns", () => {
    it("should define patterns for common app types", () => {
      expect(appPatterns.calculator).toBeDefined()
      expect(appPatterns.timer).toBeDefined()
      expect(appPatterns.todo).toBeDefined()
      expect(appPatterns.notes).toBeDefined()
      expect(appPatterns.survey).toBeDefined()
      expect(appPatterns.contact).toBeDefined()
      expect(appPatterns.weather).toBeDefined()
      expect(appPatterns.dashboard).toBeDefined()
    })

    it("should have keywords for each pattern", () => {
      expect(appPatterns.calculator.keywords.length).toBeGreaterThan(0)
      expect(appPatterns.timer.keywords.length).toBeGreaterThan(0)
    })
  })

  describe("detectAppType", () => {
    it("should detect calculator app", () => {
      expect(detectAppType("做一个计算器")).toBe("calculator")
      expect(detectAppType("create a calculator")).toBe("calculator")
      expect(detectAppType("加减乘除工具")).toBe("calculator")
    })

    it("should detect timer app", () => {
      expect(detectAppType("做一个倒计时")).toBe("timer")
      expect(detectAppType("create a countdown timer")).toBe("timer")
      expect(detectAppType("秒表应用")).toBe("timer")
    })

    it("should detect todo app", () => {
      expect(detectAppType("待办事项列表")).toBe("todo")
      expect(detectAppType("create a todo list")).toBe("todo")
      expect(detectAppType("任务清单")).toBe("todo")
    })

    it("should detect notes app", () => {
      expect(detectAppType("笔记应用")).toBe("notes")
      expect(detectAppType("create a notes app")).toBe("notes")
      expect(detectAppType("记事本")).toBe("notes")
    })

    it("should detect survey app", () => {
      expect(detectAppType("问卷调查")).toBe("survey")
      expect(detectAppType("feedback form")).toBe("survey")
    })

    it("should detect contact app", () => {
      expect(detectAppType("联系我们")).toBe("contact")
      expect(detectAppType("contact us")).toBe("contact")
    })

    it("should detect dashboard app", () => {
      expect(detectAppType("数据仪表盘")).toBe("dashboard")
      expect(detectAppType("analytics dashboard")).toBe("dashboard")
    })

    it("should return null for unknown types", () => {
      expect(detectAppType("random text")).toBeNull()
      expect(detectAppType("")).toBeNull()
    })
  })

  describe("extractAppName", () => {
    it("should extract name from Chinese description", () => {
      const name = extractAppName("做一个小费计算器")
      expect(name).toBeTruthy()
    })

    it("should extract name from English description", () => {
      const name = extractAppName("create a tip calculator")
      expect(name).toBeTruthy()
    })

    it("should return default name for unclear description", () => {
      const name = extractAppName("some random text")
      expect(name).toBe("我的应用")
    })

    it("should use app type for name when detected", () => {
      const name = extractAppName("计算器")
      expect(name).toBe("计算器")
    })
  })

  describe("generateCalculatorApp", () => {
    it("should generate a basic calculator app", () => {
      const app = generateCalculatorApp("计算器", "基本计算器")
      expect(app).toBeDefined()
      expect(app.name).toBe("计算器")
      expect(app.components).toBeDefined()
      expect(app.components.length).toBeGreaterThan(0)
      expect(app.dataModel).toBeDefined()
    })

    it("should generate a tip calculator", () => {
      const app = generateCalculatorApp("小费计算器", "小费计算器")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("tipPercent")
    })

    it("should generate a BMI calculator", () => {
      const app = generateCalculatorApp("BMI计算器", "BMI体质指数")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("height")
      expect(app.dataModel).toHaveProperty("weight")
    })

    it("should generate a loan calculator", () => {
      const app = generateCalculatorApp("贷款计算器", "贷款月供计算")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("principal")
      expect(app.dataModel).toHaveProperty("rate")
    })
  })

  describe("generateTimerApp", () => {
    it("should generate a timer app", () => {
      const app = generateTimerApp("计时器", "5分钟计时器")
      expect(app).toBeDefined()
      expect(app.name).toBe("计时器")
      expect(app.dataModel).toHaveProperty("seconds")
      expect(app.dataModel).toHaveProperty("isRunning")
    })

    it("should generate a pomodoro timer", () => {
      const app = generateTimerApp("番茄钟", "番茄工作法25分钟")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("mode")
    })

    it("should parse preset minutes from description", () => {
      const app = generateTimerApp("计时器", "10分钟倒计时")
      expect(app.dataModel.totalSeconds).toBe(600)
    })
  })

  describe("generateTodoApp", () => {
    it("should generate a basic todo app", () => {
      const app = generateTodoApp("待办事项", "简单待办列表")
      expect(app).toBeDefined()
      expect(app.name).toBe("待办事项")
      expect(app.dataModel).toHaveProperty("tasks")
      expect(app.dataModel).toHaveProperty("newTask")
    })

    it("should include filter in data model", () => {
      const app = generateTodoApp("任务", "任务管理")
      expect(app.dataModel).toHaveProperty("filter")
    })
  })

  describe("generateNotesApp", () => {
    it("should generate a notes app", () => {
      const app = generateNotesApp("笔记", "快速笔记应用")
      expect(app).toBeDefined()
      expect(app.name).toBe("笔记")
      expect(app.dataModel).toHaveProperty("notes")
      expect(app.dataModel).toHaveProperty("searchQuery")
    })
  })

  describe("generateFormApp", () => {
    it("should generate a survey form", () => {
      const app = generateFormApp("问卷", "用户满意度调查", "survey")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("form")
      expect(app.dataModel).toHaveProperty("submitted")
    })

    it("should generate a contact form", () => {
      const app = generateFormApp("联系我们", "联系表单", "contact")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("form")
    })
  })

  describe("generateTrackerApp", () => {
    it("should generate an expense tracker", () => {
      const app = generateTrackerApp("支出记录", "记账支出追踪")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("expenses")
      expect(app.dataModel).toHaveProperty("totalSpent")
    })

    it("should generate a health tracker", () => {
      const app = generateTrackerApp("健康追踪", "运动健康记录")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("todayStats")
      expect(app.dataModel).toHaveProperty("goals")
    })

    it("should generate a habit tracker by default", () => {
      const app = generateTrackerApp("习惯", "每日习惯")
      expect(app).toBeDefined()
      expect(app.dataModel).toHaveProperty("habits")
    })
  })

  describe("generateCustomApp", () => {
    it("should generate a custom app with basic structure", () => {
      const app = generateCustomApp("我的应用", "自定义应用")
      expect(app).toBeDefined()
      expect(app.components).toBeDefined()
      expect(app.components.length).toBeGreaterThan(0)
    })

    it("should include input when description mentions it", () => {
      const app = generateCustomApp("输入工具", "需要输入数据的工具")
      expect(app.components.some((c) => c.component === "TextField")).toBe(true)
    })

    it("should include button when description mentions it", () => {
      const app = generateCustomApp("按钮工具", "需要点击按钮的工具")
      expect(app.components.some((c) => c.component === "Button")).toBe(true)
    })
  })

  describe("generateDashboardApp", () => {
    it("prefers reusable widget-oriented component families for dashboards", () => {
      const app = generateDashboardApp("分析看板", "analytics dashboard")

      expect(app.components.some((component) => component.component === "ComparisonCards")).toBe(
        true
      )
      expect(app.components.some((component) => component.component === "WidgetStatus")).toBe(true)
    })
  })

  describe("generateAppFromDescription", () => {
    it("should route to calculator generator", () => {
      const request: AppGenerationRequest = { description: "做一个计算器" }
      const app = generateAppFromDescription(request)
      expect(app).toBeDefined()
      expect(app.id).toContain("calc")
    })

    it("should route to timer generator", () => {
      const request: AppGenerationRequest = { description: "做一个倒计时" }
      const app = generateAppFromDescription(request)
      expect(app).toBeDefined()
      expect(app.id).toContain("timer")
    })

    it("should route to todo generator", () => {
      const request: AppGenerationRequest = { description: "待办事项列表" }
      const app = generateAppFromDescription(request)
      expect(app).toBeDefined()
      expect(app.id).toContain("todo")
    })

    it("should route to tracker for tracking apps", () => {
      const request: AppGenerationRequest = { description: "追踪我的支出" }
      const app = generateAppFromDescription(request)
      expect(app).toBeDefined()
      expect(app.id).toContain("tracker")
    })

    it("should generate custom app for unknown types", () => {
      const request: AppGenerationRequest = { description: "一个神奇的东西" }
      const app = generateAppFromDescription(request)
      expect(app).toBeDefined()
      expect(app.id).toContain("custom")
    })

    it("should generate valid app structure", () => {
      const request: AppGenerationRequest = { description: "计算器" }
      const app = generateAppFromDescription(request)

      expect(app.id).toBeTruthy()
      expect(app.name).toBeTruthy()
      expect(app.description).toBeTruthy()
      expect(Array.isArray(app.components)).toBe(true)
      expect(typeof app.dataModel).toBe("object")
      expect(Array.isArray(app.messages)).toBe(true)
    })
  })

  describe("GeneratedApp structure", () => {
    it("should have required fields", () => {
      const app = generateCalculatorApp("Test", "Test description")

      expect(app).toHaveProperty("id")
      expect(app).toHaveProperty("name")
      expect(app).toHaveProperty("description")
      expect(app).toHaveProperty("components")
      expect(app).toHaveProperty("dataModel")
      expect(app).toHaveProperty("messages")
    })

    it("should generate unique IDs for each app", () => {
      const app1 = generateCalculatorApp("Calc1", "First calculator")
      const app2 = generateCalculatorApp("Calc2", "Second calculator")

      expect(app1.id).not.toBe(app2.id)
    })
  })

  describe("generateUnitConverterApp", () => {
    it("should generate a unit converter app", () => {
      const app = generateUnitConverterApp("Unit Converter", "Convert units")

      expect(app).toBeDefined()
      expect(app.id).toContain("converter")
      expect(app.name).toBe("Unit Converter")
      expect(app.components.length).toBeGreaterThan(0)
      expect(app.dataModel).toHaveProperty("inputValue")
      expect(app.dataModel).toHaveProperty("fromUnit")
      expect(app.dataModel).toHaveProperty("toUnit")
      expect(app.dataModel).toHaveProperty("result")
    })

    it("should detect temperature converter", () => {
      const app = generateUnitConverterApp("Temp Convert", "温度转换器 celsius fahrenheit")

      expect(app).toBeDefined()
      expect(app.id).toContain("converter")
    })

    it("should detect weight converter", () => {
      const app = generateUnitConverterApp("Weight Convert", "weight converter kg lb")

      expect(app).toBeDefined()
      expect(app.id).toContain("converter")
    })

    it("should detect currency converter", () => {
      const app = generateUnitConverterApp("Currency Convert", "货币汇率转换")

      expect(app).toBeDefined()
      expect(app.id).toContain("converter")
    })
  })

  describe("getLocalizedTexts", () => {
    it("should return Chinese texts by default", () => {
      const texts = getLocalizedTexts()

      expect(texts).toBeDefined()
      expect(texts.defaultAppName).toBe("我的应用")
    })

    it("should return Chinese texts for zh", () => {
      const texts = getLocalizedTexts("zh")

      expect(texts).toBeDefined()
      expect(texts.defaultAppName).toBe("我的应用")
    })

    it("should return English texts for en", () => {
      const texts = getLocalizedTexts("en")

      expect(texts).toBeDefined()
      expect(texts.defaultAppName).toBe("My App")
    })
  })

  describe("getStyleConfig", () => {
    it("should return colorful style by default", () => {
      const style = getStyleConfig()

      expect(style).toBeDefined()
      expect(style.headerClassName).toContain("text-primary")
    })

    it("should return minimal style", () => {
      const style = getStyleConfig("minimal")

      expect(style).toBeDefined()
      expect(style.buttonVariant).toBe("outline")
    })

    it("should return colorful style", () => {
      const style = getStyleConfig("colorful")

      expect(style).toBeDefined()
      expect(style.buttonVariant).toBe("primary")
    })

    it("should return professional style", () => {
      const style = getStyleConfig("professional")

      expect(style).toBeDefined()
      expect(style.buttonVariant).toBe("secondary")
    })
  })

  describe("generateAppFromDescription with language/style", () => {
    it("should support language parameter", () => {
      const request: AppGenerationRequest = {
        description: "calculator app",
        language: "en",
      }
      const app = generateAppFromDescription(request)

      expect(app).toBeDefined()
      expect(app.id).toContain("calc")
    })

    it("should support style parameter", () => {
      const request: AppGenerationRequest = {
        description: "计算器",
        style: "professional",
      }
      const app = generateAppFromDescription(request)

      expect(app).toBeDefined()
      expect(app.id).toContain("calc")
    })

    it("should route to unit converter for conversion requests", () => {
      const request: AppGenerationRequest = { description: "单位转换器" }
      const app = generateAppFromDescription(request)

      expect(app).toBeDefined()
      expect(app.id).toContain("converter")
    })

    it("should detect unit converter from description", () => {
      const request: AppGenerationRequest = { description: "温度转换工具" }
      const app = generateAppFromDescription(request)

      expect(app).toBeDefined()
      expect(app.id).toContain("converter")
    })
  })

  describe("extractAppName with language support", () => {
    it("should extract English names for en language", () => {
      const name = extractAppName("create a calculator", {
        language: "en",
        style: "colorful",
        texts: getLocalizedTexts("en"),
        styleConfig: getStyleConfig("colorful"),
      })

      expect(name).toBeTruthy()
    })

    it("should extract Chinese names for zh language", () => {
      const name = extractAppName("做一个计算器", {
        language: "zh",
        style: "colorful",
        texts: getLocalizedTexts("zh"),
        styleConfig: getStyleConfig("colorful"),
      })

      expect(name).toBeTruthy()
    })
  })
})
