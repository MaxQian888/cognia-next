import { QUICK_ACTIONS } from "../capture/capture-request"
import { quickActionInstruction, quickActionLabel } from "./quick-actions"

describe("quick actions", () => {
  it("names a distinct instruction and label for every action", () => {
    const message = (key: string) => `<${key}>`
    expect(QUICK_ACTIONS.map((action) => quickActionInstruction(action, message))).toEqual([
      "<quickPromptSummarize>",
      "<quickPromptExplain>",
      "<quickPromptTranslate>",
    ])
    expect(QUICK_ACTIONS.map((action) => quickActionLabel(action, message))).toEqual([
      "<quickActionSummarize>",
      "<quickActionExplain>",
      "<quickActionTranslate>",
    ])
  })
})
