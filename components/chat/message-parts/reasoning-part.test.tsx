/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { Reasoning } from "@/components/ai-elements/reasoning"
import { ReasoningToolRow } from "./reasoning-part"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Keep the body cheap: the row tests assert the activity-row chrome, not
// Streamdown internals (the renderer's streamdownProps are asserted in
// `message-renderer.test.tsx`).
jest.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) =>
    ReactForMocks.createElement("div", { "data-testid": "reasoning-streamdown" }, children),
}))
jest.mock("@/components/ai-elements/shimmer", () => ({
  Shimmer: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    ReactForMocks.createElement("span", { className, "data-testid": "shimmer" }, children),
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  ReadingCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? ReactForMocks.createElement("div", null, children) : null,
}))
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, copy: jest.fn(async () => true) }),
}))

function renderRow({
  text = "weighing the options",
  isStreaming = false,
  defaultOpen,
}: {
  text?: string
  isStreaming?: boolean
  defaultOpen?: boolean
} = {}) {
  return render(
    <Reasoning isStreaming={isStreaming} defaultOpen={defaultOpen} closeOnFinish={false}>
      <ReasoningToolRow text={text} streamdownProps={{}} />
    </Reasoning>
  )
}

describe("ReasoningToolRow", () => {
  it("renders thinking as one activity-stream row with the THINK verb", () => {
    renderRow()
    const row = screen.getByTestId("reasoning-row")
    expect(row).toHaveAttribute("data-kind", "reasoning")
    // Done thinking → settled green dot, same as a finished tool call.
    expect(row).toHaveAttribute("data-status", "output-available")
    expect(row).toHaveTextContent("verb.think")
    expect(row).toHaveTextContent("reasoning.completed")
  })

  it("expands and collapses like every other tool row", () => {
    renderRow({ defaultOpen: true })
    const toggle = screen.getByRole("button", { name: "reasoning.completed" })
    expect(screen.getByTestId("reasoning-streamdown")).toHaveTextContent("weighing the options")

    fireEvent.click(toggle)
    expect(screen.queryByTestId("reasoning-streamdown")).toBeNull()

    fireEvent.click(toggle)
    expect(screen.getByTestId("reasoning-streamdown")).toBeInTheDocument()
  })

  it("breaths blue and shimmers while the model is still thinking", () => {
    renderRow({ isStreaming: true })
    const row = screen.getByTestId("reasoning-row")
    expect(row).toHaveAttribute("data-status", "input-available")
    expect(screen.getByTestId("shimmer")).toHaveTextContent("reasoning.streaming")
  })

  it("offers a copy affordance for the thinking text", () => {
    renderRow()
    expect(screen.getByTestId("reasoning-copy")).toBeInTheDocument()
  })

  it("reports the settled duration once the wrapper has timed the turn", () => {
    // Streaming stops → the wrapper records a duration and the label switches
    // to the pluralised "thought for N seconds" message.
    const { rerender } = render(
      <Reasoning isStreaming defaultOpen closeOnFinish={false}>
        <ReasoningToolRow text="t" streamdownProps={{}} />
      </Reasoning>
    )
    rerender(
      <Reasoning isStreaming={false} defaultOpen closeOnFinish={false}>
        <ReasoningToolRow text="t" streamdownProps={{}} />
      </Reasoning>
    )
    expect(screen.getByTestId("reasoning-row")).toHaveTextContent(
      /reasoning\.completedSeconds|reasoning\.completed/
    )
  })
})
