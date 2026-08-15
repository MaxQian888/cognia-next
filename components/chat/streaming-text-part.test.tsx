import { act, render, screen } from "@testing-library/react"
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
const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

const mockMarkdownRenderer = jest.fn()
jest.mock("./markdown-renderer", () => ({
  MarkdownRenderer: (props: { content: string }) => {
    mockMarkdownRenderer(props)
    return <div data-testid="finalized-markdown-content">{props.content}</div>
  },
}))
jest.mock("./markdown/rendering-policy", () => ({
  chatMarkdownUrlTransform: (url: string) => url,
  chatStreamdownRehypePlugins: ["shared-rehype"],
}))

import { FinalizedLongTextPart, StreamingTextPart, blockRendersCode } from "./streaming-text-part"
import {
  selectStreamdownPlugins,
  streamdownPlugins,
} from "@/components/ai-elements/streamdown-plugins"
import type { MessageMarkdownOptions } from "@/types/appearance"

const MARKDOWN_DEFAULTS: MessageMarkdownOptions = {
  math: true,
  mermaid: true,
  diff: true,
  codeLineNumbers: true,
  codeWrap: false,
  mathFontScale: 1,
  mathAlign: "center",
  mathCopy: true,
}

describe("StreamingTextPart", () => {
  beforeEach(() => {
    flowMotion.reduce = false
    flowMotion.durationScale = 1
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
    expect(mockMessageResponse.mock.calls.at(-1)?.[0]).toMatchObject({
      controls: { table: false },
      isAnimating: false,
      mode: "streaming",
      rehypePlugins: ["shared-rehype"],
    })
  })

  it("forwards active streaming state to Streamdown animation and table controls", () => {
    render(<StreamingTextPart text="hello" isStreaming={true} />)

    expect(mockMessageResponse.mock.calls.at(-1)?.[0]).toMatchObject({
      controls: { table: false },
      isAnimating: true,
      mode: "streaming",
      rehypePlugins: ["shared-rehype"],
    })
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
    expect(caret).toHaveClass("w-0")
    expect(caret.firstElementChild).toHaveClass("animate-pulse")
  })

  it("renders a static caret under reduced motion", () => {
    flowMotion.reduce = true
    const { getByTestId } = render(<StreamingTextPart text="hello" isStreaming={true} />)
    expect(getByTestId("streaming-caret").firstElementChild).not.toHaveClass("animate-pulse")
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

  // Headings used to be styled on the finalised branch only, so every heading
  // rendered at body size for the whole stream and jumped when the turn ended.
  // Both branches now take them from `createSharedMarkdownComponents`.
  it("supplies headings mid-stream so they do not resize when the turn finalises", () => {
    render(<StreamingTextPart text="# Title" isStreaming={true} />)
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      components?: Record<string, React.ComponentType<{ children?: ReactNode }>>
    }
    const H1 = props.components?.h1
    expect(H1).toBeDefined()

    render(createElement(H1!, {}, "Title"))
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toHaveClass("scroll-mt-20")
  })

  it("renders an href-less anchor without attempting a workspace lookup", () => {
    render(<StreamingTextPart text="hello" isStreaming={true} projectRoot="/repo" />)
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      components?: {
        a?: React.ComponentType<{ href?: string; children?: ReactNode }>
      }
    }
    // Half-streamed markdown produces `[label](` with no URL yet.
    render(createElement(props.components!.a!, {}, "dangling"))
    const link = screen.getByText("dangling")
    expect(link.tagName).toBe("A")
    expect(link).toHaveAttribute("href", "")
  })

  it("puts the chat typeset preset on the streaming container", () => {
    render(<StreamingTextPart text="hello" isStreaming={true} />)
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as { className?: string }
    // The finalised branch carries the same pair on `MarkdownRenderer`; if the
    // two ever diverge the whole turn re-flows when streaming ends.
    expect(props.className).toContain("typeset")
    expect(props.className).toContain("typeset-chat")
  })

  // `code`/`pre` stay with `@streamdown/code` on this path, so there is no
  // component override to mark — the block wrapper is the only seam we own.
  it("opts fenced-code blocks out of typeset but leaves prose blocks in", () => {
    render(<StreamingTextPart text="hello" isStreaming={true} />)
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      BlockComponent?: React.ComponentType<{ content: string }>
    }
    const Block = props.BlockComponent!

    const fence = render(createElement(Block, { content: "```js\nconst a = 1\n```" }))
    expect(fence.container.querySelector(".not-typeset")).toBeTruthy()

    const prose = render(createElement(Block, { content: "just a paragraph" }))
    expect(prose.container.querySelector(".not-typeset")).toBeNull()
  })
})

describe("FinalizedLongTextPart", () => {
  it("mounts initial sections and defers distant Markdown until it approaches the viewport", () => {
    const callbacks: IntersectionObserverCallback[] = []
    const OriginalObserver = global.IntersectionObserver
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback)
      }
      observe = jest.fn()
      disconnect = jest.fn()
      unobserve = jest.fn()
      takeRecords = jest.fn(() => [])
      root = null
      rootMargin = "1200px 0px"
      thresholds = [0]
    }
    global.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
    const text = Array.from({ length: 80 }, (_, index) => `paragraph ${index}`).join("\n\n")

    try {
      render(<FinalizedLongTextPart text={text} messageId="m1" />)

      expect(screen.getAllByTestId("finalized-markdown-section")).toHaveLength(3)
      expect(screen.getAllByTestId("finalized-markdown-placeholder").length).toBeGreaterThan(0)

      act(() => {
        callbacks[0]?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      })

      expect(screen.getAllByTestId("finalized-markdown-section")).toHaveLength(4)
    } finally {
      global.IntersectionObserver = OriginalObserver
    }
  })
})

describe("markdown knobs (ADR-0127)", () => {
  beforeEach(() => {
    mockMessageResponse.mockClear()
    mockMarkdownRenderer.mockClear()
  })

  it("selectStreamdownPlugins returns stable, toggle-honouring plugin sets", () => {
    expect(selectStreamdownPlugins()).toBe(streamdownPlugins)
    expect(selectStreamdownPlugins({ math: true, mermaid: true })).toBe(streamdownPlugins)
    const noMath = selectStreamdownPlugins({ math: false, mermaid: true })
    expect(noMath).not.toHaveProperty("math")
    expect(noMath).toHaveProperty("mermaid")
    expect(noMath).toHaveProperty("code")
    const noMermaid = selectStreamdownPlugins({ math: true, mermaid: false })
    expect(noMermaid).toHaveProperty("math")
    expect(noMermaid).not.toHaveProperty("mermaid")
    const none = selectStreamdownPlugins({ math: false, mermaid: false })
    expect(Object.keys(none).sort()).toEqual(["cjk", "code"])
    // Stable identity across calls — `<Streamdown>` memoises on `plugins`.
    expect(selectStreamdownPlugins({ math: false, mermaid: false })).toBe(none)
  })

  it("forwards plugins, lineNumbers and the wrap class to Streamdown from the resolved knobs", () => {
    render(
      <StreamingTextPart
        text="x"
        isStreaming
        markdown={{ ...MARKDOWN_DEFAULTS, mermaid: false, codeLineNumbers: false, codeWrap: true }}
      />
    )
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      plugins: Record<string, unknown>
      lineNumbers: boolean
      className: string
    }
    expect(props.plugins).not.toHaveProperty("mermaid")
    expect(props.plugins).toHaveProperty("math")
    expect(props.lineNumbers).toBe(false)
    expect(props.className).toContain("[&_pre]:whitespace-pre-wrap")
  })

  it("defaults to the full plugin set with line numbers and no wrap when no knobs are given", () => {
    render(<StreamingTextPart text="x" isStreaming />)
    const props = mockMessageResponse.mock.calls.at(-1)?.[0] as {
      plugins: Record<string, unknown>
      lineNumbers: boolean
      className: string
    }
    expect(props.plugins).toBe(streamdownPlugins)
    expect(props.lineNumbers).toBe(true)
    expect(props.className).not.toContain("whitespace-pre-wrap")
  })

  it("re-renders when only the markdown knobs change (memo comparator)", () => {
    const { rerender } = render(
      <StreamingTextPart text="same" isStreaming markdown={MARKDOWN_DEFAULTS} />
    )
    const calls = mockMessageResponse.mock.calls.length
    rerender(
      <StreamingTextPart
        text="same"
        isStreaming
        markdown={{ ...MARKDOWN_DEFAULTS, codeLineNumbers: false }}
      />
    )
    expect(mockMessageResponse.mock.calls.length).toBeGreaterThan(calls)
    expect(
      (mockMessageResponse.mock.calls.at(-1)?.[0] as { lineNumbers: boolean }).lineNumbers
    ).toBe(false)
  })

  it("threads the knobs into every finalized long-text section", () => {
    const text = Array.from({ length: 12 }, (_, i) => `para ${i}`).join("\n\n")
    const markdown = { ...MARKDOWN_DEFAULTS, math: false }
    render(<FinalizedLongTextPart text={text} markdown={markdown} />)
    expect(mockMarkdownRenderer).toHaveBeenCalled()
    for (const call of mockMarkdownRenderer.mock.calls) {
      expect((call[0] as { markdown?: unknown }).markdown).toBe(markdown)
    }
  })
})

describe("blockRendersCode", () => {
  it.each([
    ["```js\ncode\n```", true],
    ["~~~\ncode\n~~~", true],
    ["   ```\nindented fence\n```", true],
    // A `<pre>` the opening-fence-only check missed, so it was typeset-styled
    // for the whole stream and jumped the instant the turn finalised.
    ["- item\n  ```js\n  code\n  ```", true],
    ["1. step\n\n   ```\n   code\n   ```", true],
    ["> quoted\n> ```\n> code\n> ```", true],
    ["    const x = 1\n    return x", true],
    ["\tconst x = 1", true],
    ["a paragraph", false],
    ["`inline code` in prose", false],
    // Whole-block rule: a list with four-space continuations is prose and must
    // keep typeset's rhythm.
    ["- item\n    continued on the next line", false],
    ["", false],
  ])("classifies %p as %p", (content, expected) => {
    expect(blockRendersCode(content)).toBe(expected)
  })

  it("rejects a non-string block payload", () => {
    expect(blockRendersCode(undefined)).toBe(false)
    expect(blockRendersCode(42)).toBe(false)
  })
})
