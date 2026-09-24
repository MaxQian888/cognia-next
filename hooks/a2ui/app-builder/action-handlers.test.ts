import {
  performCalculation,
  performUnitConversion,
  formatTime,
  useAppActionHandlers,
} from "./action-handlers"
import { renderHook, act } from "@testing-library/react"
import { setValueByPath } from "@/lib/a2ui/data-model"
import { surfaceTimers } from "@/lib/a2ui/surface-timer"
import { appTemplates } from "@/lib/a2ui/templates"
import { generateAppFromDescription } from "@/lib/a2ui/app-generator"
import type { A2UIComponent } from "@/types/a2ui/schema"

// ========== Helper ==========

function createMockDeps(
  initialData: Record<string, Record<string, unknown>> = {},
  locale: "en" | "zh-CN" = "en"
) {
  const appData = new Map<string, Record<string, unknown>>(Object.entries(initialData))

  const getAppData = jest.fn((appId: string) => appData.get(appId))
  const setAppData = jest.fn((appId: string, path: string, value: unknown) => {
    const data = appData.get(appId) || {}
    // Simple path setting for test purposes
    const key = path.startsWith("/") ? path.substring(1) : path
    const keys = key.split("/")
    let target: Record<string, unknown> = data
    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]]) target[keys[i]] = {}
      target = target[keys[i]] as Record<string, unknown>
    }
    target[keys[keys.length - 1]] = value
    appData.set(appId, data)
  })
  const resetAppData = jest.fn((appId: string) => appData.delete(appId))
  // Writes land in the same live map `getAppData` reads, like the real store.
  const setDataValue = jest.fn((appId: string, path: string, value: unknown) => {
    const data = appData.get(appId)
    if (data) appData.set(appId, setValueByPath(data, path, value))
  })
  const onAction = jest.fn()
  const getAppLocale = jest.fn(() => locale)

  return {
    getAppData,
    setAppData,
    resetAppData,
    setDataValue,
    onAction,
    getAppLocale,
  }
}

// ========== Part 1: Pure Helper Function Tests ==========

describe("formatTime", () => {
  it("returns 00:00 for 0 seconds", () => {
    expect(formatTime(0)).toBe("00:00")
  })

  it("returns 00:59 for 59 seconds", () => {
    expect(formatTime(59)).toBe("00:59")
  })

  it("returns 01:00 for 60 seconds", () => {
    expect(formatTime(60)).toBe("01:00")
  })

  it("returns 01:30 for 90 seconds", () => {
    expect(formatTime(90)).toBe("01:30")
  })

  it("returns 60:00 for 3600 seconds", () => {
    expect(formatTime(3600)).toBe("60:00")
  })
})

describe("performCalculation", () => {
  it("adds two numbers", () => {
    expect(performCalculation(10, 5, "+")).toBe(15)
  })

  it("subtracts two numbers", () => {
    expect(performCalculation(10, 5, "-")).toBe(5)
  })

  it("multiplies two numbers", () => {
    expect(performCalculation(10, 5, "*")).toBe(50)
  })

  it("divides two numbers", () => {
    expect(performCalculation(10, 5, "/")).toBe(2)
  })

  it("returns 0 for division by zero", () => {
    expect(performCalculation(10, 0, "/")).toBe(0)
  })

  it("computes modulo", () => {
    expect(performCalculation(10, 3, "%")).toBe(1)
  })

  it("returns b for unknown operator", () => {
    expect(performCalculation(10, 5, "^")).toBe(5)
  })
})

describe("performUnitConversion", () => {
  it("returns same value when units are identical", () => {
    expect(performUnitConversion(100, "m", "m", "length")).toBe(100)
  })

  it("converts meters to centimeters", () => {
    expect(performUnitConversion(1, "m", "cm", "length")).toBe(100)
  })

  it("converts kilograms to grams", () => {
    expect(performUnitConversion(1, "kg", "g", "weight")).toBe(1000)
  })

  it("converts Celsius to Fahrenheit", () => {
    expect(performUnitConversion(0, "celsius", "fahrenheit", "temperature")).toBe(32)
  })

  it("converts Fahrenheit to Celsius", () => {
    expect(performUnitConversion(32, "fahrenheit", "celsius", "temperature")).toBe(0)
  })

  it("converts Celsius to Kelvin", () => {
    expect(performUnitConversion(0, "celsius", "kelvin", "temperature")).toBe(273.15)
  })

  it("converts currency USD to CNY and returns a positive number", () => {
    const result = performUnitConversion(1, "usd", "cny", "currency")
    expect(result).toBeGreaterThan(0)
  })
})

// ========== Part 2: Action Dispatch Tests ==========

describe("useAppActionHandlers", () => {
  const SURFACE = "test-surface"
  const createAction = (action: string, data: Record<string, unknown> = {}) => ({
    type: "userAction" as const,
    surfaceId: SURFACE,
    componentId: "test-component",
    action,
    data,
    timestamp: Date.now(),
  })

  function renderWithDeps(initialData: Record<string, Record<string, unknown>> = {}) {
    const deps = createMockDeps(initialData)
    const { result } = renderHook(() => useAppActionHandlers(deps))
    return { result, deps }
  }

  // ---------- Todo actions ----------

  describe("add_task", () => {
    it("adds a task when newTask is non-empty", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { newTask: "Buy milk", tasks: [] },
      })

      act(() => {
        result.current.handleAppAction(createAction("add_task"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/tasks",
        expect.arrayContaining([expect.objectContaining({ text: "Buy milk", completed: false })])
      )
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/newTask", "")
    })

    it("does nothing when newTask is empty", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { newTask: "   ", tasks: [] },
      })

      act(() => {
        result.current.handleAppAction(createAction("add_task"))
      })

      expect(deps.setAppData).not.toHaveBeenCalled()
    })

    it("writes generated task statistics in the app instance locale", () => {
      const deps = createMockDeps(
        {
          [SURFACE]: { newTask: "买牛奶", tasks: [] },
        },
        "zh-CN"
      )
      const { result } = renderHook(() => useAppActionHandlers(deps))

      act(() => result.current.handleAppAction(createAction("add_task")))

      expect(deps.setDataValue).toHaveBeenCalledWith(SURFACE, "/stats", {
        completed: 0,
        pending: 1,
        completedText: "已完成 0 项",
        pendingText: "待完成 1 项",
      })
    })
  })

  describe("toggle_task", () => {
    it("toggles the completed flag of a task at the given index", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { tasks: [{ id: 1, text: "Task", completed: false }] },
      })

      act(() => {
        result.current.handleAppAction(createAction("toggle_task", { index: 0 }))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/tasks",
        expect.arrayContaining([expect.objectContaining({ completed: true })])
      )
    })
  })

  describe("delete_task", () => {
    it("removes a task at the given index", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: {
          tasks: [
            { id: 1, text: "A", completed: false },
            { id: 2, text: "B", completed: false },
          ],
        },
      })

      act(() => {
        result.current.handleAppAction(createAction("delete_task", { index: 0 }))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/tasks", [
        expect.objectContaining({ text: "B" }),
      ])
    })
  })

  // ---------- Calculator actions ----------

  describe("calculator input", () => {
    it("sets display to the pressed digit", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { display: "0", waitingForOperand: false },
      })

      act(() => {
        result.current.handleAppAction(createAction("input_5"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/display", "5")
    })
  })

  describe("calculator operator", () => {
    it("sets operator and previousValue on op_add", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { display: "10", previousValue: null, operator: null, waitingForOperand: false },
      })

      act(() => {
        result.current.handleAppAction(createAction("op_add"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/previousValue", 10)
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/operator", "+")
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/waitingForOperand", true)
    })
  })

  describe("calculate", () => {
    it("computes result from previousValue and operator", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { display: "5", previousValue: 10, operator: "+", waitingForOperand: false },
      })

      act(() => {
        result.current.handleAppAction(createAction("calculate"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/display", "15")
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/previousValue", null)
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/operator", null)
    })
  })

  describe("clear", () => {
    it("resets display to 0 and clears state", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { display: "42", previousValue: 10, operator: "+" },
      })

      act(() => {
        result.current.handleAppAction(createAction("clear"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/display", "0")
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/previousValue", null)
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/operator", null)
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/waitingForOperand", false)
    })
  })

  describe("backspace", () => {
    it("removes the last character from display", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { display: "123" },
      })

      act(() => {
        result.current.handleAppAction(createAction("backspace"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/display", "12")
    })
  })

  describe("negate", () => {
    it("toggles minus sign on display", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { display: "5" },
      })

      act(() => {
        result.current.handleAppAction(createAction("negate"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/display", "-5")
    })
  })

  // ---------- Form actions ----------

  describe("submit_form", () => {
    it("sets submitted to true", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { form: { name: "John" } },
      })

      act(() => {
        result.current.handleAppAction(createAction("submit_form"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/submitted", true)
    })
  })

  describe("submit_contact", () => {
    it("sets submitted to true", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { form: { email: "a@b.com" } },
      })

      act(() => {
        result.current.handleAppAction(createAction("submit_contact"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/submitted", true)
    })
  })

  describe("clear_form", () => {
    it("calls resetAppData", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { form: { name: "test" } },
      })

      act(() => {
        result.current.handleAppAction(createAction("clear_form"))
      })

      expect(deps.resetAppData).toHaveBeenCalledWith(SURFACE)
    })
  })

  // ---------- Notes actions ----------

  describe("save_note", () => {
    it("adds a note and updates notesCountText", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { notes: [], newNote: { title: "My Note", content: "Hello" } },
      })

      act(() => {
        result.current.handleAppAction(createAction("save_note"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/notes",
        expect.arrayContaining([expect.objectContaining({ title: "My Note", content: "Hello" })])
      )
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/notesCountText", "1 notes")
    })
  })

  describe("delete_note", () => {
    it("removes a note at the given index and updates notesCountText", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: {
          notes: [
            { id: 1, title: "A", content: "a" },
            { id: 2, title: "B", content: "b" },
          ],
        },
      })

      act(() => {
        result.current.handleAppAction(createAction("delete_note", { index: 0 }))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/notes", [
        expect.objectContaining({ title: "B" }),
      ])
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/notesCountText", "1 notes")
    })
  })

  // ---------- Shopping actions ----------

  describe("add_item", () => {
    it("adds an item and updates totalText", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { items: [], newItem: { name: "Apples", quantity: 3 } },
      })

      act(() => {
        result.current.handleAppAction(createAction("add_item"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/items",
        expect.arrayContaining([expect.objectContaining({ name: "Apples", quantity: 3 })])
      )
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/totalText", "1 items")
    })
  })

  describe("toggle_item", () => {
    it("toggles completed on the item at given index", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { items: [{ id: 1, name: "Milk", completed: false }] },
      })

      act(() => {
        result.current.handleAppAction(createAction("toggle_item", { index: 0 }))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/items",
        expect.arrayContaining([expect.objectContaining({ completed: true })])
      )
    })
  })

  describe("clear_list", () => {
    it("empties items and resets totalText", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { items: [{ id: 1, name: "X", completed: false }] },
      })

      act(() => {
        result.current.handleAppAction(createAction("clear_list"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/items", [])
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/totalText", "0 items")
    })
  })

  // ---------- Conversion ----------

  describe("convert", () => {
    it("computes and stores the conversion result", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { inputValue: "1", fromUnit: "m", toUnit: "cm", converterType: "length" },
      })

      act(() => {
        result.current.handleAppAction(createAction("convert"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/result", "100.0000")
    })
  })

  // ---------- Specialized calculators ----------

  describe("calculate_bmi", () => {
    it("computes BMI from height and weight", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { height: 170, weight: 65 },
      })

      act(() => {
        result.current.handleAppAction(createAction("calculate_bmi"))
      })

      // BMI = 65 / (1.7^2) ≈ 22.5
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/bmi", expect.any(String))
      expect(deps.setAppData).toHaveBeenCalledWith(SURFACE, "/status", "Normal")

      const bmiCall = deps.setAppData.mock.calls.find((c: unknown[]) => c[1] === "/bmi")
      const bmiValue = parseFloat(bmiCall![2] as string)
      expect(bmiValue).toBeCloseTo(22.5, 0)
    })
  })

  describe("calculate_age", () => {
    it("computes age from birthDate", () => {
      const birthYear = new Date().getFullYear() - 25
      const birthDate = `${birthYear}-01-01`

      const { result, deps } = renderWithDeps({
        [SURFACE]: { birthDate },
      })

      act(() => {
        result.current.handleAppAction(createAction("calculate_age"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/age",
        expect.stringContaining("years old")
      )
      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/nextBirthday",
        expect.stringContaining("days until the next birthday")
      )
    })
  })

  describe("calculate_loan", () => {
    it("computes monthly payment from principal, rate, and years", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: { principal: "100000", rate: 5, years: 20 },
      })

      act(() => {
        result.current.handleAppAction(createAction("calculate_loan"))
      })

      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/monthly",
        expect.stringMatching(/^¥\d+\.\d{2}$/)
      )
      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/total",
        expect.stringMatching(/^¥\d+\.\d{2}$/)
      )
      expect(deps.setAppData).toHaveBeenCalledWith(
        SURFACE,
        "/interest",
        expect.stringMatching(/^¥\d+\.\d{2}$/)
      )
    })
  })

  // ---------- Timer actions (surface timer runtime) ----------

  describe("timer actions", () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => {
      surfaceTimers.stopAll()
      jest.useRealTimers()
    })

    const pomodoro = () => ({
      [SURFACE]: {
        display: "25:00",
        seconds: 0,
        totalSeconds: 1500,
        progress: 0,
        isRunning: false,
        mode: "pomodoro",
      },
    })

    it("start counts down on the live data model (the stale-snapshot regression)", () => {
      const { result, deps } = renderWithDeps(pomodoro())

      act(() => result.current.handleAppAction(createAction("start")))
      act(() => {
        jest.advanceTimersByTime(8_000)
      })

      expect(deps.getAppData(SURFACE)).toMatchObject({
        isRunning: true,
        seconds: 8,
        display: "24:52",
      })
    })

    it("start ignores a persisted run flag with no live ticker", () => {
      const initial = pomodoro()
      initial[SURFACE].isRunning = true
      const { result, deps } = renderWithDeps(initial)

      act(() => result.current.handleAppAction(createAction("start_timer")))
      act(() => {
        jest.advanceTimersByTime(2_000)
      })

      expect(deps.getAppData(SURFACE)).toMatchObject({ seconds: 2, display: "24:58" })
    })

    it("pause freezes and reset rewinds to the loaded length", () => {
      const { result, deps } = renderWithDeps(pomodoro())

      act(() => result.current.handleAppAction(createAction("start")))
      act(() => {
        jest.advanceTimersByTime(3_000)
      })
      act(() => result.current.handleAppAction(createAction("pause_timer")))
      act(() => {
        jest.advanceTimersByTime(4_000)
      })
      expect(deps.getAppData(SURFACE)).toMatchObject({
        isRunning: false,
        seconds: 3,
        display: "24:57",
      })

      act(() => result.current.handleAppAction(createAction("reset")))
      expect(deps.getAppData(SURFACE)).toMatchObject({
        isRunning: false,
        seconds: 0,
        display: "25:00",
        progress: 0,
      })
      expect(surfaceTimers.isActive(SURFACE)).toBe(false)
    })

    it.each([
      ["set_1", 60, "01:00"],
      ["set_1min", 60, "01:00"],
      ["set_5", 300, "05:00"],
      ["set_5min", 300, "05:00"],
      ["set_10", 600, "10:00"],
      ["set_10min", 600, "10:00"],
      ["set_15", 900, "15:00"],
      ["set_25", 1500, "25:00"],
      ["set_25min", 1500, "25:00"],
    ])("%s loads a %i-second countdown", (action, totalSeconds, display) => {
      const { result, deps } = renderWithDeps(pomodoro())
      act(() => result.current.handleAppAction(createAction(action)))
      expect(deps.getAppData(SURFACE)).toMatchObject({ totalSeconds, display, isRunning: false })
    })

    it("the catalog timer counts DOWN after a preset (it used to count up from 00:00)", () => {
      const template = appTemplates.find((t) => t.id === "timer")
      expect(template).toBeDefined()
      const { result, deps } = renderWithDeps({
        [SURFACE]: structuredClone(template!.dataModel),
      })

      act(() => result.current.handleAppAction(createAction("set_5min")))
      act(() => result.current.handleAppAction(createAction("start_timer")))
      act(() => {
        jest.advanceTimersByTime(2_000)
      })

      expect(deps.getAppData(SURFACE)).toMatchObject({ seconds: 2, display: "04:58" })
    })

    it("the catalog timer without a preset runs as a stopwatch", () => {
      const template = appTemplates.find((t) => t.id === "timer")
      const { result, deps } = renderWithDeps({
        [SURFACE]: structuredClone(template!.dataModel),
      })

      act(() => result.current.handleAppAction(createAction("start_timer")))
      act(() => {
        jest.advanceTimersByTime(3_000)
      })

      expect(deps.getAppData(SURFACE)).toMatchObject({ seconds: 3, display: "00:03" })
    })
  })

  // ---------- Every built-in mini-app button reaches a handler ----------

  describe("built-in mini-app action coverage (real handler)", () => {
    // Actions the built-in handler deliberately escalates to the host.
    const ESCALATED = new Set(["follow", "message", "view_activity"])
    // Handled here AND forwarded so the host can observe the submission.
    const HANDLED_AND_FORWARDED = new Set(["submit", "submit_form", "submit_contact", "execute"])

    const GENERATOR_PROMPTS = [
      "calculator",
      "tip calculator",
      "bmi calculator",
      "age calculator",
      "loan calculator",
      "Pomodoro Timer",
      "countdown timer",
      "todo list with category priority due date",
      "notes",
      "survey",
      "contact form",
      "dashboard",
      "weather",
      "unit convert",
      "habit track",
      "expense track",
      "health track",
    ]

    function actionsOf(components: A2UIComponent[]): string[] {
      const actions = new Set<string>()
      for (const component of components as unknown as Array<Record<string, unknown>>) {
        for (const key of ["action", "itemClickAction", "rowClickAction"]) {
          const value = component[key]
          if (typeof value === "string" && value) actions.add(value)
        }
      }
      return [...actions]
    }

    const apps = [
      ...appTemplates.map((t) => ({
        label: `template:${t.id}`,
        components: t.components,
        dataModel: t.dataModel,
      })),
      ...GENERATOR_PROMPTS.map((prompt) => {
        const app = generateAppFromDescription({ description: prompt, language: "en" })
        return {
          label: `generated:${prompt}`,
          components: app.components,
          dataModel: app.dataModel,
        }
      }),
    ]

    it.each(apps.map((app) => [app.label, app]))(
      "%s: no button falls through to the unhandled default",
      (_label, app) => {
        const unhandled: string[] = []
        for (const actionName of actionsOf(app.components)) {
          const { result, deps } = renderWithDeps({ [SURFACE]: structuredClone(app.dataModel) })
          act(() => result.current.handleAppAction(createAction(actionName, { index: 0 })))
          if (
            deps.onAction.mock.calls.length > 0 &&
            !ESCALATED.has(actionName) &&
            !HANDLED_AND_FORWARDED.has(actionName)
          ) {
            unhandled.push(actionName)
          }
          surfaceTimers.stopAll()
        }
        expect(unhandled).toEqual([])
      }
    )
  })

  // ---------- Default case ----------

  describe("unknown action", () => {
    it("calls onAction callback for unrecognized actions", () => {
      const { result, deps } = renderWithDeps({
        [SURFACE]: {},
      })

      const action = createAction("some_custom_action", { foo: "bar" })

      act(() => {
        result.current.handleAppAction(action)
      })

      expect(deps.onAction).toHaveBeenCalledWith(action)
    })
  })
})
