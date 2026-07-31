import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { ComputerUseCard } from "./computer-use-card"

// 1x1 transparent PNG so the screenshot story renders a real (tiny) image
// through ImageBlock instead of a broken-image placeholder.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

function makePart(input: unknown, output: unknown): ToolUIPart {
  return {
    type: "tool-computer_use",
    toolCallId: "c1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/ComputerUseCard",
  component: ComputerUseCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ComputerUseCard>

export default meta
type Story = StoryObj<typeof meta>

export const Screenshot: Story = {
  args: {
    part: makePart(
      { action: "screenshot" },
      {
        ok: true,
        output: TINY_PNG_BASE64,
        display_width_px: 1280,
        display_height_px: 800,
      }
    ),
  },
}

export const ClickAction: Story = {
  args: {
    part: makePart(
      { action: "left_click", coordinate: [640, 400] },
      { ok: true, output: "clicked" }
    ),
  },
}

export const Error: Story = {
  args: {
    part: makePart(
      { action: "screenshot" },
      { ok: false, error: "Screen recording permission was declined by the user." }
    ),
  },
}
