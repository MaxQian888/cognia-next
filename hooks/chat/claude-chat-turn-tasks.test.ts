import {
  extractAssistantText,
  extractPlainText,
  renderGoalExitCard,
} from "./claude-chat-turn-tasks"

describe("Claude chat turn tasks", () => {
  const message = { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] } as never

  it("extracts rendered message text", () => {
    expect(extractAssistantText(message)).toBe("done")
    expect(extractPlainText(message)).toBe("done")
  })

  it("renders terminal goal cards", () => {
    expect(renderGoalExitCard("completed", "shipped")).toContain("Goal completed")
  })
})
