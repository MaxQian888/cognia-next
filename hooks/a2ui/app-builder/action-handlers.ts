/**
 * A2UI App Builder - Action Handlers
 * Default action handlers for built-in app templates (calculator, timer, todo, etc.)
 */

import { useCallback, useRef } from "react"
import type { A2UIUserAction } from "@/types/a2ui/schema"
import { loggers } from "@cognia/logging"

const log = loggers.app

interface ActionHandlerDeps {
  getAppData: (appId: string) => Record<string, unknown> | undefined
  setAppData: (appId: string, path: string, value: unknown) => void
  resetAppData: (appId: string) => void
  surfaces: Record<string, { dataModel: Record<string, unknown> }>
  setDataValue: (surfaceId: string, path: string, value: unknown) => void
  onAction?: (action: A2UIUserAction) => void
}

// ========== Pure helper functions ==========

export function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}

export function performCalculation(a: number, b: number, operator: string): number {
  switch (operator) {
    case "+":
      return a + b
    case "-":
      return a - b
    case "*":
      return a * b
    case "/":
      return b !== 0 ? a / b : 0
    case "%":
      return a % b
    default:
      return b
  }
}

export function performUnitConversion(
  value: number,
  fromUnit: string,
  toUnit: string,
  type: string
): number {
  if (fromUnit === toUnit) return value

  const conversionRates: Record<string, Record<string, number>> = {
    length: { m: 1, cm: 0.01, ft: 0.3048, in: 0.0254 },
    weight: { kg: 1, g: 0.001, lb: 0.453592, oz: 0.0283495 },
    temperature: {},
    currency: { usd: 1, cny: 0.14, eur: 1.08, jpy: 0.0067 },
  }

  if (type === "temperature") {
    let celsius: number
    if (fromUnit === "celsius") celsius = value
    else if (fromUnit === "fahrenheit") celsius = ((value - 32) * 5) / 9
    else celsius = value - 273.15

    if (toUnit === "celsius") return celsius
    if (toUnit === "fahrenheit") return (celsius * 9) / 5 + 32
    return celsius + 273.15
  }

  const rates = conversionRates[type] || conversionRates.length
  const baseValue = value * (rates[fromUnit] || 1)
  return baseValue / (rates[toUnit] || 1)
}

function updateTaskStats(
  setDataValue: (sid: string, path: string, value: unknown) => void,
  surfaceId: string,
  tasks: unknown[]
): void {
  const completed = tasks.filter((t) => (t as { completed: boolean }).completed).length
  const pending = tasks.length - completed
  setDataValue(surfaceId, "/stats", {
    completed,
    pending,
    completedText: `${completed} completed`,
    pendingText: `${pending} pending`,
  })
}

function updateHabitStats(
  setDataValue: (sid: string, path: string, value: unknown) => void,
  surfaceId: string,
  habits: unknown[]
): void {
  const completedToday = habits.filter((h) => (h as { completed: boolean }).completed).length
  const maxStreak = Math.max(0, ...habits.map((h) => (h as { streak: number }).streak || 0))
  setDataValue(surfaceId, "/stats", {
    streak: maxStreak,
    streakText: `${maxStreak} day streak`,
    todayCompleted: completedToday,
    todayText: `${completedToday} completed today`,
  })
}

function updateExpenseStats(
  setDataValue: (sid: string, path: string, value: unknown) => void,
  surfaceId: string,
  expenses: unknown[]
): void {
  const today = new Date().toDateString()
  let total = 0
  let todayTotal = 0

  for (const expense of expenses) {
    const exp = expense as { amount: number; date: string }
    total += exp.amount || 0
    if (new Date(exp.date).toDateString() === today) {
      todayTotal += exp.amount || 0
    }
  }

  setDataValue(surfaceId, "/stats", {
    total,
    totalText: `$${total.toFixed(2)}`,
    today: todayTotal,
    todayText: `$${todayTotal.toFixed(2)}`,
  })
}

/**
 * Hook providing default action handlers for A2UI app templates
 */
export function useAppActionHandlers(deps: ActionHandlerDeps) {
  const { getAppData, setAppData, resetAppData, surfaces, setDataValue, onAction } = deps
  const timerIntervalsRef = useRef(new Map<string, NodeJS.Timeout>())

  const stopTimerInterval = useCallback((surfaceId: string): void => {
    const interval = timerIntervalsRef.current.get(surfaceId)
    if (interval) {
      clearInterval(interval)
      timerIntervalsRef.current.delete(surfaceId)
    }
  }, [])

  const setTimerPreset = useCallback(
    (surfaceId: string, seconds: number): void => {
      setDataValue(surfaceId, "/totalSeconds", seconds)
      setDataValue(surfaceId, "/seconds", 0)
      setDataValue(surfaceId, "/display", formatTime(seconds))
      setDataValue(surfaceId, "/progress", 0)
      setDataValue(surfaceId, "/isRunning", false)
      stopTimerInterval(surfaceId)
    },
    [setDataValue, stopTimerInterval]
  )

  const startTimerInterval = useCallback(
    (surfaceId: string): void => {
      stopTimerInterval(surfaceId)
      const interval = setInterval(() => {
        const surface = surfaces[surfaceId]
        if (!surface || !surface.dataModel.isRunning) {
          stopTimerInterval(surfaceId)
          return
        }

        const seconds = (surface.dataModel.seconds as number) || 0
        const totalSeconds = (surface.dataModel.totalSeconds as number) || 0
        const mode = surface.dataModel.mode as string

        if (mode === "countdown" || mode === "pomodoro" || mode === "timer") {
          const remaining = totalSeconds - seconds
          if (remaining <= 0) {
            setDataValue(surfaceId, "/isRunning", false)
            setDataValue(surfaceId, "/display", "00:00")
            setDataValue(surfaceId, "/progress", 100)
            stopTimerInterval(surfaceId)
            return
          }
          setDataValue(surfaceId, "/seconds", seconds + 1)
          setDataValue(surfaceId, "/display", formatTime(remaining - 1))
          setDataValue(surfaceId, "/progress", Math.round(((seconds + 1) / totalSeconds) * 100))
        } else {
          setDataValue(surfaceId, "/seconds", seconds + 1)
          setDataValue(surfaceId, "/display", formatTime(seconds + 1))
        }
      }, 1000)
      timerIntervalsRef.current.set(surfaceId, interval)
    },
    [setDataValue, surfaces, stopTimerInterval]
  )

  const handleAppAction = useCallback(
    (action: A2UIUserAction): void => {
      const { surfaceId, action: actionType, data } = action

      // Default action handlers for common patterns
      switch (actionType) {
        // ========== Todo App Actions ==========
        case "add_task": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const newTask = currentData.newTask as string
            if (newTask?.trim()) {
              const tasks = (currentData.tasks as unknown[]) || []
              const newTaskItem = { id: Date.now(), text: newTask.trim(), completed: false }
              setAppData(surfaceId, "/tasks", [...tasks, newTaskItem])
              setAppData(surfaceId, "/newTask", "")
              updateTaskStats(setDataValue, surfaceId, [...tasks, newTaskItem])
            }
          }
          break
        }

        case "toggle_task": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const tasks = [...((currentData.tasks as unknown[]) || [])]
            const taskIndex = data.index as number
            if (tasks[taskIndex]) {
              const task = tasks[taskIndex] as { completed: boolean }
              task.completed = !task.completed
              setAppData(surfaceId, "/tasks", tasks)
              updateTaskStats(setDataValue, surfaceId, tasks)
            }
          }
          break
        }

        case "filter_all":
        case "filter_pending":
        case "filter_done": {
          const filterValue = actionType.replace("filter_", "")
          setAppData(surfaceId, "/filter", filterValue)
          break
        }

        // ========== Calculator Actions ==========
        case "input_0":
        case "input_1":
        case "input_2":
        case "input_3":
        case "input_4":
        case "input_5":
        case "input_6":
        case "input_7":
        case "input_8":
        case "input_9":
        case "input_decimal":
        case "num_0":
        case "num_1":
        case "num_2":
        case "num_3":
        case "num_4":
        case "num_5":
        case "num_6":
        case "num_7":
        case "num_8":
        case "num_9": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const digit = actionType.includes("decimal")
              ? "."
              : actionType.replace(/input_|num_/, "")
            const currentDisplay = (currentData.display as string) || "0"
            const waitingForOperand = currentData.waitingForOperand as boolean

            if (waitingForOperand) {
              setAppData(surfaceId, "/display", digit === "." ? "0." : digit)
              setAppData(surfaceId, "/waitingForOperand", false)
            } else {
              if (digit === "." && currentDisplay.includes(".")) break
              const newDisplay =
                currentDisplay === "0" && digit !== "." ? digit : currentDisplay + digit
              setAppData(surfaceId, "/display", newDisplay)
            }
          }
          break
        }

        case "op_add":
        case "op_sub":
        case "op_mul":
        case "op_div":
        case "op_subtract":
        case "op_multiply":
        case "op_divide":
        case "op_percent": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const opMap: Record<string, string> = {
              op_add: "+",
              op_sub: "-",
              op_mul: "*",
              op_div: "/",
              op_subtract: "-",
              op_multiply: "*",
              op_divide: "/",
              op_percent: "%",
            }
            const operator = opMap[actionType]
            const currentDisplay = parseFloat((currentData.display as string) || "0")
            const previousValue = currentData.previousValue as number | null
            const prevOperator = currentData.operator as string | null

            if (previousValue !== null && prevOperator && !currentData.waitingForOperand) {
              const result = performCalculation(previousValue, currentDisplay, prevOperator)
              setAppData(surfaceId, "/display", String(result))
              setAppData(surfaceId, "/previousValue", result)
            } else {
              setAppData(surfaceId, "/previousValue", currentDisplay)
            }
            setAppData(surfaceId, "/operator", operator)
            setAppData(surfaceId, "/waitingForOperand", true)
          }
          break
        }

        case "calculate": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const currentDisplay = parseFloat((currentData.display as string) || "0")
            const previousValue = currentData.previousValue as number | null
            const operator = currentData.operator as string | null

            if (previousValue !== null && operator) {
              const result = performCalculation(previousValue, currentDisplay, operator)
              setAppData(surfaceId, "/display", String(result))
              setAppData(surfaceId, "/previousValue", null)
              setAppData(surfaceId, "/operator", null)
              setAppData(surfaceId, "/waitingForOperand", true)
            }
          }
          break
        }

        case "clear": {
          setAppData(surfaceId, "/display", "0")
          setAppData(surfaceId, "/previousValue", null)
          setAppData(surfaceId, "/operator", null)
          setAppData(surfaceId, "/waitingForOperand", false)
          break
        }

        case "backspace":
        case "delete": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const currentDisplay = (currentData.display as string) || "0"
            const newDisplay = currentDisplay.length > 1 ? currentDisplay.slice(0, -1) : "0"
            setAppData(surfaceId, "/display", newDisplay)
          }
          break
        }

        // ========== Timer Actions ==========
        case "start":
        case "start_timer": {
          const currentData = getAppData(surfaceId)
          if (currentData && !currentData.isRunning) {
            setAppData(surfaceId, "/isRunning", true)
            startTimerInterval(surfaceId)
          }
          break
        }

        case "pause":
        case "pause_timer": {
          setAppData(surfaceId, "/isRunning", false)
          stopTimerInterval(surfaceId)
          break
        }

        case "reset":
        case "reset_timer": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            setAppData(surfaceId, "/isRunning", false)
            setAppData(surfaceId, "/seconds", 0)
            setAppData(surfaceId, "/display", formatTime((currentData.totalSeconds as number) || 0))
            setAppData(surfaceId, "/progress", 0)
            stopTimerInterval(surfaceId)
          }
          break
        }

        case "set_1":
        case "set_1min": {
          setTimerPreset(surfaceId, 60)
          break
        }
        case "set_5":
        case "set_5min": {
          setTimerPreset(surfaceId, 300)
          break
        }
        case "set_10":
        case "set_10min": {
          setTimerPreset(surfaceId, 600)
          break
        }
        case "set_15": {
          setTimerPreset(surfaceId, 900)
          break
        }
        case "set_25":
        case "set_25min": {
          setTimerPreset(surfaceId, 1500)
          break
        }

        // ========== Notes Actions ==========
        case "save_note": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const newNote = currentData.newNote as { title: string; content: string }
            if (newNote?.content?.trim() || newNote?.title?.trim()) {
              const notes = (currentData.notes as unknown[]) || []
              const noteItem = {
                id: Date.now(),
                title: newNote.title || "Untitled",
                content: newNote.content || "",
                createdAt: new Date().toISOString(),
              }
              const updatedNotes = [...notes, noteItem]
              setAppData(surfaceId, "/notes", updatedNotes)
              setAppData(surfaceId, "/newNote", { title: "", content: "" })
              setAppData(surfaceId, "/notesCountText", `${updatedNotes.length} notes`)
            }
          }
          break
        }

        // ========== Unit Converter Actions ==========
        case "convert": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const inputValue = parseFloat(currentData.inputValue as string) || 0
            const fromUnit = currentData.fromUnit as string
            const toUnit = currentData.toUnit as string
            const converterType = currentData.converterType as string
            const result = performUnitConversion(inputValue, fromUnit, toUnit, converterType)
            setAppData(surfaceId, "/result", result.toFixed(4))
          }
          break
        }

        // ========== Shopping List Actions ==========
        case "add_item": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const newItem = currentData.newItem as { name: string; quantity: number }
            if (newItem?.name?.trim()) {
              const items = (currentData.items as unknown[]) || []
              const itemObj = {
                id: Date.now(),
                text: `${newItem.name} (${newItem.quantity || 1})`,
                name: newItem.name.trim(),
                quantity: newItem.quantity || 1,
                completed: false,
              }
              const updatedItems = [...items, itemObj]
              setAppData(surfaceId, "/items", updatedItems)
              setAppData(surfaceId, "/newItem", { name: "", quantity: 1 })
              setAppData(surfaceId, "/totalText", `${updatedItems.length} items`)
            }
          }
          break
        }

        case "toggle_item": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const items = [...((currentData.items as unknown[]) || [])]
            const itemIndex = data.index as number
            if (items[itemIndex]) {
              const item = items[itemIndex] as { completed: boolean }
              item.completed = !item.completed
              setAppData(surfaceId, "/items", items)
            }
          }
          break
        }

        case "clear_list": {
          setAppData(surfaceId, "/items", [])
          setAppData(surfaceId, "/totalText", "0 items")
          break
        }

        // ========== Habit Tracker Actions ==========
        case "add_habit": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const newHabit = currentData.newHabit as string
            if (newHabit?.trim()) {
              const habits = (currentData.habits as unknown[]) || []
              const habitObj = {
                id: Date.now(),
                text: newHabit.trim(),
                name: newHabit.trim(),
                completed: false,
                streak: 0,
              }
              const updatedHabits = [...habits, habitObj]
              setAppData(surfaceId, "/habits", updatedHabits)
              setAppData(surfaceId, "/newHabit", "")
              updateHabitStats(setDataValue, surfaceId, updatedHabits)
            }
          }
          break
        }

        case "toggle_habit": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const habits = [...((currentData.habits as unknown[]) || [])]
            const habitIndex = data.index as number
            if (habits[habitIndex]) {
              const habit = habits[habitIndex] as { completed: boolean; streak: number }
              habit.completed = !habit.completed
              if (habit.completed) habit.streak = (habit.streak || 0) + 1
              setAppData(surfaceId, "/habits", habits)
              updateHabitStats(setDataValue, surfaceId, habits)
            }
          }
          break
        }

        // ========== Expense Tracker Actions ==========
        case "add_expense": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const newExpense = currentData.newExpense as {
              description: string
              amount: string
              category: string
            }
            const amount = parseFloat(newExpense?.amount) || 0
            if (newExpense?.description?.trim() && amount > 0) {
              const expenses = (currentData.expenses as unknown[]) || []
              const expenseObj = {
                id: Date.now(),
                text: `${newExpense.description} - $${amount.toFixed(2)}`,
                description: newExpense.description.trim(),
                amount,
                category: newExpense.category || "other",
                date: new Date().toISOString(),
              }
              const updatedExpenses = [...expenses, expenseObj]
              setAppData(surfaceId, "/expenses", updatedExpenses)
              setAppData(surfaceId, "/newExpense", {
                description: "",
                amount: "",
                category: "food",
              })
              updateExpenseStats(setDataValue, surfaceId, updatedExpenses)
            }
          }
          break
        }

        case "submit_form":
        case "submit_contact": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const formData = currentData.form as Record<string, unknown>
            log.debug("A2UI AppBuilder: Form submitted", { surfaceId, formData })
            setAppData(surfaceId, "/submitted", true)
            setAppData(surfaceId, "/submittedAt", new Date().toISOString())
          }
          onAction?.(action)
          break
        }

        case "clear_form": {
          resetAppData(surfaceId)
          break
        }

        case "refresh":
        case "refresh_data": {
          log.debug(`A2UI AppBuilder: Refreshing data for: ${surfaceId}`)
          break
        }

        // ========== BMI Calculator Actions ==========
        case "calculate_bmi": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const height = (currentData.height as number) || 170
            const weight = (currentData.weight as number) || 65
            const heightM = height / 100
            const bmi = weight / (heightM * heightM)
            const bmiRounded = Math.round(bmi * 10) / 10
            let status: string
            if (bmi < 18.5) status = "偏瘦"
            else if (bmi < 24) status = "正常"
            else if (bmi < 28) status = "偏胖"
            else status = "肥胖"
            setAppData(surfaceId, "/bmi", String(bmiRounded))
            setAppData(surfaceId, "/status", status)
          }
          break
        }

        // ========== Age Calculator Actions ==========
        case "calculate_age": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const birthDate = currentData.birthDate as string
            if (birthDate) {
              const birth = new Date(birthDate)
              const now = new Date()
              let age = now.getFullYear() - birth.getFullYear()
              const monthDiff = now.getMonth() - birth.getMonth()
              if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age--
              const nextBirthday = new Date(now.getFullYear(), birth.getMonth(), birth.getDate())
              if (nextBirthday < now) nextBirthday.setFullYear(nextBirthday.getFullYear() + 1)
              const daysUntil = Math.ceil(
                (nextBirthday.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
              )
              setAppData(surfaceId, "/age", `${age} 岁`)
              setAppData(surfaceId, "/nextBirthday", `距离下次生日还有 ${daysUntil} 天`)
            }
          }
          break
        }

        // ========== Loan Calculator Actions ==========
        case "calculate_loan": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const principal = parseFloat(currentData.principal as string) || 0
            const annualRate = (currentData.rate as number) || 5
            const years = (currentData.years as number) || 20
            const monthlyRate = annualRate / 100 / 12
            const totalMonths = years * 12
            if (principal > 0 && monthlyRate > 0) {
              const monthly =
                (principal * monthlyRate * Math.pow(1 + monthlyRate, totalMonths)) /
                (Math.pow(1 + monthlyRate, totalMonths) - 1)
              const total = monthly * totalMonths
              const interest = total - principal
              setAppData(surfaceId, "/monthly", `¥${monthly.toFixed(2)}`)
              setAppData(surfaceId, "/total", `¥${total.toFixed(2)}`)
              setAppData(surfaceId, "/interest", `¥${interest.toFixed(2)}`)
            }
          }
          break
        }

        // ========== Form Submit Actions ==========
        case "submit": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const formData = currentData.form as Record<string, unknown>
            log.debug("A2UI AppBuilder: Form submitted", { surfaceId, formData })
            setAppData(surfaceId, "/submitted", true)
            setAppData(surfaceId, "/submittedAt", new Date().toISOString())
          }
          onAction?.(action)
          break
        }

        case "execute": {
          log.debug("A2UI AppBuilder: Execute action", { surfaceId, data })
          onAction?.(action)
          break
        }

        // ========== Health Tracker Actions ==========
        case "add_steps": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const newSteps = parseInt(currentData.newSteps as string) || 0
            if (newSteps > 0) {
              const todayStats = (currentData.todayStats as Record<string, number>) || {}
              const currentSteps = todayStats.steps || 0
              setAppData(surfaceId, "/todayStats/steps", currentSteps + newSteps)
              setAppData(surfaceId, "/newSteps", "")
            }
          }
          break
        }

        case "add_water_1":
        case "add_water_2":
        case "add_water_3": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const cups = parseInt(actionType.replace("add_water_", ""))
            const todayStats = (currentData.todayStats as Record<string, number>) || {}
            const currentWater = todayStats.water || 0
            setAppData(surfaceId, "/todayStats/water", currentWater + cups)
          }
          break
        }

        // ========== Note Selection Actions ==========
        case "select_note": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const notes =
              (currentData.notes as Array<{ id: number; title: string; content: string }>) || []
            const noteIndex = data.index as number
            if (notes[noteIndex]) {
              setAppData(surfaceId, "/selectedNote", notes[noteIndex])
              setAppData(surfaceId, "/newNote", {
                title: notes[noteIndex].title,
                content: notes[noteIndex].content,
              })
            }
          }
          break
        }

        case "delete_note": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const notes = [...((currentData.notes as unknown[]) || [])]
            const noteIndex = data.index as number
            if (noteIndex >= 0 && noteIndex < notes.length) {
              notes.splice(noteIndex, 1)
              setAppData(surfaceId, "/notes", notes)
              setAppData(surfaceId, "/notesCountText", `${notes.length} notes`)
            }
          }
          break
        }

        // ========== Expense View Actions ==========
        case "view_expense": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const expenses = (currentData.expenses as unknown[]) || []
            const expenseIndex = data.index as number
            if (expenses[expenseIndex]) {
              setAppData(surfaceId, "/selectedExpense", expenses[expenseIndex])
            }
          }
          break
        }

        case "delete_expense": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const expenses = [...((currentData.expenses as unknown[]) || [])]
            const expenseIndex = data.index as number
            if (expenseIndex >= 0 && expenseIndex < expenses.length) {
              expenses.splice(expenseIndex, 1)
              setAppData(surfaceId, "/expenses", expenses)
              updateExpenseStats(setDataValue, surfaceId, expenses)
            }
          }
          break
        }

        // ========== Delete Task Actions ==========
        case "delete_task": {
          const currentData = getAppData(surfaceId)
          if (currentData && data?.index !== undefined) {
            const tasks = [...((currentData.tasks as unknown[]) || [])]
            const taskIndex = data.index as number
            if (taskIndex >= 0 && taskIndex < tasks.length) {
              tasks.splice(taskIndex, 1)
              setAppData(surfaceId, "/tasks", tasks)
              updateTaskStats(setDataValue, surfaceId, tasks)
            }
          }
          break
        }

        // ========== Toggle/Negate Actions ==========
        case "negate": {
          const currentData = getAppData(surfaceId)
          if (currentData) {
            const display = (currentData.display as string) || "0"
            if (display !== "0") {
              setAppData(
                surfaceId,
                "/display",
                display.startsWith("-") ? display.slice(1) : "-" + display
              )
            }
          }
          break
        }

        default:
          onAction?.(action)
      }
    },
    [
      getAppData,
      setAppData,
      resetAppData,
      setDataValue,
      onAction,
      startTimerInterval,
      stopTimerInterval,
      setTimerPreset,
    ]
  )

  return { handleAppAction }
}
