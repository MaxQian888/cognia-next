/**
 * A2UI App Generator - Configuration
 * Localization, styles, patterns, and detection utilities
 */

/**
 * Localized text configuration
 */
export interface LocalizedTexts {
  defaultAppName: string
  execute: string
  submit: string
  add: string
  clear: string
  refresh: string
  start: string
  pause: string
  reset: string
  save: string
  delete: string
  search: string
  noTasks: string
  noNotes: string
  completed: string
  pending: string
}

export const texts: Record<"zh" | "en", LocalizedTexts> = {
  zh: {
    defaultAppName: "我的应用",
    execute: "执行",
    submit: "提交",
    add: "添加",
    clear: "清除",
    refresh: "刷新",
    start: "开始",
    pause: "暂停",
    reset: "重置",
    save: "保存",
    delete: "删除",
    search: "搜索",
    noTasks: "暂无任务",
    noNotes: "暂无笔记",
    completed: "已完成",
    pending: "待完成",
  },
  en: {
    defaultAppName: "My App",
    execute: "Execute",
    submit: "Submit",
    add: "Add",
    clear: "Clear",
    refresh: "Refresh",
    start: "Start",
    pause: "Pause",
    reset: "Reset",
    save: "Save",
    delete: "Delete",
    search: "Search",
    noTasks: "No tasks yet",
    noNotes: "No notes yet",
    completed: "completed",
    pending: "pending",
  },
}

/**
 * Style configuration for app appearance
 */
export interface StyleConfig {
  cardClassName: string
  buttonVariant: "primary" | "secondary" | "outline"
  headerClassName: string
  accentColor: string
}

export const styles: Record<"minimal" | "colorful" | "professional", StyleConfig> = {
  minimal: {
    cardClassName: "border-0 shadow-none",
    buttonVariant: "outline",
    headerClassName: "text-foreground",
    accentColor: "muted",
  },
  colorful: {
    cardClassName: "border-primary/20 shadow-md",
    buttonVariant: "primary",
    headerClassName: "text-primary",
    accentColor: "primary",
  },
  professional: {
    cardClassName: "border shadow-sm",
    buttonVariant: "secondary",
    headerClassName: "text-foreground font-semibold",
    accentColor: "secondary",
  },
}

/**
 * Get localized texts based on language
 */
export function getLocalizedTexts(language: "zh" | "en" = "zh"): LocalizedTexts {
  return texts[language]
}

/**
 * Get style configuration
 */
export function getStyleConfig(
  style: "minimal" | "colorful" | "professional" = "colorful"
): StyleConfig {
  return styles[style]
}

/**
 * Internal generation context with resolved options
 */
export interface GenerationContext {
  language: "zh" | "en"
  style: "minimal" | "colorful" | "professional"
  texts: LocalizedTexts
  styleConfig: StyleConfig
}

/**
 * App generation request
 */
export interface AppGenerationRequest {
  description: string
  language?: "zh" | "en"
  style?: "minimal" | "colorful" | "professional"
}

/**
 * App component patterns for common use cases
 */
export const appPatterns = {
  calculator: {
    keywords: ["计算", "计算器", "calculator", "calc", "算", "加减乘除"],
    template: "calculator",
  },
  timer: {
    keywords: ["计时", "倒计时", "timer", "countdown", "秒表", "stopwatch"],
    template: "timer",
  },
  todo: {
    keywords: ["待办", "任务", "todo", "task", "清单", "list", "事项"],
    template: "todo-list",
  },
  notes: {
    keywords: ["笔记", "记事", "notes", "memo", "便签", "记录"],
    template: "notes",
  },
  contact: {
    keywords: ["联系", "联络", "contact", "留言", "message"],
    template: "contact-form",
  },
  survey: {
    keywords: ["问卷", "调查", "survey", "form", "表单", "反馈", "feedback"],
    template: "survey-form",
  },
  weather: {
    keywords: ["天气", "weather", "气温", "温度"],
    template: "weather",
  },
  dashboard: {
    keywords: ["仪表盘", "dashboard", "数据", "统计", "analytics", "图表", "chart"],
    template: "data-dashboard",
  },
}

/**
 * Detect app type from description
 */
export function detectAppType(description: string): string | null {
  const lowerDesc = description.toLowerCase()

  for (const [type, pattern] of Object.entries(appPatterns)) {
    if (pattern.keywords.some((kw) => lowerDesc.includes(kw))) {
      return type
    }
  }

  return null
}

/**
 * Auto-detect language from description
 */
export function detectLanguage(description: string): "zh" | "en" {
  const chineseRegex = /[\u4e00-\u9fff]/
  return chineseRegex.test(description) ? "zh" : "en"
}

/**
 * Extract app name from description
 */
export function extractAppName(description: string, ctx?: GenerationContext): string {
  const patterns = [
    /(?:做|创建|生成|制作|建一个|做一个|create|make|build|generate)\s*(?:一个|个)?\s*[「「"']?([^「」"'\s,，。.]+)[」」"']?/i,
    /([^,，。.\s]+?)(?:计算器|工具|应用|app|助手|小程序)/i,
  ]

  for (const pattern of patterns) {
    const match = description.match(pattern)
    if (match && match[1]) {
      return match[1].trim()
    }
  }

  const appType = detectAppType(description)
  const isEnglish = ctx?.language === "en"

  if (appType) {
    const typeNames: Record<string, { zh: string; en: string }> = {
      calculator: { zh: "计算器", en: "Calculator" },
      timer: { zh: "计时器", en: "Timer" },
      todo: { zh: "待办事项", en: "Todo List" },
      notes: { zh: "快速笔记", en: "Quick Notes" },
      survey: { zh: "调查问卷", en: "Survey" },
      contact: { zh: "联系表单", en: "Contact Form" },
      weather: { zh: "天气查看", en: "Weather" },
      dashboard: { zh: "数据仪表盘", en: "Dashboard" },
    }
    const names = typeNames[appType]
    return names ? (isEnglish ? names.en : names.zh) : ctx?.texts.defaultAppName || "我的应用"
  }

  return ctx?.texts.defaultAppName || "我的应用"
}

/**
 * Create generation context from request
 */
export function createGenerationContext(request: AppGenerationRequest): GenerationContext {
  const language = request.language || detectLanguage(request.description)
  const style = request.style || "colorful"
  return {
    language,
    style,
    texts: getLocalizedTexts(language),
    styleConfig: getStyleConfig(style),
  }
}
