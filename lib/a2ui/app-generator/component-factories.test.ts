import type { A2UIComponent } from "@/types/a2ui/schema"
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

// Tree-integrity guard reused across every factory: every `children` reference
// must resolve to a top-level component in the same tree, and every node must
// have a unique id.
function assertInternallyConsistent(components: A2UIComponent[]) {
  const ids = new Set<string>()
  for (const c of components) {
    expect(c.id).toBeTruthy()
    expect(ids.has(c.id)).toBe(false)
    ids.add(c.id)
  }
  for (const c of components) {
    const children = (c as { children?: unknown }).children
    if (Array.isArray(children)) {
      for (const childId of children) {
        if (typeof childId === "string") {
          expect(ids.has(childId)).toBe(true)
        }
      }
    }
  }
}

function getRoot(components: A2UIComponent[]): A2UIComponent {
  const root = components.find((c) => c.id === "root")
  expect(root).toBeDefined()
  return root!
}

function getById(components: A2UIComponent[], id: string): A2UIComponent | undefined {
  return components.find((c) => c.id === id)
}

describe("createBasicCalculatorComponents", () => {
  const components = createBasicCalculatorComponents()

  it("produces a self-consistent component tree", () => {
    assertInternallyConsistent(components)
  })

  it("uses a Column root that mounts display + keypad", () => {
    const root = getRoot(components)
    expect(root.component).toBe("Column")
    expect((root as { children: string[] }).children).toEqual(["display", "keypad"])
  })

  it("renders the standard 4×4 keypad with operator + digit branches", () => {
    const operators = ["btn-div", "btn-mul", "btn-sub", "btn-add", "btn-eq"]
    const digits = ["btn-1", "btn-2", "btn-3", "btn-4", "btn-5", "btn-6", "btn-7", "btn-8", "btn-9"]
    for (const id of [...operators, ...digits, "btn-c", "btn-del"]) {
      expect(getById(components, id)).toBeDefined()
    }
  })

  it("binds the display Text to the /display data path", () => {
    const displayText = getById(components, "display-text") as {
      text: { path: string }
      variant: string
    }
    expect(displayText.text.path).toBe("/display")
    expect(displayText.variant).toBe("heading1")
  })
})

describe("createTipCalculatorComponents", () => {
  const components = createTipCalculatorComponents()

  it("produces a self-consistent component tree", () => {
    assertInternallyConsistent(components)
  })

  it("exposes bill / tipPercent / people input bindings", () => {
    const bill = getById(components, "bill-input") as { value: { path: string } }
    const tip = getById(components, "tip-slider") as { value: { path: string } }
    const people = getById(components, "people-input") as { value: { path: string } }
    expect(bill.value.path).toBe("/bill")
    expect(tip.value.path).toBe("/tipPercent")
    expect(people.value.path).toBe("/people")
  })

  it("uses a Slider for tip percent with 0..30 range", () => {
    const tip = getById(components, "tip-slider") as { min: number; max: number; step: number }
    expect(tip.min).toBe(0)
    expect(tip.max).toBe(30)
    expect(tip.step).toBe(1)
  })
})

describe("createBMICalculatorComponents", () => {
  const components = createBMICalculatorComponents()

  it("produces a self-consistent component tree", () => {
    assertInternallyConsistent(components)
  })

  it("uses sliders for height/weight bound to /height + /weight", () => {
    const height = getById(components, "height-input") as { value: { path: string }; step: number }
    const weight = getById(components, "weight-input") as { value: { path: string }; step: number }
    expect(height.value.path).toBe("/height")
    expect(weight.value.path).toBe("/weight")
    // Half-kg precision on weight is the key BMI-quality knob.
    expect(weight.step).toBe(0.5)
  })

  it("renders a status Badge backed by /status", () => {
    const status = getById(components, "bmi-status") as { text: { path: string } }
    expect(status.text.path).toBe("/status")
  })
})

describe("createAgeCalculatorComponents", () => {
  const components = createAgeCalculatorComponents()

  it("produces a self-consistent component tree", () => {
    assertInternallyConsistent(components)
  })

  it("uses a DatePicker bound to /birthDate", () => {
    const dp = getById(components, "date-input") as { component: string; value: { path: string } }
    expect(dp.component).toBe("DatePicker")
    expect(dp.value.path).toBe("/birthDate")
  })
})

describe("createLoanCalculatorComponents", () => {
  const components = createLoanCalculatorComponents()

  it("produces a self-consistent component tree", () => {
    assertInternallyConsistent(components)
  })

  it("renders the three result cards: monthly / total / interest", () => {
    expect(getById(components, "monthly-value")).toBeDefined()
    expect(getById(components, "total-value")).toBeDefined()
    expect(getById(components, "interest-value")).toBeDefined()
  })

  it("uses a Slider with 1..30 years and 0.1 rate precision", () => {
    const years = getById(components, "years-input") as { min: number; max: number }
    const rate = getById(components, "rate-input") as { step: number }
    expect(years.min).toBe(1)
    expect(years.max).toBe(30)
    expect(rate.step).toBe(0.1)
  })
})

describe("createTimerComponents", () => {
  it("regular timer renders the 1/5/10 minute presets", () => {
    const components = createTimerComponents(false)
    assertInternallyConsistent(components)
    expect(getById(components, "1min-btn")).toBeDefined()
    expect(getById(components, "5min-btn")).toBeDefined()
    expect(getById(components, "10min-btn")).toBeDefined()
    expect(getById(components, "work-btn")).toBeUndefined()
  })

  it("pomodoro renders work / break / long-break presets", () => {
    const components = createTimerComponents(true)
    assertInternallyConsistent(components)
    expect(getById(components, "work-btn")).toBeDefined()
    expect(getById(components, "break-btn")).toBeDefined()
    expect(getById(components, "long-break-btn")).toBeDefined()
    expect(getById(components, "1min-btn")).toBeUndefined()
  })

  it("header text reflects the pomodoro flag", () => {
    const regular = getById(createTimerComponents(false), "header") as { text: string }
    const pom = getById(createTimerComponents(true), "header") as { text: string }
    expect(regular.text).not.toBe(pom.text)
    expect(pom.text).toContain("番茄")
    expect(regular.text).toContain("计时器")
  })

  it("registers control + progress + display nodes regardless of mode", () => {
    for (const isPomodoro of [false, true]) {
      const components = createTimerComponents(isPomodoro)
      for (const id of ["start-btn", "pause-btn", "reset-btn", "progress", "time-display"]) {
        expect(getById(components, id)).toBeDefined()
      }
    }
  })
})

describe("createTodoComponents", () => {
  it("base form (no due date) omits the due-date picker", () => {
    const components = createTodoComponents(false, false, false)
    assertInternallyConsistent(components)
    expect(getById(components, "due-date")).toBeUndefined()
    const inputRow = getById(components, "input-row") as { children: string[] }
    expect(inputRow.children).toEqual(["task-input", "add-btn"])
  })

  it("threads the due-date picker into the input row when requested", () => {
    const components = createTodoComponents(false, false, true)
    assertInternallyConsistent(components)
    expect(getById(components, "due-date")).toBeDefined()
    const inputRow = getById(components, "input-row") as { children: string[] }
    expect(inputRow.children).toEqual(["task-input", "due-date", "add-btn"])
  })

  it("renders the all/pending/done filter triplet and a List bound to /tasks", () => {
    const components = createTodoComponents(true, true, true)
    assertInternallyConsistent(components)
    expect(getById(components, "filter-all")).toBeDefined()
    expect(getById(components, "filter-pending")).toBeDefined()
    expect(getById(components, "filter-done")).toBeDefined()
    const list = getById(components, "task-list") as {
      items: { path: string }
      itemClickAction: string
    }
    expect(list.items.path).toBe("/tasks")
    expect(list.itemClickAction).toBe("toggle_task")
  })
})

describe("createNotesComponents", () => {
  it("produces a self-consistent tree with search + new-note + list", () => {
    const components = createNotesComponents()
    assertInternallyConsistent(components)
    expect(getById(components, "search")).toBeDefined()
    expect(getById(components, "new-note")).toBeDefined()
    expect(getById(components, "notes-list")).toBeDefined()
  })

  it("binds the search field to /searchQuery", () => {
    const search = getById(createNotesComponents(), "search") as { value: { path: string } }
    expect(search.value.path).toBe("/searchQuery")
  })
})

describe("createSurveyComponents", () => {
  it("renders title + description + 3 questions + submit", () => {
    const components = createSurveyComponents()
    assertInternallyConsistent(components)
    for (const id of ["title", "desc", "q1", "q2", "q3", "submit-btn"]) {
      expect(getById(components, id)).toBeDefined()
    }
  })

  it("models satisfaction as a RadioGroup with four options", () => {
    const q2 = getById(createSurveyComponents(), "q2") as {
      component: string
      options: { value: string }[]
    }
    expect(q2.component).toBe("RadioGroup")
    expect(q2.options).toHaveLength(4)
  })
})

describe("createContactComponents", () => {
  it("renders the standard fields (first/last/email/subject/message)", () => {
    const components = createContactComponents()
    assertInternallyConsistent(components)
    for (const id of ["first-name", "last-name", "email", "subject", "message", "submit-btn"]) {
      expect(getById(components, id)).toBeDefined()
    }
  })

  it("marks email as type=email + required", () => {
    const email = getById(createContactComponents(), "email") as {
      type: string
      required: boolean
    }
    expect(email.type).toBe("email")
    expect(email.required).toBe(true)
  })

  it("renders subject as a Select with three known categories", () => {
    const subject = getById(createContactComponents(), "subject") as {
      component: string
      options: { value: string }[]
    }
    expect(subject.component).toBe("Select")
    expect(subject.options.map((o) => o.value).sort()).toEqual(["feedback", "general", "support"])
  })
})

describe("createExpenseTrackerComponents", () => {
  it("renders summary + add-expense + list with budget Progress", () => {
    const components = createExpenseTrackerComponents()
    assertInternallyConsistent(components)
    expect(getById(components, "total-card")).toBeDefined()
    expect(getById(components, "budget-card")).toBeDefined()
    expect(getById(components, "expense-list")).toBeDefined()
    const progress = getById(components, "budget-progress") as { component: string; max: number }
    expect(progress.component).toBe("Progress")
    expect(progress.max).toBe(100)
  })

  it("enumerates 5 category options including food/transport/shopping/entertainment/other", () => {
    const cat = getById(createExpenseTrackerComponents(), "category-select") as {
      options: { value: string }[]
    }
    expect(cat.options.map((o) => o.value).sort()).toEqual([
      "entertainment",
      "food",
      "other",
      "shopping",
      "transport",
    ])
  })
})

describe("createHealthTrackerComponents", () => {
  it("renders steps + water progress cards with correct targets", () => {
    const components = createHealthTrackerComponents()
    assertInternallyConsistent(components)
    const steps = getById(components, "steps-progress") as { max: number }
    const water = getById(components, "water-progress") as { max: number }
    expect(steps.max).toBe(10000)
    expect(water.max).toBe(8)
  })

  it("exposes three water quick-log buttons (+1/+2/+3 cups)", () => {
    const components = createHealthTrackerComponents()
    expect(getById(components, "water-1")).toBeDefined()
    expect(getById(components, "water-2")).toBeDefined()
    expect(getById(components, "water-3")).toBeDefined()
  })
})

describe("createHabitTrackerComponents", () => {
  it("renders streak card + habits list + add-habit form", () => {
    const components = createHabitTrackerComponents()
    assertInternallyConsistent(components)
    for (const id of [
      "streak-card",
      "streak-icon",
      "streak-text",
      "habits-list",
      "habit-input",
      "add-btn",
    ]) {
      expect(getById(components, id)).toBeDefined()
    }
  })

  it("renders an Icon flame for the streak indicator", () => {
    const icon = getById(createHabitTrackerComponents(), "streak-icon") as {
      component: string
      name: string
    }
    expect(icon.component).toBe("Icon")
    expect(icon.name).toBe("Flame")
  })

  it("binds habits-list to /habits with the toggle_habit action", () => {
    const list = getById(createHabitTrackerComponents(), "habits-list") as {
      items: { path: string }
      itemClickAction: string
    }
    expect(list.items.path).toBe("/habits")
    expect(list.itemClickAction).toBe("toggle_habit")
  })
})
