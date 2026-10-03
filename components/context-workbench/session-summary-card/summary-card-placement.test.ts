import { chatColumnClass } from "@/components/chat/chat-column"

import {
  CHAT_COLUMN_MAX_REM,
  SUMMARY_CARD_WIDTH_PX,
  summaryCardPlacement,
} from "./summary-card-placement"

const COLUMN = 832

describe("summaryCardPlacement", () => {
  it("floats when the gutter beside the column holds the card and its margin", () => {
    // (1440 − 832) / 2 = 304 = 288 + 16
    expect(summaryCardPlacement(1440, COLUMN)).toEqual({
      mode: "float",
      width: SUMMARY_CARD_WIDTH_PX,
    })
  })

  it("becomes a popover one pixel short of that", () => {
    expect(summaryCardPlacement(1439, COLUMN).mode).toBe("popover")
  })

  it("never renders wider than the stage minus its margin", () => {
    expect(summaryCardPlacement(250, COLUMN)).toEqual({ mode: "popover", width: 234 })
    expect(summaryCardPlacement(10, COLUMN).width).toBe(0)
  })

  it("does not float on an unmeasured stage", () => {
    expect(summaryCardPlacement(0, COLUMN)).toEqual({
      mode: "popover",
      width: SUMMARY_CARD_WIDTH_PX,
    })
  })
})

it("tracks the chat column's real max width", () => {
  // `chatColumnClass` is a Tailwind literal, so the number lives twice; this
  // keeps the pair from drifting apart.
  expect(chatColumnClass).toContain(`max-w-[${CHAT_COLUMN_MAX_REM}rem]`)
})
