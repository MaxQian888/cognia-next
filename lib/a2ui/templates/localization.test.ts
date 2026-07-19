import {
  appTemplates,
  getLocalizedTemplateById,
  getLocalizedTemplates,
  getLocalizedTemplatesByCategory,
  searchLocalizedTemplates,
} from "./index"
import { formatBuiltInRuntimeMessage, localizeTemplate } from "./localization"

const expectedChineseNames: Record<string, string> = {
  "todo-list": "待办清单",
  calculator: "计算器",
  "survey-form": "调查表单",
  "data-dashboard": "数据仪表盘",
  timer: "计时器",
  notes: "快捷笔记",
  weather: "天气组件",
  "contact-form": "联系表单",
  "unit-converter": "单位换算器",
  "habit-tracker": "习惯追踪器",
  "shopping-list": "购物清单",
  "expense-tracker": "支出追踪器",
  "profile-card": "个人资料卡",
}

describe("built-in template localization", () => {
  it("localizes every canonical template without changing its identity or structure", () => {
    const localized = getLocalizedTemplates("zh-CN")

    expect(localized).toHaveLength(appTemplates.length)
    expect(Object.keys(expectedChineseNames)).toHaveLength(appTemplates.length)
    for (const [index, template] of localized.entries()) {
      const canonical = appTemplates[index]!
      expect(template.id).toBe(canonical.id)
      expect(template.name).toBe(expectedChineseNames[template.id])
      expect(template.description).not.toBe(canonical.description)
      expect(template.tags).not.toEqual(canonical.tags)
      expect(template.components.map((component) => component.id)).toEqual(
        canonical.components.map((component) => component.id)
      )
    }
  })

  it("applies component, option, table, and nested data-model copy", () => {
    const todo = getLocalizedTemplateById("todo-list", "zh-CN")!
    const contact = getLocalizedTemplateById("contact-form", "zh-CN")!
    const dashboard = getLocalizedTemplateById("data-dashboard", "zh-CN")!
    const weather = getLocalizedTemplateById("weather", "zh-CN")!

    expect(todo.components.find(({ id }) => id === "task-input")).toMatchObject({
      placeholder: "输入新任务……",
    })
    expect(todo.dataModel).toMatchObject({
      stats: { completed: 0, completedText: "已完成 0 项", pendingText: "待完成 0 项" },
    })
    expect(contact.components.find(({ id }) => id === "subject-select")).toMatchObject({
      options: [
        { value: "general", label: "一般咨询" },
        { value: "support", label: "技术支持" },
        { value: "sales", label: "销售咨询" },
        { value: "feedback", label: "意见反馈" },
        { value: "other", label: "其他" },
      ],
    })
    expect(dashboard.components.find(({ id }) => id === "activity-table")).toMatchObject({
      columns: [
        expect.objectContaining({ key: "date", header: "日期" }),
        expect.objectContaining({ key: "event", header: "事件" }),
        expect.objectContaining({ key: "user", header: "用户" }),
        expect.objectContaining({ key: "value", header: "数值" }),
      ],
    })
    expect(dashboard.dataModel.chartData).toEqual(
      expect.arrayContaining([expect.objectContaining({ month: "1 月", users: 1200 })])
    )
    expect(weather.dataModel).toMatchObject({
      weather: { location: "美国加利福尼亚州旧金山", condition: "局部多云", humidity: "65%" },
    })
  })

  it("returns isolated clones and never mutates the canonical template", () => {
    const canonical = appTemplates.find(({ id }) => id === "todo-list")!
    const localized = localizeTemplate(canonical, "zh-CN")

    localized.components[0]!.id = "changed"
    ;(localized.dataModel.stats as Record<string, unknown>).completed = 99
    localized.tags.push("changed")

    expect(canonical.components[0]!.id).toBe("root")
    expect(canonical.dataModel).toMatchObject({ stats: { completed: 0 } })
    expect(canonical.tags).not.toContain("changed")
  })

  it("formats action-generated copy in the instance locale", () => {
    expect(formatBuiltInRuntimeMessage("en", "noteCount", { count: 2 })).toBe("2 notes")
    expect(formatBuiltInRuntimeMessage("zh-CN", "noteCount", { count: 2 })).toBe("共 2 条笔记")
    expect(formatBuiltInRuntimeMessage("en", "bmiNormal")).toBe("Normal")
    expect(formatBuiltInRuntimeMessage("zh-CN", "bmiNormal")).toBe("正常")
    expect(formatBuiltInRuntimeMessage("zh-CN", "nextBirthday", { count: 8 })).toBe(
      "距离下次生日还有 8 天"
    )
  })

  it("searches localized metadata and keeps category filtering localized", () => {
    expect(searchLocalizedTemplates("购物", "zh-CN").map(({ id }) => id)).toContain("shopping-list")
    expect(searchLocalizedTemplates("效率", "zh-CN").map(({ id }) => id)).toEqual(
      expect.arrayContaining(["todo-list", "notes", "habit-tracker", "shopping-list"])
    )
    expect(getLocalizedTemplatesByCategory("utility", "zh-CN")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "calculator", name: "计算器" })])
    )
  })
})
