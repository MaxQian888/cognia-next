/**
 * A2UI App Generator - Component Factories
 * Functions that create A2UIComponent arrays for each app template type
 */

import type { A2UIComponent } from "@/types/a2ui/schema"

export function createBasicCalculatorComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["display", "keypad"],
      className: "gap-2 p-4 max-w-xs",
    },
    { id: "display", component: "Card", children: ["display-text"], className: "bg-muted" },
    {
      id: "display-text",
      component: "Text",
      text: { path: "/display" },
      variant: "heading1",
      align: "right",
      className: "font-mono p-3",
    },
    {
      id: "keypad",
      component: "Column",
      children: ["row1", "row2", "row3", "row4"],
      className: "gap-1",
    },
    {
      id: "row1",
      component: "Row",
      children: ["btn-c", "btn-div", "btn-mul", "btn-del"],
      className: "gap-1",
    },
    {
      id: "row2",
      component: "Row",
      children: ["btn-7", "btn-8", "btn-9", "btn-sub"],
      className: "gap-1",
    },
    {
      id: "row3",
      component: "Row",
      children: ["btn-4", "btn-5", "btn-6", "btn-add"],
      className: "gap-1",
    },
    {
      id: "row4",
      component: "Row",
      children: ["btn-1", "btn-2", "btn-3", "btn-eq"],
      className: "gap-1",
    },
    { id: "btn-c", component: "Button", text: "C", action: "clear", variant: "destructive" },
    { id: "btn-div", component: "Button", text: "÷", action: "op_div", variant: "secondary" },
    { id: "btn-mul", component: "Button", text: "×", action: "op_mul", variant: "secondary" },
    { id: "btn-del", component: "Button", text: "⌫", action: "delete", variant: "outline" },
    { id: "btn-7", component: "Button", text: "7", action: "num_7", variant: "outline" },
    { id: "btn-8", component: "Button", text: "8", action: "num_8", variant: "outline" },
    { id: "btn-9", component: "Button", text: "9", action: "num_9", variant: "outline" },
    { id: "btn-sub", component: "Button", text: "-", action: "op_sub", variant: "secondary" },
    { id: "btn-4", component: "Button", text: "4", action: "num_4", variant: "outline" },
    { id: "btn-5", component: "Button", text: "5", action: "num_5", variant: "outline" },
    { id: "btn-6", component: "Button", text: "6", action: "num_6", variant: "outline" },
    { id: "btn-add", component: "Button", text: "+", action: "op_add", variant: "secondary" },
    { id: "btn-1", component: "Button", text: "1", action: "num_1", variant: "outline" },
    { id: "btn-2", component: "Button", text: "2", action: "num_2", variant: "outline" },
    { id: "btn-3", component: "Button", text: "3", action: "num_3", variant: "outline" },
    { id: "btn-eq", component: "Button", text: "=", action: "calculate", variant: "primary" },
  ] as A2UIComponent[]
}

export function createTipCalculatorComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "inputs", "results"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "💰 小费计算器", variant: "heading2" },
    {
      id: "inputs",
      component: "Card",
      children: ["bill-input", "tip-slider", "people-input"],
      className: "p-4 gap-4",
    },
    {
      id: "bill-input",
      component: "TextField",
      value: { path: "/bill" },
      label: "账单金额",
      type: "number",
      placeholder: "0.00",
    },
    {
      id: "tip-slider",
      component: "Slider",
      value: { path: "/tipPercent" },
      label: "小费比例 (%)",
      min: 0,
      max: 30,
      step: 1,
      showValue: true,
    },
    {
      id: "people-input",
      component: "TextField",
      value: { path: "/people" },
      label: "人数",
      type: "number",
      placeholder: "1",
    },
    { id: "results", component: "Row", children: ["tip-card", "total-card"], className: "gap-3" },
    {
      id: "tip-card",
      component: "Card",
      title: "小费",
      children: ["tip-value"],
      className: "flex-1 text-center",
    },
    { id: "tip-value", component: "Text", text: { path: "/tipAmount" }, variant: "heading2" },
    {
      id: "total-card",
      component: "Card",
      title: "每人",
      children: ["per-person-value"],
      className: "flex-1 text-center",
    },
    {
      id: "per-person-value",
      component: "Text",
      text: { path: "/perPerson" },
      variant: "heading2",
    },
  ] as A2UIComponent[]
}

export function createBMICalculatorComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "inputs", "result-card"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "🏃 BMI计算器", variant: "heading2" },
    {
      id: "inputs",
      component: "Card",
      children: ["height-input", "weight-input", "calc-btn"],
      className: "p-4 gap-4",
    },
    {
      id: "height-input",
      component: "Slider",
      value: { path: "/height" },
      label: "身高 (cm)",
      min: 100,
      max: 220,
      step: 1,
      showValue: true,
    },
    {
      id: "weight-input",
      component: "Slider",
      value: { path: "/weight" },
      label: "体重 (kg)",
      min: 30,
      max: 150,
      step: 0.5,
      showValue: true,
    },
    {
      id: "calc-btn",
      component: "Button",
      text: "计算 BMI",
      action: "calculate_bmi",
      variant: "primary",
    },
    {
      id: "result-card",
      component: "Card",
      children: ["bmi-value", "bmi-status"],
      className: "text-center p-6",
    },
    { id: "bmi-value", component: "Text", text: { path: "/bmi" }, variant: "heading1" },
    { id: "bmi-status", component: "Badge", text: { path: "/status" }, variant: "secondary" },
  ] as A2UIComponent[]
}

export function createAgeCalculatorComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "input-card", "result-card"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "🎂 年龄计算器", variant: "heading2" },
    { id: "input-card", component: "Card", children: ["date-input", "calc-btn"], className: "p-4" },
    { id: "date-input", component: "DatePicker", value: { path: "/birthDate" }, label: "出生日期" },
    {
      id: "calc-btn",
      component: "Button",
      text: "计算年龄",
      action: "calculate_age",
      variant: "primary",
      className: "mt-4",
    },
    {
      id: "result-card",
      component: "Card",
      children: ["age-display", "next-birthday"],
      className: "text-center p-6",
    },
    { id: "age-display", component: "Text", text: { path: "/age" }, variant: "heading1" },
    { id: "next-birthday", component: "Text", text: { path: "/nextBirthday" }, variant: "caption" },
  ] as A2UIComponent[]
}

export function createLoanCalculatorComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "inputs", "results"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "🏠 贷款计算器", variant: "heading2" },
    {
      id: "inputs",
      component: "Card",
      children: ["principal-input", "rate-input", "years-input", "calc-btn"],
      className: "p-4 gap-3",
    },
    {
      id: "principal-input",
      component: "TextField",
      value: { path: "/principal" },
      label: "贷款金额",
      type: "number",
    },
    {
      id: "rate-input",
      component: "Slider",
      value: { path: "/rate" },
      label: "年利率 (%)",
      min: 1,
      max: 15,
      step: 0.1,
      showValue: true,
    },
    {
      id: "years-input",
      component: "Slider",
      value: { path: "/years" },
      label: "贷款年限",
      min: 1,
      max: 30,
      step: 1,
      showValue: true,
    },
    {
      id: "calc-btn",
      component: "Button",
      text: "计算",
      action: "calculate_loan",
      variant: "primary",
    },
    {
      id: "results",
      component: "Row",
      children: ["monthly-card", "total-card", "interest-card"],
      className: "gap-2",
    },
    {
      id: "monthly-card",
      component: "Card",
      title: "月供",
      children: ["monthly-value"],
      className: "flex-1 text-center",
    },
    { id: "monthly-value", component: "Text", text: { path: "/monthly" }, variant: "heading3" },
    {
      id: "total-card",
      component: "Card",
      title: "总还款",
      children: ["total-value"],
      className: "flex-1 text-center",
    },
    { id: "total-value", component: "Text", text: { path: "/total" }, variant: "heading3" },
    {
      id: "interest-card",
      component: "Card",
      title: "利息",
      children: ["interest-value"],
      className: "flex-1 text-center",
    },
    { id: "interest-value", component: "Text", text: { path: "/interest" }, variant: "heading3" },
  ] as A2UIComponent[]
}

export function createTimerComponents(isPomodoro: boolean): A2UIComponent[] {
  const presets = isPomodoro
    ? ["work-btn", "break-btn", "long-break-btn"]
    : ["1min-btn", "5min-btn", "10min-btn"]

  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "display-card", "controls", "presets"],
      className: "gap-4 p-4 items-center",
    },
    {
      id: "header",
      component: "Text",
      text: isPomodoro ? "🍅 番茄钟" : "⏱️ 计时器",
      variant: "heading2",
    },
    {
      id: "display-card",
      component: "Card",
      children: ["time-display", "progress"],
      className: "w-full text-center p-8",
    },
    {
      id: "time-display",
      component: "Text",
      text: { path: "/display" },
      variant: "heading1",
      className: "font-mono text-5xl",
    },
    {
      id: "progress",
      component: "Progress",
      value: { path: "/progress" },
      max: 100,
      className: "mt-4",
    },
    {
      id: "controls",
      component: "Row",
      children: ["start-btn", "pause-btn", "reset-btn"],
      className: "gap-2",
    },
    {
      id: "start-btn",
      component: "Button",
      text: "开始",
      action: "start",
      variant: "primary",
      icon: "Play",
    },
    {
      id: "pause-btn",
      component: "Button",
      text: "暂停",
      action: "pause",
      variant: "secondary",
      icon: "Pause",
    },
    {
      id: "reset-btn",
      component: "Button",
      text: "重置",
      action: "reset",
      variant: "outline",
      icon: "RotateCcw",
    },
    { id: "presets", component: "Row", children: presets, className: "gap-2" },
    ...(isPomodoro
      ? [
          {
            id: "work-btn",
            component: "Button",
            text: "工作 25分",
            action: "set_25",
            variant: "ghost",
          },
          {
            id: "break-btn",
            component: "Button",
            text: "休息 5分",
            action: "set_5",
            variant: "ghost",
          },
          {
            id: "long-break-btn",
            component: "Button",
            text: "长休 15分",
            action: "set_15",
            variant: "ghost",
          },
        ]
      : [
          { id: "1min-btn", component: "Button", text: "1分钟", action: "set_1", variant: "ghost" },
          { id: "5min-btn", component: "Button", text: "5分钟", action: "set_5", variant: "ghost" },
          {
            id: "10min-btn",
            component: "Button",
            text: "10分钟",
            action: "set_10",
            variant: "ghost",
          },
        ]),
  ] as A2UIComponent[]
}

export function createTodoComponents(
  hasCategories: boolean,
  hasPriority: boolean,
  hasDueDate: boolean
): A2UIComponent[] {
  const inputChildren = ["task-input"]
  if (hasDueDate) inputChildren.push("due-date")
  inputChildren.push("add-btn")

  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "input-row", "filter-row", "task-list", "stats-row"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "✅ 待办事项", variant: "heading2" },
    { id: "input-row", component: "Row", children: inputChildren, className: "gap-2" },
    {
      id: "task-input",
      component: "TextField",
      value: { path: "/newTask" },
      placeholder: "添加新任务...",
      className: "flex-1",
    },
    ...(hasDueDate
      ? [
          {
            id: "due-date",
            component: "DatePicker",
            value: { path: "/newDueDate" },
            placeholder: "截止日期",
          },
        ]
      : []),
    {
      id: "add-btn",
      component: "Button",
      text: "添加",
      action: "add_task",
      variant: "primary",
      icon: "Plus",
    },
    {
      id: "filter-row",
      component: "Row",
      children: ["filter-all", "filter-pending", "filter-done"],
      className: "gap-2",
    },
    { id: "filter-all", component: "Button", text: "全部", action: "filter_all", variant: "ghost" },
    {
      id: "filter-pending",
      component: "Button",
      text: "待完成",
      action: "filter_pending",
      variant: "ghost",
    },
    {
      id: "filter-done",
      component: "Button",
      text: "已完成",
      action: "filter_done",
      variant: "ghost",
    },
    {
      id: "task-list",
      component: "List",
      items: { path: "/tasks" },
      emptyText: "暂无任务",
      itemClickAction: "toggle_task",
      dividers: true,
    },
    {
      id: "stats-row",
      component: "Row",
      children: ["completed-badge", "pending-badge"],
      className: "gap-2 justify-center",
    },
    {
      id: "completed-badge",
      component: "Badge",
      text: { path: "/stats/completedText" },
      variant: "secondary",
    },
    {
      id: "pending-badge",
      component: "Badge",
      text: { path: "/stats/pendingText" },
      variant: "outline",
    },
  ] as A2UIComponent[]
}

export function createNotesComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "search", "new-note", "notes-list"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "📝 快速笔记", variant: "heading2" },
    {
      id: "search",
      component: "TextField",
      value: { path: "/searchQuery" },
      placeholder: "🔍 搜索笔记...",
    },
    {
      id: "new-note",
      component: "Card",
      children: ["note-title", "note-content", "save-btn"],
      className: "p-4",
    },
    {
      id: "note-title",
      component: "TextField",
      value: { path: "/newNote/title" },
      placeholder: "标题",
      label: "标题",
    },
    {
      id: "note-content",
      component: "TextArea",
      value: { path: "/newNote/content" },
      placeholder: "写下你的想法...",
      rows: 3,
    },
    {
      id: "save-btn",
      component: "Button",
      text: "保存笔记",
      action: "save_note",
      variant: "primary",
      icon: "Save",
      className: "mt-2",
    },
    {
      id: "notes-list",
      component: "List",
      items: { path: "/notes" },
      emptyText: "暂无笔记",
      itemClickAction: "select_note",
    },
  ] as A2UIComponent[]
}

export function createSurveyComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "form-card", "submit-row"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Column", children: ["title", "desc"], className: "gap-1" },
    { id: "title", component: "Text", text: "📋 快速调查", variant: "heading2" },
    { id: "desc", component: "Text", text: "请填写以下问题", variant: "caption" },
    { id: "form-card", component: "Card", children: ["q1", "q2", "q3"], className: "p-4 gap-4" },
    {
      id: "q1",
      component: "TextField",
      value: { path: "/form/name" },
      label: "您的名字",
      required: true,
    },
    {
      id: "q2",
      component: "RadioGroup",
      value: { path: "/form/satisfaction" },
      label: "满意度",
      options: [
        { value: "very", label: "非常满意" },
        { value: "good", label: "满意" },
        { value: "neutral", label: "一般" },
        { value: "poor", label: "不满意" },
      ],
    },
    {
      id: "q3",
      component: "TextArea",
      value: { path: "/form/feedback" },
      label: "其他建议",
      rows: 3,
    },
    { id: "submit-row", component: "Row", children: ["submit-btn"], className: "justify-end" },
    {
      id: "submit-btn",
      component: "Button",
      text: "提交",
      action: "submit",
      variant: "primary",
      icon: "Send",
    },
  ] as A2UIComponent[]
}

export function createContactComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "form-card", "submit-btn"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "✉️ 联系我们", variant: "heading2" },
    {
      id: "form-card",
      component: "Card",
      children: ["name-row", "email", "subject", "message"],
      className: "p-4 gap-3",
    },
    { id: "name-row", component: "Row", children: ["first-name", "last-name"], className: "gap-2" },
    {
      id: "first-name",
      component: "TextField",
      value: { path: "/form/firstName" },
      label: "名",
      required: true,
      className: "flex-1",
    },
    {
      id: "last-name",
      component: "TextField",
      value: { path: "/form/lastName" },
      label: "姓",
      required: true,
      className: "flex-1",
    },
    {
      id: "email",
      component: "TextField",
      value: { path: "/form/email" },
      label: "邮箱",
      type: "email",
      required: true,
    },
    {
      id: "subject",
      component: "Select",
      value: { path: "/form/subject" },
      label: "主题",
      options: [
        { value: "general", label: "一般咨询" },
        { value: "support", label: "技术支持" },
        { value: "feedback", label: "意见反馈" },
      ],
    },
    {
      id: "message",
      component: "TextArea",
      value: { path: "/form/message" },
      label: "留言内容",
      rows: 4,
      required: true,
    },
    {
      id: "submit-btn",
      component: "Button",
      text: "发送",
      action: "submit",
      variant: "primary",
      icon: "Send",
    },
  ] as A2UIComponent[]
}

export function createExpenseTrackerComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "summary", "add-expense", "expense-list"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "💰 支出记录", variant: "heading2" },
    {
      id: "summary",
      component: "Row",
      children: ["total-card", "budget-card"],
      className: "gap-3",
    },
    {
      id: "total-card",
      component: "Card",
      title: "已支出",
      children: ["total-value"],
      className: "flex-1 text-center",
    },
    { id: "total-value", component: "Text", text: { path: "/totalSpent" }, variant: "heading2" },
    {
      id: "budget-card",
      component: "Card",
      title: "预算",
      children: ["budget-progress"],
      className: "flex-1",
    },
    {
      id: "budget-progress",
      component: "Progress",
      value: { path: "/budgetUsed" },
      max: 100,
      showValue: true,
    },
    {
      id: "add-expense",
      component: "Card",
      children: ["amount-input", "category-select", "add-btn"],
      className: "p-4 gap-3",
    },
    {
      id: "amount-input",
      component: "TextField",
      value: { path: "/newExpense/amount" },
      label: "金额",
      type: "number",
    },
    {
      id: "category-select",
      component: "Select",
      value: { path: "/newExpense/category" },
      label: "类别",
      options: [
        { value: "food", label: "🍔 餐饮" },
        { value: "transport", label: "🚗 交通" },
        { value: "shopping", label: "🛍️ 购物" },
        { value: "entertainment", label: "🎮 娱乐" },
        { value: "other", label: "📦 其他" },
      ],
    },
    {
      id: "add-btn",
      component: "Button",
      text: "添加支出",
      action: "add_expense",
      variant: "primary",
    },
    {
      id: "expense-list",
      component: "List",
      items: { path: "/expenses" },
      emptyText: "暂无记录",
      itemClickAction: "view_expense",
    },
  ] as A2UIComponent[]
}

export function createHealthTrackerComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "stats-grid", "log-section"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "🏃 健康追踪", variant: "heading2" },
    {
      id: "stats-grid",
      component: "Row",
      children: ["steps-card", "water-card"],
      className: "gap-3 flex-wrap",
    },
    {
      id: "steps-card",
      component: "Card",
      title: "👟 步数",
      children: ["steps-progress"],
      className: "flex-1 min-w-[120px]",
    },
    {
      id: "steps-progress",
      component: "Progress",
      value: { path: "/todayStats/steps" },
      max: 10000,
      showValue: true,
    },
    {
      id: "water-card",
      component: "Card",
      title: "💧 饮水",
      children: ["water-progress"],
      className: "flex-1 min-w-[120px]",
    },
    {
      id: "water-progress",
      component: "Progress",
      value: { path: "/todayStats/water" },
      max: 8,
      showValue: true,
    },
    {
      id: "log-section",
      component: "Card",
      children: ["log-steps", "log-water"],
      className: "p-4 gap-3",
    },
    {
      id: "log-steps",
      component: "Row",
      children: ["steps-input", "add-steps"],
      className: "gap-2",
    },
    {
      id: "steps-input",
      component: "TextField",
      value: { path: "/newSteps" },
      placeholder: "步数",
      type: "number",
      className: "flex-1",
    },
    { id: "add-steps", component: "Button", text: "+", action: "add_steps", variant: "outline" },
    {
      id: "log-water",
      component: "Row",
      children: ["water-btns"],
      className: "gap-2 justify-center",
    },
    {
      id: "water-btns",
      component: "Row",
      children: ["water-1", "water-2", "water-3"],
      className: "gap-1",
    },
    { id: "water-1", component: "Button", text: "+1杯", action: "add_water_1", variant: "ghost" },
    { id: "water-2", component: "Button", text: "+2杯", action: "add_water_2", variant: "ghost" },
    { id: "water-3", component: "Button", text: "+3杯", action: "add_water_3", variant: "ghost" },
  ] as A2UIComponent[]
}

export function createHabitTrackerComponents(): A2UIComponent[] {
  return [
    {
      id: "root",
      component: "Column",
      children: ["header", "streak-card", "habits-list", "add-habit"],
      className: "gap-4 p-4",
    },
    { id: "header", component: "Text", text: "🎯 习惯打卡", variant: "heading2" },
    {
      id: "streak-card",
      component: "Card",
      children: ["streak-row"],
      className: "bg-primary/10 p-4",
    },
    {
      id: "streak-row",
      component: "Row",
      children: ["streak-icon", "streak-text"],
      className: "gap-2 items-center justify-center",
    },
    { id: "streak-icon", component: "Icon", name: "Flame", size: 24, color: "orange" },
    { id: "streak-text", component: "Text", text: { path: "/streakText" }, variant: "heading3" },
    {
      id: "habits-list",
      component: "List",
      items: { path: "/habits" },
      emptyText: "添加你的第一个习惯",
      itemClickAction: "toggle_habit",
      dividers: true,
    },
    { id: "add-habit", component: "Row", children: ["habit-input", "add-btn"], className: "gap-2" },
    {
      id: "habit-input",
      component: "TextField",
      value: { path: "/newHabit" },
      placeholder: "新习惯名称",
      className: "flex-1",
    },
    {
      id: "add-btn",
      component: "Button",
      text: "添加",
      action: "add_habit",
      variant: "primary",
      icon: "Plus",
    },
  ] as A2UIComponent[]
}
