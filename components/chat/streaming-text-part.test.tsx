import { render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"

const mockStreamdownParser = jest.fn((markdown: string) =>
  markdown.split(/(\n\n+)/).filter((block) => block.length > 0)
)
jest.mock(
  "streamdown",
  () => ({
    Block: ({ content }: { content: string }) => (
      <div data-testid="streamdown-block">{content}</div>
    ),
    parseMarkdownIntoBlocks: (markdown: string) => mockStreamdownParser(markdown),
  }),
  { virtual: true }
)

// Stub MessageResponse so we can inspect what gets passed in.
const mockMessageResponse = jest.fn()
jest.mock("@/components/ai-elements/message", () => ({
  MessageResponse: (props: { children: ReactNode }) => {
    mockMessageResponse(props)
    return <div data-testid="msg-response">{props.children}</div>
  },
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
    mockMessageResponse.mockClear()
    mockStreamdownParser.mockClear()
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

  it("supplies incremental parsing and off-screen block containment to Streamdown", () => {
    render(<StreamingTextPart text="hello" isStreaming={true} />)
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      parseMarkdownIntoBlocksFn?: (markdown: string) => string[]
      BlockComponent?: React.ComponentType<{ content: string }>
    }
    expect(props.parseMarkdownIntoBlocksFn).toEqual(expect.any(Function))
    expect(props.BlockComponent).toBeDefined()

    const initial = `${"stable\n\n".repeat(1_000)}active`
    props.parseMarkdownIntoBlocksFn!(initial)
    mockStreamdownParser.mockClear()
    props.parseMarkdownIntoBlocksFn!(`${initial} tail`)
    expect(mockStreamdownParser.mock.calls[0]?.[0].length).toBeLessThan(100)

    const { getByTestId } = render(createElement(props.BlockComponent!, { content: "contained" }))
    expect(getByTestId("streamdown-block").parentElement).toHaveClass(
      "[content-visibility:auto]",
      "[contain-intrinsic-size:auto_160px]"
    )
  })

  it("uses native-safe external links while streaming", () => {
    render(<StreamingTextPart text="[site](https://example.com)" isStreaming={true} />)
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      components?: {
        a?: React.ComponentType<{ href?: string; children?: ReactNode }>
      }
    }
    const Anchor = props.components?.a
    expect(Anchor).toBeDefined()

    render(createElement(Anchor!, { href: "https://example.com" }, "site"))
    expect(screen.getByRole("link", { name: "site" })).toHaveAttribute("target", "_blank")
  })

  it("turns workspace links into project file actions while streaming", () => {
    render(
      <StreamingTextPart text="[app](src/app.ts#L7C2)" isStreaming={true} projectRoot="/repo" />
    )
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      components?: {
        a?: React.ComponentType<{ href?: string; children?: ReactNode }>
      }
    }
    const Anchor = props.components?.a
    expect(Anchor).toBeDefined()

    render(createElement(Anchor!, { href: "src/app.ts#L7C2" }, "app"))
    expect(screen.getByRole("button", { name: "app" })).toBeInTheDocument()
  })
})
