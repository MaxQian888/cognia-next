import { render } from "@testing-library/react"
import type { ReactNode } from "react"

// Stub MessageResponse so we can inspect what gets passed in.
jest.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div data-testid="msg-response">{children}</div>
  ),
}))

// Control reduced-motion so we can assert the caret's blink toggles.
const flowMotion = { reduce: false, speed: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

import { StreamingTextPart } from "./streaming-text-part"

describe("StreamingTextPart", () => {
  beforeEach(() => {
    flowMotion.reduce = false
    flowMotion.speed = 1
  })
  it("renders the supplied text via MessageResponse", () => {
    const { getByTestId } = render(<StreamingTextPart text="hello world" isStreaming={true} />)
    expect(getByTestId("msg-response").textContent).toBe("hello world")
  })

  it("updates when the streaming text grows", () => {
    const { getByTestId, rerender } = render(<StreamingTextPart text="hello" isStreaming={true} />)
    expect(getByTestId("msg-response").textContent).toBe("hello")
    rerender(<StreamingTextPart text="hello world" isStreaming={true} />)
    expect(getByTestId("msg-response").textContent).toBe("hello world")
  })

  it("renders when isStreaming flips to false", () => {
    const { getByTestId, rerender } = render(
      <StreamingTextPart text="finalised" isStreaming={true} />
    )
    rerender(<StreamingTextPart text="finalised" isStreaming={false} />)
    expect(getByTestId("msg-response").textContent).toBe("finalised")
  })

  it("memo equality skips identical re-renders (text + isStreaming unchanged)", () => {
    const { getByTestId, rerender } = render(<StreamingTextPart text="same" isStreaming={true} />)
    const beforeNode = getByTestId("msg-response")
    rerender(<StreamingTextPart text="same" isStreaming={true} />)
    // Memo skip is internal; we verify the DOM is stable across the rerender.
    const afterNode = getByTestId("msg-response")
    expect(afterNode).toBe(beforeNode)
    expect(afterNode.textContent).toBe("same")
  })

  it("renders an empty string as no visible text", () => {
    const { getByTestId } = render(<StreamingTextPart text="" isStreaming={true} />)
    expect(getByTestId("msg-response").textContent).toBe("")
  })

  it("renders a blinking caret alongside the streaming text", () => {
    const { getByTestId } = render(<StreamingTextPart text="hello" isStreaming={true} />)
    const caret = getByTestId("streaming-caret")
    expect(caret).toBeInTheDocument()
    expect(caret).toHaveClass("animate-pulse")
  })

  it("renders a static caret under reduced motion", () => {
    flowMotion.reduce = true
    const { getByTestId } = render(<StreamingTextPart text="hello" isStreaming={true} />)
    expect(getByTestId("streaming-caret")).not.toHaveClass("animate-pulse")
  })
})
