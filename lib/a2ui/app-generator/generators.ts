/**
 * A2UI App Generator - Generator Functions
 * Each function generates a complete app (components + dataModel + messages)
 */

import type { A2UIComponent, A2UIServerMessage } from "@/types/a2ui/schema"
import { deepClone } from "../data-model"
import {
  formatBuiltInRuntimeMessage,
  generateTemplateId,
  localizeTemplate,
  weatherTemplate,
} from "../templates"
import type { GenerationContext } from "./config"
import { texts, styles } from "./config"
import {
  createBasicCalculatorComponents,
  createTipCalculatorComponents,
  createBMICalculatorComponents,
  createAgeCalculatorComponents,
  createLoanCalculatorComponents,
  createTimerComponents,
  createTodoComponents,
  createNotesComponents,
  createSurveyComponents,
  createContactComponents,
  createExpenseTrackerComponents,
  createHealthTrackerComponents,
  createHabitTrackerComponents,
} from "./component-factories"
import {
  localizeDashboardDataModel,
  localizeGeneratedComponents,
  type GeneratorFactoryKind,
} from "./localization"

function localizeFactory(
  kind: GeneratorFactoryKind,
  components: A2UIComponent[],
  ctx?: GenerationContext
): A2UIComponent[] {
  return localizeGeneratedComponents(kind, components, ctx?.language ?? "zh")
}

/**
 * Generated app result
 */
export interface GeneratedApp {
  id: string
  name: string
  description: string
  components: A2UIComponent[]
  dataModel: Record<string, unknown>
  messages: A2UIServerMessage[]
}

/**
 * Create A2UI messages from components and data
 */
export function createAppMessages(
  surfaceId: string,
  title: string,
  components: A2UIComponent[],
  dataModel: Record<string, unknown>
): A2UIServerMessage[] {
  return [
    { type: "createSurface", surfaceId, surfaceType: "inline", title },
    { type: "updateComponents", surfaceId, components },
    { type: "dataModelUpdate", surfaceId, data: dataModel },
    { type: "surfaceReady", surfaceId },
  ]
}

/**
 * Generate custom calculator app
 */
export function generateCalculatorApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("calc")

  const _isUnitConverter = /转换|换算|convert/i.test(description)
  const isTipCalculator = /小费|tip|服务费/i.test(description)
  const isBMI = /bmi|身体|体重|体质/i.test(description)
  const isAge = /年龄|age|岁/i.test(description)
  const isLoan = /贷款|loan|月供|还款/i.test(description)

  let components: A2UIComponent[]
  let dataModel: Record<string, unknown>

  if (isTipCalculator) {
    components = localizeFactory("tipCalculator", createTipCalculatorComponents(), ctx)
    dataModel = { bill: 0, tipPercent: 15, people: 1, tipAmount: 0, total: 0, perPerson: 0 }
  } else if (isBMI) {
    components = localizeFactory("bmiCalculator", createBMICalculatorComponents(), ctx)
    dataModel = { height: 170, weight: 65, bmi: 0, status: "" }
  } else if (isAge) {
    components = localizeFactory("ageCalculator", createAgeCalculatorComponents(), ctx)
    dataModel = { birthDate: "", age: "", nextBirthday: "" }
  } else if (isLoan) {
    components = localizeFactory("loanCalculator", createLoanCalculatorComponents(), ctx)
    dataModel = { principal: 100000, rate: 5, years: 30, monthly: 0, total: 0, interest: 0 }
  } else {
    components = createBasicCalculatorComponents()
    dataModel = { display: "0", expression: "" }
  }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate countdown/timer app
 */
export function generateTimerApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("timer")

  const _isCountdown = /倒计时|countdown/i.test(description)
  const isPomodoro = /番茄|pomodoro|25分钟/i.test(description)

  let presetMinutes = 5
  const minuteMatch = description.match(/(\d+)\s*(?:分钟|分|min|minute)/i)
  if (minuteMatch) {
    presetMinutes = parseInt(minuteMatch[1], 10)
  }

  const components = localizeFactory(
    isPomodoro ? "pomodoro" : "timer",
    createTimerComponents(isPomodoro),
    ctx
  )
  const dataModel = {
    display: "00:00",
    seconds: 0,
    totalSeconds: presetMinutes * 60,
    progress: 0,
    isRunning: false,
    mode: isPomodoro ? "pomodoro" : "timer",
  }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/** Generate a weather app from the canonical catalog template. */
export function generateWeatherApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("weather")
  const template = localizeTemplate(weatherTemplate, ctx?.language === "zh" ? "zh-CN" : "en")
  const components = deepClone(template.components)
  const dataModel = deepClone(template.dataModel)

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate todo/task list app
 */
export function generateTodoApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("todo")

  const hasCategories = /分类|category|类别/i.test(description)
  const hasPriority = /优先|priority|重要/i.test(description)
  const hasDueDate = /截止|due|日期|时间/i.test(description)

  const components = localizeFactory(
    "todo",
    createTodoComponents(hasCategories, hasPriority, hasDueDate),
    ctx
  )
  const locale = ctx?.language === "en" ? "en" : "zh-CN"
  const dataModel = {
    newTask: "",
    tasks: [],
    filter: "all",
    stats: {
      completed: 0,
      pending: 0,
      total: 0,
      completedText: formatBuiltInRuntimeMessage(locale, "taskCompleted", { count: 0 }),
      pendingText: formatBuiltInRuntimeMessage(locale, "taskPending", { count: 0 }),
    },
  }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate notes app
 */
export function generateNotesApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("notes")

  const components = localizeFactory("notes", createNotesComponents(), ctx)
  const dataModel = {
    searchQuery: "",
    newNote: { title: "", content: "" },
    notes: [],
    selectedNoteId: null,
  }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate form app (survey/contact)
 */
export function generateFormApp(
  name: string,
  description: string,
  type: "survey" | "contact",
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("form")

  const components =
    type === "survey"
      ? localizeFactory("survey", createSurveyComponents(), ctx)
      : localizeFactory("contact", createContactComponents(), ctx)
  const dataModel = { form: {}, submitted: false, submitting: false }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate tracker app (habits, expenses, etc.)
 */
export function generateTrackerApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("tracker")

  const isExpense = /支出|花费|expense|消费|记账/i.test(description)
  const _isHabit = /习惯|habit|打卡|签到/i.test(description)
  const isHealth = /健康|health|运动|exercise|卡路里|calorie/i.test(description)

  let components: A2UIComponent[]
  let dataModel: Record<string, unknown>

  if (isExpense) {
    components = localizeFactory("expenseTracker", createExpenseTrackerComponents(), ctx)
    dataModel = {
      newExpense: { amount: 0, category: "", description: "" },
      expenses: [],
      totalSpent: 0,
      budget: 0,
    }
  } else if (isHealth) {
    components = localizeFactory("healthTracker", createHealthTrackerComponents(), ctx)
    dataModel = {
      todayStats: { steps: 0, calories: 0, water: 0, sleep: 0 },
      goals: { steps: 10000, calories: 2000, water: 8, sleep: 8 },
      history: [],
    }
  } else {
    components = localizeFactory("habitTracker", createHabitTrackerComponents(), ctx)
    const locale = ctx?.language === "en" ? "en" : "zh-CN"
    dataModel = {
      habits: [],
      today: new Date().toISOString().split("T")[0],
      streak: 0,
      streakText: formatBuiltInRuntimeMessage(locale, "habitStreak", { count: 0 }),
    }
  }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate unit converter app
 */
export function generateUnitConverterApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("converter")
  const t = ctx?.texts || texts.zh
  const isEnglish = ctx?.language === "en"

  const _isLength = /长度|length|米|厘米|英尺|inch|feet|cm|meter/i.test(description)
  const isWeight = /重量|weight|千克|磅|kg|pound|lb/i.test(description)
  const isTemperature = /温度|temperature|摄氏|华氏|celsius|fahrenheit/i.test(description)
  const isCurrency = /货币|汇率|currency|exchange|美元|人民币|usd|cny|eur/i.test(description)

  let converterType = "length"
  let units: { value: string; label: string }[] = []

  if (isTemperature) {
    converterType = "temperature"
    units = isEnglish
      ? [
          { value: "celsius", label: "Celsius (°C)" },
          { value: "fahrenheit", label: "Fahrenheit (°F)" },
          { value: "kelvin", label: "Kelvin (K)" },
        ]
      : [
          { value: "celsius", label: "摄氏度 (°C)" },
          { value: "fahrenheit", label: "华氏度 (°F)" },
          { value: "kelvin", label: "开尔文 (K)" },
        ]
  } else if (isWeight) {
    converterType = "weight"
    units = isEnglish
      ? [
          { value: "kg", label: "Kilogram (kg)" },
          { value: "lb", label: "Pound (lb)" },
          { value: "g", label: "Gram (g)" },
          { value: "oz", label: "Ounce (oz)" },
        ]
      : [
          { value: "kg", label: "千克 (kg)" },
          { value: "lb", label: "磅 (lb)" },
          { value: "g", label: "克 (g)" },
          { value: "oz", label: "盎司 (oz)" },
        ]
  } else if (isCurrency) {
    converterType = "currency"
    units = isEnglish
      ? [
          { value: "usd", label: "USD ($)" },
          { value: "cny", label: "CNY (¥)" },
          { value: "eur", label: "EUR (€)" },
          { value: "jpy", label: "JPY (¥)" },
        ]
      : [
          { value: "usd", label: "美元 ($)" },
          { value: "cny", label: "人民币 (¥)" },
          { value: "eur", label: "欧元 (€)" },
          { value: "jpy", label: "日元 (¥)" },
        ]
  } else {
    units = isEnglish
      ? [
          { value: "m", label: "Meter (m)" },
          { value: "cm", label: "Centimeter (cm)" },
          { value: "ft", label: "Feet (ft)" },
          { value: "in", label: "Inch (in)" },
        ]
      : [
          { value: "m", label: "米 (m)" },
          { value: "cm", label: "厘米 (cm)" },
          { value: "ft", label: "英尺 (ft)" },
          { value: "in", label: "英寸 (in)" },
        ]
  }

  const headerText = `🔄 ${name}`
  const fromLabel = isEnglish ? "From" : "从"
  const toLabel = isEnglish ? "To" : "到"
  const inputLabel = isEnglish ? "Value" : "数值"
  const resultLabel = isEnglish ? "Result" : "结果"

  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: ["header", "converter-card", "result-card"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: headerText, variant: "heading2" },
    {
      id: "converter-card",
      component: "Card",
      children: ["input-row", "unit-row", "convert-btn"],
      className: "p-4 gap-4",
    },
    {
      id: "input-row",
      component: "TextField",
      value: { path: "/inputValue" },
      label: inputLabel,
      type: "number",
      placeholder: "0",
    },
    {
      id: "unit-row",
      component: "Row",
      children: ["from-unit", "arrow", "to-unit"],
      className: "gap-2 items-center",
    },
    {
      id: "from-unit",
      component: "Select",
      value: { path: "/fromUnit" },
      label: fromLabel,
      options: units,
      className: "flex-1",
    },
    {
      id: "arrow",
      component: "Icon",
      name: "ArrowRight",
      size: 20,
      className: "text-muted-foreground",
    },
    {
      id: "to-unit",
      component: "Select",
      value: { path: "/toUnit" },
      label: toLabel,
      options: units,
      className: "flex-1",
    },
    {
      id: "convert-btn",
      component: "Button",
      text: t.execute,
      action: "convert",
      variant: ctx?.styleConfig.buttonVariant || "primary",
      className: "mt-2",
    },
    {
      id: "result-card",
      component: "Card",
      children: ["result-label", "result-value"],
      className: "text-center p-6",
    },
    { id: "result-label", component: "Text", text: resultLabel, variant: "caption" },
    {
      id: "result-value",
      component: "Text",
      text: { path: "/result" },
      variant: "heading1",
      className: "font-mono",
    },
  ] as A2UIComponent[]

  const dataModel = {
    inputValue: "",
    fromUnit: units[0]?.value || "",
    toUnit: units[1]?.value || "",
    result: "0",
    converterType,
  }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate a generic custom app based on description
 */
export function generateCustomApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("custom")
  const isEnglish = ctx?.language === "en"
  const styleConfig = ctx?.styleConfig || styles.colorful

  const hasInput = /输入|input|填写|enter/i.test(description)
  const hasButton = /按钮|button|点击|click/i.test(description)
  const hasList = /列表|list|记录|records/i.test(description)
  const hasChart = /图表|chart|统计|graph/i.test(description)

  const children = ["header", "content"]
  if (hasList) children.push("list-section")
  if (hasChart) children.push("chart-section")
  children.push("actions")

  const components: A2UIComponent[] = [
    { id: "root", component: "Column", children, className: "gap-4 p-4" },
    {
      id: "header",
      component: "Text",
      text: name,
      variant: "heading2",
      className: ctx?.styleConfig.headerClassName,
    },
    {
      id: "content",
      component: "Card",
      children: hasInput ? ["input-section"] : ["info-text"],
      className: `p-4 ${ctx?.styleConfig.cardClassName || ""}`,
    },
  ]

  if (hasInput) {
    const inputPlaceholder = isEnglish ? "Enter value..." : "请输入..."
    const inputLabel = isEnglish ? "Input" : "输入"
    components.push({
      id: "input-section",
      component: "Column",
      children: ["main-input", "submit-btn"],
      className: "gap-3",
    } as A2UIComponent)
    components.push({
      id: "main-input",
      component: "TextField",
      value: { path: "/inputValue" },
      placeholder: inputPlaceholder,
      label: inputLabel,
    } as A2UIComponent)
    components.push({
      id: "submit-btn",
      component: "Button",
      text: isEnglish ? "Submit" : "提交",
      action: "submit",
      variant: styleConfig.buttonVariant,
    } as A2UIComponent)
  } else {
    components.push({
      id: "info-text",
      component: "Text",
      text: description,
      variant: "body",
    } as A2UIComponent)
  }

  components.push({
    id: "actions",
    component: "Row",
    children: hasButton ? ["action-btn"] : [],
    className: "gap-2",
  } as A2UIComponent)

  if (hasButton) {
    components.push({
      id: "action-btn",
      component: "Button",
      text: ctx?.texts.execute ?? texts.zh.execute,
      action: "execute",
      variant: "primary",
    } as A2UIComponent)
  }

  const dataModel: Record<string, unknown> = { inputValue: "", result: null }

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}

/**
 * Generate dashboard app
 */
export function generateDashboardApp(
  name: string,
  description: string,
  ctx?: GenerationContext
): GeneratedApp {
  const id = generateTemplateId("dashboard")

  const baseComponents: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: ["header", "summary", "status", "chart-section"],
      className: "gap-4 p-4",
    },
    {
      id: "header",
      component: "Row",
      children: ["title", "refresh-btn"],
      className: "justify-between items-center",
    },
    { id: "title", component: "Text", text: `📊 ${name}`, variant: "heading2" },
    {
      id: "refresh-btn",
      component: "Button",
      text: "刷新",
      action: "refresh",
      variant: "outline",
      icon: "RefreshCw",
    },
    {
      id: "summary",
      component: "ComparisonCards",
      title: "关键指标",
      items: { path: "/summaryItems" },
    },
    {
      id: "status",
      component: "WidgetStatus",
      status: "ready",
      title: "数据状态",
      message: { path: "/status/message" },
      detail: { path: "/status/detail" },
    },
    { id: "chart-section", component: "Card", title: "趋势图", children: ["main-chart"] },
    {
      id: "main-chart",
      component: "Chart",
      chartType: "area",
      data: { path: "/chartData" },
      xKey: "name",
      yKeys: ["value"],
      height: 200,
      showGrid: true,
    },
  ] as A2UIComponent[]
  const components = localizeFactory("dashboard", baseComponents, ctx)

  const baseDataModel = {
    stats: { value1: "1,234", value2: "567", value3: "+12%" },
    summaryItems: [
      { id: "value-1", title: "数据1", value: "1,234", badge: "Live" },
      { id: "value-2", title: "数据2", value: "567", badge: "Stable" },
      { id: "value-3", title: "数据3", value: "+12%", badge: "Trend" },
    ],
    status: {
      message: "数据源已同步，当前可安全刷新。",
      detail: "最近一次更新发生在过去 5 分钟内。",
    },
    chartData: [
      { name: "周一", value: 120 },
      { name: "周二", value: 180 },
      { name: "周三", value: 150 },
      { name: "周四", value: 220 },
      { name: "周五", value: 190 },
      { name: "周六", value: 280 },
      { name: "周日", value: 250 },
    ],
  }
  const dataModel = localizeDashboardDataModel(baseDataModel, ctx?.language ?? "zh")

  return {
    id,
    name,
    description,
    components,
    dataModel,
    messages: createAppMessages(id, name, components, dataModel),
  }
}
