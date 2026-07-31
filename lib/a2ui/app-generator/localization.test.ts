import {
  createAgeCalculatorComponents,
  createBMICalculatorComponents,
  createContactComponents,
  createExpenseTrackerComponents,
  createHabitTrackerComponents,
  createHealthTrackerComponents,
  createLoanCalculatorComponents,
  createNotesComponents,
  createSurveyComponents,
  createTimerComponents,
  createTipCalculatorComponents,
  createTodoComponents,
} from "./component-factories"
import {
  generatorFactoryKinds,
  localizeDashboardDataModel,
  localizeGeneratedComponents,
  type GeneratorFactoryKind,
} from "./localization"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { generateAppFromDescription } from "./index"

const factoryComponents: Record<GeneratorFactoryKind, () => A2UIComponent[]> = {
  ageCalculator: createAgeCalculatorComponents,
  bmiCalculator: createBMICalculatorComponents,
  contact: createContactComponents,
  dashboard: () => [{ id: "refresh-btn", component: "Button", text: "刷新", action: "refresh" }],
  expenseTracker: createExpenseTrackerComponents,
  habitTracker: createHabitTrackerComponents,
  healthTracker: createHealthTrackerComponents,
  loanCalculator: createLoanCalculatorComponents,
  notes: createNotesComponents,
  pomodoro: () => createTimerComponents(true),
  survey: createSurveyComponents,
  timer: () => createTimerComponents(false),
  tipCalculator: createTipCalculatorComponents,
  todo: () => createTodoComponents(true, true, true),
}

describe("app generator localization", () => {
  it("owns a complete overlay for every component factory kind", () => {
    expect(Object.keys(factoryComponents).sort()).toEqual([...generatorFactoryKinds].sort())
    for (const kind of generatorFactoryKinds) {
      const source = factoryComponents[kind]()
      const localized = localizeGeneratedComponents(kind, source, "en")
      expect(localized.map(({ id }) => id)).toEqual(source.map(({ id }) => id))
      expect(localized).not.toBe(source)
    }
  })

  it("localizes specialized, conditional, and option-bearing components", () => {
    expect(
      localizeGeneratedComponents("tipCalculator", createTipCalculatorComponents(), "en").find(
        ({ id }) => id === "header"
      )
    ).toMatchObject({ text: "💰 Tip Calculator" })
    expect(
      localizeGeneratedComponents("pomodoro", createTimerComponents(true), "en").find(
        ({ id }) => id === "long-break-btn"
      )
    ).toMatchObject({ text: "Long Break 15 min" })
    expect(
      localizeGeneratedComponents("survey", createSurveyComponents(), "en").find(
        ({ id }) => id === "q2"
      )
    ).toMatchObject({
      options: [
        { value: "very", label: "Very Satisfied" },
        { value: "good", label: "Satisfied" },
        { value: "neutral", label: "Neutral" },
        { value: "poor", label: "Dissatisfied" },
      ],
    })
  })

  it("localizes dashboard payload copy while preserving numeric data", () => {
    const localized = localizeDashboardDataModel(
      { summaryItems: [], stats: { value1: "1,234" }, chartData: [] },
      "en"
    )

    expect(localized).toMatchObject({
      stats: { value1: "1,234" },
      status: { message: "The data source is synchronized and ready to refresh." },
    })
    expect(localized.chartData).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Mon", value: 120 })])
    )
  })

  it.each([
    ["Create a tip calculator", "header", "💰 Tip Calculator"],
    ["Create a BMI calculator", "header", "🏃 BMI Calculator"],
    ["Create an age calculator", "header", "🎂 Age Calculator"],
    ["Create a loan calculator", "header", "🏠 Loan Calculator"],
    ["Create a Pomodoro timer", "header", "🍅 Pomodoro Timer"],
    ["Create a todo list with a due date", "header", "✅ Todo List"],
    ["Create a notes app", "header", "📝 Quick Notes"],
    ["Create a survey", "title", "📋 Quick Survey"],
    ["Create a contact page", "header", "✉️ Contact Us"],
    ["Create an expense tracker", "header", "💰 Expense Tracker"],
    ["Create a health tracker", "header", "🏃 Health Tracker"],
    ["Create a habit tracker", "header", "🎯 Habit Tracker"],
  ])("localizes generated English factory output for %s", (description, componentId, text) => {
    const app = generateAppFromDescription({ description, language: "en" })

    expect(app.components.find(({ id }) => id === componentId)).toMatchObject({ text })
  })

  it("localizes English dashboard components and data-model copy", () => {
    const app = generateAppFromDescription({
      description: "Create a data dashboard",
      language: "en",
    })

    expect(app.components.find(({ id }) => id === "summary")).toMatchObject({
      title: "Key Metrics",
    })
    expect(app.dataModel.summaryItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Metric 1", badge: "Live" })])
    )
    expect(app.dataModel.chartData).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Mon", value: 120 })])
    )
  })
})
