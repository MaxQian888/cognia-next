import {
  exportFilename,
  exportFlow,
  toAgentContext,
  toJson,
  toPlaywrightKey,
  toPlaywrightLocator,
  toPlaywrightSpec,
} from "@/lib/browser/recording/exporters"
import type { RecordedFlow, RecordedStep, RecordedTarget } from "@/lib/browser/recording/protocol"

function target(over: Partial<RecordedTarget> = {}): RecordedTarget {
  return { selector: "#submit", role: "button", name: "Sign in", domPath: "form > button", ...over }
}

function flow(steps: RecordedStep[], over: Partial<RecordedFlow> = {}): RecordedFlow {
  return {
    id: "flow_1",
    name: "login",
    baseUrl: "http://localhost:3000",
    createdAt: 0,
    updatedAt: 0,
    steps,
    ...over,
  }
}

const LOGIN: RecordedStep[] = [
  { act: "navigate", at: 1, url: "http://localhost:3000/login" },
  {
    act: "fill",
    at: 2,
    target: target({ selector: "#email", role: "textbox", name: "Email" }),
    value: "a@b.c",
  },
  { act: "click", at: 3, target: target() },
  { act: "wait_for", at: 4, text: "Welcome" },
]

describe("toPlaywrightKey", () => {
  it.each([
    ["ctrl+a", "Control+a"],
    ["shift+Tab", "Shift+Tab"],
    ["cmd+c", "Meta+c"],
    ["command+v", "Meta+v"],
    ["alt+F4", "Alt+F4"],
  ])("maps our chord %s to Playwright's %s", (chord, expected) => {
    expect(toPlaywrightKey(chord)).toBe(expected)
  })

  it("passes a bare key through", () => {
    expect(toPlaywrightKey("Enter")).toBe("Enter")
  })

  it("passes an unknown token through rather than dropping it", () => {
    expect(toPlaywrightKey("hyper+x")).toBe("hyper+x")
  })
})

describe("toPlaywrightLocator", () => {
  it("prefers a role locator when role and name are both known", () => {
    expect(toPlaywrightLocator(target())).toBe('page.getByRole("button", { name: "Sign in" })')
  })

  it("falls back to css when the element has no mapped role", () => {
    expect(toPlaywrightLocator(target({ role: null }))).toBe('page.locator("#submit")')
  })

  it("falls back to css when the element has no accessible name", () => {
    expect(toPlaywrightLocator(target({ name: null }))).toBe('page.locator("#submit")')
  })

  it("escapes quotes in an accessible name", () => {
    const locator = toPlaywrightLocator(target({ name: 'Say "hi"' }))
    expect(locator).toBe('page.getByRole("button", { name: "Say \\"hi\\"" })')
  })
})

describe("toPlaywrightSpec", () => {
  it("emits a runnable spec for a login flow", () => {
    expect(toPlaywrightSpec(flow(LOGIN))).toBe(
      [
        'import { test, expect } from "@playwright/test"',
        "",
        'test("login", async ({ page }) => {',
        '  await page.goto("http://localhost:3000/login")',
        '  await page.getByRole("textbox", { name: "Email" }).fill("a@b.c")',
        '  await page.getByRole("button", { name: "Sign in" }).click()',
        '  await expect(page.getByText("Welcome")).toBeVisible()',
        "})",
        "",
      ].join("\n")
    )
  })

  it("omits the expect import when the flow has no assertion", () => {
    const spec = toPlaywrightSpec(flow([{ act: "click", at: 1, target: target() }]))
    expect(spec).toContain('import { test } from "@playwright/test"')
    expect(spec).not.toContain("expect")
  })

  it("emits click modifiers", () => {
    const spec = toPlaywrightSpec(
      flow([{ act: "click", at: 1, target: target(), modifiers: ["ctrl", "shift"] }])
    )
    expect(spec).toContain(
      'await page.getByRole("button", { name: "Sign in" }).click({ modifiers: ["Control", "Shift"] })'
    )
  })

  it("presses on the target when one was focused, else on the keyboard", () => {
    expect(toPlaywrightSpec(flow([{ act: "press_key", at: 1, key: "Enter" }]))).toContain(
      'await page.keyboard.press("Enter")'
    )
    expect(
      toPlaywrightSpec(flow([{ act: "press_key", at: 1, key: "ctrl+a", target: target() }]))
    ).toContain('.press("Control+a")')
  })

  it("emits selectOption for a select step", () => {
    const spec = toPlaywrightSpec(
      flow([
        {
          act: "select",
          at: 1,
          target: target({ selector: "#plan", role: "combobox", name: "Plan" }),
          value: "pro",
        },
      ])
    )
    expect(spec).toContain('await page.getByRole("combobox", { name: "Plan" }).selectOption("pro")')
  })

  it("exports double-click, hover, and scroll events", () => {
    const spec = toPlaywrightSpec(
      flow([
        { act: "double_click", at: 1, target: target() },
        { act: "hover", at: 2, target: target() },
        { act: "scroll", at: 3, direction: "left", amount: 80 },
      ])
    )

    expect(spec).toContain(".dblclick()")
    expect(spec).toContain(".hover()")
    expect(spec).toContain("await page.mouse.wheel(-80, 0)")
  })

  it("exports double-click modifiers and vertical scroll direction", () => {
    const spec = toPlaywrightSpec(
      flow([
        { act: "double_click", at: 1, target: target(), modifiers: ["ctrl"] },
        { act: "scroll", at: 2, direction: "down", amount: 160 },
      ])
    )

    expect(spec).toContain('.dblclick({ modifiers: ["Control"] })')
    expect(spec).toContain("await page.mouse.wheel(0, 160)")
  })

  it("escapes a flow name that would otherwise break the generated source", () => {
    const spec = toPlaywrightSpec(flow([], { name: 'the "quoted" flow' }))
    expect(spec).toContain('test("the \\"quoted\\" flow", async ({ page }) => {')
  })

  it("resolves a relative navigation against the base url", () => {
    const spec = toPlaywrightSpec(flow([{ act: "navigate", at: 1, url: "/dashboard" }]))
    expect(spec).toContain('await page.goto("http://localhost:3000/dashboard")')
  })
})

describe("toAgentContext", () => {
  it("renders numbered steps with selectors and the re-snapshot directive", () => {
    const md = toAgentContext(flow(LOGIN))
    expect(md).toContain("— Recorded browser flow: login —")
    expect(md).toContain("Base URL: http://localhost:3000")
    expect(md).toContain("1. navigate to http://localhost:3000/login")
    expect(md).toContain('2. fill textbox "Email" with "a@b.c" — selector: #email')
    expect(md).toContain('3. click button "Sign in" — selector: #submit')
    expect(md).toContain('4. expect the text "Welcome" to be visible')
    expect(md).toContain("act on elements by the `ref` from the latest snapshot")
  })

  it("describes a roleless element by its selector", () => {
    const md = toAgentContext(
      flow([{ act: "click", at: 1, target: target({ role: null, name: null }) }])
    )
    expect(md).toContain("1. click #submit")
  })

  it("notes click modifiers", () => {
    const md = toAgentContext(
      flow([{ act: "click", at: 1, target: target(), modifiers: ["ctrl"] }])
    )
    expect(md).toContain("(holding ctrl)")
  })

  it("describes double-click, hover, and scroll events", () => {
    const md = toAgentContext(
      flow([
        { act: "double_click", at: 1, target: target() },
        { act: "hover", at: 2, target: target() },
        { act: "scroll", at: 3, direction: "down", amount: 120 },
      ])
    )
    expect(md).toContain('double-click button "Sign in"')
    expect(md).toContain('hover button "Sign in"')
    expect(md).toContain("scroll down by 120px")
  })

  it("says so explicitly when nothing was recorded", () => {
    expect(toAgentContext(flow([]))).toContain("(no steps recorded)")
  })

  it("renders a targetless key press", () => {
    expect(toAgentContext(flow([{ act: "press_key", at: 1, key: "Escape" }]))).toContain(
      "1. press Escape"
    )
  })
})

describe("toJson", () => {
  it("round-trips the flow", () => {
    expect(JSON.parse(toJson(flow(LOGIN)))).toEqual(flow(LOGIN))
  })
})

// A recorded password must never reach an artifact: the spec is committed, the
// agent context is sent to a model, and the json is persisted. The recorder
// never captures the value (FillStep.secret) — these pin that the exporters
// keep that promise instead of emitting an empty string as if it were the real
// value.
describe("secret fields never leak into an artifact", () => {
  const secretFlow = flow([
    {
      act: "fill",
      at: 1,
      target: target({ selector: "#password", role: "textbox", name: "Password" }),
      value: "",
      secret: true,
    },
  ])

  it("reads the password from the environment in the playwright spec", () => {
    const spec = toPlaywrightSpec(secretFlow)
    expect(spec).toContain(
      'await page.getByRole("textbox", { name: "Password" }).fill(process.env.PASSWORD ?? "")'
    )
    expect(spec).not.toContain('.fill("")')
  })

  it("tells the agent to ask rather than inventing a value", () => {
    const md = toAgentContext(secretFlow)
    expect(md).toContain("the PASSWORD secret (value not recorded; ask the user)")
  })

  it("still fills a non-secret field literally", () => {
    expect(toPlaywrightSpec(flow(LOGIN))).toContain('.fill("a@b.c")')
  })
})

describe("exportFlow", () => {
  it.each(["json", "playwright", "agent"] as const)("dispatches the %s format", (format) => {
    expect(exportFlow(flow(LOGIN), format)).toBe(
      { json: toJson, playwright: toPlaywrightSpec, agent: toAgentContext }[format](flow(LOGIN))
    )
  })
})

describe("exportFilename", () => {
  it.each([
    ["playwright", "login.spec.ts"],
    ["json", "login.json"],
    ["agent", "login.md"],
  ] as const)("names the %s artifact", (format, expected) => {
    expect(exportFilename(flow([]), format)).toBe(expected)
  })

  it("slugifies a messy flow name", () => {
    expect(exportFilename(flow([], { name: "  Log In / Sign-up!  " }), "json")).toBe(
      "log-in-sign-up.json"
    )
  })

  it("falls back to a stem when the name slugifies to nothing", () => {
    expect(exportFilename(flow([], { name: "!!!" }), "json")).toBe("recording.json")
  })
})
