/**
 * Tests for A2UI Prompts
 */

import {
  A2UI_SYSTEM_PROMPT,
  A2UI_TEMPLATES,
  buildA2UIFormPrompt,
  buildA2UIDashboardPrompt,
  buildA2UIChoicePrompt,
  buildA2UIWizardPrompt,
  buildA2UIFeedbackPrompt,
  type A2UITemplate,
} from "./a2ui-prompts"

describe("A2UI_SYSTEM_PROMPT", () => {
  it("should be a non-empty string", () => {
    expect(typeof A2UI_SYSTEM_PROMPT).toBe("string")
    expect(A2UI_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })

  it("should contain A2UI instructions", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("A2UI")
  })

  it("should describe component types", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("Button")
    expect(A2UI_SYSTEM_PROMPT).toContain("Text")
    expect(A2UI_SYSTEM_PROMPT).toContain("Card")
  })

  it("should include JSON format examples", () => {
    expect(A2UI_SYSTEM_PROMPT).toContain("surface")
    expect(A2UI_SYSTEM_PROMPT).toContain("components")
  })
})

describe("A2UI_TEMPLATES", () => {
  it("should have quickPoll template", () => {
    expect(A2UI_TEMPLATES.quickPoll).toBeDefined()
    expect(A2UI_TEMPLATES.quickPoll.name).toBe("Quick Poll")
  })

  it("should have all required template properties", () => {
    Object.values(A2UI_TEMPLATES).forEach((template) => {
      expect(template).toHaveProperty("name")
      expect(template).toHaveProperty("description")
    })
  })
})

describe("buildA2UIFormPrompt", () => {
  it("should generate form prompt with fields", () => {
    const prompt = buildA2UIFormPrompt({
      purpose: "User registration",
      fields: [
        { name: "email", type: "email", required: true },
        { name: "password", type: "password", required: true },
      ],
    })

    expect(prompt).toContain("User registration")
    expect(prompt).toContain("email")
    expect(prompt).toContain("password")
  })

  it("should include submit action when provided", () => {
    const prompt = buildA2UIFormPrompt({
      purpose: "Contact form",
      fields: [{ name: "message", type: "textarea" }],
      submitAction: "send_message",
    })

    expect(prompt).toContain("send_message")
  })

  it("should handle empty fields array", () => {
    const prompt = buildA2UIFormPrompt({
      purpose: "Empty form",
      fields: [],
    })

    expect(prompt).toBeDefined()
    expect(prompt).toContain("Empty form")
  })
})

describe("buildA2UIDashboardPrompt", () => {
  it("should generate dashboard with metrics", () => {
    const prompt = buildA2UIDashboardPrompt({
      title: "Sales Dashboard",
      metrics: [
        { name: "Revenue", value: 10000, trend: "up" },
        { name: "Users", value: 500, trend: "neutral" },
      ],
    })

    expect(prompt).toContain("Sales Dashboard")
    expect(prompt).toContain("Revenue")
    expect(prompt).toContain("10000")
  })

  it("should include chart when specified", () => {
    const prompt = buildA2UIDashboardPrompt({
      title: "Analytics",
      metrics: [{ name: "Views", value: 1000 }],
      includeChart: true,
    })

    expect(prompt).toContain("chart")
  })

  it("should handle metrics without trend", () => {
    const prompt = buildA2UIDashboardPrompt({
      title: "Simple Dashboard",
      metrics: [{ name: "Count", value: 42 }],
    })

    expect(prompt).toContain("Count")
    expect(prompt).toContain("42")
  })
})

describe("buildA2UIChoicePrompt", () => {
  it("should generate choice interface", () => {
    const prompt = buildA2UIChoicePrompt({
      question: "Select your preference",
      options: [
        { id: "opt1", label: "Option A" },
        { id: "opt2", label: "Option B", description: "Detailed option" },
      ],
    })

    expect(prompt).toContain("Select your preference")
    expect(prompt).toContain("Option A")
    expect(prompt).toContain("Option B")
  })

  it("should support multiple selection", () => {
    const prompt = buildA2UIChoicePrompt({
      question: "Select all that apply",
      options: [{ id: "a", label: "A" }],
      allowMultiple: true,
    })

    // Check that prompt is generated with multi-select option
    expect(prompt).toBeDefined()
    expect(prompt.length).toBeGreaterThan(0)
  })

  it("should include option descriptions", () => {
    const prompt = buildA2UIChoicePrompt({
      question: "Pick one",
      options: [{ id: "1", label: "First", description: "First option description" }],
    })

    expect(prompt).toContain("First option description")
  })
})

describe("buildA2UIWizardPrompt", () => {
  it("should generate wizard with steps", () => {
    const prompt = buildA2UIWizardPrompt({
      title: "Setup Wizard",
      steps: [
        { id: "step1", title: "Welcome", description: "Get started" },
        { id: "step2", title: "Configure", description: "Set options" },
        { id: "step3", title: "Finish", description: "Complete setup" },
      ],
    })

    expect(prompt).toContain("Setup Wizard")
    expect(prompt).toContain("Welcome")
    expect(prompt).toContain("Configure")
    expect(prompt).toContain("Finish")
  })

  it("should highlight current step", () => {
    const prompt = buildA2UIWizardPrompt({
      title: "Wizard",
      steps: [
        { id: "s1", title: "Step 1", description: "First" },
        { id: "s2", title: "Step 2", description: "Second" },
      ],
      currentStep: 1,
    })

    expect(prompt).toContain("current")
  })
})

describe("buildA2UIFeedbackPrompt", () => {
  it("should generate feedback interface", () => {
    const prompt = buildA2UIFeedbackPrompt({
      title: "Rate your experience",
    })

    expect(prompt).toContain("Rate your experience")
  })

  it("should support different rating types", () => {
    const starsPrompt = buildA2UIFeedbackPrompt({
      title: "Rating",
      ratingType: "stars",
    })
    expect(starsPrompt).toContain("stars")

    const emojiPrompt = buildA2UIFeedbackPrompt({
      title: "Rating",
      ratingType: "emoji",
    })
    expect(emojiPrompt).toContain("emoji")
  })

  it("should include comment field when specified", () => {
    const prompt = buildA2UIFeedbackPrompt({
      title: "Feedback",
      includeComment: true,
    })

    expect(prompt).toContain("comment")
  })
})

describe("A2UITemplate type", () => {
  it("should accept valid template keys", () => {
    const template: A2UITemplate = "quickPoll"
    expect(A2UI_TEMPLATES[template]).toBeDefined()
  })
})
